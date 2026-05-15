# Catalog System

**Source files:** `src/catalog/catalog.cpp`, `src/include/catalog/catalog.h`, `src/include/catalog/catalog_set.h`, `src/include/catalog/catalog_entry/`, `src/include/common/enums/catalog_entry_type.h`

The **Catalog** is LadybugDB's schema registry. It tracks every named object in the database — node and relationship tables, sequences, scalar/aggregate/table functions, macros, types, indexes, and graph projections. Every DDL statement reads or writes through the catalog. MVCC for schema changes is implemented via **version chains** on `CatalogEntry` objects, mirroring the row-level MVCC in the storage engine.

## Catalog Structure

The `Catalog` class owns ten `CatalogSet` instances — one per namespace:

```
Catalog
├── tables              ← NodeTableCatalogEntry, RelGroupCatalogEntry, ForeignTableCatalogEntry
├── sequences           ← SequenceCatalogEntry
├── functions           ← ScalarFunctionEntry, AggregateFunctionEntry, TableFunctionEntry,
│                          RewriteFunctionEntry, CopyFunctionEntry, StandaloneTableFunctionEntry
├── types               ← TypeCatalogEntry
├── indexes             ← IndexCatalogEntry
├── macros              ← ScalarMacroCatalogEntry
├── graphs              ← GraphCatalogEntry
├── internalTables      ← system tables (OIDs ≥ 1 << 63)
├── internalSequences   ← system sequences (OIDs ≥ 1 << 63)
└── internalFunctions   ← built-in functions (OIDs ≥ 1 << 63)
```

### User vs Internal OID Space

User-visible objects occupy OIDs `[0, 1 << 63)`. Internal/system objects start at `1 << 63`:

```cpp
// catalog_set.h
static constexpr oid_t INTERNAL_OID_START = 1ULL << 63;
```

This separation ensures that `registerBuiltInFunctions()` and `registerBuiltInTypes()` (called in the `Catalog` constructor) never collide with user-created objects, even across restarts where user OIDs are replayed from disk.

### CatalogSet internals

```cpp
class CatalogSet {
    case_insensitive_map_t<unique_ptr<CatalogEntry>> entries; // latest version per name
    oid_t                nextOID;   // auto-incremented on each createEntry()
    shared_mutex         mtx;       // readers share, single writer takes unique lock
};
```

`case_insensitive_map_t` means `CREATE TABLE Person` and `CREATE TABLE person` refer to the same entry — consistent with Cypher's case-insensitive label semantics.

## CatalogEntry Base Class

Every object in the catalog is represented as a `CatalogEntry` subclass:

```cpp
// catalog_entry.h
class CatalogEntry {
public:
    CatalogEntryType  type;        // discriminator — which subclass this is
    std::string       name;        // the object's name (case-preserved)
    oid_t             oid;         // assigned by CatalogSet::createEntry()
    transaction_t     timestamp;   // txID that created/modified this version
    bool              deleted;     // true → this version represents a DROP

    unique_ptr<CatalogEntry> prev; // older version of this entry (MVCC chain)
    CatalogEntry*            next; // newer version (raw ptr, no ownership)
    bool                     hasParent_;

    virtual std::string toCypher() const = 0; // serialize to CREATE ... Cypher string
};
```

The `prev`/`next` pointers form a **doubly-linked version chain** ordered from newest (`next == nullptr`) to oldest (`prev == nullptr`). Ownership flows backward: the `CatalogSet::entries` map holds the head (newest) via `unique_ptr`; each entry uniquely owns its predecessor via `prev`.

## CatalogEntry Lifecycle

### 1. Create

```cpp
// catalog_set.cpp (simplified)
void CatalogSet::createEntry(Transaction& tx, unique_ptr<CatalogEntry> entry) {
    entry->oid       = nextOID++;
    entry->timestamp = tx.transactionID; // not yet committed
    entry->deleted   = false;
    emplaceNoLock(std::move(entry));     // inserts into `entries` map
}
```

The entry is **immediately visible** to the creating transaction but hidden from all others until commit — because `timestamp` holds the in-flight `transactionID`, which is always `>= START_TRANSACTION_ID (1ULL << 62)`, greater than any committed snapshot timestamp.

### 2. Drop

```cpp
void CatalogSet::dropEntry(Transaction& tx, const std::string& name, oid_t oid) {
    auto* existing = entries.at(name).get();
    // Create a tombstone: a new CatalogEntry with deleted = true
    auto tombstone       = existing->copy();
    tombstone->timestamp = tx.transactionID;
    tombstone->deleted   = true;
    tombstone->prev      = std::move(entries[name]); // old entry becomes prev
    tombstone->prev->next = tombstone.get();
    entries[name]        = std::move(tombstone);
}
```

The old entry is **not removed** — it is demoted to `prev` behind a tombstone. Transactions whose snapshot predates the drop still traverse past the tombstone and see the original entry.

### 3. Alter

`ALTER TABLE` (rename column, add column, change type) creates a new `CatalogEntry` with the updated schema and pushes the old entry onto the version chain:

```cpp
// new entry gets timestamp = tx.transactionID
newEntry->prev       = std::move(entries[name]);
newEntry->prev->next = newEntry.get();
entries[name]        = std::move(newEntry);
```

### 4. Rollback

The `UndoBuffer` records a `CATALOG_ENTRY` undo record for every DDL operation. On rollback, the undo handler:
- For a **CREATE**: removes the new entry from `entries` and restores `prev` as head
- For a **DROP**: removes the tombstone, restoring the original entry as head

## MVCC Visibility: Version Chain Traversal

`CatalogSet::getEntry(tx, name)` calls `traverseVersionChainsForTransactionNoLock` to find the correct version:

```cpp
CatalogEntry* CatalogSet::traverseVersionChainsForTransactionNoLock(
        Transaction& tx, CatalogEntry* entry) {
    // Walk backwards until we find a version committed before tx.startTS
    while (entry != nullptr) {
        if (isVisible(tx, entry->timestamp)) {
            return entry->deleted ? nullptr : entry;
        }
        entry = entry->prev.get();
    }
    return nullptr; // no visible version → object doesn't exist for this TX
}

bool isVisible(Transaction& tx, transaction_t entryTimestamp) {
    // committed timestamps < START_TRANSACTION_ID; in-flight ones ≥
    if (entryTimestamp >= START_TRANSACTION_ID) {
        // in-flight: only visible to the same transaction
        return entryTimestamp == tx.transactionID;
    }
    // committed: visible if committed before this tx started
    return entryTimestamp <= tx.startTransactionID;
}
```

::: tip Snapshot isolation for schema
Schema visibility follows the same snapshot isolation rule as data: a transaction sees the catalog as it existed at its start time. This means a long-running read transaction will not see new tables created after it started, even if those tables are already committed.
:::

### Before/After Diagram: CREATE + DROP

```
Timeline →
  T=10  CREATE TABLE person(...)   committed at commitID=10
  T=20  DROP TABLE person          committed at commitID=20

Version chain in CatalogSet::entries["person"]:

  entries["person"]
        │
        ▼
  ┌─────────────────────────┐      ┌─────────────────────────┐
  │  CatalogEntry (head)    │      │  CatalogEntry (prev)    │
  │  timestamp = 20         │◄prev─│  timestamp = 10         │
  │  deleted   = true       │      │  deleted   = false      │
  │  next      = nullptr    │─next─►  next → head            │
  └─────────────────────────┘      └─────────────────────────┘

TX-A (startTS = 5):   walks past head (20 > 5) → prev (10 > 5) → nullptr  → not found
TX-B (startTS = 15):  walks past head (20 > 15) → prev (10 ≤ 15, not deleted) → returns entry
TX-C (startTS = 25):  head (20 ≤ 25, deleted = true) → returns nullptr (dropped)
```

## Obtaining the Catalog: `Catalog::Get`

Code throughout the engine retrieves the catalog via a static `Get` method that resolves the appropriate catalog for the current execution context:

```cpp
// catalog.h
static Catalog& Catalog::Get(ClientContext& context);
static Catalog& Catalog::Get(DatabaseInstance& db);
```

The `Get(context)` overload inspects the context for:
1. **Attached database** — if the query targets an attached DB, returns that DB's catalog
2. **Default graph scope** — for graph-scoped queries, returns the active graph's catalog
3. **Main database** — falls back to the primary `DatabaseInstance` catalog

```cpp
// Usage in the binder:
auto& catalog = Catalog::Get(context);
auto* entry   = catalog.tables->getEntry(*tx, tableName);
```

The `version` field on `Catalog` is a `uint64_t` bumped on every DDL. The binder caches catalog lookups and uses `version` to invalidate the cache between DDL statements:

```cpp
uint64_t Catalog::getVersion() const { return version; }
void     Catalog::incrementVersion()  { version++; }
```

## CatalogEntryType Reference

All entry discriminators are defined in `src/include/common/enums/catalog_entry_type.h`:

```cpp
enum class CatalogEntryType : uint8_t {
    NODE_TABLE_ENTRY              = 0,
    REL_GROUP_ENTRY               = 2,
    FOREIGN_TABLE_ENTRY           = 4,
    SCALAR_MACRO_ENTRY            = 10,
    AGGREGATE_FUNCTION_ENTRY      = 20,
    SCALAR_FUNCTION_ENTRY         = 21,
    REWRITE_FUNCTION_ENTRY        = 22,
    TABLE_FUNCTION_ENTRY          = 23,
    COPY_FUNCTION_ENTRY           = 25,
    STANDALONE_TABLE_FUNCTION_ENTRY = 26,
    SEQUENCE_ENTRY                = 40,
    TYPE_ENTRY                    = 41,
    INDEX_ENTRY                   = 42,
    GRAPH_ENTRY                   = 50,
    DUMMY_ENTRY                   = 100,
};
```

| Value | Name | CatalogSet | Description |
|------:|------|------------|-------------|
| 0 | `NODE_TABLE_ENTRY` | `tables` | Node table: properties, table ID, storage backend |
| 2 | `REL_GROUP_ENTRY` | `tables` | Relationship group: FROM/TO IDs, adjacency hints, properties |
| 4 | `FOREIGN_TABLE_ENTRY` | `tables` | External table (Arrow / Icebug-Disk scan source) |
| 10 | `SCALAR_MACRO_ENTRY` | `macros` | User-defined `MACRO` (Cypher expression alias) |
| 20 | `AGGREGATE_FUNCTION_ENTRY` | `functions` | Aggregate function (e.g., `sum`, `count`) |
| 21 | `SCALAR_FUNCTION_ENTRY` | `functions` | Scalar function (e.g., `upper`, `sin`) |
| 22 | `REWRITE_FUNCTION_ENTRY` | `functions` | Function replaced at rewrite time (optimizer hook) |
| 23 | `TABLE_FUNCTION_ENTRY` | `functions` | Table-valued function (returns rows, e.g., `range()`) |
| 25 | `COPY_FUNCTION_ENTRY` | `functions` | Format reader for `COPY FROM` (e.g., CSV, Parquet) |
| 26 | `STANDALONE_TABLE_FUNCTION_ENTRY` | `functions` | Table function with no associated relation |
| 40 | `SEQUENCE_ENTRY` | `sequences` | Sequence: current value, increment, min/max, cycle |
| 41 | `TYPE_ENTRY` | `types` | User-defined or built-in type alias |
| 42 | `INDEX_ENTRY` | `indexes` | Index: type (HASH), associated table + column |
| 50 | `GRAPH_ENTRY` | `graphs` | GDS graph projection: references to node/rel tables |
| 100 | `DUMMY_ENTRY` | — | Placeholder used internally during catalog rebuilds |

::: tip Gap values
The numeric gaps (1, 3, 5–9, 11–19, 24, 27–39, 43–49, 51–99) are intentional reserved space. Serialized catalog entries on disk store the `uint8_t` value, so gaps allow future entry types to be inserted without breaking backward compatibility of checkpoint files.
:::

## Special CatalogEntry Subclasses

### NodeTableCatalogEntry

```cpp
class NodeTableCatalogEntry : public CatalogEntry {
    table_id_t                  tableID;
    std::vector<PropertyDefinition> properties; // name, type, isPrimaryKey
    StorageType                 storageType;    // NATIVE | ICEDISK | ARROW
};
```

`properties` is the authoritative schema used by the binder to resolve `p.age` → column index 2. The `storageType` flag controls which scan path is taken during execution.

### RelGroupCatalogEntry

```cpp
class RelGroupCatalogEntry : public CatalogEntry {
    table_id_t  srcTableID;   // FROM node table
    table_id_t  dstTableID;   // TO node table
    std::vector<PropertyDefinition> properties;
    AdjacencyHints fwdHints;  // expected degree distribution, used for CSR sizing
    AdjacencyHints bwdHints;
};
```

### SequenceCatalogEntry

```cpp
class SequenceCatalogEntry : public CatalogEntry {
    int64_t  currVal;    // current value (mutable, not versioned per-TX)
    int64_t  increment;
    int64_t  minVal;
    int64_t  maxVal;
    bool     cycle;      // wrap around when exhausted
};
```

::: warning Sequence values are not transactional
`NEXTVAL` increments `currVal` immediately and is not rolled back on transaction abort. This matches standard database semantics — sequences intentionally produce gaps on rollback to avoid lock contention.
:::

### GraphCatalogEntry

```cpp
class GraphCatalogEntry : public CatalogEntry {
    std::vector<table_id_t> nodeTableIDs;
    std::vector<table_id_t> relTableIDs;
};
```

GDS (Graph Data Science) functions call `Catalog::Get(context).graphs->getEntry(tx, graphName)` to obtain the projection, then pull the referenced tables' scan handles for algorithm execution.

### IndexCatalogEntry

```cpp
class IndexCatalogEntry : public CatalogEntry {
    IndexType              indexType;    // currently only HASH
    table_id_t             tableID;      // table that owns this index
    std::string            indexName;    // user-supplied name
    std::vector<property_id_t> propertyIDs; // indexed properties (one for hash indexes)
    std::unique_ptr<IndexAuxInfo> auxInfo;   // loaded index data (null when not in use)
};
```

Every node table's primary key column automatically gets a hash index at creation time (unless `enable_default_hash_index=false`). Additional indexes are created explicitly with `CREATE [HASH] INDEX`:

```cypher
CREATE HASH INDEX idx_name [IF NOT EXISTS] FOR (p:TableName) ON (p.propertyName)
```

DDL flow: `ParseCreateIndex` → `BoundCreateIndex` → `LogicalCreateIndex` → `CreateIndexPhysicalOperator` → `NodeTable::addIndex()` → `indexes->createEntry(tx, IndexCatalogEntry{...})` → WAL `CREATE_CATALOG_ENTRY_RECORD`.

`toCypher()` on `BuiltinIndexAuxInfo` produces the full `CREATE HASH INDEX ...` string used for checkpoint serialization and `ALTER TABLE` replay.

**`SHOW_INDEXES()` table function** lists all indexes in the catalog:

```cypher
CALL SHOW_INDEXES() RETURN table_name, index_name, property_names;
```

## DDL and Catalog MVCC: End-to-End

### CREATE TABLE

```
CALL Catalog::createNodeTable(tx, "person", properties)
  └─ tables->createEntry(tx, NodeTableCatalogEntry{...})
       ├─ entry.timestamp = tx.transactionID   (uncommitted)
       ├─ entry.oid       = nextOID++
       └─ entries["person"] = entry

  UndoBuffer ← CATALOG_ENTRY record (for rollback)
  WAL        ← CREATE_CATALOG_ENTRY_RECORD
  Catalog::version++
```

Other transactions calling `tables->getEntry(tx, "person")` receive `nullptr` until `tx` commits and their snapshot timestamp exceeds the commit ID.

### DROP TABLE

```
CALL Catalog::dropNodeTable(tx, "person")
  └─ tables->dropEntry(tx, "person", oid)
       ├─ tombstone.timestamp = tx.transactionID
       ├─ tombstone.deleted   = true
       └─ entries["person"]   = tombstone (old entry → tombstone.prev)

  UndoBuffer ← CATALOG_ENTRY record (for rollback — saves old entry)
  WAL        ← DROP_CATALOG_ENTRY_RECORD
  Catalog::version++
```

### ALTER TABLE

```
CALL Catalog::alterTable(tx, "person", AlterTableInfo{RENAME_COLUMN, "age", "birth_year"})
  └─ tables->createEntry(tx, updatedEntry)   (new head, old entry → prev)

  UndoBuffer ← CATALOG_ENTRY record
  WAL        ← ALTER_TABLE_ENTRY_RECORD
  Catalog::version++
```

### Rollback

```
UndoBuffer::reverseIterate():
  for each CATALOG_ENTRY undo record (LIFO):
    if record was a CREATE: remove new head, restore prev as head
    if record was a DROP:   remove tombstone head, restore original as head
    if record was an ALTER: remove new head, restore old version as head
```

## Serialization & Deserialization

### Checkpoint (Serialize)

During checkpointing, the catalog is written to the checkpoint file before data pages are flushed:

```cpp
void Catalog::serialize(Serializer& ser) {
    // For each CatalogSet, iterate committed entries and call entry->toCypher()
    // Each subclass implements toCypher() returning a CREATE ... statement
    tables->serializeEntries(ser);
    sequences->serializeEntries(ser);
    functions->serializeEntries(ser);
    types->serializeEntries(ser);
    indexes->serializeEntries(ser);
    macros->serializeEntries(ser);
    graphs->serializeEntries(ser);
    // internal sets are rebuilt from registerBuiltIn*() — not serialized
}
```

`toCypher()` outputs exactly the Cypher DDL needed to recreate the object. For example, `NodeTableCatalogEntry::toCypher()` returns `CREATE NODE TABLE person(id INT64 PRIMARY KEY, name STRING, age INT64)`.

### Startup (Deserialize)

```cpp
void Catalog::deserialize(Deserializer& deser) {
    // 1. Rebuild built-ins first (registerBuiltInFunctions / registerBuiltInTypes)
    // 2. Replay serialized user entries: parse toCypher() output → createEntry()
    //    Each re-created entry gets its original OID from the serialized form
    //    nextOID is set to max(restored OIDs) + 1
}
```

### WAL Replay on Top of Checkpoint

After deserializing the checkpoint catalog, the WAL replayer re-applies any DDL that was committed after the last checkpoint:

```
WAL replay loop:
  CREATE_CATALOG_ENTRY_RECORD  → Catalog::createEntry()
  DROP_CATALOG_ENTRY_RECORD    → Catalog::dropEntry()
  ALTER_TABLE_ENTRY_RECORD     → Catalog::alterTable()
```

The replay uses a synthetic `RecoveryTransaction` with `transactionID = RECOVERY_TRANSACTION_ID` so that visibility checks treat all replayed entries as committed.

::: tip Two-phase recovery
The checkpoint provides a consistent base state. WAL replay is additive — it only needs to cover operations committed after the last checkpoint. This is why `Catalog::serialize()` only writes committed entries: any in-flight DDL at checkpoint time will be either committed (and replayed from WAL) or rolled back (and absent from WAL).
:::

## WAL Integration

Three WAL record types cover catalog mutations, defined in `src/include/storage/wal/wal_record_type.h`:

| WAL Record | Triggered By | Payload |
|------------|-------------|---------|
| `CREATE_CATALOG_ENTRY_RECORD` | `CREATE TABLE`, `CREATE INDEX`, `CREATE SEQUENCE`, function registration | `CatalogEntryType` + serialized entry (toCypher output) |
| `DROP_CATALOG_ENTRY_RECORD` | `DROP TABLE`, `DROP INDEX`, `DROP SEQUENCE` | `CatalogEntryType` + entry name + OID |
| `ALTER_TABLE_ENTRY_RECORD` | `ALTER TABLE` (rename, add/drop column, change type) | `AlterType` + table name + full new entry serialization |

WAL records are written **before** the catalog change takes effect in memory. On crash-recovery, the WAL replayer replays them on top of the last checkpointed catalog state to restore consistency.

::: tip WAL records are logical, not physical
Unlike data modifications (which go through the shadow file and record page-level changes), catalog WAL records are purely **logical** — they record the DDL intent. This is why `toCypher()` is the serialization format: it is human-readable, schema-version-tolerant, and directly executable during WAL replay.
:::

## Concurrency Control on CatalogSet

`CatalogSet` uses a `std::shared_mutex`:

```
getEntry()    → shared_lock   (concurrent reads from multiple TX)
createEntry() → unique_lock   (exclusive: modifies `entries` map)
dropEntry()   → unique_lock
```

Because LadybugDB allows only one write transaction at a time, the unique lock is never contended in practice — but the shared lock allows multiple concurrent read transactions to perform catalog lookups (e.g., binding) in parallel.

## Related Files

- `src/catalog/catalog.cpp` — `Catalog::Get`, DDL entry points, `registerBuiltIn*`
- `src/include/catalog/catalog.h` — `Catalog` class, `version` field
- `src/include/catalog/catalog_set.h` — `CatalogSet`, version chain traversal
- `src/catalog/catalog_set.cpp` — `createEntry`, `dropEntry`, `getEntry`, `traverseVersionChainsForTransactionNoLock`
- `src/include/catalog/catalog_entry/node_table_catalog_entry.h` — `NodeTableCatalogEntry`
- `src/include/catalog/catalog_entry/rel_group_catalog_entry.h` — `RelGroupCatalogEntry`
- `src/include/catalog/catalog_entry/sequence_catalog_entry.h` — `SequenceCatalogEntry`
- `src/include/catalog/catalog_entry/graph_catalog_entry.h` — `GraphCatalogEntry`
- `src/include/catalog/catalog_entry/index_catalog_entry.h` — `IndexCatalogEntry`
- `src/include/common/enums/catalog_entry_type.h` — `CatalogEntryType` enum
- `src/include/storage/wal/wal_record_type.h` — WAL record types for DDL
- `src/storage/checkpointer.cpp` — calls `Catalog::serialize` during checkpoint
- `src/transaction/undo_buffer.cpp` — `CATALOG_ENTRY` undo record handling
