# Storage Backends

**Source files:** `src/storage/table/`, `src/include/storage/table/`

LadybugDB supports five storage backends for node and relationship tables. Every backend
implements the `NodeTable` or `RelTable` interface but differs in where data lives, how it
is organized on disk or in memory, whether MVCC applies, and how scan morsels are assigned
to parallel threads.

## Backend Summary

| Backend | Node class | Rel class | Data location | Mutable? | MVCC |
|---------|-----------|-----------|---------------|----------|------|
| **Native** | `NodeTable` | `RelTable` | LadybugDB columnar files | ✅ Full read/write | ✅ |
| **In-memory native** | `NodeTable` | `RelTable` | Same layout, no disk flush | ✅ Full read/write | ✅ |
| **Arrow** | `ArrowNodeTable` | `ArrowRelTable` | In-process Arrow RecordBatches | ❌ Read-only | ❌ |
| **Icebug-Disk** | `IceDiskNodeTable` | `IceDiskRelTable` | Parquet files (local or object store) | ❌ Read-only | ❌ |
| **Foreign** | — | `ForeignRelTable` | Another table function | ❌ Read-only | ❌ |

Read-only backends throw `RuntimeException` on `insert`, `update`, and `delete_` — enforced
in the `ColumnarNodeTableBase` and `ColumnarRelTableBase` base classes.

---

## Class Hierarchy

```
Table
├── NodeTable                              (native; also used for in-memory)
│   └── ColumnarNodeTableBase              (abstract; disables mutations)
│       ├── ArrowNodeTable
│       └── IceDiskNodeTable
└── RelTable                               (native)
    ├── ColumnarRelTableBase               (abstract; disables mutations)
    │   ├── ArrowRelTable
    │   └── IceDiskRelTable
    └── ForeignRelTable
```

`ColumnarNodeTableBase` and `ColumnarRelTableBase` implement the **Template Method** pattern:
subclasses must provide `getColumnarFormatName()`, `getNumBatches()`, `getTotalRowCount()`, and
for rel tables, the degree-query virtuals.

---

## Native Storage (default)

The default backend. All data is stored in LadybugDB's own columnar format
(see [Node Groups](./node-groups) and [CSR Adjacency Lists](./csr)).

### Creating native tables

```cypher
CREATE NODE TABLE person(id INT64, name STRING, age INT32, PRIMARY KEY(id));
CREATE REL TABLE knows(FROM person TO person, since INT32);
```

### Key properties

- Full **MVCC** — reads and writes are versioned (see [MVCC](../transaction/mvcc)).
- Compressed storage: BitPacking, RLE, Dictionary encoding per column chunk (see
  [Column Compression](./compression)).
- **WAL-backed** for crash durability (see [Shadow File & WAL](./shadow-wal)).
- **Morsel size** = one node group (default 131 072 rows), assigned atomically via
  `fetch_and_add` on a shared counter.
- Both FWD and BWD adjacency lists are stored as independent `RelTableData` objects in
  `directedRelData[0]` (FWD) and `directedRelData[1]` (BWD).

### In-Memory Mode

When the database is opened with an empty path or `:memory:`, the native backend skips all
WAL and shadow-file operations. Tables still use exactly the same columnar format in memory.

```cpp
Database db{""};  // empty path = in-memory
```

### Scan coordination for native node tables

`NodeTable::initializeScanCoordination` is a no-op (virtual default). The scan operator
drives node groups directly from an atomic row counter.

### Degree queries on native rel tables

`RelTable::getDegreeEntries` reads from `RelTableData::csrHeaderColumns.offset` and
`csrHeaderColumns.length` — two dedicated `Column` objects that store the CSR start-offset
and length per source node across all node groups. It iterates committed CSR node groups,
reads the header chunks, and returns `(offset, degree)` pairs.

`RelTable::getTopKDegrees` wraps the same data with a min-heap of capacity `k`.

---

## Arrow Backend

### Overview

Wraps one or more Arrow `RecordBatch` objects in-process via the **Arrow C Data Interface**
(`ArrowSchema` + `ArrowArray`). Used when data is already available as Arrow tables (e.g.,
DataFrame or Arrow IPC imports) and must be queried without a copy into Ladybug's native
columnar format.

**Source:** `src/include/storage/table/arrow_node_table.h`,
`src/storage/table/arrow_node_table.cpp`,
`src/include/storage/table/arrow_rel_table.h`,
`src/storage/table/arrow_rel_table.cpp`,
`src/include/storage/table/arrow_table_support.h`,
`src/storage/table/arrow_table_support.cpp`

### Registration flow

Arrow tables are registered through a global process-wide registry (`g_arrowRegistry`,
`g_arrowRelRegistry`) protected by `g_arrowRegistryMutex` in `arrow_table_support.cpp`.

```cpp
// Node table — C++ API
auto result = ArrowTableSupport::createViewFromArrowTable(
    connection, "myTable", std::move(schema), std::move(arrays));
// Emits: CREATE NODE TABLE myTable (...) WITH (storage='arrow://arrow_0')
```

```cpp
// Relationship table — FLAT layout
auto result = ArrowTableSupport::createRelTableFromArrowTable(
    connection, "myRels", "src", "dst",
    std::move(schema), std::move(arrays));

// Relationship table — CSR layout
auto result = ArrowTableSupport::createRelTableFromArrowCSR(
    connection, "myRels", "src", "dst",
    std::move(indicesSchema), std::move(indicesArrays),
    std::move(indptrSchema), std::move(indptrArrays));
```

The generated `storage='arrow://arrow_N'` URI is passed through the catalog into the storage
manager which looks up the ID in the registry to construct `ArrowNodeTable` or `ArrowRelTable`.

### Memory ownership model

The registry holds the **canonical copies** of `ArrowSchemaWrapper` and
`std::vector<ArrowArrayWrapper>` (with live `release` callbacks). Arrow-backed table objects
store **shallow copies** — `ArrowSchemaWrapper` and `ArrowArrayWrapper` instances with
`release = nullptr` — pointing into the same memory. The table does not own the Arrow memory;
the registry does. When the table is dropped (`DROP TABLE` or `unregisterArrowTable`), the
table's destructor calls `ArrowTableSupport::unregisterArrowData(arrowId)`, which erases the
registry entry and triggers the wrapper destructors' `release` callbacks.

```cpp
// arrow_node_table.cpp — destructor
ArrowNodeTable::~ArrowNodeTable() {
    if (!arrowId.empty()) {
        ArrowTableSupport::unregisterArrowData(arrowId);
    }
}
```

### Arrow wrappers

`ArrowSchemaWrapper` and `ArrowArrayWrapper` (defined in `src/include/common/arrow/arrow.h`)
extend the C structs with RAII move semantics. The move constructor nullifies `release` on
the source to prevent double-free. Copy operations are deleted.

`createShallowCopy()` produces a wrapper with `release = nullptr` — used to hand non-owning
references to table objects.

---

## ArrowNodeTable

### Constructor

```cpp
ArrowNodeTable(const StorageManager*, const NodeTableCatalogEntry*,
               MemoryManager*, ArrowSchemaWrapper schema,
               std::vector<ArrowArrayWrapper> arrays, std::string arrowId);
```

On construction, `batchStartOffsets` is populated by iterating `arrays` and calling
`getArrowBatchLength()`, which reads `array.length` if positive, otherwise falls back to
`array.children[0]->length`. `totalRows` is the cumulative sum.

### Scan coordination — `ArrowNodeTableScanSharedState`

```cpp
struct ArrowNodeTableScanSharedState final : ColumnarNodeTableScanSharedState {
    // Protected by mutex:
    std::vector<size_t> batchSizes;
    node_group_idx_t currentBatchIdx = 0;
    size_t currentMorselStartOffset = 0;
    const size_t morselSize; // = 2048
};
```

`getNextMorsel()` (called by the parallel scan operator) atomically claims a morsel:

```cpp
bool getNextMorsel(ColumnarNodeTableScanState* scanState) override {
    std::lock_guard<std::mutex> lock(mtx);
    while (currentBatchIdx < batchSizes.size()) {
        auto batchLength = batchSizes[currentBatchIdx];
        if (currentMorselStartOffset < batchLength) {
            arrowScanState->currentBatchIdx = currentBatchIdx;
            arrowScanState->currentMorselStartOffset = currentMorselStartOffset;
            arrowScanState->currentMorselEndOffset =
                std::min(currentMorselStartOffset + morselSize, batchLength);
            this->currentMorselStartOffset = arrowScanState->currentMorselEndOffset;
            return true;
        }
        this->currentBatchIdx++;
        this->currentMorselStartOffset = 0;
    }
    return false;
}
```

The morsel size is `2048` (constant `scanMorselSize` in `ArrowNodeTable`), not the native
node-group size of 131 072.

### `initScanState`

```cpp
void ArrowNodeTable::initScanState(Transaction*, TableScanState& scanState,
                                    bool resetCachedBoundNodeSelVec) const;
```

Sets `arrowScanState.scanCompleted = true` initially; only resets to `false` when source is
`COMMITTED` and `currentBatchIdx` is a valid batch index (previously assigned by a successful
`getNextMorsel` call). The `resetCachedBoundNodeSelVec` parameter is accepted but **not used**
— Arrow node tables do not carry a sel-vec cache (`[[maybe_unused]]` in the implementation).

### `scanInternal`

Per morsel:
1. Reads `batch = arrays[currentBatchIdx]`.
2. Calls `scanState.resetOutVectors()`.
3. Computes `outputSize = morselEnd - morselStart`.
4. Builds a global row offset `nextGlobalRowOffset = batchStartOffsets[batchIdx] + morselStart`.
5. Calls `NodeTable::applySemiMaskFilter` to apply any semi-mask over `[nextGlobalRowOffset,
   nextGlobalRowOffset + outputSize)`.
6. Calls `getOutputToArrowColumnIdx` to map each output column ID to an Arrow child index.
7. Calls `copyArrowMorselToOutputVectors` which for each column constructs an
   `ArrowNullMaskTree` and calls `ArrowConverter::fromArrowArray(childSchema, childArray,
   outputVector, &nullMask, childArray->offset + morselStart, 0, numRowsToCopy)`.
8. Writes node IDs `{tableID, nextGlobalRowOffset + i}` into `nodeIDVector`.

### `lookupPK`

Primary-key lookup performs a **linear scan** over all batches — no index. For each batch row,
it deserializes the PK value via `ArrowConverter::fromArrowArray` into a single-value
`ValueVector` and compares with the query key. Returns `batchStartOffsets[batchIdx] + rowIdx`
as the offset on a match.

### `isVisible` / `isVisibleNoLock`

Both simply check `offset < totalRows` — no MVCC versioning.

---

## ArrowRelTable

### Constructor parameters

```cpp
ArrowRelTable(RelGroupCatalogEntry*, table_id_t from, table_id_t to,
              const StorageManager*, MemoryManager*,
              const NodeTable* fromNodeTable, const NodeTable* toNodeTable,
              ArrowRelTableLayout layout,
              ArrowSchemaWrapper schema, std::vector<ArrowArrayWrapper> arrays,
              ArrowSchemaWrapper indptrSchema, std::vector<ArrowArrayWrapper> indptrArrays,
              std::string arrowId, std::string dstColumnName = "to");
```

Two layouts are supported:

| Layout | `ArrowRelTableLayout::FLAT` | `ArrowRelTableLayout::CSR` |
|--------|----------------------------|---------------------------|
| Data file | One `from`/`to` column per row | `indices` + `indptr` arrays |
| Column idx | `fromColumnIdx`, `toColumnIdx` | `csrNbrColumnIdx`, `csrIndptrColumnIdx` |
| `from`/`to` type check | must match node PK types | `to` column must be `UINT64` offsets |
| indptr required? | No | Yes |

For FLAT, the constructor validates that the `from` column type matches the source node's PK
type and `to` matches the destination PK type (string comparison via `LogicalType::toString()`).
For CSR, the neighbor column must be `UINT64` (raw node offsets) and the indptr column must also
be `UINT64`.

`propertyColumnToArrowColumnIdx` (an `unordered_map<column_id_t, int64_t>`) is built by
matching catalog property names against Arrow schema child names via `findColumnIdx`.

### `initScanState` and `cachedBoundNodeSelVec`

This is the most important method for understanding Arrow rel scan behavior.

```cpp
void ArrowRelTable::initScanState(Transaction*, TableScanState& scanState,
                                   bool resetCachedBoundNodeSelVec) const;
```

When `resetCachedBoundNodeSelVec = true` (the default, called at the start of each scan
operator invocation):

```cpp
if (relScanState.nodeIDVector->state->getSelVector().isUnfiltered()) {
    relScanState.cachedBoundNodeSelVector.setToUnfiltered();
} else {
    relScanState.cachedBoundNodeSelVector.setToFiltered();
    memcpy(relScanState.cachedBoundNodeSelVector.getMutableBuffer().data(),
        relScanState.nodeIDVector->state->getSelVector().getMutableBuffer().data(),
        relScanState.nodeIDVector->state->getSelVector().getSelSize() * sizeof(sel_t));
}
relScanState.cachedBoundNodeSelVector.setSelSize(
    relScanState.nodeIDVector->state->getSelVector().getSelSize());
```

The snapshot of the bound-node selection vector is taken once and preserved across multiple
`scanInternal` calls. This is important because the scan may be called iteratively (once per
active bound node group), and the original `nodeIDVector->state->getSelVector()` could be
modified between calls by the driving pipeline operator.

**Why it is a _snapshot_:** The Arrow scan processes all bound nodes in a single stateful
pass through the arrays. If the pipeline rebinds a new set of bound nodes after the first
`scanInternal` returns, a fresh `initScanState` call with `resetCachedBoundNodeSelVec = true`
takes a new snapshot. Calling with `false` preserves the old snapshot so subsequent calls for
the same logical "scan chunk" continue using the same bound-node set.

After copying the selection vector, `initScanState` builds an O(1)-lookup hash map:

```cpp
relScanState.arrowBoundNodeOffsetToSelPos.clear();
for (uint64_t i = 0; i < relScanState.cachedBoundNodeSelVector.getSelSize(); ++i) {
    auto boundNodeIdx = relScanState.cachedBoundNodeSelVector[i];
    const auto boundNodeID = relScanState.nodeIDVector->getValue<nodeID_t>(boundNodeIdx);
    relScanState.arrowBoundNodeOffsetToSelPos.emplace(boundNodeID.offset, boundNodeIdx);
}
```

`arrowBoundNodeOffsetToSelPos` maps `node_offset → sel_t_position_in_bound_vector`. This
is used in FLAT scan to check whether an edge's source (or dest, for BWD) is in the bound set
in O(1) instead of O(N) linear search.

### Arrow scan state fields

The `RelTableScanState` base class carries all Arrow-specific fields (so that a single
multi-rel scan state can cover native, icebug-disk, and Arrow tables seamlessly):

| Field | Type | Purpose |
|-------|------|---------|
| `arrowCurrentBatchIdx` | `size_t` | Current RecordBatch index (FLAT) |
| `arrowCurrentBatchOffset` | `size_t` | Current row within that batch (FLAT / BWD CSR) |
| `arrowCSRBoundIdx` | `size_t` | Position into `cachedBoundNodeSelVector` (FWD CSR) |
| `arrowCSRCurrentRelOffset` | `offset_t` | Current global rel offset within CSR range |
| `arrowBoundNodeOffsetToSelPos` | `unordered_map<offset_t, sel_t>` | Fast bound lookup |
| `arrowSrcKeyVector` | `unique_ptr<ValueVector>` | Single-value work buffer for src PK/offset |
| `arrowDstKeyVector` | `unique_ptr<ValueVector>` | Single-value work buffer for dst PK/offset |
| `arrowScanCompleted` | `bool` | Set when no more edges to return |

### FLAT scan — `scanFlat`

Iterates `arrays` row by row. For each row:
1. Reads `from` and `to` values into single-value `arrowSrcKeyVector` / `arrowDstKeyVector`.
2. Calls `fromNodeTable->lookupPK(...)` and `toNodeTable->lookupPK(...)` to translate PK
   values into node offsets (linear scan over node PK column inside each node table).
3. Determines `boundOffset = isFwd ? srcNodeOffset : dstNodeOffset`.
4. Looks up `boundOffset` in `arrowBoundNodeOffsetToSelPos`. If not found, skips.
5. Enforces single-active-bound constraint: once a `boundOffset` is active, if a different
   bound is encountered, stops and returns (the caller will re-enter for the next).
6. Copies property columns via `readSingleArrowValue` → `ArrowConverter::fromArrowArray`.

Returns `true` when at least one output row was produced; sets `arrowScanCompleted` when the
batch cursor reaches the end.

### CSR scan — `scanCSR`

**Forward direction (FWD):**

For each entry in `cachedBoundNodeSelVector`:
1. Calls `readIndptr(boundNode.offset, startOffset)` and `readIndptr(boundNode.offset + 1,
   endOffset)` to get the CSR range for that source node.
2. Iterates `arrowCSRCurrentRelOffset` from `startOffset` to `endOffset`.
3. For each rel offset, reads the neighbor offset from the indices array via `readCSRValue`
   (column `csrNbrColumnIdx`, UINT64 raw node offset).
4. Does **not** call `lookupPK` — neighbor offsets are already raw node offsets.
5. Copies properties via `readArrowValueAtOffset`.

**Why indptr eliminates flattening:** The CSR layout means each source node's edges are
contiguous in the indices array. The scan uses `readIndptr(i)` and `readIndptr(i+1)` as
direct start/end cursors. There is no need to check every edge row against a bound-node set
because the indptr array already partitions edges by source. FLAT format requires
`arrowBoundNodeOffsetToSelPos.find()` on every row; CSR format does not.

**Backward direction (BWD):**

Falls back to a full table scan: iterates all rows in `arrays`, reads the neighbor (dst)
offset, looks it up in `arrowBoundNodeOffsetToSelPos`. For BWD, `findCSRSourceOffset` is used
to locate the source node via binary search on the indptr array:

```cpp
// Binary search: find largest i such that indptr[i] <= relOffset
offset_t ArrowRelTable::findCSRSourceOffset(offset_t relOffset) const {
    offset_t low = 0, high = totalIndptrRows - 1;
    while (low + 1 < high) {
        const auto mid = low + (high - low) / 2;
        offset_t midValue = INVALID_OFFSET;
        if (!readIndptr(mid, midValue)) return INVALID_OFFSET;
        if (relOffset < midValue) high = mid;
        else low = mid;
    }
    // validate bounds
    ...
    return low;
}
```

### Degree queries on Arrow rel tables

Both Arrow layouts implement the `ColumnarRelTableBase` virtual degree interface:

| Method | CSR FWD | CSR BWD | FLAT |
|--------|---------|---------|------|
| `getActiveBoundNodeCount` | iterates `totalIndptrRows`, counts entries with `end > start` | `0` | `0` |
| `getAllDegreeEntries` | returns `(i, indptr[i+1]-indptr[i])` for all `i` with degree > 0 | `{}` | `{}` |
| `getTopKDegreeEntries` | min-heap of capacity `k` over the indptr array | `{}` | `{}` |

All three read the indptr via `readIndptr(i, value)` which calls `readArrowValueAtOffset` on
the `indptrSchema`/`indptrArrays`/`indptrBatchStartOffsets`. Each call traverses the batch
vector to find the containing batch (O(num_batches) per read).

**Contrast with native:** native `RelTable::getDegreeEntries` reads `csrHeaderColumns` which
are dedicated `Column` objects backed by disk pages — random access by page ID. Arrow reads
each indptr value by iterating over `indptrArrays` batches from the start.

---

## Icebug-Disk Backend

### Overview

Stores graph data as Parquet files. Two Parquet files encode a relationship table in CSR
format; a single Parquet file encodes a node table. Designed for large read-only analytical
graphs served from local disk or object storage.

See the dedicated **[Icebug-Disk Format](./icebug-disk)** page for file naming conventions,
schema requirements, version compatibility, and per-method deep-dives.

### IceDiskNodeTable

```cpp
class IceDiskNodeTable final : public ColumnarNodeTableBase {
    std::string parquetFilePath;
    mutable std::atomic<row_idx_t> cachedRowCount{INVALID_ROW_IDX};
    // per-state: unique_ptr<ParquetReader> parquetReader (thread-safe)
};
```

- `getNumBatches` creates a temporary `ParquetReader` and returns `getNumRowGroups()`.
- `getTotalRowCount` creates a temporary reader, reads `metadata->num_rows`, and caches the
  result in `cachedRowCount` (atomic, relaxed ordering). Subsequent calls return the cached
  value without I/O.
- `initScanState` creates a per-scan-state `ParquetReader` on first call (`initialized = false`).
  Then calls `initParquetScanForRowGroup`, which calls
  `getNextBatch(assignedRowGroup)` on the shared state to claim a Parquet row group.
- `scanInternal` creates a **stack-local** `DataChunk parquetDataChunk(numColumns, scanState.outState)`,
  fills it by calling `parquetReader->scan(*parquetScanState, parquetDataChunk)`, then copies
  column by column into `scanState.outputVectors` via `copyFromVectorData`.

### IceDiskRelTable

```cpp
class IceDiskRelTable final : public ColumnarRelTableBase {
    IceDiskRelTableLayout layout;          // CSR or FLAT
    std::string indicesFilePath;
    std::string indptrFilePath;            // empty for FLAT
    mutable vector<offset_t> indptrData;   // cached once on first CSR scan
};
```

- `loadIndptrData` reads the entire indptr column into `vector<offset_t>` once
  (double-checked locking via `indptrDataMutex`). All subsequent lookups use this in-memory
  cache via `findSourceNodeForRowInternal` (binary search via `std::upper_bound`).
- Degree queries (`getAllDegreeEntries`, `getActiveBoundNodeCount`, `getTopKDegreeEntries`)
  all operate on `indptrData` in memory — only CSR FWD, FLAT returns empty/zero.

### allData vs parquetDataChunk lifecycle

**IceDiskNodeTable** (`scanInternal`): A fresh `DataChunk parquetDataChunk` is created on
the **stack** every call, used once, then destroyed. Vectors are allocated with
`make_shared<ValueVector>`, inserted into the chunk, and the Parquet reader fills them.
After the call to `parquetReader->scan(...)`, the output column data is copied element by
element into `scanState.outputVectors` via `copyFromVectorData`. There is no persistent cached
DataChunk in the node table scan path.

**IceDiskRelTable** (`IceDiskRelTableScanState::cachedBatchData`): A `unique_ptr<DataChunk>`
member of the scan state. It is **lazily reloaded** when `cachedBatchData == nullptr` or
`currentLocalRowIdx == selSize` (the cached batch is exhausted). On reload,
`reloadCachedBatchData(transaction)` creates a NEW `DataChunk`, allocates fresh `ValueVector`
instances matching the indices Parquet schema, and calls `indicesReader->scan(*parquetScanState,
*cachedBatchData)`. The loaded chunk persists across multiple `scanCSR` / `scanFlat` calls
until its rows are consumed.

```
Per call to scanCSR/scanFlat:
  if (cachedBatchData == null || currentLocalRowIdx == selSize) {
      currentBatchStartOffset += currentLocalRowIdx;
      currentLocalRowIdx = 0;
      reloadCachedBatchData(transaction);  // allocates new DataChunk
  }
  // consume rows from cachedBatchData[currentLocalRowIdx..selSize)
```

---

## Foreign Rel Table

### Overview

`ForeignRelTable` wraps a `TableFunction` (a user-defined or extension-registered scan
function) as a relationship source. Unlike Arrow and Icebug-Disk, it has no fixed on-disk
format.

```cpp
class ForeignRelTable final : public RelTable {
    function::TableFunction scanFunction;
    shared_ptr<function::TableFuncBindData> scanBindData;
};
```

`initScanState` initializes a `ForeignRelTableScanState` which holds:
- `shared_ptr<TableFuncSharedState> sharedState`
- `shared_ptr<TableFuncLocalState> localState`
- `DataChunk dataChunk` (the output buffer)

`scanInternal` calls `scanFunction(context, sharedState, localState, dataChunk)` and maps the
output chunk into `scanState.outputVectors`. `getNumTotalRows` calls the table function's
cardinality estimator if available.

ForeignRelTable does not support modifications; `insert`, `update`, `delete_` all throw.

---

## Scan State Fields — Full Reference

### `RelTableScanState` (base, `src/include/storage/table/rel_table.h`)

| Field | Type | Set by | Used by |
|-------|------|--------|---------|
| `direction` | `RelDataDirection` | `setToTable` | All rel scan paths |
| `currBoundNodeIdx` | `sel_t` | CSR scan loops | Native |
| `csrOffsetColumn` / `csrLengthColumn` | `Column*` | `setToTable` | Native CSR |
| `cachedBoundNodeSelVector` | `SelectionVector` | `initState` / `initScanState` | All |
| `localTableScanState` | `unique_ptr<LocalRelTableScanState>` | `setToTable` | Native |
| `arrowCurrentBatchIdx` | `size_t` | `ArrowRelTable::initScanState` | Arrow FLAT |
| `arrowCurrentBatchOffset` | `size_t` | Arrow scan loops | Arrow FLAT / BWD CSR |
| `arrowCSRBoundIdx` | `size_t` | `ArrowRelTable::initScanState` | Arrow CSR FWD |
| `arrowCSRCurrentRelOffset` | `offset_t` | Arrow CSR FWD loop | Arrow CSR FWD |
| `arrowBoundNodeOffsetToSelPos` | `unordered_map<offset_t, sel_t>` | `initScanState` | Arrow FLAT / BWD CSR |
| `arrowSrcKeyVector` / `arrowDstKeyVector` | `unique_ptr<ValueVector>` | `initScanState` | Arrow |
| `arrowScanCompleted` | `bool` | Arrow scan paths | Arrow |

### `IceDiskRelTableScanState` (`src/include/storage/table/ice_disk_rel_table.h`)

| Field | Type | Purpose |
|-------|------|---------|
| `parquetScanState` | `unique_ptr<ParquetReaderScanState>` | Parquet page state |
| `cachedBatchData` | `unique_ptr<DataChunk>` | Current Parquet batch (lazy reload) |
| `currentBatchStartOffset` | `offset_t` | Global row index of first row in `cachedBatchData` |
| `currentLocalRowIdx` | `offset_t` | Row pointer within `cachedBatchData` |
| `boundNodeOffsets` | `unordered_map<offset_t, sel_t>` | Bound node fast-lookup map |
| `indicesReader` / `indptrReader` | `unique_ptr<ParquetReader>` | Per-thread Parquet readers |

---

## `setToTable` — Differences by Backend

| Backend | Local table init | CSR columns | Column ptrs |
|---------|-----------------|-------------|-------------|
| Native `RelTable` | ✅ checks `LocalStorage` for local rel table | ✅ from `RelTableData` | ✅ live `Column*` |
| `ArrowRelTableScanState` | ❌ skipped (`TableScanState::setToTable` called directly) | ✅ pointer query passed to `getColumn`/`getCSROffsetColumn` | ✅ pointers set but unused in Arrow scan path |
| `IceDiskRelTableScanState` | ❌ skipped | ✅ same as Arrow | ✅ same as Arrow |

Comment in `arrow_rel_table.cpp`:
```cpp
// Same behavior as IceDiskRelTable: no local table for external data sources.
TableScanState::setToTable(transaction, table_, std::move(columnIDs_),
    std::move(columnPredicateSets_));
```

---

## Storage URI Dispatch

When `CREATE ... WITH (storage='...')` is parsed, the storage manager inspects the URI
scheme:

| URI prefix | Backend constructed |
|------------|---------------------|
| `arrow://arrow_N` | `ArrowNodeTable` or `ArrowRelTable` |
| `arrow://arrow_rel_N` | `ArrowRelTable` |
| `icebug-disk://...` | `IceDiskNodeTable` or `IceDiskRelTable` |
| (empty / default) | Native `NodeTable` / `RelTable` |

The `IceDiskNodeTable` and `IceDiskRelTable` constructors accept a `ClientContext*` which
is used for VFS path resolution (`VirtualFileSystem::resolvePath`) and Parquet version
compatibility checks (`IceDiskUtils::checkVersionCompatibility`).

---

## Version Compatibility

Icebug-Disk files embed a Parquet key-value metadata entry:

```
icebug_disk_version = v1
```

`IceDiskUtils::checkVersionCompatibility` reads this via a temporary `ParquetReader`, checks
the value case-insensitively against `IceDiskConstants::CURRENT_VERSION` (`"v1"`), and throws
`RuntimeException` on mismatch. Files missing the metadata emit a warning to `std::cerr` and
continue (backwards-compatibility with pre-versioned files).

---

## Mutation Guard

Both `ColumnarNodeTableBase` and `ColumnarRelTableBase` mark `insert`, `update`, and
`delete_` as `final` and throw immediately:

```cpp
void insert([[maybe_unused]] Transaction*, [[maybe_unused]] TableInsertState&) final {
    throw RuntimeException(
        "Cannot insert into " + getColumnarFormatName() + "-backed node table");
}
```

This prevents accidental writes to Arrow or Icebug-Disk tables at compile time for known
types, and at runtime for any polymorphic dispatch.

---

## `readArrowValueAtOffset` — Cross-Batch Value Access

Arrow data is stored as one or more `RecordBatch`-equivalent arrays. When a value must be
read at a global row offset (e.g., during indptr reads or property column reads), the function
`readArrowValueAtOffset` locates the containing batch via binary search on
`batchStartOffsets`, then computes the in-batch row:

```cpp
void ArrowRelTable::readArrowValueAtOffset(
    const ArrowSchema& schema, const std::vector<ArrowArrayWrapper>& arrays,
    const std::vector<size_t>& batchStartOffsets,
    offset_t globalOffset, ValueVector* output) const {
    // Binary search on batchStartOffsets to find batch
    auto it = std::upper_bound(batchStartOffsets.begin(), batchStartOffsets.end(), globalOffset);
    --it;
    auto batchIdx = std::distance(batchStartOffsets.begin(), it);
    auto rowInBatch = globalOffset - *it;
    const auto& arr = arrays[batchIdx];
    // Build null mask tree and copy one value
    ArrowNullMaskTree nullMask(&schema, &arr, rowInBatch, 1);
    ArrowConverter::fromArrowArray(&schema, &arr, output, &nullMask,
        arr.offset + rowInBatch, 0, 1);
}
```

This function is called once per rel property per edge during Arrow rel scans. It has
O(num_batches) binary search overhead per call — typically O(1) for a small number of batches.

---

## `ColumnarNodeTableBase` and `ColumnarRelTableBase` — Abstract Contracts

Both abstract base classes declare pure virtual methods that subclasses must implement:

### `ColumnarNodeTableBase` virtuals

| Method | Return | Purpose |
|--------|--------|---------|
| `getColumnarFormatName()` | `string` | Name used in error messages |
| `getNumBatches()` | `node_group_idx_t` | Total parallelism slots |
| `getTotalRowCount(transaction)` | `row_idx_t` | Cardinality estimate |
| `scanInternal(transaction, scanState)` | `void` | Fill output vectors for one morsel |

### `ColumnarRelTableBase` virtuals

| Method | Return | Purpose |
|--------|--------|---------|
| `getTotalRowCount(transaction)` | `row_idx_t` | Total edge count |
| `getActiveBoundNodeCount(transaction, dir)` | `row_idx_t` | Nodes with degree > 0 |
| `getAllDegreeEntries(transaction, dir)` | `vector<pair<offset_t, row_idx_t>>` | All `(node, degree)` pairs |
| `getTopKDegreeEntries(transaction, dir, k)` | `vector<pair<offset_t, row_idx_t>>` | Top-k by degree (min-heap) |

`ColumnarRelTableBase` concrete implementations (`getNumTotalRows`, `getNumActiveBoundNodes`,
`getDegreeEntries`, `getTopKDegrees`) are trivial wrappers that delegate to the virtual
pure methods above.

`ColumnarRelTableBase::findSourceNodeForRowInternal` is non-virtual and provides the shared
binary-search implementation (using `std::upper_bound`) for `IceDiskRelTable` and
`ArrowRelTable` BWD scans.

---

## See Also

- [Icebug-Disk Format](./icebug-disk) — file layout, schema, version, scan internals
- [Native Rel Tables](./native-rel-tables) — CSR node groups, `RelTableData`, degree queries
- [CSR Adjacency Lists](./csr) — CSR format fundamentals
- [Node Groups](./node-groups) — columnar node group layout
- [Morsel-Driven Parallelism](../execution/morsel) — how morsels are dispatched
