# Native Rel Tables

**Source files:**
`src/include/storage/table/rel_table.h`,
`src/storage/table/rel_table.cpp`,
`src/include/storage/table/rel_table_data.h`,
`src/storage/table/rel_table_data.cpp`,
`src/include/storage/table/csr_node_group.h`,
`src/storage/table/csr_node_group.cpp`,
`src/include/storage/table/csr_chunked_node_group.h`

The native relationship table (`RelTable`) is the primary read/write rel table in LadybugDB.
It stores edges in CSR format across one or two directed `RelTableData` objects — one for
forward (FWD) and one for backward (BWD). Each `RelTableData` manages a collection of
`CSRNodeGroup` objects, one per node-group-sized slab of source nodes.

---

## Object Structure

```
RelTable
├── table_id_t fromNodeTableID, toNodeTableID
├── offset_t nextRelOffset               ← monotonically-assigned rel IDs
├── vector<unique_ptr<RelTableData>> directedRelData
│   ├── [0] = RelTableData (FWD)
│   └── [1] = RelTableData (BWD)   ← only if multiplicity ≠ ONE (both directions stored)
```

### `RelTableData`

```cpp
class RelTableData {
    RelDataDirection direction;         // FWD or BWD
    RelMultiplicity multiplicity;       // ONE, MANY
    Table& table;                       // back-pointer to RelTable
    PackedCSRInfo packedCSRInfo;        // density parameters for rebalancing

    // Two dedicated header columns store the CSR offset and length per source node.
    // These are ordinary Column objects backed by disk pages in the data file.
    CSRHeaderColumns csrHeaderColumns;
    //   csrHeaderColumns.offset : Column storing start row index in the edge array
    //   csrHeaderColumns.length : Column storing number of edges per source node

    vector<unique_ptr<Column>> columns;
    //   [0] = NBR_ID column   (neighbour node ID, column_id = 0)
    //   [1] = REL_ID column   (edge identifier,   column_id = 1)
    //   [2+] = user-defined property columns

    unique_ptr<NodeGroupCollection> nodeGroups;
    //   nodeGroups[i] = CSRNodeGroup for source nodes [i*NODE_GROUP_SIZE, (i+1)*NODE_GROUP_SIZE)
};
```

### `CSRHeaderColumns`

```cpp
struct CSRHeaderColumns {
    unique_ptr<Column> offset;   // per-source-node CSR start offset (in edge array)
    unique_ptr<Column> length;   // per-source-node edge count
};
```

These are separate from the data columns so that the CSR header can be read independently
during scan without touching any property data. They are deserialized from the same data file
as the property columns.

---

## CSR Node Groups

### `CSRNodeGroup`

```cpp
class CSRNodeGroup final : public NodeGroup {
    // checkpointed/flushed data — packed CSR format on disk
    unique_ptr<ChunkedNodeGroup> persistentChunkGroup;

    // committed but not-yet-checkpointed data — append-only, one chunk per flush wave
    // (inherited from NodeGroup::chunkedGroups)

    // per-node index for in-memory (transient) data
    unique_ptr<CSRIndex> csrIndex;
};
```

A `CSRNodeGroup` has two tiers:

| Tier | Variable | Format | When used |
|------|----------|--------|-----------|
| Persistent | `persistentChunkGroup` | Packed CSR (`ChunkedNodeGroup` with format `CSR`) | After checkpoint/batch-insert flush |
| Transient | `chunkedGroups` (NodeGroup base) | Append-only flat chunks | Committed but not checkpointed |

The scan dispatches to the correct tier via `CSRNodeGroupScanSource`:

| Enum value | Meaning |
|------------|---------|
| `COMMITTED_PERSISTENT` | Read from `persistentChunkGroup` |
| `COMMITTED_IN_MEMORY` | Read from `chunkedGroups` with CSR index lookup |

### `CSRIndex`

```cpp
struct CSRIndex {
    array<NodeCSRIndex, NODE_GROUP_SIZE> indices;
};
```

A fixed-size array indexed by `boundOffsetInGroup` (source node offset within this node group).
Each `NodeCSRIndex` entry:

```cpp
struct NodeCSRIndex {
    bool isSequential = false;
    row_idx_vec_t rowIndices;
    // If isSequential=true:  rowIndices = [startRow, length]  (2 elements)
    // If isSequential=false: rowIndices = [r0, r1, r2, ...]   (full list)
};
```

**Sequential optimization:** When edges for a node were inserted as a single contiguous block,
`isSequential = true` stores only `{start, length}` instead of a full row index vector. This
is the common case for batch inserts. Incremental inserts (or deletes that leave gaps) cause
`turnToNonSequential()` to expand the pair into a full vector.

`NodeCSRIndex::getRows()` always returns a `row_idx_vec_t`, expanding sequential ranges on
demand.

### `PackedCSRInfo`

Controls density-based rebalancing during checkpoint. Computed once per `RelTableData`:

```cpp
struct PackedCSRInfo {
    // calibratorTreeHeight = NODE_GROUP_SIZE_LOG2 - CSR_LEAF_REGION_SIZE_LOG2
    //   = 17 - 10 = 7 levels (with default constants)
    uint64_t calibratorTreeHeight = NODE_GROUP_SIZE_LOG2 - CSR_LEAF_REGION_SIZE_LOG2;

    // Per-level density threshold: starts at PACKED_CSR_DENSITY at leaf,
    // increases by highDensityStep towards root.
    double highDensityStep = (LEAF_HIGH_CSR_DENSITY - PACKED_CSR_DENSITY)
                              / (double)calibratorTreeHeight;
};
```

During `checkpoint`, if any CSR region exceeds its allowed density, a rebalance pass
re-distributes edges across the packed array. The `calibratorTreeHeight` levels
correspond to increasing region sizes (powers of 2) from individual nodes up to the
entire node group.

---

## `RelTableScanState`

`RelTableScanState` extends the base `TableScanState` with the fields needed for CSR scanning:

```cpp
struct RelTableScanState : TableScanState {
    RelDataDirection direction;
    sel_t currBoundNodeIdx;
    Column* csrOffsetColumn;            // pointer into RelTableData::csrHeaderColumns
    Column* csrLengthColumn;
    bool randomLookup;

    SelectionVector cachedBoundNodeSelVector;  // snapshot of input bound-node sel-vec
    unique_ptr<LocalRelTableScanState> localTableScanState;

    // Arrow-specific fields (kept here for multi-rel scan unified state):
    size_t arrowCurrentBatchIdx;
    size_t arrowCurrentBatchOffset;
    size_t arrowCSRBoundIdx;
    offset_t arrowCSRCurrentRelOffset;
    unordered_map<offset_t, sel_t> arrowBoundNodeOffsetToSelPos;
    unique_ptr<ValueVector> arrowSrcKeyVector, arrowDstKeyVector;
    bool arrowScanCompleted;

    unique_ptr<CSRNodeGroupScanState> nodeGroupScanState;
};
```

The Arrow-specific fields are declared on `RelTableScanState` rather than a subclass so that
a single multi-rel scan state object can cover native, Icebug-Disk, and Arrow-backed tables
without casting (see the comment in `rel_table.h` lines 33–34).

### `cachedBoundNodeSelVector`

For the native path, `cachedBoundNodeSelVector` is set by `initCachedBoundNodeIDSelVector()`:

```cpp
void RelTableScanState::initCachedBoundNodeIDSelVector() {
    if (nodeIDVector->state->getSelVector().isUnfiltered()) {
        cachedBoundNodeSelVector.setToUnfiltered();
    } else {
        cachedBoundNodeSelVector.setToFiltered();
        memcpy(cachedBoundNodeSelVector.getMutableBuffer().data(),
            nodeIDVector->state->getSelVectorUnsafe().getMutableBuffer().data(),
            nodeIDVector->state->getSelVector().getSelSize() * sizeof(sel_t));
    }
    cachedBoundNodeSelVector.setSelSize(
        nodeIDVector->state->getSelVector().getSelSize());
}
```

The snapshot is used by `CSRNodeGroup::initializeScanState` to determine which source nodes
to scan within the current node group.

---

## `initScanState` for Native Rel Table

```cpp
void RelTable::initScanState(Transaction* transaction, TableScanState& scanState,
                              bool resetCachedBoundNodeSelVec) const {
    auto& relScanState = scanState.cast<RelTableScanState>();
    const auto boundNodePos = resetCachedBoundNodeSelVec ?
                                  relScanState.nodeIDVector->state->getSelVector()[0] :
                                  relScanState.cachedBoundNodeSelVector[0];
    const auto boundNodeID = relScanState.nodeIDVector->getValue<nodeID_t>(boundNodePos);

    const auto nodeGroupIdx = StorageUtils::getNodeGroupIdx(boundNodeID.offset);
    NodeGroup* nodeGroup = nullptr;
    if (relScanState.nodeGroupIdx != nodeGroupIdx) {
        nodeGroup = getDirectedTableData(relScanState.direction)->getNodeGroup(nodeGroupIdx);
    } else {
        nodeGroup = relScanState.nodeGroup;  // same node group as previous call: reuse
    }
    scanState.initState(transaction, nodeGroup, resetCachedBoundNodeSelVec);
}
```

Key behaviors:
1. Reads the first bound node's offset from position `[0]` of the selection vector.
2. Computes the node group index: `nodeGroupIdx = boundNodeOffset / NODE_GROUP_SIZE`.
3. If the node group index differs from the previous scan call, fetches a new `CSRNodeGroup`
   from `RelTableData::nodeGroups`. Otherwise, the same node group is reused — avoiding a
   map lookup when iterating multiple bound nodes in the same slab.
4. Calls `scanState.initState(transaction, nodeGroup, resetCachedBoundNodeSelVec)` which:
   - If `resetCachedBoundNodeSelVec = true`: copies the sel-vec snapshot and resets
     `currBoundNodeIdx = 0`.
   - Calls `nodeGroup->initializeScanState(transaction, scanState)` to set up the
     `CSRNodeGroupScanState` with CSR header offsets.
   - Sets `source = COMMITTED` if the persistent chunk group exists, or `UNCOMMITTED` if
     only in-memory data is present.

---

## Scan Flow

```
RelTable::scanInternal(transaction, scanState)
  └── scanState.scanNext(transaction)
        switch source:
        ├── COMMITTED  → nodeGroup->scan(transaction, scanState)
        │     └── CSRNodeGroup::scan
        │           ├── scanCommittedPersistent  (reads from persistentChunkGroup)
        │           └── scanCommittedInMem       (reads from chunkedGroups via CSRIndex)
        ├── UNCOMMITTED → localRelTable->scan(transaction, scanState)
        └── NONE → return false
```

After persistent data for a node group is exhausted, `scan` transitions to `UNCOMMITTED`
(local table) if `hasUnCommittedData()` returns true. After local data is exhausted, source
is set to `NONE`.

### `CSRNodeGroupScanState`

```cpp
struct CSRNodeGroupScanState final : NodeGroupScanState {
    unique_ptr<InMemChunkedCSRHeader> header;    // loaded from disk: offset[]+length[]
    optional<bitset<DEFAULT_VECTOR_CAPACITY>> cachedScannedVectorsSelBitset;
    row_idx_t numTotalRows;       // total rows in current node group for current bounds
    row_idx_t numCachedRows;      // rows cached from current CSR range
    row_idx_t nextCachedRowToScan;
    NodeCSRIndex inMemCSRList;    // in-memory CSR list for one bound node
    CSRNodeGroupScanSource source;
};
```

`InMemChunkedCSRHeader` is loaded from `csrHeaderColumns.offset` and `csrHeaderColumns.length`
at `initializeScanState` time. For each source node in the bound set, the scan reads
`header.offset[i]` and `header.length[i]` to determine which rows in the edge array belong
to that source node.

### Persistent scan — `scanCommittedPersistent`

Two sub-paths based on degree:

| Path | Condition | Method |
|------|-----------|--------|
| With cache (`WithCache`) | Multiple bound nodes in batch | `scanCommittedPersistentWithCache` |
| Without cache (`WithoutCache`) | Single bound node, high degree | `scanCommittedPersistentWithoutCache` |

`scanCommittedPersistentWithCache` reads ahead the CSR lists for all bound nodes in the current
batch using `cachedScannedVectorsSelBitset` to track which output positions have been filled.
`scanCommittedPersistentWithoutCache` streams directly without per-output caching, used for
the common case where one bound node may have thousands of edges.

The edge data is read from `persistentChunkGroup` column chunks via
`ColumnChunk::getValue<T>(rowIdx)` for each column in `columnIDs`.

### In-memory scan — `scanCommittedInMem`

```
for each bound node b in cachedBoundNodeSelVector:
    inMemCSRList = csrIndex->indices[b.offsetInGroup]
    rows = inMemCSRList.getRows()      // expands sequential ranges
    for each rowIdx in rows:
        read from chunkedGroups at rowIdx
        fill output vectors
```

Two further sub-paths:
- `scanCommittedInMemSequential`: when `inMemCSRList.isSequential=true`, reads a contiguous
  range from the chunk group.
- `scanCommittedInMemRandom`: when `isSequential=false`, accesses rows by explicit index
  — used after deletions or out-of-order inserts.

---

## Write Operations

### Insert flow

```cpp
void RelTable::insert(Transaction* transaction, TableInsertState& insertState) {
    checkRelMultiplicityConstraint(transaction, insertState);
    // All writes go to local (transaction-local) storage first
    auto localTable = transaction->getLocalStorage()->getOrCreateLocalTable(*this);
    localTable->insert(transaction, insertState);
    // Log to WAL
    if (insertState.logToWAL && transaction->shouldLogToWAL()) {
        wal.logTableInsertion(tableID, TableType::REL, selSize, vectorsToLog);
    }
    setHasChanges();
}
```

All inserts go to `LocalRelTable` first. `LocalRelTable` maintains its own CSR index
(`fwdIndex`/`bwdIndex`) keyed by source node offset, each holding a `NodeCSRIndex` for the
uncommitted edges.

### Commit flow

`RelTable::commit` is called when a transaction commits:
1. `updateRelOffsets`: assigns permanent `rel_offset` values from `nextRelOffset`.
2. For each direction: iterates `localRelTable.getCSRIndex(direction)` —
   a map of `{boundNodeOffset → rowIndices}`.
3. For each bound node: calls `getOrCreateNodeGroup(nodeGroupIdx)->cast<CSRNodeGroup>()`.
4. Calls `pushInsertInfo` to record the insertion in the node group's statistics.
5. Calls `prepareCommitForNodeGroup` to copy the local rows into the target `CSRNodeGroup`'s
   `chunkedGroups` (in-memory transient tier) and update its `CSRIndex`.

After commit, data is in `COMMITTED_IN_MEMORY` state — visible to readers, not yet on disk.

### Checkpoint flow

Checkpoint flushes `COMMITTED_IN_MEMORY` data into `persistentChunkGroup` (CSR packed format):

1. `RelTableData::checkpoint` iterates all node groups.
2. For each `CSRNodeGroup`: reads the current persistent chunk group (if any) + all in-memory
   chunks, computes new CSR header offsets.
3. Applies `PackedCSRInfo` density-based rebalancing: if a region exceeds its high-density
   threshold, rebalances by spreading edges across a wider region.
4. Writes the new packed CSR array to the data file via `Column::checkpoint`.
5. Writes new CSR header (offset/length) columns.
6. Updates `persistentChunkGroup` and clears `chunkedGroups`.

### Update flow

```cpp
void RelTable::update(Transaction* transaction, TableUpdateState& updateState) {
    const auto relOffset = relIDVector.readNodeOffset(relIDPos);
    if (relOffset >= StorageConstants::MAX_NUM_ROWS_IN_TABLE) {
        // Uncommitted row: update in local storage
        localTable->update(&DUMMY_TRANSACTION, updateState);
    } else {
        // Committed row: mark delete + insert in local storage
        for (auto& relData : directedRelData) {
            relData->update(transaction, boundNodeIDVector, relIDVector, columnID, dataVector);
        }
    }
}
```

Updates to committed rows are performed by `RelTableData::update`, which locates the row
in the persistent or in-memory chunk group via `findMatchingRow` (linear scan in the CSR list
for the source node), then applies the new value in-place. The in-memory
`InMemoryVersionRecordHandler` handles MVCC versioning so readers at older timestamps don't see
the new value.

### Delete flow

`RelTable::delete_` calls `RelTableData::delete_` for each direction, which:
1. Calls `findMatchingRow(transaction, boundNodeIDVector, relIDVector)` — a scan of the
   source node's CSR list looking for the matching REL_ID.
2. Marks the row as deleted via `CSRNodeGroup::delete_(source, rowIdxInGroup)`.
3. For in-memory rows: sets `NodeCSRIndex[row]` to `INVALID_ROW_IDX` via `setInvalid`.
4. For persistent rows: sets a deletion flag in the version record handler.

`detachDelete(transaction, deleteState)` deletes ALL edges from a specific source node
(used by `DETACH DELETE` Cypher). It scans the node's CSR list in both directions and deletes
each edge.

---

## Degree Queries on Native Rel Tables

Native `RelTable` implements the `RelDegreeTable` interface:

### `getNumTotalRows`

```cpp
row_idx_t RelTable::getNumTotalRows(const Transaction* transaction) const {
    return directedRelData[0]->getStats().totalNumRows;
}
```

Reads from `NodeGroupCollection::TableStats`, which is updated on every commit and checkpoint.

### `getDegreeEntries` and `getTopKDegrees`

```cpp
vector<pair<offset_t, row_idx_t>> RelTable::getDegreeEntries(
    const Transaction* transaction, RelDataDirection direction) const {
    auto* tableData = getDirectedTableData(direction);
    return tableData->getDegreeEntries(transaction);
}
```

`RelTableData::getDegreeEntries` iterates all committed node groups:

```cpp
vector<pair<offset_t, row_idx_t>> RelTableData::getDegreeEntries(const Transaction* t) const {
    vector<pair<offset_t, row_idx_t>> result;
    for (auto ngIdx = 0u; ngIdx < nodeGroups->getNumNodeGroups(); ngIdx++) {
        auto* ng = nodeGroups->getNodeGroup(ngIdx);
        if (!ng) continue;
        auto& csrNG = ng->cast<CSRNodeGroup>();
        // For persistent data: read offset and length columns
        auto* persistent = csrNG.getPersistentChunkedGroup();
        if (persistent) {
            // Read csrHeaderColumns.offset and .length for this node group
            // Offset baseOffset = ngIdx * NODE_GROUP_SIZE
            for (auto i = 0u; i < NODE_GROUP_SIZE; i++) {
                auto len = csrHeaderColumns.length->readValue<row_idx_t>(t, baseOffset + i);
                if (len > 0) result.emplace_back(baseOffset + i, len);
            }
        }
        // For in-memory data: use CSRIndex
        if (auto* idx = csrNG.getCSRIndex()) {
            for (auto i = 0u; i < NODE_GROUP_SIZE; i++) {
                auto numRows = idx->indices[i].getNumRows();
                if (numRows > 0) result.emplace_back(baseOffset + i, numRows);
            }
        }
    }
    return result;
}
```

**Contrast with Arrow/IceDisk:**
- **Arrow CSR**: reads `readIndptr(i, value)` via `readArrowValueAtOffset` — traverses Arrow
  batch vectors linearly; no separate header columns.
- **IceDisk CSR**: reads `indptrData[i]` — an in-memory `vector<offset_t>` loaded once.
- **Native**: reads `csrHeaderColumns.offset/length` — `Column` objects backed by disk pages,
  read through the buffer manager with page-level caching.

`getTopKDegrees` wraps `getDegreeEntries` with a min-heap of capacity `k`.

---

## Multiplicity and Directed Data

`RelTableData::multiplicity` (ONE or MANY) controls which directions are stored:

| `RelMultiplicity` | `directedRelData` size | FWD | BWD |
|-------------------|-----------------------|-----|-----|
| `ONE` | 1 | ✅ | ❌ (no reverse index) |
| `MANY` | 2 | ✅ | ✅ |

`getDirectedTableData(direction)` accesses by `RelDirectionUtils::relDirectionToKeyIdx(direction)`.
If the index is out of range (e.g., BWD requested on a ONE multiplicity table), a
`RuntimeException` is thrown: `"please set the storage direction to BOTH"`.

---

## Local Rel Table

`LocalRelTable` (in `src/storage/local_storage/local_rel_table.h`) is the per-transaction
buffer for uncommitted rel data. It uses a `LocalNodeGroup` (flat, not CSR) for the actual
row data, plus two separate CSR indices for FWD and BWD:

```cpp
class LocalRelTable final : public LocalTable {
    LocalNodeGroup localNodeGroup;
    map<offset_t, NodeCSRIndex> fwdCSRIndex;   // boundNodeOffset → in-mem CSR list
    map<offset_t, NodeCSRIndex> bwdCSRIndex;
};
```

`LocalRelTableScanState` extends `RelTableScanState` with `rowIndices` (a pre-fetched
`row_idx_vec_t` from the CSR index) and `nextRowToScan`.

`LocalRelTable::rewriteLocalColumnIDs(direction, columnIDs)` maps catalog column IDs to local
chunk column IDs by skipping the source/destination node ID columns depending on direction.

---

## Multi-Rel Scan (Multiple Relationship Tables)

When a Cypher query matches on multiple relationship types (e.g., `MATCH (a)-[r:KNOWS|LIKES]->(b)`),
the scan operator creates a single `RelTableScanState` and calls `setToTable` for each `RelTable`
in sequence. This is why:

1. All Arrow-specific fields are on `RelTableScanState` (not a subclass).
2. `initScanState(resetCachedBoundNodeSelVec=false)` can be called after the first table to
   reuse the cached sel-vec without re-copying.
3. `arrowBoundNodeOffsetToSelPos` can be reused across table switches within the same scan batch.

The multi-rel scan pattern:
```
for each relTable in [KNOWS_table, LIKES_table]:
    relTable->initScanState(transaction, scanState,
        resetCachedBoundNodeSelVec = (relTable == first_table))
    while relTable->scan(transaction, scanState):
        // process output
```

---

## Version Handlers

`RelTableData` has two `VersionRecordHandler` implementations for MVCC:

### `PersistentVersionRecordHandler`

Used for rows in `persistentChunkGroup`. Applies version records through the shadow file
system: `applyFuncToChunkedGroups` finds the target node group in `nodeGroups` and delegates
to `CSRNodeGroup::applyVersionRecordsToChunk`. `rollbackInsert` removes the row from the
persistent chunk and updates the CSR header.

### `InMemoryVersionRecordHandler`

Used for rows in `chunkedGroups` (committed but not yet checkpointed). Version records are
applied directly to the in-memory chunk without disk I/O. `rollbackInsert` calls
`CSRNodeGroup::rollbackGroupCollectionInsert` which removes the last `numRows` rows from the
appropriate `chunkedGroup` and updates the CSR index.

---

## Column IDs

For native rel tables, the fixed column layout is:

| `column_id_t` | Column | Notes |
|---------------|--------|-------|
| `0` (`NBR_ID_COLUMN_ID`) | Neighbour node ID (`nodeID_t`) | Always present |
| `1` (`REL_ID_COLUMN_ID`) | Rel ID (rel offset as `nodeID_t`) | Always present |
| `2, 3, ...` | User-defined properties | In catalog order |

Scan operators request columns by ID. The scan state stores `vector<Column*> columns` where
`columns[i]` is the `Column` object for `columnIDs[i]`, or `nullptr` for
`INVALID_COLUMN_ID` / `ROW_IDX_COLUMN_ID`.

---

## `RelTableData::addColumn`

```cpp
void RelTableData::addColumn(TableAddColumnState& state, PageAllocator& pageAllocator) {
    // Appends a new Column object to columns[]
    // Iterates all node groups and fills the new column with the default value
    for (auto ngIdx = 0u; ngIdx < nodeGroups->getNumNodeGroups(); ngIdx++) {
        auto* ng = nodeGroups->getNodeGroup(ngIdx);
        if (!ng) continue;
        ng->cast<CSRNodeGroup>().addColumn(state, &pageAllocator, /* newColumnStats */ nullptr);
    }
}
```

`CSRNodeGroup::addColumn` appends a new `ColumnChunk` to `persistentChunkGroup` (if exists)
filled with the default value, and extends each in-memory `ChunkedNodeGroup` in `chunkedGroups`
similarly.

---

## Serialization and Deserialization

`RelTableData` serializes its `CSRHeaderColumns` and all `Column` objects. Each `Column`
records its disk page allocation in the data file. `NodeGroupCollection` serializes per-node-group
statistics (`TableStats`). Deserialization reconstructs `CSRNodeGroup` objects from the
checkpointed chunk groups stored in the data file.

`CSRNodeGroup::serialize` writes any in-memory (not-yet-checkpointed) `chunkedGroups` to the
serializer. On recovery, these are deserialized back into `chunkedGroups` and the `CSRIndex`
is rebuilt from the committed row data.

---

## Checkpoint Deep-Dive

```
RelTableData::checkpoint(columnIDs, pageAllocator, snapshotTxn)
  for each CSRNodeGroup in nodeGroups:
    state = CSRNodeGroupCheckpointState{csrOffsetColumn, csrLengthColumn, ...}
    nodeGroup.checkpoint(memoryManager, state)
      └── CSRNodeGroup::checkpoint(mm, state):
            1. Build new InMemChunkedCSRHeader from persistent + in-memory data
            2. Apply PackedCSRInfo density check and rebalance if needed
            3. Write packed CSR edge data → Column::checkpoint
            4. Write new csrOffsetColumn and csrLengthColumn → Column::checkpoint
            5. persistentChunkGroup = new packed chunk
            6. chunkedGroups.clear()
            7. csrIndex.reset()
```

The density check (via `PackedCSRInfo`) redistributes edges within a node group to avoid
hotspots. Without rebalancing, successive inserts to the same source node would create
fragmented CSR regions requiring more page reads per scan. The rebalance writes a new
contiguous CSR layout to disk.

---

## Summary: Comparison with Columnar Backends

| Property | Native `RelTable` | IceDisk `IceDiskRelTable` | Arrow `ArrowRelTable` |
|----------|------------------|--------------------------|----------------------|
| Storage | LadybugDB data file (disk) | Parquet files | In-process Arrow arrays |
| Write | ✅ Full MVCC | ❌ Read-only | ❌ Read-only |
| CSR tier 1 | `persistentChunkGroup` (disk) | Parquet indices file | Arrow indices batches |
| CSR tier 2 | `chunkedGroups` (in-memory) | N/A | N/A |
| indptr | `csrHeaderColumns.offset/.length` (disk pages) | `indptrData` vector (loaded once) | Arrow batches (per-call read) |
| Morsel granularity | Node group (131072 nodes) | Parquet row group | 2048 rows (FLAT) / CSR range |
| Degree queries | CSR header columns, both directions | `indptrData` in-memory, FWD only | Arrow indptr, FWD only |
| MVCC | ✅ Full | ❌ None | ❌ None |
| Version handling | `VersionRecordHandler` (persistent + in-memory) | N/A | N/A |
| CSR density control | `PackedCSRInfo` rebalancing | N/A | N/A |
| Backward adjacency | Separate `RelTableData` (BWD) | Full scan + `findSourceNodeForRow` | Full scan + binary search on indptr |

---

---

## `RelTable::getDirectedTableData` — Direction Dispatch

```cpp
RelTableData* RelTable::getDirectedTableData(RelDataDirection direction) const {
    const auto directionIdx = RelDirectionUtils::relDirectionToKeyIdx(direction);
    if (directionIdx >= directedRelData.size()) {
        throw RuntimeException(std::format(
            "Failed to get {} data for rel table \"{}\", please set the storage direction to BOTH",
            RelDirectionUtils::relDirectionToString(direction), tableName));
    }
    DASSERT(directedRelData[directionIdx]->getDirection() == direction);
    return directedRelData[directionIdx].get();
}
```

`relDirectionToKeyIdx(FWD) = 0`, `relDirectionToKeyIdx(BWD) = 1`. If the table was created
with `directedRelData.size() == 1` (ONE multiplicity), a BWD query throws a `RuntimeException`
rather than silently returning wrong data.

---

## Reserved Rel Offsets

`RelTable::nextRelOffset` is an atomic counter shared across all transactions. When a
transaction commits:

```cpp
offset_t RelTable::reserveRelOffsets(row_idx_t numRows) {
    return nextRelOffset.fetch_add(numRows, memory_order_relaxed);
}
```

Returns the base offset. Each new edge is assigned `base + i` for `i in [0, numRows)`. These
offsets are written into the `REL_ID_COLUMN_ID` column at commit time by `updateRelOffsets`.
Offsets are never recycled — deleted edges leave gaps in the offset space. The maximum
addressable offset is `StorageConstants::MAX_NUM_ROWS_IN_TABLE` (used to distinguish committed
from uncommitted rows in update/delete dispatch).

---

## `checkIfNodeHasRels`

```cpp
bool RelTable::checkIfNodeHasRels(Transaction* transaction,
    RelDataDirection direction, ValueVector* srcNodeIDVector) const {
    return getDirectedTableData(direction)->checkIfNodeHasRels(transaction, srcNodeIDVector);
}
```

`RelTableData::checkIfNodeHasRels` reads the CSR length column for the given source node.
If the length is non-zero (committed) **or** if the source node has any entries in the local
rel table's CSR index (uncommitted), returns `true`.

Used by:
- `checkRelMultiplicityConstraint` (called before every insert on ONE-multiplicity tables)
- `throwIfNodeHasRels` (called before node deletion to enforce referential integrity)

---

## See Also

- [Storage Backends](./storage-backends) — overview of all backends and ownership model
- [Icebug-Disk Format](./icebug-disk) — Parquet-backed rel tables
- [CSR Adjacency Lists](./csr) — CSR format fundamentals
- [Node Groups](./node-groups) — columnar node group layout
- [MVCC](../transaction/mvcc) — transaction visibility and versioning
- [Checkpointing](../transaction/checkpointing) — how data is flushed to disk
