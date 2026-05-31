# Graph Algorithm Extension (ALGO)

**Source tree:** `extension/algo/src/`  
**Extension name:** `algo`  
**Namespace:** `lbug::algo_extension`

---

## Overview

The `ALGO` extension provides seven in-memory graph algorithm functions built on LadybugDB's native GDS (Graph Data Science) execution framework. All algorithms operate on **projected graphs** created with `CREATE PROJECTED GRAPH` and return per-node or per-component results as table rows.

All functions are registered as `TableFunction` entries:

```cpp
ExtensionUtils::addTableFunc<PageRankFunction>(db);
ExtensionUtils::addTableFuncAlias<PRFunction>(db);   // alias for PAGE_RANK
// …
```

---

## Quick Reference

| Function name | Alias | Category | Output columns |
|---|---|---|---|
| `PAGE_RANK` | `PR` | Centrality | `(_id, rank)` |
| `STRONGLY_CONNECTED_COMPONENTS` | `SCC` | Connectivity | `(_id, group_id)` |
| `STRONGLY_CONNECTED_COMPONENTS_KOSARAJU` | `SCC_KO` | Connectivity | `(_id, group_id)` |
| `WEAKLY_CONNECTED_COMPONENTS` | `WCC` | Connectivity | `(_id, group_id)` |
| `K_CORE_DECOMPOSITION` | `KCORE` | Core structure | `(_id, core_value)` |
| `LOUVAIN` | — | Community detection | `(_id, community)` |
| `SPANNING_FOREST` | `SF` | Spanning tree | `(_id, _parent_id)` |

All functions take a single required `ANY` (graph name) argument plus named optional parameters.

---

## Common Call Pattern

```cypher
CREATE PROJECTED GRAPH g FROM (Person)-[KNOWS]->(Person);

CALL PAGE_RANK(g) RETURN node, rank ORDER BY rank DESC LIMIT 10;
CALL WCC(g) RETURN node, group_id;
CALL LOUVAIN(g, maxiterations := 30, maxphases := 5) RETURN node, community;
```

Optional parameters use the named-parameter syntax `paramName := value`.

---

## Algorithm Reference

### `PAGE_RANK` / `PR`

Computes Google PageRank for each node in the projected graph using an iterative power-method approach.

**Signature:**

```cypher
CALL PAGE_RANK(
    graphName         ANY,
    maxiterations     INT64  := 20,
    dampingfactor     DOUBLE := 0.85,
    tolerance         DOUBLE := 0.0000001,
    normalizeinitial  BOOL   := true
) RETURN node, rank;
```

| Parameter | Type | Default | Constraint | Description |
|---|---|---|---|---|
| `maxiterations` | INT64 | 20 | ≥ 1 | Maximum number of iterations before stopping |
| `dampingfactor` | DOUBLE | 0.85 | [0, 1) | PageRank damping factor (probability of following an edge) |
| `tolerance` | DOUBLE | 0.0000001 | > 0 | Sum-of-absolute-differences convergence threshold |
| `normalizeinitial` | BOOL | true | — | When true initialise each node with 1/N; when false initialise with 1.0 |

**Output:**

| Column | Type | Description |
|---|---|---|
| `_id` | INTERNAL_ID | Node internal ID |
| `rank` | DOUBLE | Final PageRank score |

**Algorithm:**

1. Initialise `pCurrent[v] = 1/N` (if `normalizeinitial`) or `1.0`.
2. Each iteration: for every node, sum `pCurrent[nbr] / outdegree[nbr]` over all incoming neighbours.
3. Multiply by `dampingfactor`, add the constant `(1 - dampingfactor) * initialValue`.
4. Compute `diff = Σ|pNext[v] - pCurrent[v]|`. If `diff < tolerance`, stop early.
5. Swap `pCurrent` / `pNext` buffers for the next iteration.

The inner edge computation uses a **dense frontier**: all nodes are active every iteration. The implementation uses `std::atomic<double>` with a compare-exchange-based CAS accumulator for lock-free parallel accumulation.

**Parallelism:** `canParallelFunc = [] { return false; }` — PageRank executes sequentially. Parallel accumulation within an iteration is handled by the GDS framework's `GDSUtils::runAlgorithmEdgeCompute`.

---

### `STRONGLY_CONNECTED_COMPONENTS` / `SCC`

Finds all strongly connected components using Tarjan's algorithm (or an equivalent iterative variant).

**Signature:**

```cypher
CALL STRONGLY_CONNECTED_COMPONENTS(
    graphName     ANY,
    maxiterations INT64 := 100
) RETURN node, group_id;
```

| Parameter | Type | Default | Description |
|---|---|---|
| `maxiterations` | INT64 | 100 | Maximum frontier expansion iterations |

**Output:**

| Column | Type | Description |
|---|---|---|
| `_id` | INTERNAL_ID | Node internal ID |
| `group_id` | INT64 | Strongly connected component identifier |

---

### `STRONGLY_CONNECTED_COMPONENTS_KOSARAJU` / `SCC_KO`

Finds strongly connected components using Kosaraju's two-pass DFS algorithm.

**Signature:**

```cypher
CALL STRONGLY_CONNECTED_COMPONENTS_KOSARAJU(
    graphName     ANY,
    maxiterations INT64 := 100
) RETURN node, group_id;
```

Same parameters and output schema as `SCC`. Prefer this variant on graphs where the reversed-graph traversal can be cached efficiently.

---

### `WEAKLY_CONNECTED_COMPONENTS` / `WCC`

Finds all weakly connected components treating all edges as undirected.

**Signature:**

```cypher
CALL WEAKLY_CONNECTED_COMPONENTS(
    graphName     ANY,
    maxiterations INT64 := 100
) RETURN node, group_id;
```

| Parameter | Type | Default | Description |
|---|---|---|
| `maxiterations` | INT64 | 100 | Maximum BFS frontier expansions |

**Output:**

| Column | Type | Description |
|---|---|---|
| `_id` | INTERNAL_ID | Node internal ID |
| `group_id` | INT64 | Component identifier (the minimum node offset in the component) |

**Algorithm:** Label-propagation over a pair of dense `ComponentIDs` buffers (`ComponentIDsPair`). Each edge compute step tries to propagate the smaller component ID from the source to the destination. Converges when no labels change in an iteration.

---

### `K_CORE_DECOMPOSITION` / `KCORE`

Assigns each node its **core number**: the maximum `k` such that the node belongs to a subgraph where every node has degree ≥ k.

**Signature:**

```cypher
CALL K_CORE_DECOMPOSITION(
    graphName ANY
) RETURN node, core_value;
```

No optional parameters beyond the graph name.

**Output:**

| Column | Type | Description |
|---|---|---|
| `_id` | INTERNAL_ID | Node internal ID |
| `core_value` | INT64 | Core number of the node |

**Algorithm:**

1. Compute initial degree for every node into `CoreValues` (a dense atomic array initialised to `INVALID_DEGREE`).
2. Iteratively peel nodes whose current degree falls below the current `k` threshold, decrementing the degree counts of their neighbours.
3. Nodes that survive peeling at level `k` receive `core_value = k`.

---

### `LOUVAIN`

Detects communities using the Louvain modularity-maximisation method.

**Signature:**

```cypher
CALL LOUVAIN(
    graphName     ANY,
    maxiterations INT64 := 20,
    maxphases     INT64 := 20
) RETURN node, community;
```

| Parameter | Type | Default | Constraint | Description |
|---|---|---|---|---|
| `maxiterations` | INT64 | 20 | ≥ 0 | Maximum iterations per phase |
| `maxphases` | INT64 | 20 | ≥ 0 | Maximum Louvain phases (rounds of coarsening) |

**Output:**

| Column | Type | Description |
|---|---|---|
| `_id` | INTERNAL_ID | Node internal ID |
| `community` | INT64 | Detected community identifier |

**Algorithm:** Parallel Louvain following the Grappolo approach (https://hpc.pnl.gov/people/hala/grappolo.html).

Modularity formula:
```
modularity = sumIntraWeights / 2m − (sumWeightedDegrees / 2m)²
```

Each phase:
1. **Local move phase (up to `maxiterations` iterations):** each node greedily moves to the neighbouring community that maximises modularity gain.
2. **Aggregation phase:** communities are collapsed into super-nodes.
3. Repeat until modularity improvement is below threshold `THRESHOLD = 1e-6` or `maxphases` is reached.

Community IDs start as `UNASSIGNED_COMM = numeric_limits<offset_t>::max()` and are updated in-place using atomic CAS operations.

---

### `SPANNING_FOREST` / `SF`

Finds a spanning forest (a spanning tree for each connected component) of the graph.

**Signature:**

```cypher
CALL SPANNING_FOREST(
    graphName      ANY,
    variant        STRING := 'min',
    weight_property STRING := ''
) RETURN node, parent;
```

| Parameter | Type | Default | Allowed values | Description |
|---|---|---|---|---|
| `variant` | STRING | `"min"` | `"min"`, `"max"` | Minimise or maximise the total edge weight |
| `weight_property` | STRING | `""` | Any edge property name | Edge weight property; empty string = unweighted (all edges weight 1) |

**Output:**

| Column | Type | Description |
|---|---|---|
| `_id` | INTERNAL_ID | Node internal ID |
| `_parent_id` | INTERNAL_ID | Parent node in the spanning forest; NULL for root nodes |

---

## GDS Framework Integration

All ALGO functions are implemented on top of LadybugDB's native Graph Data Science (GDS) framework:

```
TableFunction {
    bindFunc             = GDSFunction::bindGraphEntry + custom optional params
    tableFunc            = algorithm-specific compute (dense frontier / BFS)
    initSharedStateFunc  = GDSFunction::initSharedState
    initLocalStateFunc   = TableFunction::initEmptyLocalState
    canParallelFunc      = [] { return false; }    (most algorithms)
    getLogicalPlanFunc   = GDSFunction::getLogicalPlan
    getPhysicalPlanFunc  = GDSFunction::getPhysicalPlan
}
```

### Projected graphs

All algorithms operate on projected graphs. A projected graph is a named, in-memory subgraph view created with:

```cypher
CREATE PROJECTED GRAPH myGraph FROM (Person)-[KNOWS]->(Person);
```

The graph name is passed as the first argument to every ALGO function.

### Dense frontier execution

Most algorithms use `DenseFrontier::getVisitedFrontier`, which marks all nodes as active. Convergence is detected by checking whether any value changed during an iteration. The `GDSUtils::runAlgorithmEdgeCompute` and `GDSUtils::runVertexCompute` utilities handle parallelism at the framework level; individual algorithms do not need to manage thread pools.

### Atomic accumulation pattern

Algorithms that need concurrent accumulation (PageRank's `pNext` sum, Louvain's modularity delta, K-Core's degree tracking) use `std::atomic<double>` or `std::atomic<degree_t>` arrays managed by `GDSDenseObjectManager`. The compare-exchange loop (`addCAS`) is used instead of `fetch_add` to correctly handle `double` atomics:

```cpp
static void addCAS(std::atomic<double>& origin, double valToAdd) {
    auto expected = origin.load(std::memory_order_relaxed);
    auto desired  = expected + valToAdd;
    while (!origin.compare_exchange_strong(expected, desired)) {
        desired = expected + valToAdd;
    }
}
```

### Progress reporting

PageRank reports progress via `ProgressBar::Get(*clientContext)->updateProgress(queryID, progress)` where `progress = currentIter / numNodes`. Other algorithms do not currently report progress.

---

## Performance Notes

1. **All algorithms are in-memory.** The projected graph is fully materialised from the stored graph before computation begins. Memory usage scales with the number of nodes and edges in the projection.

2. **`canParallelFunc = false`** for all ALGO functions. Parallelism is provided inside the GDS edge compute kernel (`GDSUtils::runAlgorithmEdgeCompute`), not at the Ladybug operator level.

3. **Frontier strategy:** Most algorithms use a dense frontier (all nodes active every iteration). For sparse graphs with high diameter (e.g. BFS-like traversal in WCC), this is less efficient than a sparse frontier. Future versions may adopt adaptive frontier strategies.

4. **Louvain convergence:** The inner threshold `THRESHOLD = 1e-6` is hard-coded and not exposed as a configuration parameter.
