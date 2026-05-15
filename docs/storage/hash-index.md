# Hash Index

**Source files:** `src/storage/index/hash_index.cpp`, `src/storage/index/in_mem_hash_index.cpp`, `src/include/storage/index/hash_index.h`, `src/include/storage/index/hash_index_slot.h`

## Purpose

The `HashIndex` is the primary key index for node tables. It maps a key (e.g., a string or integer primary key) to a `node_offset_t` — the row position in the node table. It is the single path for point lookups on primary keys.

## CREATE INDEX DDL

By default, every node table's primary key column automatically gets a hash index at table creation time (controlled by `enable_default_hash_index`, which defaults to `true`). Additional hash indexes can be created explicitly with `CREATE INDEX`:

```cypher
-- Default form (creates a HASH index)
CREATE INDEX idx_name [IF NOT EXISTS] FOR (p:TableName) ON (p.propertyName)

-- Explicit HASH form (identical behaviour)
CREATE HASH INDEX idx_name [IF NOT EXISTS] FOR (p:TableName) ON (p.propertyName)
```

**`IF NOT EXISTS` semantics:**
- Without `IF NOT EXISTS`: throws a `BinderException` if an index with that name already exists on the table.
- With `IF NOT EXISTS`: returns `"Index idx_name already exists."` and is a no-op — safe for idempotent scripts.

**Example:**

```cypher
CREATE NODE TABLE person(id INT64, name STRING, PRIMARY KEY(id));
-- PK index created automatically (enable_default_hash_index=true)

-- Create an explicit index on a non-PK property (when supported)
CREATE HASH INDEX idx_person_name IF NOT EXISTS FOR (p:person) ON (p.name);
```

**`SHOW_INDEXES()` — inspect existing indexes:**

```cypher
CALL SHOW_INDEXES() RETURN table_name, index_name, property_names;
-- idx_person|idx_person_pk|[id]
```

**Disabling automatic PK indexes:**

```cypher
CALL enable_default_hash_index=false;
CREATE NODE TABLE person(id INT64, name STRING, PRIMARY KEY(id));
-- No index created automatically; add one explicitly when needed
```

The DDL flow goes through the full binder → planner → executor pipeline:
`ParseCreateIndex` → `BoundCreateIndex` → `LogicalCreateIndex` → `CreateIndexPhysicalOperator` → `NodeTable::addIndex()`

## Dual-Layer Architecture

```
HashIndex<T>
├─ Persistent store    ← on-disk, buffer-managed DiskArray of slots
└─ Local store         ← in-memory InMemHashIndex (write-tx only)
     ├─ localInsertions   (new keys not yet checkpointed)
     └─ localDeletions    (keys deleted this transaction)
```

**Lookup path:**
1. Check `localDeletions` — if marked deleted, return not found
2. Check `localInsertions` — if found, return the local value
3. Fall through to persistent store — scan slot chain on disk

## Slot Structure

The persistent store is an array of **slots**. Each slot holds up to `FINGERPRINT_CAPACITY = 20` entries and a link to an overflow slot chain.

```cpp
// hash_index_slot.h
class SlotHeader {
    std::array<uint8_t, 20> fingerprints; // 1-byte hash fingerprints for fast rejection
    uint32_t  validityMask;               // bit i = 1 means entry i is occupied
    uint64_t  nextOvfSlotId;              // chained overflow slot (INVALID = end)
};

struct Slot<T> {
    SlotHeader header;
    Entry<T>   entries[FINGERPRINT_CAPACITY]; // key + value pairs
};
```

Each `Entry<T>` stores:
```cpp
struct Entry<T> {
    T        key;    // the primary key value (int64, string pointer, etc.)
    offset_t value;  // node offset in the node table
};
```

## Lookup Algorithm

```
lookup(key):
  fingerprint = hash(key) & 0xFF        // 8-bit fingerprint

  slotId = hash(key) % numSlots         // primary slot
  while slotId != INVALID:
    slot = readSlot(slotId)             // buffer-managed page read
    for each valid entry i in slot:
      if slot.header.fingerprints[i] == fingerprint:  // fast 1-byte check
        if slot.entries[i].key == key:                // full comparison only on match
          return slot.entries[i].value
    slotId = slot.header.nextOvfSlotId  // follow overflow chain
  return NOT_FOUND
```

::: tip Fingerprint optimization
The 1-byte fingerprint check avoids loading and comparing the full key for most entries. For a slot with 20 entries, typically only 1–2 will have a matching fingerprint, so full key comparisons are rare.
:::

## Insertion Algorithm

```
insert(key, value):
  1. Check localDeletions — remove the deletion mark if present
  2. Check localInsertions + persistent store — reject if key already exists
  3. Append (key, value) to localInsertions InMemHashIndex
     └─ InMemHashIndex uses a separate in-memory open-addressing table
        that gets merged to disk on checkpoint
```

## In-Memory Index (Bulk Load Path)

`InMemHashIndex` is used during:
- **Initial bulk load** via `COPY` statements
- **Write transaction** local insertions before checkpoint

It uses a simpler open-addressing table without overflow chains. On checkpoint, it gets serialized into the persistent slot array format.

```cpp
// in_mem_hash_index.h (simplified)
class InMemHashIndex<T> {
    std::vector<Entry<T>> slots;   // flat open-addressing table
    uint64_t numEntries;
    double   loadFactor;           // triggers resize when exceeded

    bool lookup(T key, offset_t& result);
    bool insert(T key, offset_t value);   // returns false if duplicate
    void flush(DiskArray& diskSlots);     // serialize to persistent format
};
```

## String Keys

String primary keys are not stored inline in slots — strings can be arbitrarily long. Instead:
- The string is stored in the **overflow file** (`OverflowFileHandle`)
- The slot entry stores a `string_t` (pointer + length) that points into the overflow file
- Comparisons dereference the pointer for full string equality

Template parameter `S` (stored type) differs from `T` (key type) for strings:
```cpp
// T = std::string_view  (lookup key type)
// S = string_t          (stored type, pointer into overflow file)
HashIndex<std::string_view>  // key type used in API
```

## Concurrent Access

The `HashIndex` uses a `std::shared_mutex`:
- **Read transactions**: `shared_lock` — multiple readers concurrently
- **Write transactions**: `unique_lock` acquired via `adoptLock()` at checkpoint

`tryLock()` is used for optimistic concurrent inserts during bulk load.

## Checkpoint & Rollback

```cpp
bool HashIndex::checkpoint(PageAllocator& pageAllocator):
  1. Merge localInsertions into persistent slot array
  2. Process localDeletions (mark slots invalid)
  3. Flush modified pages via ShadowFile

bool HashIndex::rollbackInMemory():
  1. Clear localInsertions
  2. Clear localDeletions
  // persistent store is untouched — shadow pages discarded
```

## Related Files

- `src/storage/index/hash_index.cpp` — main lookup/insert/delete logic
- `src/storage/index/hash_index_slot.h` — `SlotHeader`, `Entry`, fingerprint layout
- `src/storage/index/in_mem_hash_index.cpp` — bulk-load and local write index
- `src/storage/index/hash_index_utils.h` — hashing utilities, fingerprint computation
- `src/storage/index/hash_index_header.h` — on-disk header: slot count, capacity, level
