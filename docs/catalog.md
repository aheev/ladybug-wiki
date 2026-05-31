# Catalog System

This page is an engineering reference for LadybugDB's catalog implementation.
It is written from the current C++ source.
It is not a generic database-catalog overview.

## Scope and primary source files

- `src/include/catalog/catalog.h`
- `src/catalog/catalog.cpp`
- `src/include/catalog/catalog_set.h`
- `src/catalog/catalog_set.cpp`
- `src/include/catalog/property_definition_collection.h`
- `src/catalog/property_definition_collection.cpp`
- `src/include/catalog/catalog_entry/catalog_entry_type.h`
- `src/include/catalog/catalog_entry/catalog_entry.h`
- `src/catalog/catalog_entry/catalog_entry.cpp`
- `src/include/catalog/catalog_entry/table_catalog_entry.h`
- `src/catalog/catalog_entry/table_catalog_entry.cpp`
- `src/include/catalog/catalog_entry/node_table_catalog_entry.h`
- `src/catalog/catalog_entry/node_table_catalog_entry.cpp`
- `src/include/catalog/catalog_entry/rel_group_catalog_entry.h`
- `src/catalog/catalog_entry/rel_group_catalog_entry.cpp`
- `src/include/catalog/catalog_entry/index_catalog_entry.h`
- `src/catalog/catalog_entry/index_catalog_entry.cpp`
- `src/include/catalog/catalog_entry/sequence_catalog_entry.h`
- `src/catalog/catalog_entry/sequence_catalog_entry.cpp`
- `src/include/catalog/catalog_entry/function_catalog_entry.h`
- `src/catalog/catalog_entry/function_catalog_entry.cpp`
- `src/include/catalog/catalog_entry/type_catalog_entry.h`
- `src/catalog/catalog_entry/type_catalog_entry.cpp`
- `src/include/catalog/catalog_entry/scalar_macro_catalog_entry.h`
- `src/catalog/catalog_entry/scalar_macro_catalog_entry.cpp`
- `src/include/catalog/catalog_entry/graph_catalog_entry.h`
- `src/catalog/catalog_entry/graph_catalog_entry.cpp`
- `src/include/catalog/catalog_entry/dummy_catalog_entry.h`
- `src/include/catalog/catalog_entry/node_table_id_pair.h`
- `src/include/common/types/types.h`
- `src/include/common/serializer/serializer.h`
- `src/include/common/serializer/deserializer.h`
- `src/transaction/transaction.h`
- `src/include/extension/extension.h`
- `src/include/extension/extension_manager.h`
- `src/extension/extension.cpp`
- `src/extension/extension_entries.cpp`
- `extension/vector/src/main/vector_extension.cpp`
- `extension/vector/src/include/catalog/hnsw_index_catalog_entry.h`
- `extension/vector/src/include/index/hnsw_index.h`
- `extension/vector/src/include/function/hnsw_index_functions.h`
- `extension/vector/src/function/create_hnsw_index.cpp`
- `extension/fts/src/main/fts_extension.cpp`
- `extension/fts/src/include/catalog/fts_index_catalog_entry.h`
- `extension/fts/src/include/index/fts_index.h`
- `extension/fts/src/include/function/create_fts_index.h`
- `extension/fts/src/include/function/query_fts_index.h`
- `extension/fts/src/function/create_fts_index.cpp`
- `extension/fts/src/function/query_fts_index.cpp`
- `extension/json/src/main/json_extension.cpp`
- `extension/duckdb/src/include/catalog/duckdb_table_catalog_entry.h`
- `extension/duckdb/src/catalog/duckdb_table_catalog_entry.cpp`
- `extension/adbc/src/include/catalog/adbc_table_catalog_entry.h`
- `extension/adbc/src/catalog/adbc_table_catalog_entry.cpp`

## What the catalog is responsible for

The `Catalog` is LadybugDB's in-memory schema registry.
It owns named metadata objects.
It answers existence checks.
It provides lookup by name and OID.
It creates new entries during DDL.
It versions schema changes with MVCC-style chains.
It serializes committed metadata to disk.
It reconstructs metadata during recovery.
It also hosts built-in functions and a small set of built-in types.

The catalog does **not** store table data pages.
That is the storage manager's job.
The catalog stores the metadata that lets other subsystems interpret those pages.

## The top-level object layout

`Catalog` owns one `CatalogSet` per metadata namespace.
The constructor calls:

- `initCatalogSets()`
- `registerBuiltInFunctions()`
- `registerBuiltInTypes()`

The ten catalog sets are:

1. `tables`
2. `sequences`
3. `functions`
4. `types`
5. `indexes`
6. `macros`
7. `internalTables`
8. `internalSequences`
9. `internalFunctions`
10. `graphs`

That list is not inferred.
It is the exact order in `Catalog::initCatalogSets()`.

## Why there are "internal" sets

LadybugDB separates user-defined objects from system or built-in objects with dedicated OID ranges and dedicated catalog sets.

The internal sets are:

- `internalTables`
- `internalSequences`
- `internalFunctions`

These sets are initialized with `CatalogSet(true)`.
That constructor sets `nextOID` to a high-water mark.

## Internal OID space

`CatalogSet` defines:

- `INTERNAL_CATALOG_SET_START_OID = 1LL << 63`

The comment in the header states the reason clearly:

- internal OIDs start at `2^63`
- this avoids collisions with user tables and sequences

So the OID space is effectively split into two halves:

- user objects use low OIDs
- internal objects use high OIDs

This separation is used immediately by:

- built-in function registration
- internal-table registration
- internal sequence creation for serial columns

## Catalog selection in multi-database contexts

`Catalog::Get(const ClientContext&)` is more nuanced than a simple `context.getDatabase()->getCatalog()`.

It checks in this order:

1. attached database
2. default graph catalog from `DatabaseManager`
3. primary database catalog

That means a client session can be routed to a graph-specific catalog or attached database catalog depending on context state.

## Namespace overview

### Tables namespace

The `tables` and `internalTables` sets hold table-like entries.
In current code those are mainly:

- `NODE_TABLE_ENTRY`
- `REL_GROUP_ENTRY`
- `FOREIGN_TABLE_ENTRY`

### Sequences namespace

The `sequences` and `internalSequences` sets hold `SEQUENCE_ENTRY` entries.
Internal sequences are used for serial columns.

### Functions namespace

The `functions` and `internalFunctions` sets hold function overload sets.
The `macros` set is separate and does not share the same namespace container.
However `getFunctionEntry()` consults both functions and macros.

### Types namespace

The `types` set stores user-defined and registered named logical types.
The built-in catalog currently registers JSON explicitly here.

### Indexes namespace

The `indexes` set stores named index metadata.
Its key is an internal name derived from table id plus user-visible index name.

### Graphs namespace

The `graphs` set stores `GraphCatalogEntry` objects.
Those represent named graph objects and the `ANY GRAPH` concept via a boolean flag.

## `CatalogEntryType`

Current `CatalogEntryType` values are:

| Entry type | Numeric value |
| --- | --- |
| `NODE_TABLE_ENTRY` | `0` |
| `REL_GROUP_ENTRY` | `2` |
| `FOREIGN_TABLE_ENTRY` | `4` |
| `SCALAR_MACRO_ENTRY` | `10` |
| `AGGREGATE_FUNCTION_ENTRY` | `20` |
| `SCALAR_FUNCTION_ENTRY` | `21` |
| `REWRITE_FUNCTION_ENTRY` | `22` |
| `TABLE_FUNCTION_ENTRY` | `23` |
| `COPY_FUNCTION_ENTRY` | `25` |
| `STANDALONE_TABLE_FUNCTION_ENTRY` | `26` |
| `SEQUENCE_ENTRY` | `40` |
| `TYPE_ENTRY` | `41` |
| `INDEX_ENTRY` | `42` |
| `GRAPH_ENTRY` | `50` |
| `DUMMY_ENTRY` | `100` |

A few consequences of this exact enum:

- functions are distinguished by catalog-entry type, not by a second function-class field
- macros are not stored as normal function entries
- dummy entries are first-class catalog-entry objects used for versioning mechanics

### What extensions do and do not add to the enum

In the current source tree, extensions do **not** add extra `CatalogEntryType` enum members such as `HNSW_INDEX` or `FTS_INDEX`.
The authoritative enum in `src/include/catalog/catalog_entry/catalog_entry_type.h` still stops at the core values above, and `CatalogEntry::deserialize(...)` only switches over those core discriminators.

Extension code instead layers on top of existing entry kinds:

- vector and FTS indexes are still stored as `CatalogEntryType::INDEX_ENTRY`
- DuckDB and ADBC foreign tables are still stored as `CatalogEntryType::FOREIGN_TABLE_ENTRY`

The extension-specific pieces live inside helper structs, subclasses, and auxiliary payloads rather than in a widened top-level enum.

Concrete examples from the extension tree:

- `vector_extension::HNSWIndexCatalogEntry` is a tiny helper that publishes `TYPE_NAME = "HNSW"`
- `fts_extension::FTSIndexCatalogEntry` is a tiny helper that publishes `TYPE_NAME = "FTS"`
- both extensions pair those names with custom `IndexAuxInfo` subclasses (`HNSWIndexAuxInfo`, `FTSIndexAuxInfo`)
- `DuckDBTableCatalogEntry` and `ADBCTableCatalogEntry` are real `TableCatalogEntry` subclasses, but both constructors still pass `CatalogEntryType::FOREIGN_TABLE_ENTRY`

So the current catalog-extension contract is:

- core enum chooses the broad family (`INDEX_ENTRY`, `FOREIGN_TABLE_ENTRY`, etc.)
- extension-owned strings like `"HNSW"` / `"FTS"` choose the concrete index flavor
- extension-owned aux-info objects or table-entry subclasses carry the extra metadata and runtime hooks

From a user-facing or public-doc perspective, it is still reasonable to talk about **HNSW** and **FTS** as separate index families.
The important implementation detail is that those families currently live *inside* the core `INDEX_ENTRY` bucket rather than as separate `CatalogEntryType` enum variants.

## `CatalogEntry` base class

Every catalog object derives from `CatalogEntry`.

### Stored fields

The base class stores:

- `CatalogEntryType type`
- `std::string name`
- `oid_t oid`
- `transaction_t timestamp`
- `bool deleted`
- `bool hasParent_`
- `std::unique_ptr<CatalogEntry> prev`
- `CatalogEntry* next`

### Meaning of those fields

`type`
- entry discriminator

`name`
- catalog key
- lookup is case-insensitive at the set level even though the string is preserved here

`oid`
- globally unique only within its OID region and set-allocation discipline

`timestamp`
- creation/modification timestamp for MVCC visibility
- stores transaction id while uncommitted
- stores commit timestamp after commit handling updates version timestamps

`deleted`
- marks tombstone versions

`hasParent_`
- used by some DDL and object-ownership flows
- especially relevant for child objects and auto-created metadata like serial sequences

`prev`
- owned pointer to the older version in the version chain

`next`
- non-owning pointer to the newer version

### Version-chain ownership direction

Ownership flows backward.
The newest visible-or-pending entry is owned by the `CatalogSet` map.
That entry owns its previous version through `prev`.
That previous version owns the next older one.
And so on.

So the chain looks conceptually like:

- map head -> newest
- newest `prev` -> previous
- previous `prev` -> older

`next` only exists for navigation.
It is not an ownership link.

### Base-class operations

Notable base-class methods:

- `rename(...)`
- `setTimestamp(...)`
- `setDeleted(...)`
- `setHasParent(...)`
- `setOID(...)`
- `getPrev()`
- `movePrev()`
- `setPrev(...)`
- `setNext(...)`
- `serialize(...)`
- `deserialize(...)`
- `toCypher(...)`

The base `toCypher()` is not implemented.
Only specific entry subclasses provide it.

## `DummyCatalogEntry`

`DummyCatalogEntry` is a special implementation detail that matters a lot for MVCC semantics.

Its constructor does three things immediately:

- sets `deleted = true`
- sets `timestamp = 0`
- sets the provided OID

It is never serialized.
Its `serialize()` method is `UNREACHABLE_CODE`.
Its `toCypher()` is also unreachable.

### Why dummy entries exist

They are used in two places:

1. create paths
2. drop paths

During create, a dummy head can be inserted before the real entry is emplaced.
During drop, a dummy-like tombstone head becomes the new visible head.

The important point is that the catalog uses real catalog-entry objects to model deletion and name reuse rather than deleting map keys eagerly.

## `CatalogSet`

`CatalogSet` is the real concurrency and MVCC engine behind the catalog.

### Stored fields

- `mutable std::shared_mutex mtx`
- `oid_t nextOID`
- `case_insensitive_map_t<std::unique_ptr<CatalogEntry>> entries`

### Case-insensitive lookup

The map type is `case_insensitive_map_t`.
So names are keyed case-insensitively.
This means:

- existence checks are case-insensitive
- create/drop/lookup conflicts are case-insensitive

The catalog entry still stores the original name string.
But the set lookup semantics are case-insensitive.

### Locking model

Read paths use `std::shared_lock`.
Write paths use `std::unique_lock`.

Typical read methods:

- `containsEntry(...)`
- `getEntry(...)`
- `getEntries(...)`
- `getEntryOfOID(...)`

Typical write methods:

- `createEntry(...)`
- `dropEntry(...)`
- `alterTableEntry(...)`
- `getNextOID()`

### OID allocation

`createEntry(...)` takes a write lock and increments `nextOID`.
`getNextOID()` also exists and locks internally.
`getNextOIDNoLock()` exists for callers already under the set mutex.

The rel-group creation path uses `tables->getNextOID()` to pre-assign OIDs for individual relationship-table infos before the group entry itself is inserted.
That is a subtle but important detail.

## Visibility traversal

The catalog's MVCC visibility rule lives in:

- `CatalogSet::traverseVersionChainsForTransactionNoLock(...)`

It walks from newest to oldest and stops when one of these is true:

1. entry timestamp equals the current transaction id
2. entry timestamp is committed and `<= transaction->getStartTS()`
3. there are no older versions left

This exactly captures snapshot visibility for schema objects.

### Practical interpretation

A transaction sees:

- its own uncommitted schema changes
- committed schema versions that were committed before the transaction snapshot started
- nothing newer than its snapshot unless it created it itself

This is the same high-level rule as row MVCC, but implemented with version-chain traversal on metadata objects.

## Write-write conflict detection

`catalog_set.cpp` defines a helper:

- `checkWWConflict(transaction, entry)`

It reports conflict when:

- the head entry belongs to another still-running transaction, or
- the head entry committed after the current transaction's start timestamp

So DDL conflicts are detected both against in-flight writers and against committed writers that are newer than the caller's snapshot.

That is the schema-level equivalent of a write-write conflict test.

## Existence validation helpers

Two helpers are used heavily inside locked paths:

- `validateExistNoLock(...)`
- `validateNotExistNoLock(...)`

Their error messages are intentionally simple:

- `X does not exist in catalog.`
- `X already exists in catalog.`

Several higher-level `Catalog` methods wrap these with more informative messages for specific object categories.

## Create path in detail

The public write entry point is:

- `CatalogSet::createEntry(transaction, unique_ptr<CatalogEntry>)`

Step-by-step behavior:

1. acquire unique lock
2. allocate OID from `nextOID`
3. set the entry OID
4. call `createEntryNoLock(...)`
5. release lock
6. if the transaction should append to the undo buffer, push a create/drop catalog undo record

### `createEntryNoLock(...)`

Inside the lock, the implementation does the following:

1. validate that no visible entry with the same name exists for this transaction snapshot
2. set `entry->timestamp = transaction->getID()`
3. if the name already exists in the map, inspect the current head
4. reject write-write conflicts
5. reject a still-live existing entry
6. create a dummy head with the same name and OID
7. insert the dummy into the map
8. `emplaceNoLock(realEntry)` so the real entry becomes the head and the dummy becomes its `prev`

This is a subtle design.
The catalog does not simply insert the real entry directly.
It uses a dummy predecessor to preserve chain mechanics even for freshly created names.

### Why the timestamp is the transaction id first

New entries are stamped with the creating transaction id before commit.
That means other transactions will skip them during visibility traversal unless they are the creating transaction itself.

## `emplaceNoLock(...)`

This helper is the core version-chain manipulation primitive.

Behavior:

- if the map already contains the name, move the existing head into `entry->prev`
- set the previous head's `next` pointer to the new head
- erase the old map slot
- insert the new head into the map

This single helper is reused by:

- create
- drop
- alter
- rename-create side of rename
- deserialization

## Drop path in detail

The public drop entry point is:

- `CatalogSet::dropEntry(transaction, name, oid)`

Step-by-step behavior:

1. acquire unique lock
2. call `dropEntryNoLock(...)`
3. release lock
4. push create/drop undo record if needed

### `dropEntryNoLock(...)`

It does the following:

1. validate the entry exists for the transaction snapshot
2. create a dummy tombstone for the same name and OID
3. set the tombstone timestamp to the current transaction id
4. `emplaceNoLock(tombstone)`

The previous head becomes `tombstone->prev`.
The new head is marked deleted.

### Visibility effect of a drop

Transactions whose snapshot predates the drop will traverse past the tombstone and still see the older committed version.
Transactions whose snapshot includes the tombstone will stop at the tombstone and treat the entry as deleted.

That is the exact schema-MVCC deletion behavior.

## Lookup paths in detail

### `containsEntry(...)`

Steps:

1. shared lock
2. if map does not contain the name, return false
3. otherwise traverse version chain for transaction visibility
4. return `!entry->isDeleted()`

### `getEntry(...)`

Steps:

1. shared lock
2. validate visible existence
3. traverse version chain
4. assert result is non-null and not deleted
5. return it

### `getEntries(...)`

This method returns a case-insensitive map of visible heads for the given transaction.
For each map head it:

- traverses the version chain
- skips deleted visible heads
- inserts the visible version into the result map

### `getEntryOfOID(...)`

This is a linear scan over the set map.
For each current head it:

- checks head OID equality first
- then traverses visibility
- skips deleted visible versions

So OID lookup is not backed by a separate OID hash map.
It scans the name map.
That is worth remembering for performance reasoning.

## Serialization rules in `CatalogSet`

### `serialize(...)`

The set serializes only committed, non-deleted, serializable entry kinds.

It first builds `entriesToSerialize`.
While scanning current heads it skips these entry types entirely:

- `SCALAR_FUNCTION_ENTRY`
- `REWRITE_FUNCTION_ENTRY`
- `AGGREGATE_FUNCTION_ENTRY`
- `COPY_FUNCTION_ENTRY`
- `TABLE_FUNCTION_ENTRY`
- `STANDALONE_TABLE_FUNCTION_ENTRY`
- `FOREIGN_TABLE_ENTRY`

Then for all other entry kinds it picks the committed visible version by calling `getCommittedEntryNoLock(...)`.
If that committed entry exists and is not deleted, it is serialized.

Then the stream writes:

- debugging tag `nextOID`
- `nextOID`
- debugging tag `numEntries`
- count
- each entry payload

### Why function entries are skipped

The code comment in `FunctionCatalogEntry` says built-in functions are always registered while initializing the catalog.
So serializing them is unnecessary.

### Why foreign tables are skipped

The set-level serializer skips `FOREIGN_TABLE_ENTRY` explicitly.
That is an implementation choice of the current persistence format.

### `serializeSnapshot(...)`

Snapshot serialization is similar, but instead of taking the latest committed version it takes the version visible to a synthetic snapshot transaction built from the caller-provided timestamp.

That is important for checkpointing or exporting a transaction-consistent catalog snapshot.

### `deserialize(...)`

Deserialization:

1. reads `nextOID`
2. reads serialized entry count
3. repeatedly calls `CatalogEntry::deserialize(...)`
4. emplaces each returned entry as the head for its name

No version chains are reconstructed from multiple historical versions.
Only the serialized committed or snapshot-visible heads are restored.

## Top-level `Catalog` serialization order

`Catalog::serialize(...)` writes sets in this exact order:

1. `tables`
2. `sequences`
3. `functions`
4. `types`
5. `indexes`
6. `macros`
7. `internalTables`
8. `internalSequences`
9. `internalFunctions`
10. `graphs`

`Catalog::serializeSnapshot(...)` uses the same order.
`Catalog::deserialize(...)` expects the same order.

That ordering is part of the on-disk format contract.

## Catalog version counters

The `Catalog` object also tracks a version counter separate from per-entry timestamps.

Stored fields:

- `std::atomic<uint64_t> version`
- `uint64_t lastCheckpointVersion`

Important methods:

- `incrementVersion()`
- `getVersion()`
- `getVersionSinceCheckpoint()`
- `changedSinceLastCheckpoint()`
- `resetVersion()`
- `resetVersion(checkpointedVersion)`

The comment says `getVersionSinceCheckpoint()` is the user-visible version number for procedures like `CALL catalog_version()`.

So:

- per-entry timestamps drive MVCC visibility
- catalog version drives coarse change counting since checkpoint

## Table catalog entries: common layer

`TableCatalogEntry` is the base class for table-like entries.
It derives from `CatalogEntry`.

### Stored fields

- `std::string comment`
- `PropertyDefinitionCollection propertyCollection`

### Key API

- `getTableID()`
- `alter(...)`
- `isParent(...)`
- `getTableType()`
- `getComment()`
- `setComment(...)`
- `getScanFunction()`
- `getBoundScanInfo(...)`
- `getMaxColumnID()`
- `vacuumColumnIDs(...)`
- `getProperties()`
- `containsProperty(...)`
- `getPropertyID(...)`
- `getProperty(...)`
- `getColumnID(...)`
- `addProperty(...)`
- `dropProperty(...)`
- `renameProperty(...)`
- `serialize(...)`
- `copy()`
- `getBoundCreateTableInfo(...)`

### Important identity rule

`getTableID()` simply returns `oid`.
There is no separate table-id field.
The table id is the catalog OID.

### Property storage

The property-definition collection centralizes:

- property ids
- column ids
- property definitions

This lets both node and relationship group entries share common property metadata handling.

## `NodeTableCatalogEntry`

This is the catalog entry for node tables.

### Stored fields

- `primaryKeyName`
- `storage`
- `StorageFormat storageFormat`
- `std::optional<TableFunction> scanFunction`
- `CreateBindDataFunc createBindDataFunc`
- `foreignDatabaseName`
- `TableCatalogEntry* referencedEntry`

### Constructor families

There are three constructor flavors:

1. ordinary node table
2. foreign-backed table
3. shadow table

That is already a strong sign that node tables are used for both native and extension-backed storage flows.

### Important methods

- `getPrimaryKeyName()`
- `getPrimaryKeyID()`
- `getPrimaryKeyDefinition()`
- `getStorage()`
- `getStorageFormat()`
- `getScanFunction()`
- `getCreateBindDataFunc()`
- `getForeignDatabaseName()`
- `setReferencedEntry(...)`
- `getReferencedEntry()`
- `setForeignDatabaseName(...)`
- `getBoundScanInfo(...)`
- `renameProperty(...)`
- `serialize(...)`
- `deserialize(...)`
- `copy()`
- `toCypher(...)`

### Foreign-backed node tables

The foreign-table constructor stores:

- a scan function
- a bind-data factory callback
- optional foreign database name

This design avoids making core catalog code depend on extension-specific bind-data types.
The callback lets extensions recreate bind data lazily.

### Shadow tables

A special constructor takes `ShadowTag`.
It stores the foreign database name without a scan function.
This is part of LadybugDB's foreign/shadow-table story.

## `RelGroupCatalogEntry`

This is the catalog entry for relationship groups.
It represents a family of relationship tables, not just one physical edge table.

### Stored fields

- `srcMultiplicity`
- `dstMultiplicity`
- `storageDirection`
- `std::vector<RelTableCatalogInfo> relTableInfos`
- `storage`
- `StorageFormat storageFormat`
- optional `scanFunction`
- optional shared `scanBindData`
- `foreignDatabaseName`

### `RelTableCatalogInfo`

Each child relationship-table info stores:

- `NodeTableIDPair nodePair`
- `oid`

So the group entry knows the source/destination node-table pairs and the OIDs reserved for those pair-specific rel tables.

### Special property offset rule

The constructor initializes `propertyCollection` with `1`.
The comment says this skips the `NBR_NODE_ID` column as the first one.
That is a very implementation-specific relationship-table detail.

### Important methods

- `isParent(tableID)`
- `getTableType()` -> `REL`
- `getMultiplicity(direction)`
- `isSingleMultiplicity(direction)`
- `getStorageDirection()`
- `getStorage()`
- `getStorageFormat()`
- `getScanFunction()`
- `getScanBindData()`
- `getForeignDatabaseName()`
- `getNumRelTables()`
- `getRelEntryInfos()`
- `getSingleRelEntryInfo()`
- `getRelEntryInfo(src, dst)`
- `getSrcNodeTableIDSet()`
- `getDstNodeTableIDSet()`
- `getBoundNodeTableIDSet(direction)`
- `getNbrNodeTableIDSet(direction)`
- `getRelDataDirections()`
- `addFromToConnection(src, dst, oid)`
- `dropFromToConnection(src, dst)`
- `serialize(...)`
- `deserialize(...)`
- `toCypher(...)`
- `copy()`

### Storage direction note

The header contains a TODO comment:

- "Avoid using extend direction for storage direction"

So current code intentionally reuses `ExtendDirection` as the storage-direction enum even though that is conceptually not ideal.

## Table creation in `Catalog`

### Entry dispatch

`Catalog::createTableEntry(...)` dispatches on `BoundCreateTableInfo.type`.
Current supported cases are:

- `NODE_TABLE_ENTRY`
- `REL_GROUP_ENTRY`

### Node-table creation

The node-table creation path constructs the node entry, adds properties, sets parent flag, creates an internal serial sequence when needed, inserts into the correct table set, and returns the new entry.

### Relationship-group creation

The rel-group path is more specialized.
It:

1. inspects `BoundExtraCreateRelTableGroupInfo`
2. prebuilds `RelTableCatalogInfo` entries from node pairs, reserving OIDs via `tables->getNextOID()`
3. constructs the `RelGroupCatalogEntry`
4. adds property definitions
5. sets `hasParent`
6. creates serial sequence(s) if needed
7. inserts into `tables` or `internalTables`
8. returns the inserted entry via name lookup

That reservation of child rel-table OIDs before the group entry itself is important for deterministic metadata creation.

## Table lookup helpers in `Catalog`

### `containsTable(transaction, name, useInternal)`

Checks user tables first.
If not found and `useInternal` is true, checks internal tables.

### `containsTable(transaction, tableID, useInternal)`

Looks up by OID in user tables, then internal tables if requested.

### `getTableCatalogEntry(transaction, tableID)`

Searches user tables first.
Then internal tables.
Throws `RuntimeException` if no match exists.

### `getTableCatalogEntry(transaction, tableName, useInternal)`

If user tables do not contain the name:

- throws `CatalogException` if `useInternal` is false
- otherwise fetches from internal tables

### `getNodeTableEntries(...)`

Returns only visible node tables.
Can optionally include internal tables.

### `getRelGroupEntries(...)`

Returns only visible relationship-group entries.
Can optionally include internal tables.

### `getTableEntries(...)`

Returns all visible table entries from user tables and optionally internal tables.

## Table alteration

`Catalog::alterTableEntry(...)` forwards to `tables->alterTableEntry(...)`.
The interesting logic is inside `CatalogSet`.

### Supported alter kinds in the current switch

- `RENAME`
- `COMMENT`
- `ADD_PROPERTY`
- `DROP_PROPERTY`
- `RENAME_PROPERTY`
- `ADD_FROM_TO_CONNECTION`
- `DROP_FROM_TO_CONNECTION`

### Rename semantics

Rename is treated as drop-plus-create.
The implementation comment says this directly.

Actual flow:

1. fetch visible current entry
2. call `tableEntry->alter(...)` to build the new entry
3. `dropEntryNoLock(oldName, oldOID)`
4. `createEntryNoLock(newEntry)`
5. push alter undo record
6. push create/drop undo record for the create side, optionally skipping WAL logging

Rename therefore produces a different version-chain shape than non-rename alter operations.

### Non-rename alter semantics

For comment/property/connection edits:

1. build new entry with `alter(...)`
2. `emplaceNoLock(newEntry)` directly over the current head
3. push alter undo record

That means these alter operations create a new version in the same name chain.

## Table drop helpers in `Catalog`

`Catalog` offers several drop entry points.

### `dropTableEntryAndIndex(transaction, name)`

This is the high-level helper.
It:

1. resolves the table id
2. drops all indexes on that table
3. drops the table entry itself

### `dropTableEntry(transaction, tableID)`

Resolves the entry by id and forwards.

### `dropTableEntry(transaction, entry)`

Performs two actions:

1. `dropSerialSequence(...)`
2. drops from either `tables` or `internalTables` depending on where the visible entry currently lives

So dropping a table is also responsible for cleaning up auto-generated serial sequence metadata.

## Sequences

`SequenceCatalogEntry` models SQL-style sequences and serial backing objects.

### Stored state

The payload is a `SequenceData` struct containing:

- `usageCount`
- `currVal`
- `increment`
- `startValue`
- `minValue`
- `maxValue`
- `cycle`

There is also:

- `std::mutex mtx`

### Concurrency model

Sequence value advancement is protected by the sequence's own mutex.
This is separate from catalog-set locking.
The catalog protects metadata versioning.
The sequence entry protects mutable sequence value state.

### Important methods

- `getSequenceData()`
- `currVal()`
- `nextKVal(transaction, count)`
- `nextKVal(transaction, count, resultVector)`
- `rollbackVal(usageCount, currVal)`
- `serialize(...)`
- `deserialize(...)`
- `toCypher(...)`
- `getBoundCreateSequenceInfo(...)`
- `getSerialName(tableName, propertyName)`

### Serial naming convention

Auto-generated serial sequence names are:

- `<table>_<property>_serial`

That naming rule is encoded in `getSerialName(...)`.

### Catalog-level sequence operations

`Catalog` exposes:

- `containsSequence(...)`
- `getSequenceEntry(name, useInternalSeq)`
- `getSequenceEntry(sequenceID)`
- `getSequenceEntries()`
- `createSequence(...)`
- `dropSequence(name)`
- `dropSequence(sequenceID)`

### Internal vs user sequence lookup

Lookup by name checks user sequences first and then internal sequences if `useInternalSeq` is true.
Lookup by OID checks internal sequences first and then user sequences.

That asymmetry is an implementation detail worth remembering.

## Types

`TypeCatalogEntry` is a simple wrapper around a named `LogicalType`.

### Stored state

- inherited catalog-entry metadata
- `LogicalType type`

### Important methods

- `getLogicalType()`
- `serialize(...)`
- `deserialize(...)`

### Catalog-level type operations

`Catalog` exposes:

- `containsType(...)`
- `getType(...)`
- `createType(...)`

`createType(...)` is idempotent in one narrow sense:

- if the name already exists in the type set, it returns immediately

### Built-in types registered today

`registerBuiltInTypes()` currently registers exactly one built-in named type entry:

- `JSON`

That is far more specific than many readers expect.
Most built-in scalar types are handled by the logical-type parser rather than by explicit catalog entries.
JSON is the exception currently inserted into the type catalog at startup.

### Missing-type error enrichment

If `Catalog::getType(...)` cannot find a type, it consults `ExtensionManager::lookupExtensionsByTypeName(...)`.
If an extension advertises the type name, the error message tells the user to:

- `INSTALL <extension>;`
- `LOAD EXTENSION <extension>;`

So type errors are extension-aware.

## Functions

`FunctionCatalogEntry` stores a `function_set`.
It does **not** serialize.
The class comment says built-in functions are always registered while initializing the catalog.

### Stored state

- inherited catalog-entry metadata
- `function::function_set functionSet`

### Function namespaces

There are three relevant containers:

- `functions`
- `internalFunctions`
- `macros`

### Catalog-level function operations

`Catalog` exposes:

- `containsFunction(...)`
- `getFunctionEntry(...)`
- `getFunctionEntries()`
- `addFunction(...)`
- `dropFunction(...)`

### `getFunctionEntry(...)`

Lookup order is:

1. `functions`
2. `macros`
3. `internalFunctions` if requested
4. otherwise throw

So macros are conceptually part of the function name resolution surface even though they live in a separate set.

### Function registration at startup

`registerBuiltInFunctions()`:

1. gets `FunctionCollection::getFunctions()`
2. iterates until `.name == nullptr`
3. obtains each function set from its registration callback
4. inserts a `FunctionCatalogEntry` into `functions` using `DUMMY_TRANSACTION`

That means built-ins are registered as ordinary catalog entries, but in the user-function set and under an always-visible dummy transaction.

### Function existence errors

If a function is missing, `Catalog` consults `ExtensionManager::lookupExtensionsByFunctionName(...)` and may append an install/load hint just like the type path does.

### Why built-ins go to `functions` and not `internalFunctions`

The current implementation of `registerBuiltInFunctions()` inserts into `functions`, not `internalFunctions`.
That is a concrete implementation detail of the current source.
Do not assume built-ins are always stored in the internal-function set.

### How extensions populate `FunctionCatalogEntry`

Extension function registration goes through `src/include/extension/extension.h`, not through a separate extension-only catalog class.
The key template is `extension::addFunc<T>(...)`:

1. fetch `database.getCatalog()`
2. call `catalog->containsFunction(&DUMMY_TRANSACTION, name, isInternal)`
3. if absent, call `catalog->addFunction(&DUMMY_TRANSACTION, functionType, name, T::getFunctionSet(), isInternal)`

`Catalog::addFunction(...)` then does exactly one catalog thing:

- allocate a `FunctionCatalogEntry(entryType, name, functionSet)`
- insert it into either `functions` or `internalFunctions`

So `FunctionCatalogEntry` is populated by extensions in the same shape as built-ins:

- `entryType` comes from the helper used by the extension
- `name` is usually `T::name`
- `functionSet` comes entirely from `T::getFunctionSet()`

`ExtensionUtils` provides the public wrappers that choose the catalog-entry discriminator:

- `addScalarFunc<T>()` -> `SCALAR_FUNCTION_ENTRY`
- `addTableFunc<T>()` -> `TABLE_FUNCTION_ENTRY`
- `addStandaloneTableFunc<T>()` -> `STANDALONE_TABLE_FUNCTION_ENTRY`
- `addInternalStandaloneTableFunc<T>()` -> `STANDALONE_TABLE_FUNCTION_ENTRY` in `internalFunctions`
- `addExportFunc<T>()` -> `COPY_FUNCTION_ENTRY`

Concrete load paths from the extension submodule:

- `FtsExtension::load(...)` registers `STEM`, `TOKENIZE`, `QUERY_FTS_INDEX`, `CREATE_FTS_INDEX`, internal `_CREATE_FTS_INDEX`, `DROP_FTS_INDEX`, and internal `_DROP_FTS_INDEX`
- `VectorExtension::load(...)` registers `QUERY_VECTOR_INDEX`, `CREATE_VECTOR_INDEX`, internal `_CREATE_HNSW_INDEX`, internal `_FINALIZE_HNSW_INDEX`, internal `_DROP_HNSW_INDEX`, and `DROP_VECTOR_INDEX`
- `JsonExtension::load(...)` registers JSON scalar/copy/table functions but explicitly does **not** re-register the JSON type itself because that type is now built into core

### What actually lives inside the extension-supplied `function_set`

A `function_set` is just `std::vector<std::unique_ptr<Function>>`.
Extensions fill it with normal engine function objects.
Examples from the current tree:

- `StemFunction::getFunctionSet()` builds a `ScalarFunction` with `STRING, STRING -> STRING`
- `CreateVectorIndexFunction::getFunctionSet()` builds a `TableFunction`, wires bind/shared/local/rewrite callbacks, and returns it as a one-entry set
- many JSON functions return a one-entry scalar overload set, but the container shape allows multiple overloads under one catalog name

That is why the catalog does not need any extension-specific `FunctionCatalogEntry` subclass.
All extension variability is already encoded in the ordinary `Function` objects stored in the `function_set`.

## Scalar macros

`ScalarMacroCatalogEntry` stores:

- inherited metadata
- `std::unique_ptr<ScalarMacroFunction> macroFunction`

### Catalog-level macro operations

`Catalog` exposes:

- `containsMacro(...)`
- `addScalarMacroFunction(...)`
- `getScalarMacroCatalogEntry(macroID)`
- `dropMacroEntry(macroID)`
- `dropMacroEntry(entry)`
- `getScalarMacroFunction(name)`
- `getMacroNames()`
- `dropMacro(name)`

### Macro lookup by OID bug-shaped detail

`getScalarMacroCatalogEntry(macroID)` currently calls `functions->getEntryOfOID(...)` and then casts to `ScalarMacroCatalogEntry`.
Because macros are stored in the `macros` set, this is a detail worth double-checking when debugging macro-by-OID paths.
The implementation is source-authoritative even if it looks surprising.

### Serialization

Unlike built-in function entries, scalar macro entries do serialize.
That is why the macros set is included in top-level catalog serialization.

## Indexes

`IndexCatalogEntry` represents index metadata.
It derives directly from `CatalogEntry`, not from `TableCatalogEntry`.

### Stored fields

- `std::string type`
- `table_id_t tableID`
- `std::string indexName`
- `std::vector<property_id_t> propertyIDs`
- `std::unique_ptr<uint8_t[]> auxBuffer`
- `std::unique_ptr<IndexAuxInfo> auxInfo`
- `uint64_t auxBufferSize`

### Internal name rule

The catalog key is not the user-visible index name alone.
`IndexCatalogEntry::getInternalIndexName(tableID, indexName)` formats it as:

- `"<tableID>_<indexName>"`

This allows different tables to reuse the same user-visible index name without a namespace collision.

### Loaded vs unloaded index metadata

`IndexCatalogEntry::isLoaded()` returns:

- `auxBuffer == nullptr`

This means:

- loaded index metadata uses parsed `auxInfo`
- unloaded metadata still holds raw auxiliary bytes and awaits extension-driven reconstruction

### Auxiliary metadata design

`IndexAuxInfo` is a polymorphic hook for index-specific metadata.
It provides:

- `serialize()`
- `copy()`
- `toCypher(...)`
- `getTableEntryToExport(...)`

`BuiltinIndexAuxInfo` is the concrete built-in implementation currently visible in the header.

### Serialization behavior

The header comment explains index serialization clearly:

- base fields are written first
- then auxiliary-data size
- then auxiliary-data payload

During deserialization:

- raw auxiliary bytes are kept in `auxBuffer`
- once the corresponding extension is loaded, indexes can be reconstructed from that auxiliary buffer

### How extension index catalog entries work in practice

The vector and FTS extensions show the full pattern.
Neither extension subclasses `IndexCatalogEntry`.
Instead they create an ordinary `IndexCatalogEntry` whose broad catalog type is still `INDEX_ENTRY`, but whose `type` string and aux-info payload are extension-defined.

FTS creation does this explicitly:

- build `std::make_unique<catalog::IndexCatalogEntry>(FTSIndexCatalogEntry::TYPE_NAME, ...)`
- pass `std::make_unique<FTSIndexAuxInfo>(ftsConfig)` as aux info
- register the runtime storage flavor separately with `ExtensionUtils::registerIndexType(db, FTSIndex::getIndexType())`

Vector/HNSW follows the same split:

- the stored catalog entry uses `HNSWIndexCatalogEntry::TYPE_NAME`
- the aux payload is `HNSWIndexAuxInfo`
- the storage manager learns the runtime loader via `OnDiskHNSWIndex::getIndexType()` and `registerIndexType(...)`

After recovery or database reopen, both extensions perform the same rehydration loop in `load(...)`:

1. iterate `catalog.getIndexEntries(...)`
2. filter by `indexEntry->getIndexType() == "FTS"` or `"HNSW"`
3. require `!indexEntry->isLoaded()`
4. deserialize the aux buffer into the extension-specific `IndexAuxInfo`
5. find the matching storage-side unloaded index in the node table
6. call `load(...)` on the storage-side index holder

This is the key architectural point:

- catalog persistence is generic and extension-agnostic
- extension identity is carried by the `type` string plus aux bytes
- extension runtime reconstruction happens only when that extension is loaded

### Catalog-level index operations

`Catalog` exposes:

- `createIndex(...)`
- `getIndex(tableID, indexName)`
- `getIndexEntries()`
- `getIndexEntries(tableID)`
- `containsIndex(tableID, indexName)`
- `containsIndex(tableID, propertyID)`
- `containsUnloadedIndex(tableID, propertyID)`
- `dropAllIndexes(tableID)`
- `dropIndex(tableID, indexName)`
- `dropIndex(indexOID)`

### `containsUnloadedIndex(...)`

This helper scans visible index entries for a given table and property id and returns true if any matching index exists whose metadata is not loaded yet.
That is a subtle recovery/export integration hook.

## Graph entries

`GraphCatalogEntry` is simple but important.

### Stored fields

- inherited metadata
- `bool isAnyGraph`

### Important methods

- `isAnyGraphType()`
- `serialize(...)`
- `deserialize(...)`
- `toCypher(...)`

### Catalog-level graph operations

`Catalog` exposes:

- `containsGraph(...)`
- `getGraphEntry(...)`
- `getGraphEntries()`
- `createGraph(name, isAnyGraph)`
- `dropGraph(name)`

The `isAnyGraph` flag is how the catalog distinguishes ordinary named graph entries from the special any-graph case.

## Property-definition collection

`TableCatalogEntry` relies on `PropertyDefinitionCollection` for property management.
Even though that class is not itself a catalog entry, it is essential to table metadata.

### What it manages

- ordered property definitions
- property-name lookup
- property-id lookup
- column-id lookup

### Why it matters

Several seemingly simple `TableCatalogEntry` methods are thin wrappers over this collection:

- `containsProperty(...)`
- `getPropertyID(...)`
- `getProperty(...)`
- `getColumnID(...)`
- `addProperty(...)`
- `dropProperty(...)`
- `renameProperty(...)`

So if table property metadata behaves oddly, the problem may be below the catalog entry class itself.

## Undo-buffer integration

After successful set-level create or drop operations, `CatalogSet` checks:

- `transaction->shouldAppendToUndoBuffer()`

If true, it records undo metadata through transaction helpers such as:

- `pushCreateDropCatalogEntry(...)`
- `pushAlterCatalogEntry(...)`

The catalog therefore participates in transaction rollback just like the storage layer.

## WAL integration by implication

Catalog serialization itself is not the WAL.
However catalog DDL changes interact with WAL and undo-buffer logging through transaction machinery.
The rename alter path even uses a `skipLoggingToWAL` flag for one of its undo-buffer calls.
So the catalog is not an isolated metadata island.
It is transaction-aware and recovery-aware.

## Built-in vs user-visible persistence behavior

It is useful to group entries by persistence behavior.

### Persisted normally

- node tables
- relationship groups
- sequences
- named types
- indexes
- macros
- internal tables
- internal sequences
- graphs

### Recreated at startup rather than serialized

- built-in functions / function entries

### Explicitly skipped by set serializer

- function entry kinds in general
- foreign table entries

### Never serialized

- dummy entries

## Snapshot vs latest-committed export

There are two distinct serialization modes.

### `serialize(...)`

Exports the latest committed, non-deleted, serializable heads.
Good mental model:

- "current durable catalog"

### `serializeSnapshot(snapshotTS)`

Exports the versions visible to a transaction snapshot timestamp.
Good mental model:

- "catalog as of snapshot X"

This difference matters whenever concurrent DDL and checkpoint/export interactions are involved.

## Error-message patterns

The catalog surface contains several recurring error-message styles.
Knowing them helps trace which layer threw.

### Raw `CatalogSet` messages

- `X does not exist in catalog.`
- `X already exists in catalog.`
- `Write-write conflict on creating catalog entry with name X.`
- `Catalog entry with name X already exists.`

### Higher-level table/function/type messages

- `function X does not exist.` plus extension hints
- `X is neither an internal type nor a user defined type.` plus extension hints
- `Cannot find table catalog entry with id X.`
- `Index with OID X does not exist.`

The source of the message often tells you whether the failure happened in generic set logic or in type/function/table-specific wrapper logic.

## End-to-end object flows

### Creating a node table

1. binder produces `BoundCreateTableInfo`
2. catalog dispatches to node-table creation
3. entry object is constructed
4. property definitions are attached
5. parent flag is copied
6. serial sequence may be auto-created
7. entry is inserted into `tables` or `internalTables`
8. entry is visible only to the creating transaction until commit

### Creating a relationship group

1. binder produces rel-group extra info
2. node-table pairs are inspected
3. child relationship-table OIDs are reserved up front
4. group entry is constructed
5. `NBR_NODE_ID` column offset rule is applied implicitly by property collection init
6. properties are attached
7. serial support is created if needed
8. group entry is inserted into the proper set

### Dropping a table

1. table lookup resolves visible entry
2. indexes are dropped if using the high-level helper
3. serial sequence is dropped
4. a tombstone head is inserted
5. older transactions continue seeing the old entry version
6. newer transactions see the name as deleted

### Renaming a table

1. visible current entry is fetched
2. `alter(...)` builds a renamed copy
3. old name gets a tombstone head
4. new name gets a created head with its own chain
5. undo records are created for both alter and create/drop aspects

### Creating a user-defined type

1. name existence check in `types`
2. if already present, the call returns without error
3. otherwise a `TypeCatalogEntry` is inserted

### Registering built-in functions

1. function registry is enumerated
2. each entry produces a `function_set`
3. a `FunctionCatalogEntry` is inserted using `DUMMY_TRANSACTION`
4. entries are not serialized later because they are recreated during startup

### Loading extension functions and indexes

1. extension shared library calls its `load(ClientContext*)` entrypoint
2. the extension's `load(...)` method calls `ExtensionUtils::add*Func(...)`
3. each helper turns `T::getFunctionSet()` into a `FunctionCatalogEntry`
4. public functions land in `functions`; internal helpers land in `internalFunctions`
5. index-oriented extensions also call `ExtensionUtils::registerIndexType(...)` so the storage manager knows the runtime loader for `"FTS"` or `"HNSW"`
6. vector/FTS then scan existing `IndexCatalogEntry` rows, deserialize aux buffers, and re-load previously persisted extension indexes

So extension loading is not just "register new SQL names".
For index extensions it is also the moment where generic catalog metadata becomes a live storage index again.

## Important implementation asymmetries

A few asymmetries are easy to miss.

### Name lookup vs OID lookup costs

- name lookup is map-based
- OID lookup is scan-based

### User vs internal lookup order differs by API

- table lookup by name: user first, internal second when allowed
- sequence lookup by OID: internal first, user second
- function lookup by name: user functions, then macros, then internal functions when allowed

### Rename uses two chains, not one

A rename is modeled as:

- drop old name
- create new name

Not as a single same-name chain update.

### Graph entries have their own namespace

Graphs do not live in the table namespace.
That matters when tracing graph-loading and graph-catalog resolution logic.

## Checklist for reading a catalog bug

If you need to debug a catalog issue, a good reading order is:

1. `catalog.h`
2. `catalog.cpp`
3. `catalog_set.h`
4. `catalog_set.cpp`
5. the relevant entry subclass header and cpp
6. `transaction.h` for timestamp semantics
7. serializer/deserializer helpers if persistence is involved

Then ask these questions in order:

- Which catalog set owns the object?
- Is the lookup by name or by OID?
- Is the caller allowed to see internal objects?
- Which transaction snapshot is in play?
- Is the current head deleted?
- Is there a write-write conflict?
- Is the object serializable or recreated at startup?
- Is the object using extension-aware error messaging?

## Summary

The catalog implementation is built from a small number of strong ideas:

- each namespace is a `CatalogSet`
- each named object is a `CatalogEntry`
- schema MVCC is implemented with per-name version chains
- deletions are modeled by tombstone heads, not eager removal
- internal objects live in a separate OID range
- built-in functions are registered at startup instead of serialized
- table, sequence, index, macro, type, and graph metadata each have dedicated entry subclasses

The single most important file for the subsystem is `catalog_set.cpp`.
The single most important conceptual rule is:

- **the map head is not necessarily what every transaction sees**

Every schema read must pass through version-chain visibility.
That is the central invariant of LadybugDB's catalog.

## Appendix A: field-by-field quick reference

### `Catalog`

- owns ten `CatalogSet` objects
- owns version counters
- owns optional storage-manager pointer used by graph/db integration flows
- routes lookups across user/internal namespaces
- routes creation to the correct entry subclass
- serializes sets in a fixed order

### `CatalogSet`

- owns case-insensitive name map
- owns OID allocator
- owns schema-version chain heads
- provides read/write locking
- provides snapshot traversal
- provides serialization filtering

### `CatalogEntry`

- stores identity and version metadata
- links older and newer versions
- supports serialization polymorphism
- supports `toCypher()` polymorphism where implemented

### `TableCatalogEntry`

- adds comments and properties
- uses OID as table id
- supports alter/copy/create-info conversion

### `NodeTableCatalogEntry`

- stores primary-key name
- stores native-storage hints
- stores optional foreign scan function and bind-data factory
- stores optional referenced entry

### `RelGroupCatalogEntry`

- stores multiplicities
- stores storage direction
- stores per-node-pair rel-table infos
- offsets properties because of hidden neighbor-node column semantics

### `SequenceCatalogEntry`

- stores mutable sequence data plus mutex
- supports batch next-value materialization
- supports rollback of allocated range metadata

### `FunctionCatalogEntry`

- stores overload set
- not serialized

### `TypeCatalogEntry`

- stores a named `LogicalType`
- serialized normally

### `ScalarMacroCatalogEntry`

- stores macro function object
- serialized normally

### `IndexCatalogEntry`

- stores table-scoped internal name
- stores property ids
- stores polymorphic aux info or raw aux buffer
- can represent unloaded extension indexes

### `GraphCatalogEntry`

- stores graph name plus any-graph flag

### `DummyCatalogEntry`

- deleted from construction time
- timestamp `0`
- never serialized
- used to model tombstones and chain scaffolding

## Appendix B: exact set serialization skip list

Entries skipped by `CatalogSet::serialize()` and `serializeSnapshot()`:

- scalar function entries
- rewrite function entries
- aggregate function entries
- copy function entries
- table function entries
- standalone table function entries
- foreign table entries

Everything else is serialized only if the selected version is visible and not deleted.

## Appendix C: exact top-level set order again

When in doubt, the set order is:

1. tables
2. sequences
3. functions
4. types
5. indexes
6. macros
7. internalTables
8. internalSequences
9. internalFunctions
10. graphs

That order appears in:

- `Catalog::serialize()`
- `Catalog::serializeSnapshot()`
- `Catalog::deserialize()`

## Appendix D: quick MVCC rules in one screen

- newest map head is only a candidate
- current transaction sees entries whose timestamp equals its transaction id
- otherwise it sees entries whose timestamp is committed and `<= startTS`
- deleted visible heads hide the name
- older versions remain chained for old snapshots
- create uses current transaction id timestamp
- drop uses tombstone with current transaction id timestamp
- rename is drop-old-name plus create-new-name
- committed-entry serialization walks backward until it finds a committed version

## Appendix E: quick namespace list in one screen

- user tables
- user sequences
- user functions
- user types
- indexes
- macros
- internal tables
- internal sequences
- internal functions
- graphs

## Appendix F: exact extension-aware error hooks

The catalog checks extension registries for:

- missing types via `lookupExtensionsByTypeName(...)`
- missing functions via `lookupExtensionsByFunctionName(...)`

If a match is found, the error message tells the user to install and load that extension.

## Appendix G: exact internal OID fact

Internal catalog sets start OIDs at:

- `1 << 63`

This fact is fundamental to understanding why system metadata can coexist with user-created metadata without OID collision.
