# Join-Order Enumeration and Hint Planning

**Primary sources read**

- `src/planner/plan/plan_join_order.cpp`
- `src/include/planner/join_order_enumerator_context.h`, `src/planner/join_order_enumerator_context.cpp`
- `src/include/planner/join_order/cardinality_estimator.h`, `src/planner/join_order/cardinality_estimator.cpp`
- `src/include/planner/join_order/cost_model.h`, `src/planner/join_order/cost_model.cpp`
- `src/include/planner/join_order/join_order_util.h`, `src/planner/join_order/join_order_util.cpp`
- `src/include/planner/join_order/join_tree.h`
- `src/include/planner/join_order/join_plan_solver.h`, `src/planner/join_order/join_plan_solver.cpp`
- `src/include/planner/join_order/join_tree_constructor.h`, `src/planner/join_order/join_tree_constructor.cpp`
- `src/planner/plan/append_join.cpp`

This page covers how LadybugDB enumerates graph-pattern joins, estimates costs, honors join hints, and chooses between extend-based, hash-join-based, and intersect-based plans.

## 1. Core state objects

### 1.1 `JoinOrderEnumeratorContext`

The planner keeps join-enumeration state in `JoinOrderEnumeratorContext`.

Stored fields:

- `binder::expression_vector whereExpressionsSplitOnAND`
- `uint32_t currentLevel`
- `uint32_t maxLevel`
- `std::unique_ptr<SubPlansTable> subPlansTable`
- `const binder::QueryGraph* queryGraph`

Initialization logic:

```cpp
maxLevel = queryGraph_->getNumQueryNodes() + queryGraph_->getNumQueryRels() + 1;
currentLevel = 1;
```

So levels are counted over all matched variables, not just nodes.

### 1.2 `SubqueryGraph`

`SubqueryGraph` is the subset key used for dynamic programming. It contains two bitsets:

- `queryNodesSelector`
- `queryRelsSelector`

Helper methods such as `getNbrSubgraphs(...)`, `getConnectedNodePos(...)`, `getNodePositionsIgnoringNodeSelector()`, and `containAllVariables(...)` drive the enumeration logic.

## 2. Planning a graph collection

`planQueryGraphCollection(...)` handles one `QueryGraphCollection`, which may contain multiple disconnected connected-components.

The algorithm is:

1. split predicates per connected `QueryGraph` using `queryGraph->canProjectExpression(...)`
2. plan each component independently
3. if correlated subquery planning could not attach `ExpressionsScan` to any component, plan it independently
4. cross-product all component plans
5. append remaining predicates

## 3. Base plans

`planBaseTableScans(...)` seeds the DP table before any join level is explored.

### 3.1 Plain planning mode: `SubqueryPlanningType::NONE`

The planner:

- node-scans every query node
- rel-scans every query relationship

### 3.2 Unnested correlated mode: `UNNEST_CORRELATED`

For correlated nodes already supplied by an outer query, the planner uses `planNodeIDScan(...)` rather than rescanning full node storage. It also rectifies cardinality with:

```cpp
cardinalityEstimator.rectifyCardinality(*queryNode->getInternalID(), info.corrExprsCard);
```

### 3.3 Correlated mode: `CORRELATED`

The planner skips rescanning correlated nodes and instead creates an `ExpressionsScan` over the correlated expressions, deduplicated by `appendDistinct(corrExprs, plan)`.

## 4. Seed operator construction

### 4.1 Node seeds

`planNodeScan(...)` builds:

- `LogicalScanNodeTable`
- followed by any predicates newly matched by this node

If the node maps to a foreign table and that table provides `getBoundScanInfo(...)`, the planner may use a table-function call instead of a local storage scan.

### 4.2 Relationship seeds

`planRelScan(...)` creates a standalone plan for a relationship by:

1. scanning one endpoint node
2. extending across the relationship
3. applying predicates newly matched by that rel-only state

When correlated planning has exactly one correlated endpoint, the planner deliberately anchors the rel scan on that endpoint.

## 5. Enumeration levels

After base seeds, `planQueryGraph(...)` does:

```cpp
context.currentLevel++;
while (context.currentLevel < context.maxLevel) {
    planLevel(context.currentLevel++);
}
```

### 5.1 Exact levels

`planLevelExactly(level)` explores splits `(leftLevel, rightLevel)` up to `floor(level / 2.0)`.

For each split:

- if `leftLevel > 1`, try worst-case-optimal join via `planWCOJoin(...)`
- always try inner joins via `planInnerJoin(...)`

### 5.2 Approximate levels

When `level > MAX_LEVEL_TO_PLAN_EXACTLY`, the planner falls back to:

```cpp
planInnerJoin(1, level - 1);
```

So large patterns degrade into a greedy-ish expansion from level-1 seeds rather than full exact DP.

## 6. Worst-case-optimal join path (`INTERSECT`)

LadybugDB's WCOJ support is implemented as an `INTERSECT`-based plan, not as a separate generalized multiway join engine.

### 6.1 Candidate generation

`populateIntersectRelCandidates(...)` examines a subgraph's neighboring relationships and groups them by the node position that could serve as an intersect node.

A candidate is rejected if:

- the rel is a closing edge whose both endpoints are already connected in the current subgraph
- the relationship's supported directions do not contain the needed direction

### 6.2 Plan construction

`planWCOJoin(...)`:

- chooses build plans for each relationship using `getWCOJBuildPlanForRel(...)`
- uses the intersect node's internal ID as the probe key
- appends `LogicalIntersect`
- appends predicates newly matched by the new combined subgraph

### 6.3 Current limitation called out in source

The planner explicitly disables WCOJ when the intersect node is already in scope of the probe side, with a comment that the correct fix would be node-at-a-time rather than edge-at-a-time enumeration.

## 7. Inner join enumeration

`planInnerJoin(...)` enumerates neighboring subgraph pairs and then applies several filters.

### 7.1 Implicit-join pruning

`needPruneImplicitJoins(...)` detects cases where two subgraphs are actually connected by more join nodes than `getConnectedNodePos(...)` reports because node selectors omit some endpoints.

Example in the source comment:

```text
(a)-[e1]->(b) and (b)-[e2]->(a)
```

### 7.2 INL-style extend preference

If `tryPlanINLJoin(...)` succeeds, hash-join candidates are pruned.

The INL path only applies when:

- there is exactly one join node
- one side is a single relationship subgraph
- the bound node is sequential on the existing plan
- the extend direction is supported
- correlated planning, if present, agrees with the chosen anchor endpoint

Mechanically, success means the planner copies the existing plan and appends another `EXTEND` instead of building a `HASH_JOIN`.

### 7.3 Hash join fallback

If INL planning fails, `planInnerHashJoin(...)` evaluates hash join candidates, possibly in both probe/build orientations when `leftLevel != rightLevel`.

A candidate is only materialized if:

```cpp
CostModel::computeHashJoinCost(...) < maxCost
```

where `maxCost` comes from the current `SubPlansTable` entry for the combined subgraph.

## 8. Cost model

`CostModel` is intentionally simple.

### 8.1 Extend cost

```cpp
childPlan.getCost() + childPlan.getCardinality()
```

### 8.2 Hash join cost

```cpp
probe.cost + build.cost + probe.cardinality +
PlannerKnobs::BUILD_PENALTY * flatCardinality(buildJoinKeys)
```

### 8.3 Intersect cost

```cpp
probe.cost + probe.cardinality + sum(build.cost)
```

The source comment explicitly says intersect costing still needs improvement.

## 9. Cardinality estimation

`CardinalityEstimator` maintains two key maps:

- `nodeTableStats`
- `nodeIDName2dom`

where `nodeIDName2dom` is the estimated domain size of each node-ID expression.

### 9.1 Scan estimates

- regular node scan -> number of nodes across the relevant table IDs, at least one
- primary-key equality scan -> exactly `1`
- primary-key range scan -> domain size estimate, at least one

### 9.2 Extend rate

For non-recursive rels:

```text
extension rate = numRels / numBoundNodes
```

For recursive patterns, that one-hop rate is scaled by the recursive upper bound and `recursivePatternCardinalityScaleFactor` from client config.

### 9.3 Hash join estimates

For internal-ID-only joins:

```text
probe.cardinality * flatBuildJoinKeyCardinality / product(join-key domains)
```

For non-ID joins, the planner falls back to naive selectivity multiplication using `PlannerKnobs::EQUALITY_PREDICATE_SELECTIVITY`.

### 9.4 Filter estimates

Special cases in source:

- equality on a primary key -> cardinality `1`
- equality on a single-labelled property with stats -> divide by number of distinct values
- otherwise equality -> multiply by equality selectivity
- non-equality -> multiply by non-equality selectivity

### 9.5 Aggregate estimate

- no group keys -> `1`
- with group keys -> child's cardinality

## 10. Join hints

Join hints are not interpreted directly by the enumerator. They are first converted into an explicit join tree.

### 10.1 Tree representation

`join_tree.h` defines:

- `TreeNodeType::NODE_SCAN`
- `TreeNodeType::REL_SCAN`
- `TreeNodeType::BINARY_JOIN`
- `TreeNodeType::MULTIWAY_JOIN`

Payload structs:

- `ExtraScanTreeNodeInfo`
- `ExtraJoinTreeNodeInfo`
- `NodeRelScanInfo`

### 10.2 `JoinTreeConstructor`

`JoinTreeConstructor::construct(...)` refuses correlated hinted joins for now.

Its recursive constructor has three main cases:

- leaf node-pattern -> `constructNodeScan(...)`
- leaf rel-pattern -> `constructRelScan(...)`
- internal node with two children -> binary join or nested-loop fusion
- internal node with more than two children -> multiway join, requiring rel-scan build sides

A particularly important optimization is `tryConstructNestedLoopJoin(...)`: if a hinted binary join is really “node scan + rel scan joined on that node”, the constructor can merge the rel scan into the node-scan tree node instead of forcing a separate hash join.

### 10.3 `JoinPlanSolver`

`JoinPlanSolver` converts the tree into executable logical operators:

- `NODE_SCAN` -> scan node, append local rel extends, append filters
- `REL_SCAN` -> scan anchor node, append one extend, append filters
- `BINARY_JOIN` -> `appendHashJoin(...)`, then filters
- `MULTIWAY_JOIN` -> `appendIntersect(...)`, then filters

## 11. SIP hooks during join append

Join append code also seeds sideways-information-passing metadata.

### 11.1 Hash join

After `LogicalHashJoin` is built, the planner may set `SemiMaskPosition::PROHIBIT_PROBE_TO_BUILD` when the probe side is much larger than the build side (`probeCardinality > buildCardinality * PlannerKnobs::SIP_RATIO`).

### 11.2 Intersect

While appending `LogicalIntersect`, the planner may set `SemiMaskPosition::PROHIBIT` when probe/build ratios exceed the SIP threshold.

## 12. Predicate placement during enumeration

The planner repeatedly asks `Planner::getNewlyMatchedExprs(...)` and places a predicate as soon as it becomes evaluable in the new subgraph while remaining unavailable in all previous subgraphs.

## 13. Selection of the final plan

Once all levels have been explored, `planQueryGraph(...)` retrieves all plans for the fully matched subgraph and picks the one with the lowest `LogicalPlan::cost`.

If the query graph is empty, it appends `LogicalEmptyResult`.

## 14. Mental model

Unhinted planning is:

```text
Bound QueryGraph
  -> seed node/rel scans
  -> DP over SubqueryGraph subsets
  -> prefer extend-style INL when possible
  -> otherwise costed HASH_JOIN
  -> sometimes INTERSECT for WCOJ shapes
  -> cheapest fully matched plan wins
```

Hinted planning is:

```text
BoundJoinHintNode
  -> JoinTreeConstructor
  -> JoinPlanSolver
  -> deterministic logical plan
```
