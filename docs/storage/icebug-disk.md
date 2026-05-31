# Icebug-Disk Format

**Source files:**
`src/include/storage/table/ice_disk_node_table.h`,
`src/storage/table/ice_disk_node_table.cpp`,
`src/include/storage/table/ice_disk_rel_table.h`,
`src/storage/table/ice_disk_rel_table.cpp`,
`src/include/storage/table/ice_disk_utils.h`,
`src/include/storage/table/ice_disk_constants.h`

Icebug-Disk is a **read-only columnar graph storage backend** built on top of Parquet files.
It stores the graph externally from the LadybugDB data file, mapping node tables to single
Parquet files and relationship tables to pairs of Parquet files (CSR format) or a single flat
Parquet file. Designed for large read-only analytical graphs served from local disk or object
storage (S3, Azure Blob, etc. via the virtual filesystem layer).

---

## Version Check

Every Icebug-Disk Parquet file must (or should) carry a Parquet key-value metadata entry:

```
icebug_disk_version = v1
```

`IceDiskUtils::checkVersionCompatibility(filePath, context)`:

1. Opens a temporary `ParquetReader` for the given path.
2. Reads all key-value pairs from the Parquet footer metadata.
3. If the key `icebug_disk_version` is missing — prints a warning to `std::cerr` and returns
   (treats the file as pre-versioned, continues loading).
4. If the key exists but does not match `IceDiskConstants::CURRENT_VERSION` ("v1",
   case-insensitive comparison) — throws `RuntimeException`.

The constant is declared in `src/include/storage/table/ice_disk_constants.h`:

```cpp
struct IceDiskConstants {
    static constexpr const char* CURRENT_VERSION = "v1";
    static constexpr const char* VERSION_KEY = "icebug_disk_version";
};
```

---

## File Layout

### Node Table Files

Each node table corresponds to **one Parquet file**:

```
nodes_{tableName}.parquet
```

Or, if the storage string ends with `.parquet` (case-insensitive), that path is used as-is.
Path construction is handled by `IceDiskUtils::constructNodeTablePath(storageDir, tableName)`.

**Required schema:** One Parquet column per node property, including the primary key. Row `i`
is node with offset `i`. The PK column does not have to be first — the scan matches columns by
name against the catalog property list.

```
nodes_city.parquet
┌──────────┬───────┬────────────┐
│ id (INT32)│ name  │ population │
├──────────┼───────┼────────────┤
│ 0        │ NY    │ 8M         │
│ 1        │ LA    │ 4M         │
...
```

### Relationship Table Files — CSR Layout

Two Parquet files per relationship table:

```
indices_{tableName}.parquet    ← one row per edge
indptr_{tableName}.parquet     ← one row per source node (N+1 rows for N nodes)
```

**`indices` schema:**
- Column 0: destination node offset (UINT64). Must be named according to `dstColumnName`
  parameter (default `"dst_offset"`).
- Columns 1+: edge properties.

**`indptr` schema:**
- Column 0: UINT64 CSR row pointer. Column 1+ are ignored (future-proofing).
- Row `i` = start offset in `indices` for source node `i`.
- Row `N` (last) = total number of edges (end sentinel).

```
indices_knows.parquet         indptr_knows.parquet
┌────────────┬──────────┐    ┌───────┐
│ dst_offset │ since    │    │ ptr   │
├────────────┼──────────┤    ├───────┤
│ 2          │ 2019     │    │ 0     │  ← node 0 has edges [0,2)
│ 5          │ 2021     │    │ 2     │  ← node 1 has edges [2,3)
│ 1          │ 2020     │    │ 3     │  ← node 2 has no edges
...                          │ 3     │  ← end sentinel
```

Path construction: `IceDiskUtils::constructCSRPaths(storageDir, tableName)` →
`{storageDir/indices_{tableName}.parquet, storageDir/indptr_{tableName}.parquet}`.

### Relationship Table Files — FLAT Layout

A single Parquet file:

```
{tableName}.parquet
```

Or the full path if storage ends with `.parquet`. The FLAT layout stores one row per edge:

```
┌─────────────┬────────────┬──────────┐
│ src_offset  │ dst_offset │ since    │
├─────────────┼────────────┼──────────┤
│ 0           │ 2          │ 2019     │
│ 0           │ 5          │ 2021     │
...
```

Column 0 = `src_offset`, column 1 = `dst_offset`, columns 2+ = properties.

---

## Schema Declaration

### Node Table

```cypher
CREATE NODE TABLE city(
    id INT32, name STRING, population INT64, PRIMARY KEY(id)
) WITH (storage = 'icebug-disk:///data/graph/');
```

The storage string may be:
- A directory path: table file is `{dir}/nodes_city.parquet`
- A full `.parquet` path: file is used as-is

### Relationship Table — CSR

```cypher
CREATE REL TABLE knows(
    FROM person TO person,
    since INT32
) WITH (storage = 'icebug-disk:///data/graph/', storageFormat = 'CSR');
```

Files expected: `{dir}/indices_knows.parquet`, `{dir}/indptr_knows.parquet`.

### Relationship Table — FLAT

```cypher
CREATE REL TABLE likes(
    FROM person TO post,
    score FLOAT
) WITH (storage = 'icebug-disk:///data/graph/');
```

File expected: `{dir}/likes.parquet` (or full path if storage ends with `.parquet`).

---

## IceDiskNodeTable — Scan Internals

### Class Layout

```cpp
class IceDiskNodeTable final : public ColumnarNodeTableBase {
    std::string parquetFilePath;
    mutable std::atomic<row_idx_t> cachedRowCount{INVALID_ROW_IDX};
    // per-thread state lives in IceDiskNodeTableScanState
};
```

### `getTotalRowCount`

```cpp
row_idx_t IceDiskNodeTable::getTotalRowCount(const Transaction*) const {
    if (cachedRowCount != INVALID_ROW_IDX)
        return cachedRowCount.load(memory_order_relaxed);
    auto reader = make_unique<ParquetReader>(parquetFilePath, {}, context);
    auto count = reader->metadata->num_rows;
    cachedRowCount.store(count, memory_order_relaxed);
    return count;
}
```

The `cachedRowCount` atomic is initialized to `INVALID_ROW_IDX` and set once on the first
call. Subsequent calls do a relaxed load with no I/O.

### `getNumBatches`

Creates a temporary `ParquetReader` and returns `getNumRowGroups()`. Called once by the
shared scan coordinator to determine parallelism.

### `IceDiskNodeTableScanSharedState` and row group assignment

```cpp
struct IceDiskNodeTableScanSharedState final : ColumnarNodeTableScanSharedState {
    std::mutex mtx;
    node_group_idx_t nextBatchIdx = 0;
    uint64_t numBatches;
    bool getNextBatch(node_group_idx_t& batchIdx) {
        std::lock_guard<std::mutex> lock(mtx);
        if (nextBatchIdx >= numBatches) return false;
        batchIdx = nextBatchIdx++;
        return true;
    }
};
```

The mutex serializes batch assignment across threads. Each Parquet row group is exactly one
morsel (no sub-group splitting). A TODO comment in the code (issue #245) notes this should be
replaced with a finer-grained `getNextMorsel` to enable load balancing within large row groups.

### `initScanState`

```cpp
void IceDiskNodeTable::initScanState(Transaction* transaction,
                                      TableScanState& scanState,
                                      bool resetCachedBoundNodeSelVec) const;
```

1. On first call (`!initialized`): creates `parquetScanState = make_unique<ParquetReaderScanState>()`.
   Creates `parquetReader = make_unique<ParquetReader>(parquetFilePath, columnSkips, context)`.
   Sets `initialized = true`.
2. Calls `sharedState->getNextBatch(rowGroupIdx)`. If no batch available, sets
   `scanCompleted = true`.
3. Calls `initializeScan(*parquetScanState, groupsToRead, vfs)` with the assigned row group.
4. Sets `scanCompleted = false` if a batch was successfully assigned.

### `scanInternal` and the `parquetDataChunk` lifecycle

```cpp
void IceDiskNodeTable::scanInternal(Transaction*, TableScanState& scanState) const {
    auto& diskScanState = scanState.cast<IceDiskNodeTableScanState>();
    auto* outputState = scanState.outState.get();

    // Stack-local DataChunk: created fresh each call, destroyed at end of call.
    DataChunk parquetDataChunk(numParquetColumns, outputState);
    for (auto i = 0u; i < numParquetColumns; i++) {
        parquetDataChunk.insert(i, make_shared<ValueVector>(parquetColumnTypes[i]));
    }

    auto selSize = diskScanState.parquetReader->scan(
        *diskScanState.parquetScanState, parquetDataChunk);

    // Build the node offset range for the output
    auto startOffset = computeStartOffset(diskScanState);
    diskScanState.nodeIDVector->...;  // fill node IDs

    // Map Parquet column → output column by name
    for (auto& [parquetColName, parquetColIdx] : parquetColIndexMap) {
        if (!nodeTableCatalogEntry->containsProperty(parquetColName))
            continue;
        auto outColIdx = nodeTableCatalogEntry->getPropertyIdx(parquetColName);
        copyFromVectorData(scanState.outputVectors[outColIdx],
                           parquetDataChunk.getValueVector(parquetColIdx).get(),
                           0, 0, selSize);
    }
}
```

Key points:
- **`parquetDataChunk` is stack-local** — allocated and freed on every call to `scanInternal`.
  It holds ALL Parquet columns in the file (or whichever are not in `columnSkips`).
- Output columns are mapped **by name**, not by position. If the Parquet file has extra columns
  not in the catalog, they are read but silently discarded after `copyFromVectorData`.
- If the catalog has extra properties not in the Parquet file, those output vectors remain
  as-initialized (nulls, zeros).

### `startOffset` calculation

```cpp
offset_t computeStartOffset(IceDiskNodeTableScanState& state) {
    // Find which row groups preceded this one
    auto currentGroupIdx = state.parquetScanState->groupIdxList[
                               state.parquetScanState->currentGroup];
    offset_t offset = 0;
    for (auto rg = 0; rg < currentGroupIdx; rg++) {
        offset += state.parquetReader->metadata->row_groups[rg].num_rows;
    }
    // Subtract the rows already consumed within this group
    offset += state.parquetScanState->groupOffset - selSize;
    return offset;
}
```

The `parquetScanState->currentGroup` is an index into `groupIdxList` (the list of row groups
assigned to this scan state), not a global row group index. The global row group index is
`groupIdxList[currentGroup]`.

---

## IceDiskRelTable — Scan Internals

### Class Layout

```cpp
class IceDiskRelTable final : public ColumnarRelTableBase {
    IceDiskRelTableLayout layout;       // CSR or FLAT
    std::string indicesFilePath;        // CSR: indices file; FLAT: main file
    std::string indptrFilePath;         // CSR only; empty for FLAT

    mutable vector<offset_t> indptrData;   // entire indptr loaded in memory (CSR)
    mutable mutex indptrDataMutex;

    // Shared readers for degree queries (class-level, not per-scan-state)
    mutable unique_ptr<ParquetReader> indicesReader;
    mutable unique_ptr<ParquetReader> indptrReader;
    mutable mutex parquetReaderMutex;
};
```

### Column ID Mapping

**CSR layout:**

| Parquet column index | Logical column | Catalog column ID |
|----------------------|----------------|-------------------|
| 0 | dst node offset | `NBR_ID = 0` (virtual, translated) |
| 1 | first user property | 2 (0=NBR_ID, 1=REL_ID virtual) |
| 2 | second user property | 3 |
| ... | ... | ... |

Mapping: `parquetColIdx = catalogColID - 1` for user properties (since Parquet col 0 is
always `dst_offset`, and catalog columns 0 and 1 are `NBR_ID` and `REL_ID` which are virtual).

**FLAT layout:**

| Parquet column index | Logical column |
|----------------------|----------------|
| 0 | src node offset |
| 1 | dst node offset |
| 2 | first user property |
| ... | ... |

Mapping: `parquetColIdx = catalogColID` (src/dst are included in column 0/1).

### `indptrData` lazy loading

```cpp
void IceDiskRelTable::loadIndptrData() const {
    std::lock_guard<std::mutex> lock(indptrDataMutex);
    if (!indptrData.empty()) return;   // double-check after lock

    auto reader = make_unique<ParquetReader>(indptrFilePath, {}, context);
    DataChunk chunk(1, /* single column */);
    auto scanState = make_unique<ParquetReaderScanState>();
    reader->initializeScan(*scanState, {0}, vfs);   // all row groups

    while (true) {
        chunk.reset();
        auto n = reader->scan(*scanState, chunk);
        if (n == 0) break;
        auto* vec = chunk.getValueVector(0).get();
        for (auto i = 0u; i < n; i++) {
            indptrData.push_back(vec->getValue<offset_t>(i));
        }
    }
}
```

`indptrData[i]` = first row in `indices` for source node `i`. Loading reads the entire
Parquet file (potentially multiple row groups) into a `vector<offset_t>`. This is done once;
subsequent lookups are `O(log N)` binary searches via `std::upper_bound`.

### `cachedBatchData` lifecycle

`IceDiskRelTableScanState` holds a `unique_ptr<DataChunk> cachedBatchData`. On each call to
`scanCSR` or `scanFlat`:

```cpp
void IceDiskRelTable::maybeReloadCachedBatch(IceDiskRelTableScanState& state,
                                              Transaction* transaction) const {
    if (state.cachedBatchData == nullptr ||
        state.currentLocalRowIdx == state.cachedBatchData->getSelVector().getSelSize()) {
        state.currentBatchStartOffset += state.currentLocalRowIdx;
        state.currentLocalRowIdx = 0;
        reloadCachedBatchData(state, transaction);
    }
}
```

`reloadCachedBatchData` allocates a new `DataChunk` with vectors for all indices columns, then
calls `state.indicesReader->scan(*state.parquetScanState, *state.cachedBatchData)`. The scan
advances the Parquet reader's internal row group state. The batch persists across multiple
output vector fills until `currentLocalRowIdx` reaches the number of valid rows in the chunk.

**Contrast with node table:** Node table uses a stack-local `parquetDataChunk` that is
discarded every call. Rel table uses a heap-allocated `cachedBatchData` that is reused until
exhausted. This difference exists because rel table scans may be interrupted after outputting
`DEFAULT_VECTOR_CAPACITY` rows (the scan state must be resumable), whereas node table scans
always consume a full row group per `scanInternal` call.

### `scanCSR`

**Forward direction:**

```cpp
void IceDiskRelTable::scanCSR_Fwd(Transaction* transaction,
                                   IceDiskRelTableScanState& state) const {
    auto& boundNodeOffsets = state.boundNodeOffsets;  // snapshot from initScanState

    while (state.arrowCSRBoundIdx < boundNodeOffsets.size() &&
           outputCount < DEFAULT_VECTOR_CAPACITY) {
        auto& [boundNodeOffset, selPos] = boundNodeOffsets[state.arrowCSRBoundIdx];

        // Get CSR range for this source node
        if (state.currentLocalRowIdx == 0) {
            state.csrStart = indptrData[boundNodeOffset];
            state.csrEnd   = indptrData[boundNodeOffset + 1];
            state.currentRelOffset = state.csrStart;
        }

        while (state.currentRelOffset < state.csrEnd &&
               outputCount < DEFAULT_VECTOR_CAPACITY) {
            maybeReloadCachedBatch(state, transaction);
            auto localIdx = state.currentRelOffset - state.currentBatchStartOffset;

            // Read dst offset from column 0 of cachedBatchData
            auto dstOffset = cachedBatchData->getValueVector(0)->getValue<offset_t>(localIdx);
            // Fill output vectors with property columns
            for (auto& [catColId, parqColId] : propColMapping)
                copyValue(state.outputVectors[catColId], cachedBatchData, parqColId, localIdx);

            state.currentRelOffset++;
            outputCount++;
        }

        if (state.currentRelOffset == state.csrEnd) {
            state.arrowCSRBoundIdx++;
            state.currentLocalRowIdx = 0;
        }
    }
}
```

The indptr lookup `indptrData[boundNodeOffset]` is an O(1) in-memory array access (after the
initial `loadIndptrData`). The inner loop iterates edges for one source node at a time,
reloading `cachedBatchData` when the current Parquet batch is exhausted.

**Backward direction:**

For BWD CSR, the table performs a full sequential scan of the indices file, checking each row's
destination offset against `boundNodeOffsets` (the map from `initScanState`). Source is
recovered via `findSourceNodeForRowInternal(globalRowIdx, indptrData)` — a `std::upper_bound`
binary search.

### `scanFlat`

FLAT layout stores (src_offset, dst_offset, props). The scan reads rows sequentially:

```cpp
// For FWD: skip rows where src_offset not in boundNodeOffsets
// For BWD: skip rows where dst_offset not in boundNodeOffsets
```

Each row is checked against `boundNodeOffsets` map. The scan tracks `activeBoundOffset`: once
a bound node's edges have been emitted, it advances to the next in the selection vector.
Output is capped at `DEFAULT_VECTOR_CAPACITY` rows per call.

### Degree Queries

| Method | CSR FWD | CSR BWD | FLAT |
|--------|---------|---------|------|
| `getActiveBoundNodeCount` | Counts entries in `indptrData` with `indptr[i+1] > indptr[i]` | `0` | `0` |
| `getAllDegreeEntries` | Returns `(i, indptr[i+1]-indptr[i])` for all `i` with degree > 0 | `{}` | `{}` |
| `getTopKDegreeEntries` | Min-heap of size `k` over `indptrData` pairs | `{}` | `{}` |

All three methods require `loadIndptrData()` — called lazily if not already loaded. The
degree computation is purely in-memory after that.

### `findSourceNodeForRowInternal`

Defined in `ColumnarRelTableBase` (shared with `ArrowRelTable`):

```cpp
offset_t ColumnarRelTableBase::findSourceNodeForRowInternal(
    offset_t globalRowIdx, const vector<offset_t>& indptrData) const {
    // upper_bound finds first element > globalRowIdx
    auto it = std::upper_bound(indptrData.begin(), indptrData.end(), globalRowIdx);
    if (it == indptrData.begin())
        throw RuntimeException("Invalid global row index: " + to_string(globalRowIdx));
    --it;
    return static_cast<offset_t>(std::distance(indptrData.begin(), it));
}
```

Returns the source node index (offset) for a given global edge index in the indices array.

---

## IceDiskRelTableScanState — Detail

```cpp
struct IceDiskRelTableScanState final : RelTableScanState {
    // Parquet state
    unique_ptr<ParquetReaderScanState> parquetScanState;
    unique_ptr<DataChunk> cachedBatchData;      // current loaded Parquet batch
    offset_t currentBatchStartOffset = 0;       // global row idx of batch[0]
    offset_t currentLocalRowIdx = 0;            // row pointer within batch

    // Bound node map (built at initScanState)
    unordered_map<offset_t, sel_t> boundNodeOffsets;

    // Per-scan-state readers (thread-safe, one per scan state)
    unique_ptr<ParquetReader> indicesReader;
    unique_ptr<ParquetReader> indptrReader;

    // CSR navigation
    offset_t csrStart = 0, csrEnd = 0;
    offset_t currentRelOffset = 0;
    size_t arrowCSRBoundIdx = 0;       // position in boundNodeOffsets

    void reset() {
        cachedBatchData.reset();
        currentBatchStartOffset = 0;
        currentLocalRowIdx = 0;
        arrowCSRBoundIdx = 0;
        currentRelOffset = 0;
    }
};
```

The `indicesReader` and `indptrReader` in the scan state are **per-thread** — each parallel
scan worker gets its own `ParquetReader`. The class-level `indicesReader` and `indptrReader`
(protected by `parquetReaderMutex`) are used only for degree queries, which are typically
called from a single planner thread.

---

## `initScanState` and `cachedBoundNodeSelVec` for IceDiskRelTable

```cpp
void IceDiskRelTable::initScanState(Transaction*, TableScanState& scanState,
                                     bool resetCachedBoundNodeSelVec) const {
    auto& relScanState = scanState.cast<RelTableScanState>();

    if (resetCachedBoundNodeSelVec) {
        // Snapshot the current bound-node selection vector
        if (relScanState.nodeIDVector->state->getSelVector().isUnfiltered()) {
            relScanState.cachedBoundNodeSelVector.setToUnfiltered();
        } else {
            relScanState.cachedBoundNodeSelVector.setToFiltered();
            memcpy(relScanState.cachedBoundNodeSelVector.getMutableBuffer().data(),
                relScanState.nodeIDVector->state->getSelVector().getMutableBuffer().data(),
                relScanState.nodeIDVector->state->getSelVector().getSelSize() * sizeof(sel_t));
            relScanState.cachedBoundNodeSelVector.setSelSize(
                relScanState.nodeIDVector->state->getSelVector().getSelSize());
        }

        // Build offset-to-selPos map
        auto& diskState = scanState.cast<IceDiskRelTableScanState>();
        diskState.boundNodeOffsets.clear();
        for (uint64_t i = 0; i < relScanState.cachedBoundNodeSelVector.getSelSize(); i++) {
            auto sel = relScanState.cachedBoundNodeSelVector[i];
            auto nodeID = relScanState.nodeIDVector->getValue<nodeID_t>(sel);
            diskState.boundNodeOffsets.emplace(nodeID.offset, sel);
        }
    }

    if (layout == IceDiskRelTableLayout::CSR) {
        loadIndptrData();   // lazy; no-op if already loaded
    }
}
```

Same semantics as Arrow: the sel-vec snapshot is taken once per operator invocation
(`resetCachedBoundNodeSelVec = true`), and the `boundNodeOffsets` map is the O(1) lookup
structure used throughout the scan. `resetCachedBoundNodeSelVec = false` reuses the existing
snapshot (multi-rel scan optimization).

---

## End-to-End: Node Scan Example

```
Query: MATCH (n:city) RETURN n.name

1. initializeScanCoordination → shared state with 4 row groups (batches)
2. Thread A: initScanState → gets row group 0, creates ParquetReader
3. Thread B: initScanState → gets row group 1, creates ParquetReader
4. Thread A calls scanInternal:
   - Creates stack-local parquetDataChunk
   - parquetReader->scan(scanState, parquetDataChunk)   ← fills all columns from Parquet row group 0
   - Maps 'name' column from parquetDataChunk → outputVector
   - Returns outputVector with row group 0 results
5. Thread A calls scanInternal again:
   - getNextBatch → row group 2 assigned
   - ...repeat...
6. Thread A: getNextBatch → no more batches → scanCompleted = true
```

---

## End-to-End: CSR Rel Scan Example

```
Query: MATCH (a:person)-[r:knows]->(b:person) WHERE a.id IN [1, 3] RETURN b.id

1. initScanState(resetCachedBoundNodeSelVec=true):
   - Snapshot selVector: positions [0, 1] (two bound nodes a.offset=1, a.offset=3)
   - Build boundNodeOffsets: {1 → 0, 3 → 1}
   - loadIndptrData: [0, 2, 5, 5, 7, ...] (loaded once)

2. First scanCSR (FWD):
   - arrowCSRBoundIdx=0, boundNode.offset=1
   - csrStart = indptrData[1] = 2, csrEnd = indptrData[2] = 5
   - currentRelOffset=2: maybeReloadCachedBatch → loads Parquet batch from indices file
   - localIdx=2-0=2 (within batch): reads dst_offset=42, copies since=2020
   - currentRelOffset=3: reads dst_offset=17, copies since=2018
   - currentRelOffset=4: reads dst_offset=99, copies since=2022
   - csrEnd reached → arrowCSRBoundIdx=1
   - DEFAULT_VECTOR_CAPACITY not reached, continue to next bound node
   - boundNode.offset=3: csrStart=5, csrEnd=7
   - currentRelOffset=5,6: reads two more edges
   - Output: 5 edges for bound nodes 1 and 3

3. Next call: no more bound nodes → scan returns false
```

---

## Parquet Reader Integration

`IceDiskNodeTable` and `IceDiskRelTable` use `ParquetReader` from
`src/extension/parquet/` (the built-in Parquet extension). Key methods:

| Method | Purpose |
|--------|---------|
| `ParquetReader::initializeScan(state, rowGroups, vfs)` | Set up row group list for scan |
| `ParquetReader::scan(state, chunk)` | Fill chunk from current position, advance |
| `ParquetReader::getNumRowGroups()` | Count of Parquet row groups |
| `ParquetReader::metadata->num_rows` | Total row count from footer |
| `ParquetReader::metadata->row_groups[i].num_rows` | Per-row-group count |

The `columnSkips` parameter (passed to `ParquetReader` constructor) is a bitset of column
indices to skip — used by the scan to skip unused columns. Column skipping is based on the
catalog property list vs. Parquet schema intersection.

---

## Writing Icebug-Disk Files

LadybugDB itself does not write Icebug-Disk Parquet files. Files must be produced externally.
Recommended approach using PyArrow:

```python
import pyarrow as pa
import pyarrow.parquet as pq

# Node table
nodes = pa.table({'id': [0, 1, 2], 'name': ['Alice', 'Bob', 'Carol']})
pq.write_table(nodes, 'data/nodes_person.parquet',
               custom_metadata={'icebug_disk_version': 'v1'})

# Relationship table — CSR
# indices: [dst_offset per edge, property]
indices = pa.table({
    'dst_offset': pa.array([1, 2, 2], type=pa.uint64()),
    'since': [2019, 2020, 2021]
})
pq.write_table(indices, 'data/indices_knows.parquet',
               custom_metadata={'icebug_disk_version': 'v1'})

# indptr: [cumulative edge counts per source node + sentinel]
indptr = pa.table({'ptr': pa.array([0, 2, 3, 3], type=pa.uint64())})
pq.write_table(indptr, 'data/indptr_knows.parquet',
               custom_metadata={'icebug_disk_version': 'v1'})
```

---

## Key Differences from Arrow Backend

| Property | Icebug-Disk | Arrow |
|----------|------------|-------|
| Data location | Files (local/object store) | In-process memory |
| Scan unit | Parquet row group | 2048-row morsel |
| Column data chunk | `cachedBatchData` (heap, lazy reload) | Direct `ArrowArray` access |
| Node table scan chunk | Stack-local `parquetDataChunk` | No intermediate chunk (direct copy) |
| PK lookup | Sequential scan within Parquet reader | Linear scan across Arrow batches |
| indptr storage | `vector<offset_t>` loaded once into memory | Arrow arrays (read-through per batch) |
| Write support | ❌ Read-only | ❌ Read-only |
| MVCC | ❌ No | ❌ No |
| Version check | ✅ Parquet footer metadata | ❌ None |

---

## See Also

- [Storage Backends](./storage-backends) — comparison of all backends, ownership model
- [Native Rel Tables](./native-rel-tables) — native CSR rel tables for comparison
- [CSR Adjacency Lists](./csr) — CSR format fundamentals
- [Node Groups](./node-groups) — columnar node group layout
