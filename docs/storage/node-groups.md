# Node Groups & Columnar Layout

**Source files:** `src/storage/table/node_table.cpp`, `src/storage/table/node_group.cpp`, `src/include/storage/table/node_group.h`

## What is a Node Group?

A **node group** is the fundamental horizontal partition unit for node tables. Every node table is split into fixed-size node groups of `NODE_GROUP_SIZE = 2^NODE_GROUP_SIZE_LOG2` nodes (default: `2^17 = 131072` nodes per group).

```
Node Table: Person  (500,000 nodes)
┌──────────────────────────────────────────────┐
│  NodeGroup 0  │  offsets  0 – 131,071         │
│  NodeGroup 1  │  offsets  131,072 – 262,143   │
│  NodeGroup 2  │  offsets  262,144 – 393,215   │
│  NodeGroup 3  │  offsets  393,216 – 500,000   │  (partial)
└──────────────────────────────────────────────┘
```

Global offset arithmetic:
```
global_offset = node_group_idx * NODE_GROUP_SIZE + offset_within_group
```

Node IDs (`nodeID_t`) encode both the table and position:
```cpp
struct nodeID_t {
    offset_t  offset;   // position within the node table
    table_id_t tableID; // which table this node belongs to
};
```

## Columnar Storage Within a Node Group

Each node group stores **one column chunk per property column**. No rows — only columns.

```
NodeGroup 0 for Person(name STRING, age INT64)
┌──────────────────────────────┐
│  ColumnChunk: name           │  ← all 131,072 name values
│    data pages (compressed)   │
│    null bitmap               │
│    metadata (min/max, etc.)  │
├──────────────────────────────┤
│  ColumnChunk: age            │  ← all 131,072 age values
│    data pages (bit-packed)   │
│    null bitmap               │
└──────────────────────────────┘
```

This layout means:
- Scanning only `age` never reads `name` pages from disk
- Compression is per-column: integers compress far better than strings
- Min/max metadata enables predicate pushdown at the node group level (skip entire group if `age` max < filter value)

## Column Chunk Compression

Each `ColumnChunk` independently chooses its compression codec at write time:

| Codec | Best for | Notes |
|-------|----------|-------|
| **BitPacking** | Low-cardinality integers | Stores values in minimum bits |
| **RLE** (Run-Length Encoding) | Sorted / repetitive data | Run count + value pairs |
| **Dictionary** | Low-cardinality strings | Dictionary + integer index column |
| **Uncompressed** | Fallback | Used for random high-entropy data |

The `Filterer` struct in `column.cpp` uses the `SelectionVector` to **skip compressed blocks entirely** when only a subset of rows are needed:

```cpp
// column.cpp — readCompressedValuesToVector (simplified)
struct Filterer {
    const SelectionVector& selVector;
    uint16_t posInSelVector;

    // Returns true only if [startIdx, endIdx) contains a selected position.
    // When false, the entire block is skipped — no decompression.
    bool operator()(offset_t startIdx, offset_t endIdx) {
        return (posInSelVector < selVector.getSelSize() &&
                isInRange(selVector[posInSelVector] - offsetInVector, startIdx, endIdx));
    }
};
```

::: tip Key insight
The SelVector is the bridge between logical filtering (semi masks, predicates) and physical I/O skipping. A semi mask produced from a hash join gets converted to a SelVector, which then causes the column scan to skip entire RLE/bitpack blocks on disk.
:::

## Committed vs Uncommitted Node Groups

The scanner distinguishes two sources:

```cpp
enum class TableScanSource : uint8_t {
    COMMITTED,    // on-disk, buffer-managed pages
    UNCOMMITTED,  // in LocalNodeTable (write-tx only, in-memory)
    NONE,
};
```

During a write transaction, newly inserted nodes live in `LocalNodeTable` (in-memory). The scanner processes all committed groups first, then uncommitted ones:

```cpp
// ScanNodeTableSharedState::nextMorsel (scan_node_table.cpp)
if (currentCommittedGroupIdx < numCommittedNodeGroups) {
    nodeScanState.nodeGroupIdx = currentCommittedGroupIdx++;  // atomic
    nodeScanState.source = TableScanSource::COMMITTED;
    return;
}
if (currentUncommittedGroupIdx < numUncommittedNodeGroups) {
    nodeScanState.nodeGroupIdx = currentUncommittedGroupIdx++;
    nodeScanState.source = TableScanSource::UNCOMMITTED;
    return;
}
```

## Scan Flow

```
ScanNodeTable operator
│
├─ initGlobalState()
│    └─ ScanNodeTableSharedState::initialize()
│         counts numCommittedNodeGroups from table->getNumCommittedNodeGroups()
│
├─ getNextTuplesInternal()  [called per thread, per morsel]
│    │
│    ├─ while (table->scan(transaction, *scanState)):
│    │    └─ NodeTable::scanInternal()
│    │         └─ scanState.scanNext(transaction)
│    │              ├─ reads ColumnChunk pages via BufferManager
│    │              └─ applies SelVector / semi-mask filter
│    │
│    └─ sharedState->nextMorsel(*scanState)  [when morsel exhausted]
│         └─ atomic increment of currentCommittedGroupIdx
```

## Node Group Metadata

Each node group tracks:
- `numCommittedRows` — rows visible to committed transactions
- `hasUpdatesOrDeletions` — dirty flag for MVCC version checks
- `columnChunks[]` — one per column, stores buffer-managed page ranges

## Related Files

- `src/storage/table/node_group.cpp` — node group scan and insert logic
- `src/storage/table/column.cpp` — column chunk read/write, `Filterer` struct
- `src/storage/table/node_table.cpp` — `NodeTable::scanInternal()`
- `src/processor/operator/scan/scan_node_table.cpp` — morsel assignment, `nextMorsel()`
- `src/include/storage/table/chunked_node_group.h` — in-memory node group layout
