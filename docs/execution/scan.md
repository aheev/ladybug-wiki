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
- `src/storage/table/node_table.cpp` — `NodeTable::scanInternal()`
- `src/storage/table/column.cpp` — column chunk read, `Filterer`, block skipping
- `src/include/processor/operator/scan/scan_node_table.h` — `ScanNodeTableSharedState`
- `src/storage/local_storage/local_node_table.h` — uncommitted node group layout
- `src/include/storage/table/chunked_node_group.h` — in-memory node group
