# Morsel-Driven Parallelism

**Source files:** `src/processor/`, `src/include/processor/`, `docs/morsel_parallelism.md`

## What is a Morsel?

A **morsel** is the unit of work assigned to a worker thread. Each morsel is a contiguous range of rows from a source table. Worker threads atomically claim morsels from a shared counter — no central coordinator is needed.

```
Source table: 393,216 nodes (= 3 node groups × 131,072 nodes each)

Morsel assignments (4 worker threads, native table):
  Thread 1: NodeGroup 0 (offsets 0–131071)     ← 1 morsel = 1 full node group
  Thread 2: NodeGroup 1 (offsets 131072–262143)
  Thread 3: NodeGroup 2 (offsets 262144–393215)
  Thread 4: (no morsel available — threads > node groups, thread 4 is idle)
```

## Morsel Sizes

Different source types use different morsel granularities:

| Source Type | Morsel Size | Notes |
|-------------|-------------|-------|
| Native NodeTable | 1 full node group = 131,072 rows | Matches storage layout (one column chunk per group) |
| Native RelTable | 1 full node group of the src node | All edges from one src node group |
| Arrow table | 2,048 rows | Sub-row-group slicing for finer parallelism |
| Icebug-Disk | 2,048 rows | Arrow-based, same as Arrow table |
| In-memory DataChunk | 2,048 rows | `DEFAULT_VECTOR_CAPACITY` |

## Atomic Morsel Assignment

The shared source state tracks assignment with a single atomic counter:

```cpp
// scan_node_table.h
struct ScanNodeTableSharedState {
    atomic<node_group_idx_t> currentNodeGroupIdx{0};
    uint64_t numNodeGroups;

    // Called by each worker thread to claim the next morsel:
    node_group_idx_t getNextMorsel() {
        auto idx = currentNodeGroupIdx.fetch_add(1, memory_order_relaxed);
        return idx < numNodeGroups ? idx : INVALID_NODE_GROUP_IDX;
    }
};
```

No mutex, no work-stealing queue — just a fetch-add. The ABA problem does not apply here because node group indices are monotonically assigned.

## Worker Thread Model

```
Scheduler:
  N worker threads (default: num_cpu_cores - 1)
  1 main thread (handles client communication, compiles queries)

Per pipeline execution:
  For each worker thread:
    while (true):
      nodeGroupIdx = sharedState.getNextMorsel()
      if nodeGroupIdx == INVALID: break         ← no more morsels
      // Execute full pipeline for this morsel:
      localScanState.initForNodeGroup(nodeGroupIdx)
      while (localScanState.hasMore()):
        localScanState.scan(dataChunk)           ← fills 2048-row chunk
        for each operator in pipeline:
          operator.execute(dataChunk)
      sink.combine()                             ← merge local → shared state
```

## Node Group Morsel

A "native table morsel" is one full node group. All column chunks for that group are read together, providing:
1. **Column-locality** — all data for columns in that group is in adjacent pages
2. **Minimal coordination** — one atomic fetch covers up to 131K rows
3. **Compression alignment** — each column chunk is independently compressed and decoded

## Imbalanced Workloads

If node groups have very different numbers of valid (non-deleted) rows, some threads finish early. The current scheduler does **not** do work-stealing across pipelines — a fast thread that exhausts its morsels simply moves on to the next pipeline. Future work: sub-node-group morsels for better load balance.

## Frontier Scan (Graph Traversal)

For multi-hop graph traversal, the morsel model is applied to the **frontier** (set of active nodes) rather than a static table:

```cpp
// scan_frontier.h
struct ScanFrontierSharedState {
    // The current frontier is a SelVector or Roaring Bitmap
    // Partitioned into chunks of FRONTIER_MORSEL_SIZE (= DEFAULT_VECTOR_CAPACITY)
    atomic<uint32_t> currentFrontierChunkIdx{0};
    uint32_t numFrontierChunks;
};
```

Each thread processes a chunk of frontier nodes, extends their edges, and writes the new frontier nodes into a thread-local buffer. After all threads finish, the local buffers are merged into the next global frontier.

## Worked Example: 4-thread Query

```
Query: MATCH (p:Person) RETURN count(*)
Person table: 400,000 nodes in 4 node groups

Pipeline:
  [ScanNodeTable (sharedState)] → [Aggregate count(*) (localState/sharedState)]

T0 claims group 0 → scans 100K rows → local count = 100,000 → combine() → shared count += 100,000
T1 claims group 1 → scans 100K rows → local count = 100,000 → combine() → shared count += 100,000
T2 claims group 2 → scans 100K rows → local count = 100,000 → combine() → shared count += 100,000
T3 claims group 3 → scans 100K rows → local count = 100,000 → combine() → shared count += 100,000

finalize(): return shared count = 400,000
```

No inter-thread synchronization needed during the scan phase — only the `combine()` step merges local aggregates.

## Related Files

- `src/processor/` — pipeline executor, scheduler
- `src/include/processor/operator/scan/scan_node_table.h` — `ScanNodeTableSharedState`
- `src/include/processor/operator/scan/scan_rel_table.h` — rel table morsel state
- `docs/morsel_parallelism.md` — original design notes in repo
