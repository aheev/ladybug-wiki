# Table Scan Internals

**Source files:** `src/processor/operator/scan/scan_node_table.cpp`, `src/processor/operator/scan/scan_rel_table.cpp`, `src/storage/table/node_table.cpp`, `src/storage/table/column.cpp`

## Overview

The table scan is the entry point for reading data from disk into the execution engine. It connects the storage layer (node groups, column chunks, buffer manager) to the execution layer (pipelines, morsels, DataChunks).

Two primary scan operators exist:

| Operator | Scans | Morsel unit |
|----------|-------|-------------|
| `ScanNodeTable` | Node property columns | 1 node group (131,072 nodes) |
| `ScanRelTable` | Relationship adjacency lists | 1 node group of source nodes |

Both operators are **sources** — the first operator in a pipeline, producing DataChunks from storage rather than receiving them from an upstream operator.

## ScanNodeTable

### Initialization

When the scheduler starts a pipeline, `initGlobalState()` creates a `ScanNodeTableSharedState` shared across all worker threads:

```cpp
struct ScanNodeTableSharedState {
    atomic<node_group_idx_t> currentCommittedGroupIdx{0};
    atomic<node_group_idx_t> currentUncommittedGroupIdx{0};
    uint64_t numCommittedNodeGroups;
    uint64_t numUncommittedNodeGroups;
};
```

Committed groups are on-disk node groups managed by the buffer manager. Uncommitted groups hold rows inserted in the current write transaction and live in `LocalNodeTable` (in-memory).

### Morsel Assignment

Each worker thread calls `nextMorsel()` to atomically claim a node group. No lock is needed — a single `fetch_add` is sufficient:

```cpp
void ScanNodeTableSharedState::nextMorsel(NodeTableScanState& scanState) {
    // Committed groups first (on-disk)
    if (currentCommittedGroupIdx < numCommittedNodeGroups) {
        scanState.nodeGroupIdx = currentCommittedGroupIdx.fetch_add(1, memory_order_relaxed);
        scanState.source = TableScanSource::COMMITTED;
        return;
    }
    // Then uncommitted rows (write-tx local storage, in-memory)
    if (currentUncommittedGroupIdx < numUncommittedNodeGroups) {
        scanState.nodeGroupIdx = currentUncommittedGroupIdx.fetch_add(1, memory_order_relaxed);
        scanState.source = TableScanSource::UNCOMMITTED;
        return;
    }
    scanState.source = TableScanSource::NONE;  // this thread is done
}
```

### Inner Scan Loop

Once a morsel (node group) is assigned, the operator iterates vectors of `DEFAULT_VECTOR_CAPACITY = 2048` rows within that group until the group is exhausted:

```
getNextTuplesInternal() [called per thread]:
  loop:
    filled = table->scan(transaction, *scanState)
    // scan() fills output DataChunk with up to 2048 rows
    // returns false when the current node group is exhausted
    if not filled:
      sharedState->nextMorsel(*scanState)  ← claim next node group
      if scanState.source == NONE: return  ← no more work
    else:
      push DataChunk to next operator in pipeline
```

### Column Read Path

Inside `NodeTable::scanInternal()`, each requested column is fetched from its `ColumnChunk` via the buffer manager:

```
For each column in scanState.columnIDs:
  column->scan(transaction, nodeGroupIdx, valueVector, scanState)

column->scan():
  1. Locate the ColumnChunk for nodeGroupIdx
  2. Pin pages via BufferManager (page cache hit or disk read)
  3. Decompress values into ValueVector (BitPacking / RLE / Dictionary / raw)
  4. Apply SelectionVector: skip compressed blocks that contain no selected row
  5. Unpin pages
```

Step 4 is where the `Filterer` struct in `column.cpp` acts. Before decompressing each block (an RLE run or a bitpack group), it checks whether the block's row range intersects the `SelectionVector`. If not, the block is skipped without any decompression:

```cpp
struct Filterer {
    const SelectionVector& selVector;
    uint16_t posInSelVector;

    // Returns true only if [startIdx, endIdx) contains a selected position.
    bool operator()(offset_t startIdx, offset_t endIdx) {
        while (posInSelVector < selVector.getSelSize() &&
               selVector[posInSelVector] - offsetInVector < startIdx) {
            posInSelVector++;
        }
        return posInSelVector < selVector.getSelSize() &&
               selVector[posInSelVector] - offsetInVector < endIdx;
    }
};
```

This is the mechanism by which semi-masks (produced by hash join build sides) eliminate physical I/O on the probe side: matching node IDs are converted to a `SelectionVector`, which then causes irrelevant compressed column blocks to be skipped entirely.

## ScanRelTable

Relationship scans read CSR (Compressed Sparse Row) adjacency lists. Each morsel is one source node group:

```
ScanRelTableSharedState:
  morsel = one source node group

Per morsel, for each source node in the group:
  1. Read CSR entry: (csrOffset, csrLength) for this node's edges
  2. Scan csrLength destination nodeIDs + edge property columns
  3. Emit DataChunks of up to 2048 edges at a time
```

The `RelTableScanState` tracks position within a source node group's CSR list:

```cpp
struct RelTableScanState {
    offset_t     boundNodeOffset;  // current source node being expanded
    offset_t     csrOffset;        // current position in the CSR array
    offset_t     csrLength;        // total edges for boundNodeOffset
};
```

Forward and backward scans (for `()-[:R]->()` vs `()<-[:R]-()`) use separate CSR lists stored in the same `RelTable`.

The actual scan state carries additional fields used by Arrow-backed tables so that a single `ScanMultiRelTable` operator can cover native, icebug-disk, and Arrow tables with one state object:

```cpp
struct RelTableScanState {
    // --- Native CSR fields ---
    RelDataDirection direction;
    sel_t            currBoundNodeIdx;
    Column*          csrOffsetColumn;
    Column*          csrLengthColumn;
    SelectionVector  cachedBoundNodeSelVector;

    // --- Arrow-backed fields (used by ArrowRelTable) ---
    size_t arrowCurrentBatchIdx    = 0;
    size_t arrowCurrentBatchOffset = 0;
    unordered_map<offset_t, sel_t> arrowBoundNodeOffsetToSelPos;
    unique_ptr<ValueVector> arrowSrcKeyVector;
    unique_ptr<ValueVector> arrowDstKeyVector;
    bool arrowScanCompleted = true;
};
```

## Storage Backend Scan Variants

Each rel table storage backend overrides `initScanState()` and `scanInternal()` with backend-specific state and logic.

### Native RelTable (CSR)

The default backend. Edges are stored as a per-direction CSR on disk, managed by the buffer manager.

**Scan flow:**

1. `initScanState()` sets `csrOffsetColumn`/`csrLengthColumn` pointers and caches the bound-node selection vector.
2. `scanNext()` iterates through bound nodes in the cached `selVector`, reads the CSR offset/length for each, then scans that range of the adjacency column to emit destination nodeIDs and property values.
3. Uncommitted edges are handled by `LocalRelTableScanState`, which holds a pre-built `rowIndices` list from the in-memory forward/backward index.

Both `FWD` and `BWD` directions have independent `RelTableData` objects (and therefore independent CSR arrays), so scanning in either direction is symmetric.

### IceDiskRelTable (Parquet CSR)

Edges are persisted as two Parquet files: `indices.parquet` (destination node IDs and properties) and `indptr.parquet` (CSR row pointer array).

```cpp
struct IceDiskRelTableScanState : RelTableScanState {
    unique_ptr<ParquetReaderScanState> parquetScanState;
    unique_ptr<DataChunk>              cachedBatchData;
    offset_t currentBatchStartOffset; // global row index of current batch start
    offset_t currentLocalRowIdx;      // row within current batch
    unordered_map<offset_t, sel_t>    boundNodeOffsets; // src offset → selPos
    // Per-scan-state readers (one per thread for thread safety)
    unique_ptr<ParquetReader> indicesReader;
    unique_ptr<ParquetReader> indptrReader;
};
```

**Key design points:**

- **Per-scan-state Parquet readers** — unlike native CSR where columns are buffer-managed centrally, each `IceDiskRelTableScanState` owns its own `ParquetReader` instances. This avoids contention across worker threads at the cost of slightly more memory per active scan.
- **`boundNodeOffsets` map** — because Parquet is read in row-group batches (not per-node), the scan builds a map of `{srcNodeOffset → selVectorPosition}` from the upstream bound-node vector. After reading a batch, it looks up each row's source node in this map to decide which rows to emit.
- **Read-only** — IceDisk tables do not support write operations; insert/update/delete throw at runtime.

**Scan flow:**

```
initScanState():
  build boundNodeOffsets from the bound-node selVector
  load indptr array (cached after first load)
  reset batch cursor

scanInternal() loop:
  reloadCachedBatchData() → reads next Parquet row group via indicesReader
  for each row in batch:
    look up row's src offset in boundNodeOffsets
    if found: emit row to output vectors
  advance currentLocalRowIdx; when batch exhausted → load next batch
```

### ArrowRelTable (In-Process Arrow Arrays)

Edges are held entirely in memory as Arrow arrays (e.g. injected by the `REGISTER RELATIONSHIP` API). The scan iterates over Arrow `RecordBatch` objects.

```cpp
class ArrowRelTable {
    int64_t fromColumnIdx; // Arrow column index for source nodeID key
    int64_t toColumnIdx;   // Arrow column index for destination nodeID key
    vector<ArrowArrayWrapper> arrays;   // per-batch Arrow arrays
    vector<size_t> batchStartOffsets;   // global row offset of each batch
    unordered_map<column_id_t, int64_t> propertyColumnToArrowColumnIdx;
};
```

**Scan flow using `RelTableScanState` Arrow fields:**

```
initScanState():
  build arrowBoundNodeOffsetToSelPos from bound-node vector
  reset arrowCurrentBatchIdx = 0, arrowCurrentBatchOffset = 0
  arrowScanCompleted = false

scanInternal() per batch:
  for each row in current Arrow batch starting at arrowCurrentBatchOffset:
    read src key from arrays[fromColumnIdx]
    look up in arrowBoundNodeOffsetToSelPos
    if found: copy property columns to output vectors
  advance arrowCurrentBatchOffset; when batch exhausted → arrowCurrentBatchIdx++
  set arrowScanCompleted = true when all batches exhausted
```

Because Arrow arrays are already in process memory, there is no I/O and no buffer manager involvement. The main cost is iterating the `arrowBoundNodeOffsetToSelPos` lookup per row.

**Read-only** — Arrow-backed tables do not support insert/update/delete.

### ForeignRelTable (TableFunction Delegation)

A thin wrapper around a user-supplied `TableFunction`. The scan state holds `TableFuncSharedState` and `TableFuncLocalState` objects and a scratch `DataChunk`:

```cpp
struct ForeignRelTableScanState : RelTableScanState {
    shared_ptr<TableFuncSharedState> sharedState;
    shared_ptr<TableFuncLocalState>  localState;
    DataChunk                        dataChunk;
};
```

`scanInternal()` calls the `TableFunction`'s scan callback with `(sharedState, localState, dataChunk)` and copies results into the output vectors. The foreign function is responsible for all filtering and bounds logic.

**Read-only** — insert/update/delete throw a `RuntimeException`.

## Multi-Table Scans

Queries over multiple labels or relationship types produce multi-table scan operators.

### ScanNodeTable (Multi-Label)

When a query matches nodes of several labels (e.g. `MATCH (n:Person|Organisation)`), a single `ScanNodeTable` operator is configured with a list of `tableInfos` and a corresponding list of `sharedStates` — one per label table. The operator iterates through the list, exhausting each table's node groups before moving to the next.

A `ColumnCaster` shim handles type mismatches between homonymous properties across different label tables (e.g. `name` being `STRING` in one table but `BLOB` in another). The caster inserts a cast expression between the raw column read and the output vector.

### ScanMultiRelTable

Used for queries over multiple relationship type tables (e.g. `MATCH (a)-[:KNOWS|LIKES]->(b)`).

**Key data structures:**

```cpp
// Maps each source-node tableID to the collection of rel tables reachable from it
table_id_map_t<RelTableCollectionScanner> scanners;

// Each scanner holds an ordered list of rel table infos to try
class RelTableCollectionScanner {
    vector<ScanRelTableInfo> relInfos;
    idx_t currentTableIdx;
    uint32_t nextTableIdx;
};
```

**Scan loop:**

```
getNextTuplesInternal():
  loop:
    if currentScanner is active and scanner.scan() returns data:
      emit DataChunk and return true

    get next bound node from child operator (e.g. ScanNodeTable)
    if child exhausted: return false

    nodeID = boundNodeIDVector[selPos]
    initCurrentScanner(nodeID):
      look up scanners[nodeID.tableID]
      if found: set currentScanner, reset its state
      else:     currentScanner = nullptr  ← this node's table has no matching rel type
```

**`RelTableCollectionScanner::scan()` loop:**

```
loop:
  if no current table: initNextTable()
    → calls relInfo.initScanState() + table->initScanState()
    → increments nextTableIdx
  call relInfo.table->scan()
  if scan returned rows:
    if directionVector set: fill direction flags for each output row
    call relInfo.castColumns() for type-cast shims
    return true
  else (current table exhausted):
    initNextTable() → try next table in relInfos
    if no more tables: return false
```

**Scan state selection** — `initLocalStateInternal()` inspects all scanners to detect whether any `ArrowRelTable` or `IceDiskRelTable` is present and allocates the matching specialised scan state (`ArrowRelTableScanState` or `IceDiskRelTableScanState`). A single scan state object covers all backend types in one multi-rel scan thanks to the Arrow fields embedded in the base `RelTableScanState`.

## Rel Groups

A **rel group** is the user-visible concept of a relationship type in Cypher. It lives in the catalog as a `RelGroupCatalogEntry`. Physically, a rel group decomposes into one or more **rel tables** — one per `(srcTableID, dstTableID)` pair.

```
Cypher:  CREATE REL TABLE KNOWS (FROM Person TO Person, FROM Person TO Bot)
         → RelGroupCatalogEntry "KNOWS"
               relTableInfos:
                 [0] { nodePair: (Person, Person), oid: 5 }  → RelTable id=5
                 [1] { nodePair: (Person, Bot),    oid: 6 }  → RelTable id=6
```

### RelGroupCatalogEntry fields

| Field | Type | Meaning |
|-------|------|---------|
| `srcMultiplicity` | `RelMultiplicity` | Constraint on source side (MANY / ONE) |
| `dstMultiplicity` | `RelMultiplicity` | Constraint on destination side (MANY / ONE) |
| `storageDirection` | `ExtendDirection` | Which CSR directions to materialise: `FWD`, `BWD`, or `BOTH` |
| `relTableInfos` | `vector<RelTableCatalogInfo>` | One entry per (src, dst) node-table pair |
| `storage` | `string` | Backend tag: `""` = native CSR, `"icebug-disk"` = Parquet, `"arrow"` = Arrow |
| `storageFormat` | `string` | Optional format hint (e.g. icebug-disk file path prefix) |
| `scanFunction` | `optional<TableFunction>` | Set for foreign-backed tables |
| `scanBindData` | `optional<TableFuncBindData>` | Bind data for the foreign scan function |
| `foreignDatabaseName` | `string` | Source database for foreign-backed tables |

### Storage direction and physical CSR layout

`storageDirection` controls how many CSR arrays are materialised:

| Value | FWD CSR | BWD CSR | Typical use |
|-------|---------|---------|-------------|
| `BOTH` | ✓ | ✓ | Default — supports both traversal directions |
| `FWD` | ✓ | ✗ | Write-optimised or append-only workloads |
| `BWD` | ✗ | ✓ | Reverse-lookup-only workloads |

At query time, if the planner tries to extend in a direction not stored, it must flip the traversal (swap src/dst). `DirectionInfo::needFlip()` in `ScanMultiRelTable` checks this and sets the `directionVector` output accordingly.

### Rel group → rel table lookup

```
// Catalog lookup during planning
RelGroupCatalogEntry* group = catalog.getRelGroup("KNOWS");

// Find physical table for (Person → Bot) pair
const RelTableCatalogInfo* info = group->getRelEntryInfo(personTableID, botTableID);
RelTable* physTable = storageManager.getTable(info->oid);

// Iterate all (src, dst) pairs
for (const auto& info : group->getRelEntryInfos()) {
    RelTable* t = storageManager.getTable(info.oid);
    // ...
}
```

### Summary: logical ↔ physical mapping

```
RelGroupCatalogEntry  (1 per relationship type name)
  └── relTableInfos[]
        └── RelTableCatalogInfo  (1 per src×dst node-table pair)
              └── oid → RelTable / IceDiskRelTable / ArrowRelTable / ForeignRelTable
                         (actual storage object, keyed by oid in StorageManager)
```

## SelVector / Semi-Mask Integration

The scan respects any `SelectionVector` attached to the DataChunk before it reads column data. When a **semi-mask** from a hash join is active:

```
Pipeline 1 (build):
  ScanNodeTable(Person) → Filter(age > 30) → HashJoinBuild
  → produces SemiMask: Roaring bitmap of matching node offsets

Pipeline 2 (probe):
  ScanNodeTable(Person):
    initForNodeGroup(nodeGroupIdx):
      semiMask.toSelVector(selVector, nodeGroupIdx)
      // Roaring bitmap → SelVector covering only matching offsets in this group
    column->scan(..., selVector)
      // Filterer skips blocks with no matching position → no decompression, no I/O
```

This is the key insight behind SIP (Sideways Information Passing): the build side's matching set physically prunes the probe-side disk reads at the compressed-block level.

## MVCC Visibility

For committed node groups, the scan checks each row's visibility against the current transaction:

- If a row has been **deleted** by a committed transaction visible to this TX, the row is excluded from the `SelectionVector`.
- If a row has been **updated**, the scan follows the `UndoBuffer` version chain to find the correct version.
- The `hasUpdatesOrDeletions` flag on each node group is a fast-path check: if false, no MVCC overhead is incurred and all rows are emitted directly.

For uncommitted node groups (`TableScanSource::UNCOMMITTED`), the data is in `LocalNodeTable` and is always fully visible to the owning write transaction.

## Output Format

Both scan operators output a `DataChunk` containing:

- One `ValueVector` per requested property column
- A `NODE_ID` vector of `nodeID_t` values (`offset` + `tableID`) — used by downstream join probes and semi-maskers

The `NODE_ID` vector is always produced even if not in the `RETURN` clause, because it is required by the `SemiMasker` and `HashJoinProbe` operators.

## Worked Example: Full Scan

```
Query: MATCH (p:Person) WHERE p.age > 30 RETURN p.name, p.age

ScanNodeTableSharedState: 4 node groups (500,000 nodes total)

Thread 0 claims group 0 (offsets 0–131071):
  column->scan(age, selVector=[0..131071])   ← no semi-mask yet, unfiltered
    → decompresses all bitpack blocks
  DataChunk: { nodeID, name, age }[2048] × ~64 iterations
  → passes to FilterOperator (age > 30)
    → updates selVector to keep matching rows

Thread 1 claims group 1 in parallel — same path

...after HashJoinBuild in a later pipeline...

Thread 0 re-scans group 0 (probe side, semi-mask active):
  semiMask.toSelVector(selVector, group=0)
    → selVector = [41, 1093, 3821, ...]  (sparse — only matching persons)
  column->scan(name, selVector)
    → Filterer skips most compressed blocks
    → only blocks containing selected positions are decompressed
```

## Related Files

- `src/processor/operator/scan/scan_node_table.cpp` — `ScanNodeTable`, morsel assignment, `getNextTuplesInternal()`
- `src/processor/operator/scan/scan_rel_table.cpp` — `ScanRelTable`, CSR traversal
- `src/processor/operator/scan/scan_multi_rel_tables.cpp` — `ScanMultiRelTable`, `RelTableCollectionScanner`
- `src/include/processor/operator/scan/scan_multi_rel_tables.h` — `ScanMultiRelTable`, `DirectionInfo`
- `src/include/processor/operator/scan/scan_rel_table.h` — `ScanRelTableInfo`
- `src/storage/table/node_table.cpp` — `NodeTable::scanInternal()`
- `src/storage/table/column.cpp` — column chunk read, `Filterer`, block skipping
- `src/include/storage/table/rel_table.h` — `RelTableScanState` (including Arrow fields), `LocalRelTableScanState`
- `src/include/storage/table/ice_disk_rel_table.h` — `IceDiskRelTableScanState`, `IceDiskRelTable`
- `src/include/storage/table/arrow_rel_table.h` — `ArrowRelTable`, `fromColumnIdx`/`toColumnIdx`
- `src/include/storage/table/foreign_rel_table.h` — `ForeignRelTable`, `ForeignRelTableScanState`
- `src/include/processor/operator/scan/scan_node_table.h` — `ScanNodeTableSharedState`
- `src/include/catalog/catalog_entry/rel_group_catalog_entry.h` — `RelGroupCatalogEntry`, `RelTableCatalogInfo`
- `src/storage/local_storage/local_node_table.h` — uncommitted node group layout
- `src/include/storage/table/chunked_node_group.h` — in-memory node group
