# Graph Data Science (GDS) & Variable-Length Traversals

**Source files:** `src/function/gds/`, `src/include/function/gds/`, `src/graph/`, `src/processor/operator/recursive_extend/`

## Overview

LadybugDB's GDS system handles all **graph-algorithm queries** — variable-length path matching, shortest paths, and weighted shortest paths. At query time, Cypher patterns like `(a)-[*1..5]->(b)` are translated by the planner into a `LogicalRecursiveExtend` node, which the physical mapper turns into a `RecursiveExtend` operator backed by one of the GDS functions below.

### GDS Function Catalogue

| Function name | Purpose | Traversal strategy |
|---|---|---|
| `VAR_LEN_JOINS` | Variable-length pattern matching `[*min..max]` | DFS / BFS |
| `SINGLE_SP_DESTINATIONS` | Single-source shortest path (distances only) | BFS |
| `SINGLE_SP_PATHS` | Single-source shortest path with path tracking | BFS |
| `ALL_SP_DESTINATIONS` | All-pairs shortest path (distances only) | BFS per source |
| `ALL_SP_PATHS` | All-pairs shortest path with path tracking | BFS per source |
| `WEIGHTED_SP_DESTINATIONS` | Weighted single-source SP destinations (Dijkstra) | Dijkstra |
| `WEIGHTED_SP_PATHS` | Weighted single-source SP paths (Dijkstra) | Dijkstra |
| `ALL_WEIGHTED_SP_PATHS` | All weighted shortest paths (all equi-cost paths) | Dijkstra |

### Cypher Syntax → GDS Function Mapping

```cypher
-- Variable-length (any path of length 1–5):
MATCH (a)-[*1..5]->(b) RETURN a, b
-- → LogicalRecursiveExtend → RecursiveExtend → VAR_LEN_JOINS

-- Single shortest path:
MATCH (a)-[* SHORTEST 1..5]->(b) RETURN a, b
-- → SINGLE_SP_PATHS

-- All shortest paths (all equi-length shortest):
MATCH (a)-[* ALL SHORTEST]->(b) RETURN a, b
-- → ALL_SP_PATHS

-- Weighted shortest path:
MATCH (a)-[* WSHORTEST (r, e | r.weight) 1..5]->(b) RETURN a, b
-- → WEIGHTED_SP_PATHS

-- With a node filter predicate:
MATCH (a)-[*1..5 (r, n | WHERE n.age > 18)]->(b) RETURN a, b
-- → VAR_LEN_JOINS, graphNodeMask restricts traversable nodes
```

---

## Variable-Length Patterns and RecursiveExtend

### Planner Phase

When the binder encounters `(a)-[*min..max]->(b)`, it creates a `RecursiveRelExpression` that carries the bounds and semantic. The planner wraps it in a `LogicalRecursiveExtend`:

```cpp
// logical_recursive_extend.h
class LogicalRecursiveExtend : public LogicalOperator {
    shared_ptr<NodeExpression>  nodeInput;   // a — the source node
    shared_ptr<NodeExpression>  nodeOutput;  // b — the destination node
    shared_ptr<RelExpression>   rel;         // the *min..max rel expr
    uint32_t                    lowerBound;
    uint32_t                    upperBound;
    RecursivePatternSemantic    semantic;    // WALK | TRAIL | ACYCLIC
};
```

The planner selects the appropriate GDS function based on the pattern keywords:

```
Pattern keyword        → GDS function chosen
──────────────────────────────────────────────
[*min..max]            → VAR_LEN_JOINS
[* SHORTEST]           → SINGLE_SP_PATHS / SINGLE_SP_DESTINATIONS
[* ALL SHORTEST]       → ALL_SP_PATHS / ALL_SP_DESTINATIONS
[* WSHORTEST (r,e|…)]  → WEIGHTED_SP_PATHS / WEIGHTED_SP_DESTINATIONS
```

### Physical Operator: RecursiveExtend

`RecursiveExtend` is the physical operator that drives execution. Its structure:

```cpp
// recursive_extend.h
class RecursiveExtend : public PhysicalOperator {
    shared_ptr<GDSFuncSharedState> sharedState;
    // sharedState->graph  — in-memory graph view
    // sharedState->factorizedTablePool — per-thread output tables
    // sharedState->graphNodeMask       — optional input node mask

    GDSFunction* gdsFunction;  // points to VAR_LEN_JOINS, SINGLE_SP_PATHS, etc.
};
```

Execution flow:

```
RecursiveExtend::execute()
  │
  ├─ 1. Build in-memory Graph from NativeGraph storage
  │       (materialises adjacency lists used by GDS traversal)
  │
  ├─ 2. Apply graphNodeMask (if WHERE clause restricts source/dest)
  │
  ├─ 3. GDSUtils::runVertexCompute(context, sharedState, graph, rjVertexCompute)
  │       ↳ TaskScheduler distributes node groups to worker threads
  │       ↳ Each thread: vc.copy() → processes its node-group range
  │                       → writes (src, dst, length, path) rows to local FactorizedTable
  │
  └─ 4. FactorizedTablePool::merge() → single output table for downstream operators
```

---

## The Graph Abstraction

### `Graph` Interface

All GDS algorithms operate through a uniform `Graph` interface, hiding whether the underlying data is a native LadybugDB table or an Arrow-backed external source:

```cpp
// graph.h
class Graph {
public:
    virtual ~Graph() = default;

    // Scan neighbors of node `nodeID` in the given direction.
    // Fills `chunk` with (nbrNodeID, edgeID, weight?, …).
    virtual void scanFwd(nodeID_t nodeID, NbrScanState::Chunk& chunk) = 0;
    virtual void scanBwd(nodeID_t nodeID, NbrScanState::Chunk& chunk) = 0;

    virtual uint64_t getNumNodes(table_id_t tableID) const = 0;
    virtual uint64_t getNumRels(table_id_t tableID) const = 0;
};
```

### `NativeGraph`

`NativeGraph` wraps the native `NodeTable` / `RelTable` storage. It is constructed once per query execution and kept in `GDSFuncSharedState::graph`:

```cpp
// native_graph.h
class NativeGraph : public Graph {
    ClientContext*                  clientContext;
    NativeGraphEntry                graphEntry;   // which node+rel tables form the graph
    vector<RelTableScanState>       fwdScanStates;
    vector<RelTableScanState>       bwdScanStates;

    void scanFwd(nodeID_t nodeID, NbrScanState::Chunk& chunk) override;
    void scanBwd(nodeID_t nodeID, NbrScanState::Chunk& chunk) override;
};
```

### `NbrScanState::Chunk`

Each `scanFwd` / `scanBwd` call fills a vectorized batch of neighbor information:

```cpp
// nbr_scan_state.h
struct NbrScanState::Chunk {
    ValueVector* nbrNodeIDVector;   // neighbor node IDs (tableID + offset)
    ValueVector* edgeIDVector;      // edge IDs (for path tracking)
    ValueVector* weightVector;      // edge weight property (Dijkstra only)
    uint64_t     size;              // number of valid neighbors in this batch
};
```

This vectorized design means even the neighbor expansion step operates on batches of up to `DEFAULT_VECTOR_CAPACITY` (2,048) neighbors at a time, rather than one edge at a time.

---

## GDS Shared State and Bind Data

### `GDSFuncSharedState`

Holds everything shared across all worker threads for one GDS query execution:

```cpp
// gds_function.h
struct GDSFuncSharedState {
    unique_ptr<Graph>            graph;             // in-memory graph view
    FactorizedTablePool          factorizedTablePool; // per-thread output tables
    unique_ptr<NodeOffsetMaskMap> graphNodeMask;    // optional traversal mask
};
```

### `GDSBindData`

Captures the static, query-compile-time parameters:

```cpp
struct GDSBindData : public FunctionBindData {
    NativeGraphEntry  graphEntry;  // which node/rel tables form the traversal graph
    expression_vector output;      // output columns: src_id, dst_id, length, path_nodes, path_edges
};
```

### `GDSConfig`

Per-algorithm runtime configuration resolved from the Cypher pattern:

```cpp
struct GDSConfig {
    uint32_t         lowerBound;       // min path length
    uint32_t         upperBound;       // max path length
    std::string      weightColumnName; // for Dijkstra: which rel property is the weight
};
```

---

## BFSGraph: Parent-Pointer Structure

Shortest-path GDS functions need to remember **how** each node was reached so that the path can be reconstructed. This is managed by `BFSGraph` (`bfs_graph.cpp`).

### `DenseBFSGraph`

```cpp
// bfs_graph.h
class DenseBFSGraph {
    // One slot per node in the graph, indexed by node offset.
    // Each slot is a pointer to a ParentList (linked list of parents).
    vector<atomic<ParentList*>> parents;   // size = numNodes

    ObjectBlock<ParentList> block;  // slab allocator, block size = 512 KB
};
```

Each `ParentList` node records one parent edge:

```cpp
struct ParentList {
    uint32_t   iter;         // BFS iteration (= distance from source)
    nodeID_t   boundNodeID;  // parent node
    relID_t    edgeID;       // edge taken to reach this node
    nodeID_t   nbrNodeID;    // this node
    bool       fwdEdge;      // direction of traversal
    ParentList* next;        // next parent (for all-shortest-paths; NULL for single)
};
```

### Memory Allocation: `ObjectBlock`

`ObjectBlock<ParentList>` is a fixed-size slab allocator that avoids per-object `malloc` overhead during high-throughput BFS:

```
ObjectBlock (512 KB)
┌──────────────────────────────────────────────────────┐
│ ParentList[0] │ ParentList[1] │ ParentList[2] │ ...  │
│  (32 bytes)   │  (32 bytes)   │  (32 bytes)   │      │
└──────────────────────────────────────────────────────┘
 ↑ bumped via atomic fetch_add — no mutex needed
```

When a block is full, a new block is allocated and linked. Each thread gets its own block reference to minimise contention.

### Atomic Parent Insertion

Two variants handle single vs. all shortest paths:

```cpp
// Single shortest path — CAS to set the FIRST parent only:
void DenseBFSGraph::addSingleParent(
    uint32_t iter, nodeID_t boundNodeID, relID_t edgeID,
    nodeID_t nbrNodeID, bool fwdEdge, ObjectBlock<ParentList>& block)
{
    auto* newNode = block.alloc();
    newNode->set(iter, boundNodeID, edgeID, nbrNodeID, fwdEdge, nullptr);
    ParentList* expected = nullptr;
    // CAS: only succeeds for the first writer; all others discard their node
    parents[nbrNodeID.offset].compare_exchange_strong(expected, newNode);
}

// All shortest paths — append to the list (all parents at the same depth):
void DenseBFSGraph::addParent(
    uint32_t iter, nodeID_t boundNodeID, relID_t edgeID,
    nodeID_t nbrNodeID, bool fwdEdge, ObjectBlock<ParentList>& block)
{
    auto* newNode = block.alloc();
    newNode->set(iter, boundNodeID, edgeID, nbrNodeID, fwdEdge, nullptr);
    // Spin-CAS to prepend newNode to the existing list
    ParentList* head = parents[nbrNodeID.offset].load();
    do {
        newNode->next = head;
    } while (!parents[nbrNodeID.offset].compare_exchange_weak(head, newNode));
}
```

### Initialisation

`DenseBFSGraph::init()` zeroes all parent pointers in parallel using `BFSGraphInitVertexCompute`:

```cpp
class BFSGraphInitVertexCompute : public VertexCompute {
    void vertexCompute(offset_t startOffset, offset_t endOffset, table_id_t) override {
        for (auto i = startOffset; i < endOffset; i++) {
            graph->parents[i].store(nullptr, memory_order_relaxed);
        }
    }
};

void DenseBFSGraph::init(ExecutionContext& ctx, Graph& graph) {
    BFSGraphInitVertexCompute vc{this};
    GDSUtils::runVertexCompute(ctx, sharedState, graph, vc);
}
```

---

## Frontier-Based BFS Traversal

### Data Structures

```cpp
// dense_frontier.h
class DenseFrontier {
    // Bitarray: bit i = 1 means node with offset i is in this frontier
    vector<uint64_t> bits;   // size = ceil(numNodes / 64)

    void set(offset_t nodeOffset);
    bool isSet(offset_t nodeOffset) const;
    void clear();
};

// sp_frontier_pair.h
struct SPFrontierPair {
    DenseFrontier* curFrontier;   // nodes being expanded this iteration
    DenseFrontier* nextFrontier;  // nodes discovered this iteration
    uint32_t       iter;          // current BFS depth (= path length so far)

    static constexpr uint32_t FRONTIER_UNVISITED = UINT32_MAX;

    // Returns FRONTIER_UNVISITED if the node hasn't been reached yet,
    // or the iteration number at which it was first reached.
    uint32_t getNextFrontierValue(offset_t nodeOffset) const;
};
```

### Step-by-Step BFS Algorithm

```
Initialise:
  curFrontier  = { source node }
  nextFrontier = { }
  iter         = 0
  visited[all] = FRONTIER_UNVISITED
  visited[src] = 0

While curFrontier is non-empty AND iter < upperBound:
  ┌─ For each node u in curFrontier  (parallel — see §Parallelism)
  │   For each neighbor v of u (via graph.scanFwd / scanBwd):
  │     if visited[v] == FRONTIER_UNVISITED:
  │       visited[v] = iter + 1
  │       nextFrontier.set(v)
  │       if trackingPaths:
  │           bfsGraph.addSingleParent(iter, u, edgeID(u→v), v, fwd, block)
  └─

  swap(curFrontier, nextFrontier)
  nextFrontier.clear()
  iter++

If iter >= lowerBound:
  Emit paths: for each v reachable in [lowerBound, upperBound],
              walk parent pointers back to source to reconstruct path
```

ASCII diagram of two BFS iterations on a small graph:

```
         iter=0           iter=1           iter=2
         frontier         frontier         frontier
         {A}              {B,C}            {D,E,F}

    A ──→ B ──→ D
    │           │
    └──→ C ──→ E
              │
              └──→ F

Visited after iter=0:  A=0
Visited after iter=1:  A=0  B=1  C=1
Visited after iter=2:  A=0  B=1  C=1  D=2  E=2  F=2
```

---

## Shortest Path Variants

### Single Shortest Path (`SINGLE_SP_PATHS` — `ssp_paths.cpp`)

Uses `SSPPathsEdgeCompute` to process each edge during BFS expansion. For every neighbor, it checks whether the node is unvisited and, if so, records one parent:

```cpp
// ssp_paths.cpp
class SSPPathsEdgeCompute : public EdgeCompute {
    SPFrontierPair*    frontierPair;
    BFSGraphManager*   bfsGraphManager;
    ObjectBlock<ParentList>& block;

    void edgeCompute(nodeID_t boundNodeID, NbrScanState::Chunk& chunk, bool isFwd) override {
        for (auto i = 0u; i < chunk.size; i++) {
            auto nbrNodeID = chunk.nbrNodeIDVector->getValue<nodeID_t>(i);
            auto edgeID    = chunk.edgeIDVector->getValue<relID_t>(i);

            if (frontierPair->getNextFrontierValue(nbrNodeID.offset) == FRONTIER_UNVISITED) {
                // First time we see nbrNodeID — record one parent
                frontierPair->setNextFrontierValue(nbrNodeID.offset, frontierPair->iter + 1);
                bfsGraphManager->getCurrentGraph()->addSingleParent(
                    frontierPair->iter, boundNodeID, edgeID, nbrNodeID, isFwd, block);
            }
        }
    }
};
```

### All Shortest Paths (`ALL_SP_PATHS`)

Identical to `SINGLE_SP_PATHS` except `addParent` is used instead of `addSingleParent`. This allows multiple parent entries for the same node (all equi-length paths are tracked). The CAS loop appends each discovered parent to the linked list.

### Weighted Shortest Path (`WEIGHTED_SP_PATHS` — Dijkstra)

Instead of a frontier bitarray, weighted SP uses a **priority queue** (min-heap) keyed on cumulative edge weight. The `NbrScanState::Chunk` includes a `weightVector` column:

```
Priority queue:  { (dist=0, src) }

While pq non-empty:
  (dist_u, u) = pq.pop_min()
  if u already settled: continue
  settled[u] = true

  For each neighbor v of u:
    w     = chunk.weightVector[v]
    dist_v = dist_u + w
    if dist_v < best_dist[v]:
      best_dist[v] = dist_v
      parent[v]    = u  (via addSingleParent)
      pq.push( (dist_v, v) )

Emit paths for all v in [lowerBound, upperBound] distance range
```

`ALL_WEIGHTED_SP_PATHS` relaxes the early-termination condition: all paths with the same minimum cost are retained (multiple parent records per node).

---

## Parallelism in GDS

### `GDSUtils::runVertexCompute`

The main entry point for parallel GDS work:

```cpp
// gds_utils.h
namespace GDSUtils {
    void runVertexCompute(
        ExecutionContext&    context,
        GDSFuncSharedState& sharedState,
        Graph&              graph,
        VertexCompute&      vc          // prototype — each thread gets vc.copy()
    );
}
```

Internally this submits tasks to the `TaskScheduler`. Each task covers one **node group** (up to 131,072 nodes):

```
TaskScheduler dispatches node groups across worker threads:

  Thread 0: nodeGroup 0  → vc0 = vc.copy()
                           vc0.vertexCompute(offset 0,       131071,   tableID)
                           vc0.combine() → merge local FTable into pool

  Thread 1: nodeGroup 1  → vc1 = vc.copy()
                           vc1.vertexCompute(offset 131072,  262143,   tableID)
                           vc1.combine()

  Thread 2: nodeGroup 2  → vc2 = vc.copy()
                           vc2.vertexCompute(offset 262144,  393215,   tableID)
                           vc2.combine()
  …
```

### `VertexCompute` Interface

```cpp
// vertex_compute.h
class VertexCompute {
public:
    virtual unique_ptr<VertexCompute> copy() = 0;  // per-thread clone

    // Called once per table before the range loop.
    // Return false to skip all offsets for this table entirely.
    virtual bool beginOnTable(table_id_t tableID) = 0;

    // Process nodes [startOffset, endOffset) in tableID.
    virtual void vertexCompute(
        offset_t startOffset, offset_t endOffset, table_id_t tableID) = 0;

    // Called after all node groups are done; merge local state upward.
    virtual void combine() {}
};
```

### `RJVertexCompute` (Recursive Join Result Writer)

`RJVertexCompute` is the `VertexCompute` implementation used to write result rows after the BFS/DFS traversal is complete:

```cpp
// rj_vertex_compute.h
class RJVertexCompute : public VertexCompute {
    FactorizedTable*   localFTable;   // thread-local output table
    BFSGraph*          bfsGraph;
    SPFrontierPair*    frontierPair;

    bool beginOnTable(table_id_t tableID) override {
        // Skip tables not in the destination node set
        return destNodeTableIDs.contains(tableID);
    }

    void vertexCompute(offset_t start, offset_t end, table_id_t tableID) override {
        for (auto offset = start; offset < end; offset++) {
            if (!isReachable(offset, tableID)) continue;
            // Walk parent pointers → reconstruct path
            auto [pathNodes, pathEdges] = reconstructPath(bfsGraph, {tableID, offset});
            localFTable->append({srcID, {tableID, offset}, pathLength, pathNodes, pathEdges});
        }
    }

    void combine() override {
        sharedState->factorizedTablePool.merge(std::move(localFTable));
    }
};
```

### `FactorizedTablePool`

After all threads have called `combine()`, the pool holds one `FactorizedTable` per thread. The main thread merges them into a single output table that the downstream pipeline operators consume:

```
Thread 0 local FTable: [ (A→D, len=2, …), (A→E, len=2, …) ]
Thread 1 local FTable: [ (A→F, len=3, …) ]
Thread 2 local FTable: [ ]

FactorizedTablePool::merge():
  → Output FTable: [ (A→D, 2, …), (A→E, 2, …), (A→F, 3, …) ]
```

### Progress Bar Integration

Long-running GDS queries report progress via the client's progress bar:

```cpp
// recursive_extend.cpp
auto& progressBar = ProgressBar::Get(*clientContext);
progressBar.startProgress("GDS traversal", totalIterations);
for (uint32_t iter = 0; iter < upperBound; iter++) {
    runOneFrontierIteration();
    progressBar.incrementProgress();
}
progressBar.finishProgress();
```

---

## RecursivePatternSemantic: WALK / TRAIL / ACYCLIC

The `RecursivePatternSemantic` enum controls how the traversal handles repeated nodes and edges:

| Semantic | Repeated nodes? | Repeated edges? | Cypher default |
|---|---|---|---|
| `WALK` | ✓ allowed | ✓ allowed | Yes |
| `TRAIL` | ✓ allowed | ✗ forbidden | No |
| `ACYCLIC` | ✗ forbidden | ✗ forbidden | No |

```cpp
enum class RecursivePatternSemantic { WALK, TRAIL, ACYCLIC };
```

These semantics are enforced during path reconstruction (for BFS-based shortest paths) and during DFS expansion (for `VAR_LEN_JOINS`). For DFS, each recursive frame maintains a visited-node / visited-edge set depending on the semantic:

```
WALK:    no visited tracking — simply recurse up to upperBound depth
TRAIL:   carry visited_edges set through recursive frames
ACYCLIC: carry visited_nodes set through recursive frames
```

For BFS-based shortest path functions, `WALK` is the only semantically meaningful option (BFS already finds shortest paths without revisiting nodes at the same distance layer).

---

## Input Node Masks

### `NodeOffsetMaskMap`

When the Cypher query contains a `WHERE` predicate that filters on source or destination nodes, the planner can push that predicate into the GDS operator as a **node mask**:

```cypher
MATCH (a:Person)-[*1..3]->(b:Person)
WHERE a.country = 'US' AND b.age > 30
RETURN a, b
```

The executor:
1. Evaluates `a.country = 'US'` → builds a `NodeOffsetMaskMap` for `a` (the source mask)
2. Evaluates `b.age > 30` → builds a `NodeOffsetMaskMap` for `b` (the destination mask)
3. Stores both in `GDSFuncSharedState::graphNodeMask`

During BFS/DFS traversal, the mask is checked before adding a node to the frontier or before emitting it as a result:

```cpp
// Check source mask: only start BFS from nodes in the source mask
if (sharedState.graphNodeMask &&
    !sharedState.graphNodeMask->isSrcMasked(nodeID)) {
    continue;  // skip — not in the allowed source set
}

// Check dest mask: only emit paths whose destination is in the dest mask
if (sharedState.graphNodeMask &&
    !sharedState.graphNodeMask->isDstMasked(nbrNodeID)) {
    continue;
}
```

### `NodeOffsetMaskMap` Structure

```cpp
// node_offset_mask_map.h
class NodeOffsetMaskMap {
    // Per-table bitmask: offset i = 1 means node i passes the predicate
    unordered_map<table_id_t, RoaringBitmap> masks;

    bool isMasked(table_id_t tableID, offset_t offset) const {
        auto it = masks.find(tableID);
        return it != masks.end() && it->second.contains(offset);
    }
};
```

The mask is populated by the same pipeline that scans the source/dest node tables and evaluates the WHERE predicates — it is conceptually equivalent to the [Semi-Mask](/execution/semi-mask) used for hash joins, but adapted for graph traversal inputs.

---

## End-to-End Worked Example

```
Query:
  MATCH (a:Person)-[* SHORTEST 1..3]->(b:Person)
  WHERE a.name = 'Alice'
  RETURN a, b, length(path) AS dist

Graph (Person nodes: A, B, C, D; KNOWS edges):
  A → B → D
  A → C → D

Execution:
  1. Planner creates LogicalRecursiveExtend(lowerBound=1, upperBound=3,
       semantic=WALK, gdsFunc=SINGLE_SP_PATHS)

  2. RecursiveExtend::execute():
       Build NativeGraph (materialise KNOWS adjacency)
       Apply source mask: { A } (from a.name = 'Alice')

  3. BFS iter=0:
       curFrontier = {A},  visited = {A:0}
       Expand A → neighbors {B, C}
       addSingleParent(iter=0, A, edgeAB, B, fwd)
       addSingleParent(iter=0, A, edgeAC, C, fwd)
       nextFrontier = {B, C},  visited = {A:0, B:1, C:1}

  4. BFS iter=1:
       curFrontier = {B, C}
       Expand B → neighbor {D}: FRONTIER_UNVISITED → record parent
         addSingleParent(iter=1, B, edgeBD, D, fwd)
       Expand C → neighbor {D}: ALREADY VISITED (visited[D]=2) → skip
       nextFrontier = {D},  visited = {A:0, B:1, C:1, D:2}

  5. iter=2 > upperBound=3? No, but frontier empty after expanding D → stop

  6. RJVertexCompute emits rows for iter in [1..3]:
       B  (dist=1): path A→B
       C  (dist=1): path A→C
       D  (dist=2): path A→B→D   (single shortest — only one parent recorded)

  7. FactorizedTablePool merges per-thread local tables → downstream pipeline
```

---

## Related Files

- `src/function/gds/gds_function_collection.h` — GDS function registry (`VAR_LEN_JOINS`, `SINGLE_SP_PATHS`, etc.)
- `src/function/gds/rec_joins.cpp` — `VAR_LEN_JOINS` implementation (DFS recursive joins)
- `src/function/gds/ssp_paths.cpp` — `SINGLE_SP_PATHS` / `SSPPathsEdgeCompute`
- `src/function/gds/ssp_destinations.cpp` — `SINGLE_SP_DESTINATIONS` (distances only)
- `src/function/gds/all_sp_paths.cpp` — `ALL_SP_PATHS` (all equi-length shortest)
- `src/function/gds/weighted_sp.cpp` — `WEIGHTED_SP_PATHS` / `WEIGHTED_SP_DESTINATIONS` (Dijkstra)
- `src/function/gds/bfs_graph.cpp` — `DenseBFSGraph`, `ObjectBlock<ParentList>`, parent insertion
- `src/function/gds/sp_frontier_pair.cpp` — `SPFrontierPair`, `DenseFrontier`, sentinel values
- `src/function/gds/gds_utils.cpp` — `GDSUtils::runVertexCompute()`, `runEdgeCompute()`
- `src/function/gds/rj_vertex_compute.h` — `RJVertexCompute` (result row writer)
- `src/processor/operator/recursive_extend/recursive_extend.cpp` — physical operator
- `src/include/processor/operator/recursive_extend/recursive_extend.h` — `RecursiveExtend` header
- `src/graph/graph.h` — `Graph` abstract interface
- `src/graph/native_graph.cpp` — `NativeGraph` implementation
- `src/graph/nbr_scan_state.h` — `NbrScanState::Chunk`
- `src/include/planner/logical_plan/logical_recursive_extend.h` — `LogicalRecursiveExtend`
- `src/binder/expression/recursive_rel_expression.h` — `RecursivePatternSemantic`
- `src/include/function/gds/gds_function.h` — `GDSFuncSharedState`, `GDSBindData`, `GDSConfig`
- `src/include/function/gds/node_offset_mask_map.h` — `NodeOffsetMaskMap`
