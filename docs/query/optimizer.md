# Optimizer

**Source files:** `src/optimizer/optimizer.cpp`, `src/include/optimizer/`, `src/optimizer/`

## What This Document Covers

This document is the definitive engineering reference for LadybugDB's query optimizer. It describes the complete optimizer pipeline: the exact sequence of all rewrite passes, the purpose and algorithm of each pass, the `LogicalOperatorVisitor` infrastructure used by every pass, and a worked end-to-end example. For a deep dive into the two most complex passes — FilterPushDown and ProjectionPushDown — see [Optimizer Passes (Deep Dive)](./optimizer-passes.md). For how the optimized plan is translated into physical operators, see [Physical Planner](./planner.md).

---

## Architecture: The `Optimizer` Entry Point

The optimizer lives in `src/optimizer/optimizer.cpp`. Its single public method is:

```cpp
// src/optimizer/optimizer.cpp
void Optimizer::optimize(planner::LogicalPlan* plan,
                         main::ClientContext* context,
                         const planner::CardinalityEstimator& cardinalityEstimator);
```

The optimizer is enabled/disabled by `ClientConfig::enablePlanOptimizer`. When disabled, only `SchemaPopulator` runs to fill operator schemas. When enabled, a fixed sequence of passes runs in order.

Key design decisions:
- **Passes are independent objects**, each instantiated fresh per query.
- **The plan tree is mutable**: passes replace operator subtrees using `shared_ptr` return values.
- **Schemas are recomputed after structural changes** via `computeFlatSchema()` or `computeFactorizedSchema()`.
- **No cost model** drives pass ordering; the sequence is determined by semantic dependencies between passes.

---

## The `LogicalOperatorVisitor` Pattern

Every optimizer pass extends `LogicalOperatorVisitor` (`src/include/optimizer/logical_operator_visitor.h`). The visitor provides two traversal dispatch methods:

```cpp
class LogicalOperatorVisitor {
protected:
    // In-place visitor: visit each operator type without replacing the node
    void visitOperatorSwitch(LogicalOperator* op);

    // Replacing visitor: may return a different operator (for rewrites)
    std::shared_ptr<LogicalOperator> visitOperatorReplaceSwitch(
        std::shared_ptr<LogicalOperator> op);

    // Per-type virtual hooks — default implementations do nothing / return op unchanged
    virtual void visitFilter(LogicalOperator* op) {}
    virtual std::shared_ptr<LogicalOperator> visitFilterReplace(
        std::shared_ptr<LogicalOperator> op) { return op; }
    // ... one pair per logical operator type
};
```

Passes override only the hooks they care about. Both `visitOperatorSwitch` and `visitOperatorReplaceSwitch` dispatch on `op->getOperatorType()` — a single switch covering all ~40 operator types.

**Traversal direction** is chosen by each pass:
- **Bottom-up** (post-order): visit children before parents. Used when a pass must see leaf output before rewriting interior nodes (e.g., FactorizationRewriter, CardinalityUpdater).
- **Top-down** (pre-order): visit parents before children. Used when a pass pushes context down into the tree (e.g., FilterPushDownOptimizer).

---

## Complete Optimizer Pipeline

The exact sequence, read directly from `optimizer.cpp`:

```
1.  RemoveFactorizationRewriter          // Remove any pre-existing FLATTEN nodes
2.  CorrelatedSubqueryUnnestSolver       // Unnest correlated subquery joins
3.  RemoveUnnecessaryJoinOptimizer       // Prune trivially empty join sides
4.  UnwindDedupOptimizer                 // Deduplicate UNWIND in MERGE patterns
5.  CountRelTableOptimizer (pass 1)      // COUNT(*) on rel tables → degree scan
6.  ForeignJoinPushDownOptimizer         // Push joins into foreign (Arrow/IceDisk) scans
7.  FilterPushDownOptimizer              // Push filters toward scans; rewrite cross→hash
8.  ProjectionPushDownOptimizer          // Column pruning; remove unused properties
9.  OrderByPushDownOptimizer             // Push ORDER BY into table functions
10. LimitPushDownOptimizer               // Push LIMIT into subplans / recursive extend
11. HashJoinSIPOptimizer (if enabled)    // Semi-mask (SIP) optimization for hash joins
12. TopKOptimizer                        // ORDER BY + LIMIT → top-k operator
13. CountRelTableOptimizer (pass 2)      // Re-run after TopK folds LIMIT into ORDER BY
14. FactorizationRewriter                // Insert FLATTEN operators for factorized eval
15. AggKeyDependencyOptimizer            // Remove functionally-dependent GROUP BY keys
16. CardinalityUpdater (EXPLAIN only)    // Re-estimate cardinalities for EXPLAIN output
```

> **Note on SchemaPopulator**: when optimization is disabled, `SchemaPopulator::rewrite()` runs instead of the full pipeline. It does a bottom-up traversal calling `computeFactorizedSchema()` on each node.

---

## Pass 1: RemoveFactorizationRewriter

**Source:** `src/optimizer/remove_factorization_rewriter.cpp`

**Purpose:** Remove any `FLATTEN` operators that may have been inserted by a prior planning round or carried over from a previous optimization run. The factorization schema (introduced by Lbug's vectorized factorization model) is rebuilt from scratch later in the pipeline (pass 14), so starting clean is critical.

**Algorithm:**
1. Bottom-up traversal via `visitOperator`.
2. For every `FLATTEN` node encountered: replace it with its single child (`visitFlattenReplace` returns `op->getChild(0)`).
3. After rewriting, asserts that no `FLATTEN` nodes remain (uses `LogicalFlattenCollector`).

```cpp
std::shared_ptr<LogicalOperator> RemoveFactorizationRewriter::visitFlattenReplace(
    std::shared_ptr<LogicalOperator> op) {
    return op->getChild(0);   // elide FLATTEN; expose child directly
}
```

**When it fires:** Always fires first. Must precede all other passes because `computeFlatSchema()` used by downstream passes assumes no FLATTEN nodes in the tree.

---

## Pass 2: CorrelatedSubqueryUnnestSolver

**Source:** `src/optimizer/correlated_subquery_unnest_solver.cpp`

**Purpose:** Convert correlated subqueries (which appear as "accumulating hash joins" in the logical plan) into properly ordered join pipelines that can be executed. The key challenge is connecting an `EXPRESSIONS_SCAN` node in the subquery's build side to the `ACCUMULATE` on the probe side, so that the subquery's correlated parameters are resolved at runtime.

**Key concept — Accumulating Hash Join:** The logical planner marks certain hash joins as "accumulating" (acc hash joins) when one side is a correlated subquery. These are identified by `LogicalOperatorUtils::isAccHashJoin(hashJoin)`. For an acc hash join:

```
HASH_JOIN (acc)
  ├── probe side → ACCUMULATE → child_plan
  └── build side → contains EXPRESSIONS_SCAN (correlated parameter source)
```

**Algorithm:**
1. Top-down traversal via `visitOperator`.
2. When an acc hash join is found, call `solveAccHashJoin`.
3. `solveAccHashJoin`:
   - Sets `SIPDependency::BUILD_DEPENDS_ON_PROBE` — the build side must wait for the probe side accumulate.
   - Recursively creates a `CorrelatedSubqueryUnnestSolver` for the build side, passing the `ACCUMULATE` operator as context.
   - Recursively creates another solver for the probe side's child.
4. When an `EXPRESSIONS_SCAN` is found and an outer accumulate is set, `visitExpressionsScan` calls `expressionsScan->setOuterAccumulate(accumulateOp)` to wire the scan to the accumulate.

**Result:** Correlated `EXISTS`/`NOT EXISTS` subqueries become LEFT or ANTI hash joins wired to pull correlated values from the outer query via the accumulate pipeline.

---

## Pass 3: RemoveUnnecessaryJoinOptimizer

**Source:** `src/optimizer/remove_unnecessary_join_optimizer.cpp`

**Purpose:** Prune hash join operators whose build or probe side provides no value.

**Algorithm:** Bottom-up traversal. For each `HASH_JOIN` node:
1. Skip non-`INNER` joins (LEFT, MARK joins are preserved — they change result semantics).
2. If the **build side** is a `SCAN_NODE_TABLE` with no properties to read (`getProperties().empty()`), the build side contributes no columns → replace the entire hash join with the probe side child.
3. If the **probe side** is a `SCAN_NODE_TABLE` with no properties → replace with the build side child.

```cpp
if (op->getChild(1)->getOperatorType() == LogicalOperatorType::SCAN_NODE_TABLE) {
    if (scanNode->getProperties().empty()) {
        return op->getChild(0);  // prune build side
    }
}
```

**Why this matters:** The logical planner sometimes creates hash joins purely to resolve node identity (the internal node ID) without reading any properties. After `ProjectionPushDownOptimizer` would have removed unnecessary properties, these joins become dead weight. Running this optimizer early (before projection push down) catches structural cases detectable without property information.

---

## Pass 4: UnwindDedupOptimizer

**Source:** `src/optimizer/unwind_dedup_optimizer.cpp`

**Purpose:** In `MERGE` queries that use `UNWIND` to generate data, deduplicate the unwind output before MERGE executes. Without deduplication, the same node/relationship might be merged multiple times within a single query execution, causing spurious conflicts.

**Pattern matched:**
```
MERGE
  └── HASH_JOIN
        ├── probe: UNWIND (or subtree containing UNWIND)
        └── build side
```

**Algorithm:**
1. Bottom-up traversal; tracks `canRewriteCurrentMerge` flag.
2. For a `MERGE` node:
   - Skip if MERGE has `ON MATCH` or `ON CREATE` clauses (dedup would hide duplicates from these semantic clauses).
   - Check that MERGE's child is a HASH_JOIN.
   - Search for an UNWIND in the probe side (direct or nested).
   - Compute dedup key expressions from `merge.getKeys()` plus source/destination node IDs of any relationship inserts.
   - Insert a `LogicalUnwindDeduplicate` node between the HASH_JOIN and MERGE.

---

## Pass 5 (and 13): CountRelTableOptimizer

**Source:** `src/optimizer/count_rel_table_optimizer.cpp`

**Purpose:** Rewrite `COUNT(*)` or `COUNT(r._id)` over a relationship scan into a direct degree table lookup, bypassing the full relationship scan. This is a special-case optimization leveraging LadybugDB's pre-computed degree metadata.

**Pattern matched (pass 1 — no LIMIT):**
```
AGGREGATE [COUNT(*), no keys]
  └── EXTEND (relationship scan)
        └── SCAN_NODE_TABLE
```

**Pattern matched (pass 2 — with LIMIT after TopK folds it):**
```
ORDER_BY [with limitNum set]
  └── AGGREGATE [COUNT(*), no keys]
        └── EXTEND
              └── SCAN_NODE_TABLE
```

**Algorithm:**
- `isSimpleCount(op)`: aggregate has no keys, exactly one aggregate function (`COUNT(*)` or `COUNT(id)`), and is not `DISTINCT`.
- `isCountStar(op)`: the aggregate function is `CountStarFunction`.
- `isCountRelID(op, rel)`: the aggregate function is `COUNT` and its child is the internal ID of the relationship.
- When the pattern is found, replaces the entire `EXTEND + AGGREGATE` subtree with a `LogicalCountRelTable` (or `LogicalRelDegreeTable` in the top-K case), which directly reads pre-computed degree values.

**Runs twice** because TopK (pass 12) folds the LIMIT number into the ORDER BY node, unlocking additional top-K COUNT rewrites only discoverable after that transformation.

---

## Pass 6: ForeignJoinPushDownOptimizer

**Source:** `src/optimizer/foreign_join_push_down_optimizer.cpp`

**Purpose:** For queries that join LadybugDB native tables with foreign tables (Apache Arrow, IceDisk), push the join condition into the foreign table scan's predicate, reducing data transferred from the foreign source.

**When it fires:** Before `FilterPushDownOptimizer` so the complete join pattern (with the original filter) is detectable before FilterPushDown restructures the tree.

**Mechanism:** Checks `tableFunctionCall.getTableFunc().supportsPushDownFunc()`. If true, join conditions referencing foreign table columns are rewritten as column predicates on the `LogicalTableFunctionCall` node.

---

## Pass 7: FilterPushDownOptimizer

**Source:** `src/optimizer/filter_push_down_optimizer.cpp`

**Purpose:** Push `FILTER` predicates as close to their data sources as possible. Also rewrites `CROSS_PRODUCT` operators into `HASH_JOIN` when equality predicates span both sides. See [Optimizer Passes (Deep Dive)](./optimizer-passes.md) for the complete algorithm.

**Key behaviors:**
- **Literal predicate elimination:** `WHERE false` or `WHERE null` → `LogicalEmptyResult` (short-circuit entire subtree).
- **Cross-product → hash join:** Equality predicates spanning two cross-product children trigger join rewrite.
- **Primary key index scan:** `WHERE node.pk = constant` rewrites `SCAN_NODE_TABLE` to `PRIMARY_KEY_SCAN` (point lookup or range scan using ART index).
- **Zone map predicates:** Column predicates pushed onto `ScanNodeTable` and `LogicalExtend` via `scan.setPropertyPredicates(...)` to enable zone map skipping at storage layer.
- **Foreign table push down:** Predicates on foreign tables pushed via `setColumnPredicates`.

**`PredicateSet`** categorizes predicates:
- `equalityPredicates` — `ExpressionType::EQUALS` predicates
- `nonEqualityPredicates` — all others (range, NOT_EQUALS, complex)

The optimizer maintains a `PredicateSet` per scope. Each operator handler either processes the accumulated predicates, pushes them further, or "finishes" them by appending remaining ones as `LogicalFilter` nodes above the current operator.

---

## Pass 8: ProjectionPushDownOptimizer

**Source:** `src/optimizer/projection_push_down_optimizer.cpp`

**Purpose:** Remove unused columns from the plan, avoiding unnecessary property reads from storage. See [Optimizer Passes (Deep Dive)](./optimizer-passes.md) for the complete algorithm.

**Key behaviors:**
- Tracks three expression sets: `propertiesInUse`, `variablesInUse`, `nodeOrRelInUse`.
- `collectExpressionsInUse()` recurses into expression children to gather all referenced leaves.
- `pruneExpressions()` filters expression lists to only those in the tracked sets.
- `preAppendProjection()` inserts a `LogicalProjection` between an operator and one of its children when the child exposes more columns than needed.
- **Projection restart:** When a `PROJECTION` node is encountered during top-down traversal, a fresh `ProjectionPushDownOptimizer` is instantiated — projections define scope boundaries.
- **Path optimization:** If a recursive relationship's path is not needed downstream, switches from path-tracking to destination-only GDS algorithms (e.g., `SingleSPPathsFunction` → `SingleSPDestinationsFunction`).
- **Foreign table column skips:** Sets `columnSkips` on `LogicalTableFunctionCall` to avoid reading unneeded foreign columns.

---

## Pass 9: OrderByPushDownOptimizer

**Source:** `src/optimizer/order_by_push_down_optimizer.cpp`

**Purpose:** Push `ORDER BY` clauses into foreign table function scans that support push-down (`supportsPushDownFunc()`). This lets the foreign table produce pre-sorted data, potentially avoiding a sort step in LadybugDB's pipeline.

**Algorithm:**
- Accumulates `ORDER BY` key strings as it descends through transparent operators (FILTER, PROJECTION, ACCUMULATE, LIMIT, MULTIPLICITY_REDUCER, EXPLAIN).
- Calls `tableFunc.setOrderBy(orderByString)` when a supported table function call is reached.
- Returns the table function call without the ORDER BY wrapper (the ORDER BY was consumed by the push-down).

---

## Pass 10: LimitPushDownOptimizer

**Source:** `src/optimizer/limit_push_down_optimizer.cpp`

**Purpose:** Push `LIMIT` values into subplans where they can reduce work early.

**Pushdown targets:**
- **Table function calls** with `supportsPushDownFunc()`: sets `limitNum` on the function.
- **`DISTINCT`** operators: sets `limitNum` and `skipNum` directly.
- **Recursive extend** (`HASH_JOIN → PATH_PROPERTY_PROBE → RECURSIVE_EXTEND`): sets `limitNum` on the recursive extend to stop BFS/DFS early.
- **UNION ALL**: creates a fresh `LimitPushDownOptimizer` per union branch.

```cpp
// Push limit into recursive extend
auto& extend = op->getChild(0)->getChild(0)->cast<LogicalRecursiveExtend>();
extend.setLimitNum(skipNumber + limitNumber);
```

---

## Pass 11: HashJoinSIPOptimizer (Sideways Information Passing)

**Source:** `src/optimizer/acc_hash_join_optimizer.cpp` (class `HashJoinSIPOptimizer`)

**Purpose:** Apply the **Sideways Information Passing (SIP)** optimization for hash joins. SIP allows the hash table built from one side to filter the other side using a semi-mask, reducing I/O when one side is selective.

**Two SIP directions:**

**Probe-to-build SIP** (`tryProbeToBuildHJSIP`):
- Applies when the probe side is **selective** (contains a filter or index scan: `subPlanContainsFilter(probeRoot)`).
- Probe side has not already been accumulated.
- Inserts a `LogicalSemiMasker` on the probe side targeting scan nodes in the build side.
- Wraps the probe side in `ACCUMULATE` so the probe materializes before build executes.
- Sets `SIPDependency::PROBE_DEPENDS_ON_BUILD`, `SIPDirection::PROBE_TO_BUILD`.

**Build-to-probe SIP** (`tryBuildToProbeHJSIP`):
- Applies when the build side is selective or contains a recursive extend.
- Inserts a `LogicalSemiMasker` on the build side targeting scan nodes in the probe side.
- Sets `SIPDependency::BUILD_DEPENDS_ON_PROBE`, `SIPDirection::BUILD_TO_PROBE`.

**Semi-mask targets** can be:
- `SCAN_NODE` — a regular `ScanNodeTable` operator
- `RECURSIVE_EXTEND_INPUT_NODE` — the input node of a recursive traversal
- `RECURSIVE_EXTEND_OUTPUT_NODE` — the output node of a recursive traversal

**Intersect and PathPropertyProbe** operators also receive SIP treatment in their respective visit methods.

**Guard:** `SemiMaskPosition::PROHIBIT` on the join's SIPInfo prevents SIP from being applied (set by FilterPushDown when it creates hash joins from cross products).

---

## Pass 12: TopKOptimizer

**Source:** `src/optimizer/top_k_optimizer.cpp`

**Purpose:** Fold `ORDER BY → LIMIT` patterns into a single top-K evaluation, avoiding full sort of the entire dataset.

**Pattern matched:**
```
LIMIT (hasLimitNum)
  └── MULTIPLICITY_REDUCER
        └── ORDER_BY                  (direct child)
          or
        └── PROJECTION
              └── ORDER_BY            (projection between reducer and sort)
```

**Rewrite:** Sets `limitNum` (and optionally `skipNum`) directly on the `LogicalOrderBy` node, then removes the `LIMIT` node from the tree. The physical planner later maps a `LogicalOrderBy` with a limit number to a TopK physical operator.

---

## Pass 14: FactorizationRewriter

**Source:** `src/optimizer/factorization_rewriter.cpp`

**Purpose:** Insert `FLATTEN` operators wherever the vectorized factorized execution model requires a data chunk group to be materialized (flattened) before it can be consumed by an operator.

**Background — Factorized Execution:** LadybugDB uses a factorized representation where each data chunk group (`f_group`) can be either **flat** (one value per tuple) or **unflat** (one pointer to a vector of values). Certain operators require their input groups to be flat before they can operate correctly. The `FactorizationRewriter` inserts `FLATTEN` operators to enforce this.

**The `f_group` concept:** Each column in LadybugDB's schema belongs to an `f_group_pos`. Groups can be flat (size 1 in the current vector) or unflat (contain multiple values). When an operator needs to access two unflat groups from different factorized branches simultaneously — a "cross-group access" — one of them must be flattened first.

**`appendFlattenIfNecessary(op, groupPos)`:**
```cpp
std::shared_ptr<LogicalOperator> FactorizationRewriter::appendFlattenIfNecessary(
    std::shared_ptr<LogicalOperator> op, f_group_pos groupPos) {
    if (op->getSchema()->getGroup(groupPos)->isFlat()) {
        return op;  // Already flat, no FLATTEN needed
    }
    auto flatten = std::make_shared<LogicalFlatten>(groupPos, std::move(op), 0);
    flatten->computeFactorizedSchema();
    return flatten;
}
```

**Per-operator decisions:**
| Operator | Groups flattened |
|----------|-----------------|
| `HASH_JOIN` | Groups to flatten on probe side (from `getGroupsPosToFlattenOnProbeSide()`) and build side |
| `INTERSECT` | Probe side and each build side separately |
| `PROJECTION` | If random function present: flatten all groups; otherwise for each projected expression: flatten all groups except one (FlattenAllButOne) |
| `ACCUMULATE` | Groups from `getGroupPositionsToFlatten()` |
| `AGGREGATE` | Groups from `getGroupsPosToFlatten()` |
| `ORDER_BY` | Groups from `getGroupsPosToFlatten()` |
| `LIMIT` | Groups from `getGroupsPosToFlatten()` |
| `DISTINCT` | Groups from `getGroupsPosToFlatten()` |
| `UNWIND` | Groups from `getGroupsPosToFlatten()` |
| `UNION_ALL` | Per-child groups |
| `FILTER` | Groups from `getGroupsPosToFlatten()` |
| `SET_PROPERTY`, `DELETE`, `INSERT`, `MERGE`, `COPY_TO` | Respective groups |

**FlattenAllButOne:** For each projected expression, identifies the "leading" unflat group (the one that should remain unflat) and flattens all others. This preserves the factorized structure for single-expression projections while ensuring correct semantics.

---

## Pass 15: AggKeyDependencyOptimizer

**Source:** `src/optimizer/agg_key_dependency_optimizer.cpp`

**Purpose:** Detect redundant GROUP BY keys that are functionally dependent on other keys and demote them from "keys" to "dependent keys." This reduces the number of hash table columns compared in GROUP BY, improving performance.

**Algorithm:**
1. For each key in the GROUP BY list:
   - If the key is a **primary key** or **internal ID** property, add its variable name to `primaryVarNames`.
2. Second pass:
   - Keys that are primary keys or internal IDs → remain in `keys`.
   - Properties whose variable is in `primaryVarNames` → moved to `dependentKeys` (they are functionally determined by the primary key).
   - Node/rel patterns whose variable is in `primaryVarNames` → moved to `dependentKeys`.
   - All others → remain in `keys`.

**Example:** `RETURN a._id, a.age, COUNT(*)` — `a._id` is the primary key; `a.age` is functionally determined by `a._id`. So `a._id` is a key, `a.age` is a dependent key. The hash aggregate only needs to hash/compare on `a._id`.

Applied to both `LogicalAggregate` (moves to `dependentKeys`) and `LogicalDistinct` (moves to `payloads`).

---

## Pass 16: CardinalityUpdater (EXPLAIN only)

**Source:** `src/optimizer/cardinality_updater.cpp`

**Purpose:** Re-estimate cardinalities for each operator after all rewrites have completed. Runs only when the query is `EXPLAIN LOGICAL` — during normal query execution cardinalities are not needed after planning.

**Algorithm:** Bottom-up traversal; calls `cardinalityEstimator` for:
- `SCAN_NODE_TABLE` → `estimateScanNode()`
- `EXTEND` → `getExtensionRate()` × child cardinality
- `HASH_JOIN` → `estimateHashJoin(joinConditions, child0, child1)`
- `CROSS_PRODUCT` → `estimateCrossProduct(child0, child1)`
- `INTERSECT` → `estimateIntersect(keyNodeIDs, child0, buildOps)`
- `FLATTEN` → `estimateFlatten(child, groupPos)`
- `FILTER` → `estimateFilter(child, predicate)` (applies selectivity factor)
- `LIMIT` → evaluates limit expression as literal
- `AGGREGATE` → `estimateAggregate(aggregate)`
- Default (unary ops) → inherit child cardinality

---

## Worked Example

**Query:** `MATCH (a:Person)-[:KNOWS]->(b) RETURN a.name, count(b) ORDER BY count(b) DESC LIMIT 10`

**After logical planning, approximate tree:**
```
LIMIT(10)
  MULTIPLICITY_REDUCER
    ORDER_BY [count(b) DESC]
      PROJECTION [a.name, count(b)]
        AGGREGATE [keys: a._id; aggs: COUNT(b._id)]
          EXTEND [:KNOWS, fwd]
            SCAN_NODE_TABLE [a:Person] {a._id, a.name}
              SCAN_NODE_TABLE [b]  (join for b node)
```

**Passes applied:**

1. **RemoveFactorizationRewriter** — no FLATTENs present; no-op.
2. **CorrelatedSubqueryUnnestSolver** — no correlated subqueries; no-op.
3. **RemoveUnnecessaryJoinOptimizer** — if `b` scan has no properties read, prune the join.
4. **UnwindDedupOptimizer** — no MERGE/UNWIND; no-op.
5. **CountRelTableOptimizer (pass 1)** — AGGREGATE has keys (`a._id`), so does not match "simple count" pattern; no-op.
6. **ForeignJoinPushDownOptimizer** — no foreign tables; no-op.
7. **FilterPushDownOptimizer** — no explicit WHERE clause; no filter predicates to push. If there were a `WHERE a.name = 'Alice'`, this pass would either rewrite to a PRIMARY_KEY_SCAN (if `name` is PK) or push the filter below AGGREGATE.
8. **ProjectionPushDownOptimizer** — determines that from PROJECTION, only `a.name`, `b._id` (for COUNT), and `a._id` (GROUP BY key) are needed. Prunes any other properties from `SCAN_NODE_TABLE`. Sets `columnSkips` for `b`'s scan if `b._id` is not needed beyond the COUNT.
9. **OrderByPushDownOptimizer** — no foreign table function; no-op.
10. **LimitPushDownOptimizer** — LIMIT=10. Traverses through MULTIPLICITY_REDUCER, ORDER_BY is not a direct pushdown target; stores limit=10 for TopK.
11. **HashJoinSIPOptimizer** — examines hash joins in the plan. If the `b` SCAN is on the build side and there is a filter on probe, applies probe-to-build SIP.
12. **TopKOptimizer** — finds pattern `LIMIT(10) → MULTIPLICITY_REDUCER → ORDER_BY`. Moves `limitNum=10` onto `ORDER_BY`, removes `LIMIT` node.
13. **CountRelTableOptimizer (pass 2)** — now sees `ORDER_BY [with limitNum=10] → AGGREGATE [COUNT(*)]`. If this matches degree-lookup pattern, rewrites to `LogicalRelDegreeTable`.
14. **FactorizationRewriter** — bottom-up traversal inserts FLATTEN nodes. AGGREGATE needs its child group flattened (groups from EXTEND are unflat). Inserts `FLATTEN` before AGGREGATE.
15. **AggKeyDependencyOptimizer** — GROUP BY key is `a._id` (primary key/internal ID). `a.name` is a property of `a` and is moved to `dependentKeys`. Hash aggregate hashes only on `a._id`.
16. **CardinalityUpdater** — only if `EXPLAIN LOGICAL`; estimates cardinalities for display.

**Final optimized logical tree (approximate):**
```
PROJECTION [a.name, count(b)]
  AGG_SCAN
    AGG_FINALIZE
      AGGREGATE [keys: a._id; dependentKeys: a.name; aggs: COUNT(b._id)]   ← ORDER_BY has limitNum=10
        FLATTEN [group 1]
          EXTEND [:KNOWS, fwd]
            SCAN_NODE_TABLE [a:Person] {a._id, a.name}   ← only needed cols
```


---

## Schema Computation After Each Pass

After each structural change (node insertion, replacement, or subtree rewrite), operators call `computeFlatSchema()` or `computeFactorizedSchema()`. These methods re-derive the output schema — the set of data chunk groups and the expressions in each group — based on the operator's type and children's schemas.

- **`computeFlatSchema()`** — used by passes that work with flat (non-factorized) schemas: FilterPushDown, ProjectionPushDown, RemoveFactorizationRewriter, etc.
- **`computeFactorizedSchema()`** — used by FactorizationRewriter and SchemaPopulator, which must model the full factorized structure.

Schema recomputation is critical because expressions are addressed by `(dataChunkPos, valueVectorPos)` positions that depend on the schema layout. If a FLATTEN or PROJECTION is inserted without recomputing schemas, downstream operators will read from wrong positions.

---

## Guard: `enablePlanOptimizer`

The full pipeline only runs when `ClientConfig::enablePlanOptimizer` is `true` (the default). When disabled:

```cpp
auto schemaPopulator = SchemaPopulator{};
schemaPopulator.rewrite(plan);
```

`SchemaPopulator` does a bottom-up traversal calling `computeFactorizedSchema()` on each node to ensure schemas are populated, but does not apply any rewrites. This is useful for debugging or testing logical plans without optimizer interference.

---

## Guard: `enableSemiMask`

`HashJoinSIPOptimizer` (pass 11) only runs if `ClientConfig::enableSemiMask` is `true`. This flag can be disabled to measure the performance impact of SIP, or when SIP causes correctness issues in edge cases.

---

## Inter-Pass Dependencies

The pass order is not arbitrary. Key dependencies:

| Pass | Requires |
|------|----------|
| `CorrelatedSubqueryUnnestSolver` | `RemoveFactorizationRewriter` has run (no FLATTENs blocking schema traversal) |
| `FilterPushDownOptimizer` | `ForeignJoinPushDownOptimizer` has run (foreign join pattern detected before it's broken up) |
| `HashJoinSIPOptimizer` | `FilterPushDownOptimizer` has run (filters in place so selectivity is measurable); `AccHashJoin` markers set |
| `TopKOptimizer` | `OrderByPushDownOptimizer` and `LimitPushDownOptimizer` have run |
| `CountRelTableOptimizer (pass 2)` | `TopKOptimizer` has run (limitNum folded into ORDER_BY) |
| `FactorizationRewriter` | All structural rewrites done (no more operator insertions that would invalidate factorized schemas) |
| `AggKeyDependencyOptimizer` | `FactorizationRewriter` has run (factorized structure is stable) |
| `CardinalityUpdater` | All passes done (final plan shape) |

---

## Source Files Reference

| File | Class | Role |
|------|-------|------|
| `src/optimizer/optimizer.cpp` | `Optimizer` | Pipeline orchestration |
| `src/optimizer/logical_operator_visitor.cpp` | `LogicalOperatorVisitor` | Base visitor dispatch |
| `src/optimizer/remove_factorization_rewriter.cpp` | `RemoveFactorizationRewriter` | Remove FLATTEN nodes |
| `src/optimizer/correlated_subquery_unnest_solver.cpp` | `CorrelatedSubqueryUnnestSolver` | Unnest correlated subqueries |
| `src/optimizer/remove_unnecessary_join_optimizer.cpp` | `RemoveUnnecessaryJoinOptimizer` | Prune trivial joins |
| `src/optimizer/unwind_dedup_optimizer.cpp` | `UnwindDedupOptimizer` | MERGE/UNWIND dedup |
| `src/optimizer/count_rel_table_optimizer.cpp` | `CountRelTableOptimizer` | COUNT → degree scan |
| `src/optimizer/foreign_join_push_down_optimizer.cpp` | `ForeignJoinPushDownOptimizer` | Foreign table push-down |
| `src/optimizer/filter_push_down_optimizer.cpp` | `FilterPushDownOptimizer` | Filter push-down |
| `src/optimizer/projection_push_down_optimizer.cpp` | `ProjectionPushDownOptimizer` | Projection push-down |
| `src/optimizer/order_by_push_down_optimizer.cpp` | `OrderByPushDownOptimizer` | ORDER BY push-down |
| `src/optimizer/limit_push_down_optimizer.cpp` | `LimitPushDownOptimizer` | LIMIT push-down |
| `src/optimizer/acc_hash_join_optimizer.cpp` | `HashJoinSIPOptimizer` | Semi-mask SIP |
| `src/optimizer/top_k_optimizer.cpp` | `TopKOptimizer` | ORDER BY + LIMIT → TopK |
| `src/optimizer/factorization_rewriter.cpp` | `FactorizationRewriter` | Insert FLATTEN nodes |
| `src/optimizer/agg_key_dependency_optimizer.cpp` | `AggKeyDependencyOptimizer` | Reduce GROUP BY keys |
| `src/optimizer/schema_populator.cpp` | `SchemaPopulator` | Schema-only (no optimizer) |
| `src/optimizer/cardinality_updater.cpp` | `CardinalityUpdater` | Re-estimate cardinalities |

---

## See Also

- [Optimizer Passes (Deep Dive)](./optimizer-passes.md) — full algorithm for FilterPushDown and ProjectionPushDown
- [Physical Planner](./planner.md) — maps optimized logical plan to physical operators
- [Expression Evaluator](./expressions.md) — runtime expression evaluation
- [Semi-Mask & SIP Optimization](/execution/semi-mask) — SIP execution details
- [Logical Planner](./planner.md) — how logical plans are constructed before optimization

---

## Detailed: `LogicalOperatorCollector` Utilities

Many optimizer passes use collector helper classes to gather specific operator types from a subtree without full traversal code. Defined in `src/optimizer/logical_operator_collector.cpp`:

```cpp
// Example collectors used in the optimizer
LogicalFilterCollector          // collects all LogicalFilter nodes
LogicalIndexScanNodeCollector   // collects primary key scan nodes
LogicalScanNodeTableCollector   // collects all ScanNodeTable nodes
LogicalRecursiveExtendCollector // collects RecursiveExtend nodes
LogicalFlattenCollector         // used to assert no FLATTENs remain
```

Usage pattern:
```cpp
auto collector = LogicalScanNodeTableCollector();
collector.collect(root);
for (auto& op : collector.getOperators()) {
    auto& scan = op->constCast<LogicalScanNodeTable>();
    // process scan
}
```

This pattern is used extensively in `HashJoinSIPOptimizer` to find candidate scan nodes for semi-mask insertion.

---

## Detailed: `PredicateSet` Structure

`FilterPushDownOptimizer` maintains a `PredicateSet` that classifies predicates by their comparison type:

```cpp
struct PredicateSet {
    expression_vector equalityPredicates;      // ExpressionType::EQUALS only
    expression_vector nonEqualityPredicates;   // all other comparisons

    void addPredicate(std::shared_ptr<Expression> predicate);
    expression_vector getAllPredicates();       // equality ++ non-equality

    // Primary key operations
    std::shared_ptr<Expression> popNodePKEqualityComparison(const Expression& nodeID);
    PrimaryKeyRangePredicate popNodePKRangeComparison(const Expression& nodeID);
    bool isEmpty() const;
    void clear();
};
```

The separation of equality vs. non-equality predicates matters because:
1. **Equality predicates** can be rewritten as join conditions when they span a cross-product.
2. **Equality predicates on primary keys** trigger index scan rewrites.
3. **Range predicates on primary keys** (using an ART index) trigger range index scan rewrites.

The `popNodePKEqualityComparison` method normalizes the predicate so the primary key is always on the **left-hand side** — a precondition for the primary key scan code path.

### Primary Key Range Scan

When the table has an ART primary key index and there are `>`, `>=`, `<`, `<=` predicates on the primary key with constant bounds, a range scan is created:

```cpp
struct PrimaryKeyRangePredicate {
    std::shared_ptr<Expression> lowerBound;   // nullptr if no lower bound
    bool lowerInclusive;                       // >= vs >
    std::shared_ptr<Expression> upperBound;   // nullptr if no upper bound
    bool upperInclusive;                       // <= vs <
    bool hasBound() const { return lowerBound != nullptr || upperBound != nullptr; }
};
```

After extracting the range predicates, they are **erased from `nonEqualityPredicates`** using index-based erase in descending order (to avoid shifting issues):
```cpp
std::sort(predicateIndices.begin(), predicateIndices.end(), std::greater<>());
for (auto predicateIdx : predicateIndices) {
    if (predicateIdx != INVALID_IDX) {
        nonEqualityPredicates.erase(nonEqualityPredicates.begin() + predicateIdx);
    }
}
```

---

## Detailed: `ScanNodeTable` Scan Types

After FilterPushDownOptimizer runs, a `LogicalScanNodeTable` can have one of three scan types:

```cpp
enum class LogicalScanNodeTableType {
    SCAN,              // Full sequential scan with morsel-based parallelism
    PRIMARY_KEY_SCAN,  // Point or range lookup via ART/hash index
};
```

The `PrimaryKeyScanInfo` extra info carries the lookup parameters:

```cpp
struct PrimaryKeyScanInfo {
    // Point lookup
    std::shared_ptr<Expression> key;

    // Range lookup
    std::shared_ptr<Expression> lowerBound;
    bool lowerInclusive;
    std::shared_ptr<Expression> upperBound;
    bool upperInclusive;
    bool isRange;
};
```

---

## Detailed: Recursive Pattern Handling in ProjectionPushDownOptimizer

The optimizer has special handling for recursive (variable-length) relationship patterns. When the path output (`rel`) is **not** referenced in the downstream projection:

```cpp
void ProjectionPushDownOptimizer::visitPathPropertyProbe(LogicalOperator* op) {
    auto& pathPropertyProbe = op->cast<LogicalPathPropertyProbe>();
    if (nodeOrRelInUse.contains(pathPropertyProbe.getRel())) {
        return; // Path is needed — keep as is
    }
    // Path is not needed — switch to destination-only algorithm
    pathPropertyProbe.setJoinType(planner::RecursiveJoinType::TRACK_NONE);
    auto extend = child->ptrCast<LogicalRecursiveExtend>();
    auto functionName = extend->getFunction().getFunctionName();
    if (functionName == VarLenJoinsFunction::name) {
        extend->getBindDataUnsafe().writePath = false;
    } else if (functionName == SingleSPPathsFunction::name) {
        extend->setFunction(SingleSPDestinationsFunction::getAlgorithm());
    } else if (functionName == AllSPPathsFunction::name) {
        extend->setFunction(AllSPDestinationsFunction::getAlgorithm());
    } else if (functionName == WeightedSPPathsFunction::name) {
        extend->setFunction(WeightedSPDestinationsFunction::getAlgorithm());
    }
}
```

This is a significant performance optimization: shortest-path algorithms that do not need to reconstruct the path can use simpler BFS variants that do not track parent pointers.

---

## Detailed: `isConstantExpression` in FilterPushDown

For primary key scans, the right-hand side of the equality must be a "constant expression" — evaluable without the current row context:

```cpp
static bool isConstantExpression(const std::shared_ptr<Expression> expression) {
    switch (expression->expressionType) {
    case ExpressionType::LITERAL:
    case ExpressionType::PARAMETER:
        return true;
    case ExpressionType::FUNCTION: {
        auto& func = expression->constCast<ScalarFunctionExpression>();
        if (func.getFunction().name == "CAST") {
            return isConstantExpression(func.getChild(0));
        }
        return false;
    }
    default:
        return false;
    }
}
```

`PARAMETER` (prepared statement parameter) is treated as constant because it is bound before execution. `CAST` of a constant is also constant. Any other expression (property access, sub-expression, etc.) disqualifies the primary key scan rewrite.

---

## Detailed: Cross-Product to Hash Join Rewrite

When `FilterPushDownOptimizer` processes a `CROSS_PRODUCT`, it attempts to rewrite it as a `HASH_JOIN`:

```
FILTER [a.id = b.id]           HASH_JOIN [a.id = b.id]
  CROSS_PRODUCT          →       SCAN a
    SCAN a                       SCAN b
    SCAN b
```

Algorithm:
1. For each predicate in `predicateSet`: partition into `probePSet`, `buildPSet`, `remainingPSet`.
   - A predicate belongs to probe if it is evaluable solely using the probe schema.
   - A predicate belongs to build if it is evaluable solely using the build schema.
   - Otherwise it remains.
2. Push `probePSet` into a fresh `FilterPushDownOptimizer` for the probe child.
3. Push `buildPSet` into a fresh `FilterPushDownOptimizer` for the build child.
4. From `remainingPSet.equalityPredicates`, check if each predicate's two children span the probe and build schemas exactly. If so, convert to `join_condition_t`.
5. If any join conditions were found, create `LogicalHashJoin(INNER)` with `SemiMaskPosition::PROHIBIT` (cross-product joins are not eligible for SIP).
6. Apply remaining non-equality predicates as `LogicalFilter` nodes above the hash join.
