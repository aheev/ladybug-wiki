# Graph Data Science (GDS) & Variable-Length Traversals

**Source files:**
- `src/include/function/gds/gds.h`, `src/function/gds/`
- `src/include/function/gds/gds_frontier.h`
- `src/include/function/gds/gds_task.h`
- `src/include/function/gds/compute.h`
- `src/include/function/gds/bfs_graph.h`, `src/function/gds/bfs_graph.cpp`
- `src/include/function/gds/gds_utils.h`, `src/function/gds/gds_utils.cpp`
- `src/include/function/gds/rec_joins.h`
- `src/include/graph/graph.h`, `src/include/graph/on_disk_graph.h`
- `src/include/graph/graph_entry.h`, `src/include/graph/graph_entry_set.h`
- `src/processor/operator/recursive_extend/recursive_extend.cpp`

---

## Overview

LadybugDB's GDS system handles all **graph-algorithm queries** — variable-length path matching, shortest paths, and weighted shortest paths. At query time, Cypher patterns like `(a)-[*1..5]->(b)` are translated by the planner into a `LogicalRecursiveExtend` node, which the physical mapper turns into a `RecursiveExtend` operator backed by one of the GDS functions below.

The system is built around three layered abstractions:

1. **`GDSFunction`** — algorithm descriptor (bind, plan, init shared state)
2. **`Graph` / `OnDiskGraph`** — lazy storage reader for the projected subgraph
3. **Frontier engine** — sparse/dense adaptive BFS frontier with parallel morsel dispatch

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

## GDS Class Hierarchy

### `GDSFunction`

```cpp
// gds.h
class GDSFunction : public TableFunction {
public:
    // Static helpers called by PlanMapper
    static NativeGraphEntry bindGraphEntry(ClientContext*, GDSBindInput*);
    static unique_ptr<GDSFuncSharedState> initSharedState(TableFunctionInitInput&);
    static unique_ptr<LogicalOperator> getLogicalPlan(ClientContext*, GDSBindData*);
    static unique_ptr<PhysicalOperator> getPhysicalPlan(ClientContext*, GDSBindData*,
                                                         physical_op_vector_t children);
};
```

`GDSFunction` is the algorithm descriptor.  It tells the planner and mapper *how* to
construct the logical and physical operator trees.  No algorithm state lives here.

### `GDSBindData`

```cpp
// gds.h
struct GDSBindData : public TableFuncBindData {
    NativeGraphEntry graphEntry;       // projected subgraph spec
    expression_vector outputExpressions;
    shared_ptr<processor::FactorizedTable> sharedTable; // output accumulator
};
```

`NativeGraphEntry` carries two vectors:
- `vector<NativeGraphEntryTableInfo> nodeInfos` — one entry per node table in the projection
- `vector<NativeGraphEntryTableInfo> relInfos` — one entry per rel table in the projection

Each `NativeGraphEntryTableInfo` holds a `TableCatalogEntry*` plus optional `Expression`
pointers for the node/rel variable and for a filter predicate.

### `GDSFuncSharedState`

```cpp
// gds.h
struct GDSFuncSharedState : public FuncSharedState {
    unique_ptr<graph::Graph>        graph;         // OnDiskGraph instance
    FactorizedTablePool             tablePool;     // per-thread output tables
    graph::NodeOffsetMaskMap*       graphNodeMask; // optional source-node filter
};
```

`GDSFuncSharedState` is instantiated once per query execution and shared by all worker
threads.  The `graph` field is an `OnDiskGraph` that lazily scans the underlying
`NodeTable` / `RelTable` storage.

### `GDSComputeState`

```cpp
// gds.h
struct GDSComputeState {
    shared_ptr<FrontierPair>      frontierPair;   // current / next frontier
    unique_ptr<EdgeCompute>       edgeCompute;    // per-edge callback
    unique_ptr<GDSAuxiliaryState> auxiliaryState; // algorithm-specific state (e.g. BFSGraph)
};
```

`GDSComputeState` is created per algorithm invocation by `RJAlgorithm::getComputeState()`.
It bundles the frontier state machine with the algorithm's edge-processing logic.

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

    // Return a copy of this graph (lightweight — no large data copied).
    // Callers MUST copy before using in parallel worker threads.
    virtual unique_ptr<Graph> copy() = 0;

    // Scan neighbors of node `nodeID` in the given direction.
    // Returns an EdgeIterator over NbrScanState::Chunk batches.
    virtual EdgeIterator scanFwd(nodeID_t nodeID, NbrScanState& state) = 0;
    virtual EdgeIterator scanBwd(nodeID_t nodeID, NbrScanState& state) = 0;

    // Vertex scanner for property reads
    virtual VertexIterator scanVertices(offset_t begin, offset_t end,
                                        VertexScanState& state) = 0;

    // Projected subgraph spec
    virtual NativeGraphEntry* getGraphEntry() = 0;

    // Per-source-table: which rel tables to scan
    virtual vector<GraphRelInfo> getRelInfos(table_id_t srcTableID) = 0;

    virtual uint64_t getNumNodes(table_id_t tableID) const = 0;
    virtual uint64_t getNumRels(table_id_t tableID) const = 0;
};
```

### `OnDiskGraph`

`OnDiskGraph` is the concrete implementation of `Graph` for native storage. It is
constructed once per query execution and kept in `GDSFuncSharedState::graph`. The
`Graph` interface contract states that `copy()` must be called before using the graph
across parallel threads; `OnDiskGraph::copy()` is lightweight (creates a new scan-state
wrapper pointing at the same underlying `NodeTable` / `RelTable` objects).

```cpp
// on_disk_graph.h
class OnDiskGraph : public Graph {
    ClientContext*         clientContext;
    NativeGraphEntry       graphEntry;     // projected node/rel tables + predicates
    NodeOffsetMaskMap*     nodeOffsetMaskMap;  // optional source node filter

    // Per-table scan handles (NOT thread-safe — use copy() before parallel use)
    table_id_map_t<NodeTable*>  nodeIDToNodeTable;
    vector<GraphRelInfo>        relInfos;
};
```

Neighbor scans use `OnDiskGraphNbrScanState` internally:

```cpp
struct OnDiskGraphNbrScanState : public NbrScanState {
    // One InnerIterator per (rel table × direction)
    vector<InnerIterator> innerIterators;
};

struct InnerIterator {
    RelTableScanState scanState;
    ExpressionEvaluator* predicateEvaluator;  // null if no predicate
    SemiMask*            semiMask;             // null if no node mask

    bool next(RelTable& table);  // fills chunk; returns false when exhausted
};
```

`InnerIterator::next()` calls `RelTable::scan()`, then applies predicate filtering and
semi-mask filtering in-place on the result vector before returning the chunk.

### `NbrScanState::Chunk`

Each `scanFwd` / `scanBwd` iteration step fills a vectorized batch:

```cpp
// graph.h
struct NbrScanState::Chunk {
    ValueVector* nbrNodeIDVector;   // neighbor node IDs (tableID + offset)
    ValueVector* edgeIDVector;      // edge IDs (for path tracking)
    ValueVector* weightVector;      // edge weight property (Dijkstra only; may be null)
    uint64_t     size;              // number of valid neighbors in this batch
};
```

This vectorized design means even the neighbor expansion step operates on batches of up to
`DEFAULT_VECTOR_CAPACITY` (2,048) neighbors at a time, rather than one edge at a time.

### `getRelInfos` — which rel tables to scan

```cpp
// graph.h
struct GraphRelInfo {
    NodeTable*      srcTable;
    NodeTable*      dstTable;
    RelGroupCatalogEntry* relGroupEntry;
    table_id_t      relTableID;
};
```

`getRelInfos(srcTableID)` filters the `NativeGraphEntry`'s rel infos to those where the
source matches `srcTableID`.  `GDSUtils::runOneIteration` iterates over `nodeInfos` and
calls `getRelInfos(tableID)` for each to enumerate which rel tables to scan per BFS step.

---

## Frontier Engine

The frontier engine manages which nodes are "active" in the current BFS iteration and
which should be activated in the next.

### Sparse vs. Dense Frontiers

```cpp
// gds_frontier.h
using iteration_t = uint16_t;
constexpr iteration_t FRONTIER_UNVISITED       = UINT16_MAX;
constexpr iteration_t FRONTIER_INITIAL_VISITED = 0;
```

| Class | Storage | Concurrency | Best for |
|-------|---------|-------------|---------|
| `SparseFrontier` | Per-table hash map `offset→iteration_t` via `GDSSparseObjectManager` | Not atomic | Few active nodes |
| `DenseFrontier` | Flat array `atomic<iteration_t>[]` sized to max offset | Atomic | Many active nodes |

The key difference: `DenseFrontier` uses atomics for lock-free parallel writes; `SparseFrontier`
uses hash maps and is single-threaded (used only on the non-concurrent side of an iteration).

### `FrontierPair`

```cpp
// gds_frontier.h
class FrontierPair {
    atomic<bool>  hasActiveNodesForNextIter_;
    iteration_t   curIter;

    virtual void beginNewIteration() = 0;   // swap cur↔next, clear next
    virtual bool continueNextIter(iteration_t maxIter) const;

    bool hasActiveNodes() const { return hasActiveNodesForNextIter_.load(); }
};
```

`beginNewIteration()` swaps the current and next frontier, resets the active-node flag,
and increments `curIter`.  `continueNextIter(maxIter)` returns `true` if there are active
nodes and we have not exceeded the maximum iteration count.

### Three Concrete `FrontierPair` Subclasses

#### `SPFrontierPair` (Shortest-Path)

Used by SSP/ASP algorithms.  A single backing store because nodes are visited at most once.
Starts sparse; calls `switchToDense()` when the threshold is exceeded:

```cpp
class SPFrontierPair : public FrontierPair {
    unique_ptr<SparseFrontier> sparseFrontier;   // active while sparse
    unique_ptr<DenseFrontier>  denseFrontier;    // active after switchToDense()
    bool isSparse;

    bool needSwitchToDense(uint64_t threshold) const;
    void switchToDense();
};
```

#### `DenseSparseDynamicFrontierPair` (Adaptive)

Uses separate cur/next frontiers.  Both start sparse.  The next frontier switches to dense
when `nextSparseFrontier->size() > threshold` (checked at iteration boundaries):

```cpp
class DenseSparseDynamicFrontierPair : public FrontierPair {
    unique_ptr<SparseFrontier> curSparseFrontier;
    unique_ptr<SparseFrontier> nextSparseFrontier;
    unique_ptr<DenseFrontier>  curDenseFrontier;   // null until switched
    unique_ptr<DenseFrontier>  nextDenseFrontier;  // null until switched
};
```

Used for algorithms like variable-length joins where nodes may be re-visited at different
iteration depths.

#### `DenseFrontierPair` (Always Dense)

Pre-allocates dense frontiers for both cur and next.  Used by WCC and other algorithms
that expect to touch a large fraction of nodes every iteration.

### `FrontierMorselDispatcher`

```cpp
// frontier_morsel.h
class FrontierMorselDispatcher {
    static constexpr uint64_t MIN_FRONTIER_MORSEL_SIZE    = 512;
    static constexpr uint64_t MIN_NUMBER_OF_FRONTIER_MORSELS = 128;

    atomic<offset_t> nextOffset;  // lock-free claim counter

    // Returns the next [begin, end) range for a worker, or nullopt when done.
    optional<pair<offset_t,offset_t>> getNextMorsel(offset_t maxOffset);
};
```

Workers call `getNextMorsel` in a loop; each successful call claims an exclusive range of
offsets from the current frontier.  The atomic increment ensures no two workers process the
same nodes.

The morsel size is chosen as `max(MIN_FRONTIER_MORSEL_SIZE, maxOffset / (numThreads * MIN_NUMBER_OF_FRONTIER_MORSELS))` so that the number of morsels scales with the
graph size and thread count.

---

## Edge and Vertex Compute Interfaces

### `EdgeCompute`

```cpp
// compute.h
class EdgeCompute {
public:
    virtual ~EdgeCompute() = default;

    // Called for each batch of neighbors of boundNodeID.
    // Returns the set of neighbor nodeIDs that should be added to the next frontier.
    virtual vector<nodeID_t> edgeCompute(
        nodeID_t boundNodeID,
        NbrScanState::Chunk& chunk,
        bool fwdEdge) = 0;

    // Optional early-termination hook.
    virtual bool terminate(NodeOffsetMaskMap* maskMap) { return false; }
};
```

Concrete implementations:
- `SSPEdgeCompute` — writes one parent per newly-discovered node (SSP)
- `ASPEdgeCompute` — appends all parents at the same distance (ASP)
- `WCCEdgeCompute` — updates component IDs
- `VarLenEdgeCompute` — tracks visited edge sets for TRAIL/ACYCLIC semantics

### `VertexCompute`

```cpp
// compute.h
class VertexCompute {
public:
    virtual unique_ptr<VertexCompute> copy() = 0;  // per-thread clone

    // Return false to skip all offsets for this table.
    virtual bool beginOnTable(table_id_t tableID) { return true; }

    // Process a vectorized chunk of nodes.
    virtual void vertexCompute(const VertexScanState::Chunk& chunk) {}

    // Process a scalar range [startOffset, endOffset).
    virtual void vertexCompute(offset_t startOffset, offset_t endOffset,
                               table_id_t tableID) {}

    // Called once per table after all offsets are processed.
    virtual void vertexCompute(table_id_t tableID) {}

    // Called after all tables are done; merge local state into shared pool.
    virtual void combine() {}
};
```

`GDSUtils::runVertexCompute()` submits `VertexComputeTask`s to the task scheduler.
Each task receives a clone of the prototype `VertexCompute` via `copy()`, processes a
node-group range, and calls `combine()` to merge results.

---

## GDS Outer Loop (`GDSUtils`)

### `runAlgorithmEdgeCompute`

This is the main BFS iteration loop:

```cpp
// gds_utils.cpp
void GDSUtils::runAlgorithmEdgeCompute(
    ExecutionContext& ctx,
    GDSComputeState& computeState,
    Graph& graph,
    bool isFwd,
    iteration_t maxIter)
{
    auto& fp = *computeState.frontierPair;
    while (fp.continueNextIter(maxIter)) {
        fp.beginNewIteration();
        runOneIteration(ctx, computeState, graph, isFwd);
    }
}
```

### `runOneIteration`

```cpp
void GDSUtils::runOneIteration(
    ExecutionContext& ctx, GDSComputeState& computeState,
    Graph& graph, bool isFwd)
{
    for (auto& nodeInfo : graph.getGraphEntry()->nodeInfos) {
        auto tableID = nodeInfo.entry->getTableID();
        for (auto& relInfo : graph.getRelInfos(tableID)) {
            scheduleFrontierTask(ctx, computeState, graph, relInfo, isFwd);
        }
    }
}
```

One `FrontierTask` is scheduled per `(nodeTable × relTable × direction)` combination.

### `scheduleFrontierTask` — New Worker Thread

```cpp
void GDSUtils::scheduleFrontierTask(...) {
    auto task = make_shared<FrontierTask>(...);
    // NOTE: launchNewWorkerThread = true
    taskScheduler.scheduleTaskAndWaitOrError(task, ctx, /*launchNewWorkerThread=*/true);
}
```

The `true` flag is critical: the calling thread is a worker (`Tm`) managed by the scheduler.
If it blocked waiting on the task *without* launching a new thread, a single-thread scheduler
would deadlock because no thread remains to run the submitted tasks.  Launching a new thread
ensures the waiting caller does not count against the thread pool.

### `FrontierTask`

```cpp
// gds_task.h
class FrontierTask : public common::Task {
    FrontierTaskInfo      info;   // graph ref, relInfo, direction
    FrontierTaskSharedState* sharedState;  // morsel dispatcher

    void run() override;       // for dense frontiers
    void runSparse() override; // for sparse frontiers
};
```

`run()` calls `getNextMorsel()` in a loop, then for each claimed morsel:
1. Iterates over nodes in the frontier range.
2. For each active node, calls `graph.scanFwd/scanBwd` to get neighbor chunks.
3. Calls `edgeCompute.edgeCompute(node, chunk, isFwd)` for each chunk.
4. Sets returned neighbor nodeIDs into the next frontier.

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

The frontier data structures (`DenseFrontier`, `SparseFrontier`, `SPFrontierPair`, etc.)
are described in the [Frontier Engine](#frontier-engine) section above.  Here we describe
the step-by-step algorithm logic.

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

The entry point for parallel *output-writing* passes (after traversal):

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

Internally this submits `VertexComputeTask`s to the `TaskScheduler`. Each task covers one
**node group** (up to 128K nodes):

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

- `src/include/function/gds/gds.h` — `GDSFunction`, `GDSBindData`, `GDSFuncSharedState`, `GDSComputeState`
- `src/include/function/gds/gds_frontier.h` — All frontier types: `SparseFrontier`, `DenseFrontier`, `SPFrontierPair`, `DenseSparseDynamicFrontierPair`, `DenseFrontierPair`
- `src/include/function/gds/gds_task.h` — `FrontierTask`, `FrontierTaskInfo`, `FrontierTaskSharedState`, `VertexComputeTask`
- `src/include/function/gds/compute.h` — `EdgeCompute`, `VertexCompute` interfaces
- `src/include/function/gds/frontier_morsel.h` — `FrontierMorselDispatcher` (MIN_MORSEL=512, MIN_MORSELS=128)
- `src/include/function/gds/rec_joins.h` — `RJBindData`, `RJAlgorithm` interface
- `src/include/function/gds/bfs_graph.h` — `ParentList`, `BaseBFSGraph`, `DenseBFSGraph`, `SparseBFSGraph`, `BFSGraphManager`
- `src/function/gds/gds_utils.cpp` — `GDSUtils::runAlgorithmEdgeCompute()`, `runOneIteration()`, `scheduleFrontierTask()`
- `src/include/function/gds/gds_utils.h` — `GDSUtils` declarations
- `src/function/gds/rec_joins.cpp` — `VAR_LEN_JOINS` implementation (DFS recursive joins)
- `src/function/gds/ssp_paths.cpp` — `SINGLE_SP_PATHS` / `SSPPathsEdgeCompute`
- `src/function/gds/ssp_destinations.cpp` — `SINGLE_SP_DESTINATIONS` (distances only)
- `src/function/gds/all_sp_paths.cpp` — `ALL_SP_PATHS` (all equi-length shortest)
- `src/function/gds/weighted_sp.cpp` — `WEIGHTED_SP_PATHS` / `WEIGHTED_SP_DESTINATIONS` (Dijkstra)
- `src/function/gds/bfs_graph.cpp` — `DenseBFSGraph`, `ObjectBlock<ParentList>`, parent insertion
- `src/processor/operator/recursive_extend/recursive_extend.cpp` — physical operator
- `src/include/graph/graph.h` — `Graph` abstract interface
- `src/include/graph/on_disk_graph.h` — `OnDiskGraph`, `OnDiskGraphNbrScanState`
- `src/graph/on_disk_graph.cpp` — `OnDiskGraph` construction, predicate wiring
- `src/include/graph/graph_entry.h` — `NativeGraphEntry`, `NativeGraphEntryTableInfo`
- `src/include/graph/graph_entry_set.h` — `GraphEntrySet` (per-`ClientContext` projected graph registry)
- `src/include/planner/logical_plan/logical_recursive_extend.h` — `LogicalRecursiveExtend`
- `src/include/function/gds/node_offset_mask_map.h` — `NodeOffsetMaskMap`
