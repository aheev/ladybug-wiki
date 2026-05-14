# CSR Adjacency Lists

**Source files:** `src/storage/table/rel_table.cpp`, `src/include/storage/table/rel_table.h`

## Why CSR?

LadybugDB stores relationship (edge) tables using **Compressed Sparse Row (CSR)** format — the same structure used in sparse matrix libraries (scipy, MKL) and many graph systems. CSR is optimal for the dominant access pattern in graph queries: **"give me all neighbors of node X"**.

## CSR Structure

Two arrays represent the entire adjacency list:

```
indptr:  uint64[]   length = num_source_nodes + 1
indices: nodeID_t[] length = num_edges
```

For a graph with nodes A=0, B=1, C=2, D=3 and edges A→B, A→C, A→D, B→C, D→A:

```
Edges:  A→B  A→C  A→D  B→C  D→A

indptr:  [ 0,  3,  4,  4,  5 ]
          ^A   ^B   ^C   ^D   ^end

indices: [ 1,  2,  3,  2,  0 ]
           B   C   D   C   A
```

Neighbors of node X: `indices[ indptr[X] .. indptr[X+1] )`

```
Neighbors of A (X=0): indices[indptr[0] .. indptr[1]] = indices[0..3] = [B, C, D]  ✓
Neighbors of B (X=1): indices[indptr[1] .. indptr[2]] = indices[3..4] = [C]         ✓
Neighbors of C (X=2): indices[indptr[2] .. indptr[3]] = indices[4..4] = []          ✓ (no outgoing)
Neighbors of D (X=3): indices[indptr[3] .. indptr[4]] = indices[4..5] = [A]         ✓
```

::: tip Complexity
- Neighbor lookup: **O(1)** — two array accesses to get start/end offset
- Iteration over k neighbors: **O(k)** — sequential memory reads
- Sequential memory layout = excellent CPU cache behavior
:::

## Rel Table Storage Layout

LadybugDB stores **two CSR structures per relationship table** — one for the forward direction (src→dst) and one for the backward direction (dst→src):

```
RelTable: KNOWS
┌─────────────────────────────────┐
│  fwdIndex (src → dst list)      │
│    indptr[]:  per-source offsets │
│    indices[]: destination nodes  │
│    props[]:   edge properties    │
├─────────────────────────────────┤
│  bwdIndex (dst → src list)      │
│    indptr[]:  per-dest offsets   │
│    indices[]: source nodes       │
│    props[]:   edge properties    │
└─────────────────────────────────┘
```

This enables both `MATCH (a)-[:KNOWS]->(b)` and `MATCH (a)<-[:KNOWS]-(b)` to be served with the same O(1) + O(k) complexity. The `adjList.getNumNbrs(nodeOffset)` call computes `indptr[X+1] - indptr[X]`.

## CSR on Disk — Column Chunks

The CSR arrays are not stored as flat files but as **column chunks** within node groups, using the same columnar storage format as node tables:

```
RelTable CSR storage:
  NodeGroup 0  (nodes 0..131071 as sources)
  ├─ Column: indptr   (uint64 offsets, bitpacked)
  ├─ Column: nbrID    (nodeID_t, compressed)
  └─ Column: [prop0]  (edge property, compressed)
  NodeGroup 1  (nodes 131072..262143 as sources)
  ...
```

This means CSR data benefits from the same column compression, SelVector-based skip, and buffer management as node tables.

## Icebug-Disk CSR Representation

The read-only [Icebug-Disk format](/storage/icebug-disk) stores CSR as two separate Parquet files:

```
indices_KNOWS.parquet   ← one row per edge: [target, prop0, prop1, ...]
indptr_KNOWS.parquet    ← N+1 rows: CSR row pointer array
```

This maps directly to the CSR concept — a consumer can read `indptr` to find the slice of `indices` for any source node.

## Scan Algorithm

```cpp
// Rel table scan: get all neighbors of nodeOffset
uint64_t start = indptr[nodeOffset];
uint64_t end   = indptr[nodeOffset + 1];

for (uint64_t i = start; i < end; i++) {
    nodeID_t neighbor = indices[i];
    // process neighbor
}
```

In the vectorized executor, this is chunked into `DEFAULT_VECTOR_CAPACITY` (2048) sized slices to fill DataChunks.

## Multi-Hop Patterns

For `MATCH (a)-[:KNOWS]->(b)-[:LIKES]->(c)`, the executor:
1. Scans `a` node group → DataChunk of `a` IDs
2. For each `a`, looks up its `KNOWS` neighbors → DataChunk of `b` IDs (may expand or shrink)
3. For each `b`, looks up its `LIKES` neighbors → DataChunk of `c` IDs

The factorized execution model delays materialization — `(a, b, c)` triples are not fully expanded until projection time, avoiding blowup from dense graphs.

## Related Files

- `src/storage/table/rel_table.cpp` — `RelTable::scan()`, CSR index management
- `src/storage/table/csr_node_group.cpp` — CSR-specific node group operations
- `src/include/storage/table/rel_table.h` — `fwdIndex`, `bwdIndex` layout
- `src/processor/operator/scan/scan_rel_table.cpp` — rel scan operator
