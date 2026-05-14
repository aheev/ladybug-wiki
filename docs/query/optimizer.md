# Optimizer

**Source files:** `src/optimizer/optimizer.cpp`, `src/include/optimizer/`, `src/optimizer/`

## Overview

The optimizer transforms a logical plan into an **optimized logical plan** through a series of rewrite passes. Each pass traverses the plan tree and applies local or global rewrites. The order matters — later passes depend on earlier ones having run.

## Pass Order

```cpp
// optimizer.cpp
void Optimizer::optimize(LogicalPlan& plan) {
    // 1. Push predicates as close to the data source as possible
    PredicatePushDownOptimizer{}.rewrite(plan);

    // 2. Push projections down: drop columns not needed by downstream ops
    ProjectionPushDownOptimizer{}.rewrite(plan);

    // 3. Decide SIP direction for each hash join (semi-mask optimization)
    AccHashJoinOptimizer{}.rewrite(plan);

    // 4. Remove unnecessary FLATTEN ops introduced by factorized planning
    FlattenRewriter{}.rewrite(plan);

    // 5. Rewrite recursive (variable-length) patterns
    RecursivePatternRewriter{}.rewrite(plan);

    // 6. Rewrite EXISTS/NOT EXISTS subqueries
    ExistsSubqueryRewriter{}.rewrite(plan);
}
```

## Predicate Push-Down

**Goal:** Evaluate `WHERE` predicates as early as possible to reduce the number of rows flowing through the pipeline.

```
Before:
  LogicalFilter [p.age > 30]
    └─ LogicalHashJoin [p.id = KNOWS.src]
         ├─ LogicalScanNodeTable [Person p]
         └─ LogicalExtend [KNOWS]

After:
  LogicalHashJoin [p.id = KNOWS.src]
    ├─ LogicalScanNodeTable [Person p, pushdownFilter: age > 30]  ← pushed in
    └─ LogicalExtend [KNOWS]
```

The scan operator then evaluates `age > 30` during the column chunk scan, potentially skipping entire compressed blocks (via `Filterer`).

**Rules:**
- A predicate can be pushed to a scan if it only references columns from one table
- Predicates referencing multiple tables (join predicates) stay at the join operator
- Predicates cannot be pushed past `OPTIONAL MATCH` boundaries (they would turn left-outer-join semantics into inner-join semantics)

```cpp
// predicate_push_down_optimizer.cpp
void PredicatePushDownOptimizer::visitFilter(LogicalFilter& filter) {
    auto& pred = filter.getPredicate();
    // Identify which tables the predicate references
    auto tables = collectReferencedTables(pred);
    if (tables.size() == 1) {
        // Single-table predicate: push down to the scan
        auto* scan = findScanForTable(filter.getChild(), *tables.begin());
        if (scan) {
            scan->addPushdownFilter(pred);
            filter.replaceWithChild();  // remove the LogicalFilter node
        }
    }
    // Multi-table predicate: stays as LogicalFilter (join predicate)
}
```

## Projection Push-Down

**Goal:** Drop columns as early as possible so operators do not pass around data that is never read.

```
RETURN friend.name, count(*)
→ only friend.name and friend.id (join key) are needed after the join
→ drop p.name, p.email, etc. from p's scan
```

This reduces the number of column chunks read from disk and the number of `ValueVector`s allocated per DataChunk.

## AccHashJoinOptimizer (SIP)

See the dedicated [Semi-Mask & SIP Optimization](/execution/semi-mask) page for full details.

Summary: For each `LogicalHashJoin`, this pass decides whether to push a semi-mask from build→probe or probe→build, based on cardinality estimates.

```cpp
// acc_hash_join_optimizer.cpp
void AccHashJoinOptimizer::visitHashJoin(LogicalHashJoin& join) {
    auto buildCard = estimator.estimate(*join.getBuildSide());
    auto probeCard = estimator.estimate(*join.getProbeSide());
    if (buildCard < probeCard * SIP_THRESHOLD) {
        join.setSIPDirection(SIPDirection::BUILD_TO_PROBE);
    } else {
        join.setSIPDirection(SIPDirection::PROBE_TO_BUILD);
    }
}
```

## FlattenRewriter

The factorized planner can produce logical plans with `LogicalFlatten` operators where a factorized result must be materialized into a flat row set. The `FlattenRewriter` removes unnecessary flattens:

```
Unnecessary: LogicalFlatten → LogicalResultCollector (already returns all rows)
Removed:     LogicalResultCollector (directly)

Necessary: LogicalFlatten → LogicalAggregate (aggregate requires flat tuples)
Kept:      LogicalFlatten → LogicalAggregate
```

## Expression Evaluation Optimization

Within individual expressions, the optimizer rewrites certain patterns:

### Constant Folding

```
3 + 4 > x → 7 > x  (evaluated at compile time)
```

### NULL Short-Circuiting

```
x IS NULL AND expensive_func(x) → short-circuit: if x IS NULL, skip expensive_func
```

### Index Lookup Rewrite

```
MATCH (p:Person {id: 42})
→ Instead of scan + filter, rewrite to hash index lookup:
   LogicalIndexScan [Person, pk=42]
```

```cpp
// expression_rewriter.cpp
void IndexScanRewriter::visitFilter(LogicalFilter& filter) {
    // Pattern: property = literal, where property is the primary key
    if (isPrimaryKeyEquality(filter.getPredicate())) {
        auto scan = filter.getChild()->as<LogicalScanNodeTable>();
        scan->setPrimaryKeyLookup(getLiteralValue(filter.getPredicate()));
        filter.replaceWithChild();  // replace Filter + Scan with direct index lookup
    }
}
```

## Related Files

- `src/optimizer/optimizer.cpp` — pass orchestration
- `src/optimizer/predicate_push_down_optimizer.cpp` — predicate push-down
- `src/optimizer/projection_push_down_optimizer.cpp` — projection push-down
- `src/optimizer/acc_hash_join_optimizer.cpp` — SIP direction
- `src/optimizer/flatten_rewriter.cpp` — factorization flatten removal
- `src/binder/expression_rewriter.cpp` — constant folding, null rewriting
