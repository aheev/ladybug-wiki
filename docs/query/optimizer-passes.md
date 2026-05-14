# Optimizer Passes

LadybugDB's query optimizer is a rule-based, multi-pass rewriter that transforms logical plans into optimized logical plans before physical planning. All passes run in a fixed order inside `optimizer/optimizer.cpp`.

Optimization can be disabled via `CALL enable_plan_optimizer=false`, in which case only `SchemaPopulator` runs (schema computation is always required for the executor).

## Pass Execution Order

| # | Pass | File |
|---|------|------|
| 1 | `RemoveFactorizationRewriter` | `remove_factorization_rewriter.cpp` |
| 2 | `CorrelatedSubqueryUnnestSolver` | `correlated_subquery_unnest_solver.cpp` |
| 3 | `RemoveUnnecessaryJoinOptimizer` | `remove_unnecessary_join_optimizer.cpp` |
| 4 | `UnwindDedupOptimizer` | `unwind_dedup_optimizer.cpp` |
| 5 | `CountRelTableOptimizer` | `count_rel_table_optimizer.cpp` |
| 6 | `ForeignJoinPushDownOptimizer` | `foreign_join_push_down_optimizer.cpp` |
| 7 | `FilterPushDownOptimizer` | `filter_push_down_optimizer.cpp` |
| 8 | `ProjectionPushDownOptimizer` | `projection_push_down_optimizer.cpp` |
| 9 | `OrderByPushDownOptimizer` | `order_by_push_down_optimizer.cpp` |
| 10 | `LimitPushDownOptimizer` | `limit_push_down_optimizer.cpp` |
| 11 | `HashJoinSIPOptimizer` *(if `enableSemiMask`)* | `acc_hash_join_optimizer.cpp` |
| 12 | `TopKOptimizer` | `top_k_optimizer.cpp` |
| 13 | `FactorizationRewriter` | `factorization_rewriter.cpp` |
| 14 | `AggKeyDependencyOptimizer` | `agg_key_dependency_optimizer.cpp` |
| 15 | `CardinalityUpdater` *(EXPLAIN LOGICAL only)* | `cardinality_updater.cpp` |

---

## Pass Details

### 1. RemoveFactorizationRewriter

Strips the factorization structure (f-groups) from the planner schema before any other optimization. Many optimizers cannot handle non-flat operator groups, so this is always the first step. Pass 13 (`FactorizationRewriter`) then reintroduces factorization at the end.

### 2. CorrelatedSubqueryUnnestSolver

Detects correlated subqueries (`EXISTS`, `IN`, scalar subqueries with references to outer scope) and rewrites them into joins. After this pass, every subquery is either a hash join or a semi-join — regular join optimizers can then reason about them.

**Example:**
```cypher
MATCH (p:Person)
WHERE EXISTS { MATCH (p)-[:KNOWS]->(q:Person) WHERE q.city = 'NYC' }
RETURN p.name
-- Unnested to: SemiJoin(Person scan, EXTEND+filter)
```

### 3. RemoveUnnecessaryJoinOptimizer

Removes joins where one side's output columns are never referenced downstream. Typical case: a join that extends to a node only to check existence, but whose properties are unused.

**Example:**
```cypher
MATCH (p:Person)-[:KNOWS]->(q)
RETURN p.name
-- If q's properties are never used, the join with q may be eliminated
```

### 4. UnwindDedupOptimizer

When a `UNWIND list AS x` expression would produce duplicate values across morsel-parallel threads, this optimizer inserts a dedup step. Applied after factorization is removed because deduplication requires a flat schema to determine per-thread boundaries.

### 5. CountRelTableOptimizer

Rewrites `COUNT(*)` on a bare relationship table scan into a direct table cardinality lookup — bypassing the full scan entirely.

**Example:**
```cypher
MATCH ()-[e:KNOWS]->() RETURN COUNT(*)
-- Optimized to: NodeTable::getNumRels("KNOWS") → return single integer
```

Applied early before other passes can restructure the plan.

### 6. ForeignJoinPushDownOptimizer

When a pattern involves a cross-database foreign table (accessed via an attached database), this pass identifies the foreign join pattern and rewrites it to push the join computation down to the remote database. Must run before `FilterPushDownOptimizer` so the full join pattern is visible before it gets split by filter pushdown.

### 7. FilterPushDownOptimizer

Moves `WHERE` predicates as close to the data source as possible. This is the most important optimization for scan performance.

**What it pushes down:**

- `WHERE p.age > 35` pushed into `ScanNodeTable[person]`:
  - Becomes a `ColumnPredicate` on the node table
  - During scan, `ColumnPredicateSet::checkZoneMap(stats)` can skip entire column chunks where `max(age) <= 35` (zone map skipping)
  - Rows that pass the zone map check are still filtered after decompression

- Join predicates are distributed to the relevant join child:
  - `WHERE p.city = q.city` pushed into both sides as column predicates where possible

- Cross-product joins with a matching equality predicate are converted to hash joins

**Implementation details:**
- Traverses the plan tree top-down collecting predicates into a `PredicateSet`
- When reaching `LogicalScanNodeTable`, calls `visitScanNodeTableReplace()` which converts matching predicates into `ColumnPredicateSet` attached to the scan
- Constant-false literals (`WHERE false`) are replaced with `LogicalEmptyResult` (early termination, no data read)

### 8. ProjectionPushDownOptimizer

Removes columns produced by scan operators but never referenced by any downstream expression. Reduces memory bandwidth and intermediate data size.

For recursive patterns, the `recursivePatternSemantic` (WALK/TRAIL/ACYCLIC) determines which path tracking columns must be preserved even if not explicitly projected.

### 9. OrderByPushDownOptimizer

Pushes ORDER BY clauses below projection boundaries where semantically safe. Often a prerequisite for TopK optimization (pass 12) because the limit must be adjacent to the sort.

### 10. LimitPushDownOptimizer

Pushes `LIMIT N` through projections and filters toward the scan. Enables early-exit in pipelines — once N tuples have been produced, subsequent morsels can be skipped.

::: tip
`LimitPushDown` + `OrderByPushDown` together set up the conditions for `TopKOptimizer` in pass 12.
:::

### 11. HashJoinSIPOptimizer (Sideways Information Passing)

The most complex optimizer pass. Implements **Semi-mask Intersection Pushdown (SIP)** — a technique that avoids scanning irrelevant nodes by pushing knowledge from the hash join build phase back to the probe-side scan.

**How SIP works:**

```
Without SIP:
  HashJoin(build: Tag scan, probe: Person scan+filter)
  Person scan reads ALL 10M persons, HashJoin discards 9.9M

With SIP:
  SemiMasker → Tag scan (marks matching tagIDs)
  HashJoin   → probe: Person scan (skips persons not in SemiMask)
  Person scan reads only ~100K persons with matching tags
```

**When SIP is inserted:**

`isProbeSideQualified(probeRoot)` returns true if the probe side has any filter or primary-key scan. A build-side `LogicalScanNodeTable` is then wrapped in `LogicalSemiMasker`.

**Recursive extend SIP:**

For `MATCH (a)-[*1..5]->(b)` patterns, SIP can mask both:
- `RECURSIVE_EXTEND_INPUT_NODE` — nodes entering the traversal (`a`)
- `RECURSIVE_EXTEND_OUTPUT_NODE` — destination nodes (`b`)

This avoids expanding from/to nodes that will be discarded by a downstream join condition.

**Config:** Only applied when `config.enableSemiMask = true` (default: `true`). Can be disabled per-session with `CALL enable_semi_mask=false`.

### 12. TopKOptimizer

Converts `ORDER BY ... LIMIT N` into a `TopK` operator that maintains a min/max heap of the top N rows, discarding the rest during scan.

**Complexity:** `O(n log k)` vs `O(n log n)` for full sort.

Applied after LimitPushDown and OrderByPushDown have positioned the LIMIT and ORDER BY operators adjacently.

### 13. FactorizationRewriter

Reintroduces factorization (f-groups) into the optimized plan. Factorization allows certain expressions to be computed once per group (e.g., once per source node) rather than once per row in the full cross-product.

This is the inverse of pass 1 (`RemoveFactorizationRewriter`). The rewriter analyzes expression dependencies and assigns each output expression to the correct f-group.

See the [Factorization Rewriter pass](#_13-factorizationrewriter) above for context.

### 14. AggKeyDependencyOptimizer

Removes `GROUP BY` keys that are functionally determined by other keys in the same aggregate.

**Example:**
```cypher
MATCH (p:Person)
RETURN p.id, p.name, COUNT(*)
GROUP BY p.id, p.name
-- If p.id is the primary key, p.name is determined by p.id
-- Optimized to: GROUP BY p.id  (p.name added back in projection)
```

This reduces the hash table key size for aggregations over node properties.

### 15. CardinalityUpdater (EXPLAIN LOGICAL only)

Propagates cardinality estimates through the optimized logical plan so that `EXPLAIN (TYPE LOGICAL)` shows accurate row count annotations. Uses the same `CardinalityEstimator` that was used during join order planning. Does nothing for non-EXPLAIN queries.

---

## Schema Populator (no-optimization fallback)

When `enablePlanOptimizer = false`, all 15 passes are skipped. `SchemaPopulator` runs instead — it only computes expression schemas (data types, flat/unflat group state) that the physical executor requires, without rewriting the plan structure.

---

## Disabling Optimization

```cypher
-- Disable all optimizer passes (useful for debugging plan shape)
CALL enable_plan_optimizer=false;

-- Disable only semi-mask/SIP
CALL enable_semi_mask=false;
```

---

## Related Files

| File | Purpose |
|------|---------|
| `src/optimizer/optimizer.cpp` | Top-level pass orchestration |
| `src/optimizer/filter_push_down_optimizer.cpp` | Filter pushdown + zone map predicate conversion |
| `src/optimizer/acc_hash_join_optimizer.cpp` | SIP / semi-mask injection |
| `src/optimizer/factorization_rewriter.cpp` | F-group reintroduction |
| `src/optimizer/top_k_optimizer.cpp` | ORDER+LIMIT → TopK heap |
| `src/optimizer/count_rel_table_optimizer.cpp` | COUNT(*) shortcut |
| `src/optimizer/agg_key_dependency_optimizer.cpp` | Redundant GROUP BY key removal |
| `src/include/planner/operator/sip/logical_semi_masker.h` | SemiMasker logical operator |
| `src/storage/predicate/column_predicate.h` | ColumnPredicate / zone map check |
