# Logical Planner

**Source files:** `src/planner/planner.cpp`, `src/include/planner/`, `src/planner/join_order/`

## Planner Responsibilities

The planner takes a **bound statement** and produces a **logical plan** — a tree of relational algebra operators. No physical decisions are made here (no operator implementations, no parallelism). The plan is later optimized by the optimizer, then mapped to physical operators.

## Logical Operators

```cpp
enum class LogicalOperatorType {
    SCAN_NODE_TABLE,
    SCAN_REL_TABLE,
    EXTEND,                  // 1-hop graph traversal
    RECURSIVE_EXTEND,        // variable-length path (e.g., *1..3)
    HASH_JOIN,
    MERGE_JOIN,
    CROSS_PRODUCT,
    FILTER,
    PROJECTION,
    AGGREGATE,
    ORDER_BY,
    LIMIT,
    UNION_ALL,
    INTERSECT,
    FLATTEN,
    INSERT_NODE, INSERT_REL,
    UPDATE_NODE, UPDATE_REL,
    DELETE_NODE, DELETE_REL,
    CREATE_TABLE, DROP_TABLE,
    // ...
};
```

## Pattern Planning

For a `MATCH` clause with a graph pattern, the planner decomposes the pattern into a sequence of scan + extend operations and joins them:

```
Pattern: (a:Person)-[:KNOWS]->(b:Person)-[:WORKS_AT]->(c:Company)

Decomposition options:
  Option 1: Scan(a) → Extend(KNOWS, FORWARD) → Extend(WORKS_AT, FORWARD) → Filter(c:Company)
  Option 2: Scan(c) → Extend(WORKS_AT, BACKWARD) → Extend(KNOWS, BACKWARD) → Filter(a:Person)
  Option 3: Scan(a) → HashJoin(b) ← Scan(c) → Extend(WORKS_AT, BACKWARD)
```

The planner uses **dynamic programming (DP) join ordering** to enumerate plans and choose the lowest estimated cost.

## Join Order DP

```cpp
// join_order_enumerator.cpp
class JoinOrderEnumerator {
    // For N node/rel patterns, enumerate all 2^N subsets
    // For each subset, find the optimal join order using Selinger-style DP

    unordered_map<JoinNodeSet, LogicalPlan> dpTable;

    LogicalPlan enumerate(const QueryGraph& queryGraph) {
        // Base case: single-node scans
        for (auto node : queryGraph.nodes) {
            dpTable[{node}] = makeScanPlan(node);
        }
        // Extend to larger subsets
        for (auto size = 2; size <= queryGraph.nodes.size(); size++) {
            for (auto subset : allSubsetsOfSize(queryGraph.nodes, size)) {
                for (auto joinPoint : allSplits(subset)) {
                    auto leftPlan  = dpTable[joinPoint.left];
                    auto rightPlan = dpTable[joinPoint.right];
                    auto joinPlan  = makeJoinPlan(leftPlan, rightPlan, queryGraph);
                    if (!dpTable.count(subset) || cost(joinPlan) < cost(dpTable[subset])) {
                        dpTable[subset] = joinPlan;
                    }
                }
            }
        }
        return dpTable[allNodes(queryGraph)];
    }
};
```

## Cardinality Estimation

The planner uses `CardinalityEstimator` to estimate the number of rows each operator produces:

```cpp
class CardinalityEstimator {
    // Scan estimate: table row count (from catalog statistics)
    uint64_t estimateScan(NodeTableID tableID);

    // Extend estimate: avg degree × input cardinality
    uint64_t estimateExtend(RelTableID relTableID, uint64_t inputCardinality);

    // Filter estimate: selectivity × input cardinality
    uint64_t estimateFilter(const BoundExpression& predicate, uint64_t inputCardinality);
};
```

Statistics used:
- `numNodes` per node table (from `NodeTableStatistics`)
- `numRels` per rel table (from `RelTableStatistics`)
- Default selectivity for comparisons: 0.33 (=, !=), 0.5 (<, >, <=, >=)

## Factorization

LadybugDB's planner supports **factorized representation** — instead of flattening all intermediate results, the plan can produce a factorized tuple that represents multiple rows compactly.

```
Pattern: (a)-[:KNOWS]->(b), (a)-[:LIKES]->(c)

Without factorization:
  (a1, b1, c1), (a1, b1, c2), (a1, b2, c1), (a1, b2, c2) — 4 tuples

With factorization:
  (a1, {b1, b2}, {c1, c2}) — 1 factorized tuple
  represents 4 logical tuples without materializing all 4
```

The `FlattenRewriter` optimizer pass determines when a factorized node must be flattened (materialized) — typically before aggregation or result projection.

## RETURN Clause Planning

After the join plan is constructed, the planner adds:

1. `LogicalFilter` for WHERE predicates not already pushed into scans
2. `LogicalAggregate` for aggregation functions with group-by keys
3. `LogicalOrderBy` for ORDER BY columns
4. `LogicalLimit` for LIMIT / SKIP
5. `LogicalProjection` for the final set of return columns

## Subquery Planning

`EXISTS {}` and `COUNT {}` subqueries are planned as **correlated subplans**:

```
MATCH (a:Person) WHERE EXISTS { MATCH (a)-[:KNOWS]->(b) }

Logical Plan:
  LogicalFilter [EXISTS subquery]
    ├─ outer: LogicalScanNodeTable [Person]
    └─ subplan: LogicalSemiJoin
                  ├─ correlated input: a (from outer)
                  └─ LogicalExtend [KNOWS FORWARD from a]
```

## Related Files

- `src/planner/planner.cpp` — main planner, handles all statement types
- `src/planner/join_order/join_order_enumerator.cpp` — DP join ordering
- `src/planner/join_order/cardinality_estimator.cpp` — row count estimation
- `src/include/planner/logical_plan/` — logical operator hierarchy
- `src/include/planner/planner.h` — Planner class declaration
