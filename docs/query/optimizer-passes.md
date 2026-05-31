# Optimizer Passes (Deep Dive)

**Source files:** `src/optimizer/filter_push_down_optimizer.cpp`, `src/optimizer/projection_push_down_optimizer.cpp`, `src/include/optimizer/filter_push_down_optimizer.h`, `src/include/optimizer/projection_push_down_optimizer.h`

## What This Document Covers

This document provides a complete technical deep dive into LadybugDB's two most complex optimizer passes: `FilterPushDownOptimizer` and `ProjectionPushDownOptimizer`. It covers the full algorithm for each pass with pseudocode, explains every key data structure, and explains the critical `equalityPredicates.erase` logic in FilterPushDown. For a higher-level overview of all optimizer passes, see [Optimizer](./optimizer.md). For how the resulting optimized plan maps to physical operators, see [Physical Planner](./planner.md).

---

## FilterPushDownOptimizer — Complete Reference

**Source:** `src/optimizer/filter_push_down_optimizer.cpp`  
**Header:** `src/include/optimizer/filter_push_down_optimizer.h`

### Overview

`FilterPushDownOptimizer` is a **top-down, scope-passing** rewriter. Unlike most passes which traverse bottom-up, FilterPushDown descends into the tree carrying a set of accumulated predicates. At each node it decides: can this predicate be evaluated here, or must it continue down?

The optimizer is constructed with an initial (empty) `PredicateSet` and a `ClientContext*`:
```cpp
class FilterPushDownOptimizer {
    ClientContext* context;
    PredicateSet predicateSet;

    FilterPushDownOptimizer(ClientContext* context)
        : context{context}, predicateSet{} {}
    FilterPushDownOptimizer(ClientContext* context, PredicateSet pSet)
        : context{context}, predicateSet{std::move(pSet)} {}
};
```

For each subtree it enters, it may spawn a **fresh** `FilterPushDownOptimizer` with a subset of the current predicates — this maintains correct scoping.

### `PredicateSet` — The Core Data Structure

```cpp
struct PredicateSet {
    expression_vector equalityPredicates;      // ExpressionType::EQUALS
    expression_vector nonEqualityPredicates;   // all other predicates

    void addPredicate(std::shared_ptr<Expression> predicate);
    // addPredicate routes by ExpressionType: EQUALS → equalityPredicates, else → nonEquality

    expression_vector getAllPredicates();  // concat equality ++ non-equality

    std::shared_ptr<Expression> popNodePKEqualityComparison(const Expression& nodeID);
    PrimaryKeyRangePredicate popNodePKRangeComparison(const Expression& nodeID);

    bool isEmpty() const;
    void clear();
};
```

Predicates are **not deduplicated** — the caller guarantees each predicate is added once.

### Top-Level Algorithm

```
FilterPushDownOptimizer::rewrite(LogicalPlan* plan):
    visitOperator(plan->getLastOperator())

visitOperator(op):
    switch op.type:
        FILTER       → visitFilterReplace(op)       // absorb predicate, continue
        CROSS_PRODUCT→ visitCrossProductReplace(op) // split predicates, possibly rewrite to JOIN
        EXTEND       → visitExtendReplace(op)       // push column predicates to extend
        SCAN_NODE_TABLE → visitScanNodeTableReplace(op) // push predicates to scan
        TABLE_FUNCTION_CALL → visitTableFunctionCallReplace(op)
        default      → visitChildren(op)            // stop current push down; start fresh for children
```

### Handling `FILTER` Nodes

```cpp
std::shared_ptr<LogicalOperator> FilterPushDownOptimizer::visitFilterReplace(
    const std::shared_ptr<LogicalOperator>& op) {
    auto& filter = op->constCast<LogicalFilter>();
    auto predicate = filter.getPredicate();

    // Case 1: Literal predicate — evaluate at compile time
    if (predicate->expressionType == ExpressionType::LITERAL) {
        auto& literalExpr = predicate->constCast<LiteralExpression>();
        if (literalExpr.isNull() || !literalExpr.getValue().getValue<bool>()) {
            // WHERE false / WHERE null → entire subtree produces no rows
            return std::make_shared<LogicalEmptyResult>(*op->getSchema());
        }
        // WHERE true → ignore filter, continue
    } else {
        // Add predicate to the current set and keep pushing down
        predicateSet.addPredicate(predicate);
    }
    // FILTER node is "dissolved" — we continue into child with the predicate in our set
    return visitOperator(filter.getChild(0));
}
```

**Key point:** The `FILTER` operator is not kept in the tree at this point. It is dissolved and its predicate absorbed into `predicateSet`. The predicate will either be pushed to a scan or re-applied as a new `FILTER` later via `finishPushDown`.

### The `finishPushDown` Method

When the optimizer reaches a node it cannot push through (the default case), or after processing a terminal operator (SCAN, TABLE_FUNCTION_CALL), it calls `finishPushDown`:

```cpp
std::shared_ptr<LogicalOperator> FilterPushDownOptimizer::finishPushDown(
    std::shared_ptr<LogicalOperator> op) {
    if (predicateSet.isEmpty()) {
        return op;  // Nothing to apply
    }
    auto predicates = predicateSet.getAllPredicates();
    auto root = appendFilters(predicates, op);  // re-apply as FILTER nodes above op
    predicateSet.clear();
    return root;
}
```

`appendFilters` creates a chain of `LogicalFilter` nodes, one per predicate:
```cpp
for (auto& p : predicates) {
    root = appendFilter(p, root);  // LogicalFilter(p, child=root)
}
```

The result: predicates that could not be pushed further are stacked above the operator.

### Handling `CROSS_PRODUCT` → Hash Join Rewrite

The most complex transformation in FilterPushDown:

```
Step 1: Classify current predicateSet into three subsets:
    probePSet = predicates evaluable on probe schema only
    buildPSet = predicates evaluable on build schema only
    remainingPSet = predicates spanning both schemas or neither

Step 2: Recurse into each child with their respective subset:
    probeOptimizer = new FilterPushDownOptimizer(probePSet)
    probeOptimizer.visitOperator(probe_child)
    buildOptimizer = new FilterPushDownOptimizer(buildPSet)
    buildOptimizer.visitOperator(build_child)

Step 3: From remainingPSet.equalityPredicates, attempt join condition extraction:
    For each equality predicate (left = right):
        if left ∈ probeSchema AND right ∈ buildSchema:
            joinConditions.add((left, right))
        elif right ∈ probeSchema AND left ∈ buildSchema:
            joinConditions.add((right, left))  // normalize: probe key first
        else:
            predicates.add(predicate)          // cannot be a join condition

Step 4: If joinConditions is empty → return finishPushDown(CROSS_PRODUCT)
        (cannot rewrite, just apply remaining predicates above)

Step 5: Create HashJoin(INNER, joinConditions, probe_child, build_child)
        Set hashJoin.SIPInfo.position = PROHIBIT  // no SIP for cross-product joins

Step 6: Append remaining non-equality predicates as FILTER nodes above the hash join
```

**Why PROHIBIT SIP:** Cross-product to hash join rewrites produce joins without node ID-based join conditions (they use arbitrary equality conditions). The SIP optimizer requires node ID joins to find scan targets for semi-mask application.

### Handling `SCAN_NODE_TABLE` — Index Scan Rewrite

```
Step 1: Apply zone map predicates (if enableZoneMap):
    For each property column of the scan:
        Extract column-specific predicates from predicateSet
        Set scan.propertyPredicates[col] = ColumnPredicateSet

Step 2: Attempt primary key equality scan (point lookup):
    If scan has exactly one table:
        pk_pred = predicateSet.popNodePKEqualityComparison(nodeID)
        If pk_pred != null AND rhs of pk_pred is constant AND table has PK index:
            scan.setScanType(PRIMARY_KEY_SCAN)
            scan.extraInfo = PrimaryKeyScanInfo{key = rhs}
        else if pk_pred != null AND (no index OR rhs not constant):
            predicateSet.addPredicate(pk_pred)  // put it back, cannot use index

Step 3: If no equality scan AND table has ART index:
    Attempt primary key range scan:
        Extract lower and upper bound predicates from nonEqualityPredicates
        If hasBound():
            scan.setScanType(PRIMARY_KEY_SCAN)
            scan.extraInfo = PrimaryKeyScanInfo{isRange=true, lowerBound, upperBound, ...}

Step 4: finishPushDown(scan)  // apply remaining predicates as FILTER above scan
```

### The Critical `equalityPredicates.erase` Explained

`popNodePKEqualityComparison` contains this code:

```cpp
std::shared_ptr<Expression> PredicateSet::popNodePKEqualityComparison(const Expression& nodeID) {
    auto resultPredicateIdx = INVALID_IDX;
    for (auto i = 0u; i < equalityPredicates.size(); ++i) {
        auto predicate = equalityPredicates[i];
        if (isNodePrimaryKey(*predicate->getChild(0), nodeID)) {
            resultPredicateIdx = i;
            break;
        } else if (isNodePrimaryKey(*predicate->getChild(1), nodeID)) {
            // Normalize: swap so PK is on LHS
            auto leftChild = predicate->getChild(0);
            auto rightChild = predicate->getChild(1);
            predicate->setChild(1, leftChild);
            predicate->setChild(0, rightChild);
            resultPredicateIdx = i;
            break;
        }
    }
    if (resultPredicateIdx != INVALID_IDX) {
        auto result = equalityPredicates[resultPredicateIdx];
        equalityPredicates.erase(equalityPredicates.begin() + resultPredicateIdx);
        return result;
    }
    return nullptr;
}
```

**Why the erase is necessary:**

The `erase(begin() + resultPredicateIdx)` removes the matched primary key predicate from `equalityPredicates`. This is essential for the following reason:

After `popNodePKEqualityComparison` returns the predicate and we use it to create a `PRIMARY_KEY_SCAN`, the predicate has been "consumed" — it is encoded in the scan operator itself. If the predicate were left in `equalityPredicates`, `finishPushDown` would re-apply it as a `FILTER` node above the scan, causing the same condition to be evaluated **twice**: once in the index lookup and once as a post-scan filter. This is not merely a performance issue — for prepared statement parameters that may not be bound at optimization time, double evaluation could produce wrong results.

Additionally, after `erase`, `finishPushDown` will apply the **remaining** predicates (those not consumed by the index scan) as post-scan filters, which is correct.

**The index-based `erase` pattern** (as opposed to, say, using an iterator or a mark-and-sweep) is used for simplicity in a list that is at most a few elements long. The `popNodePKRangeComparison` method uses sorted descending erases to handle the case where both a lower and upper bound predicate must be removed without index shifting:

```cpp
std::array<idx_t, 2> predicateIndices{lowerPredicateIdx, upperPredicateIdx};
std::sort(predicateIndices.begin(), predicateIndices.end(), std::greater<>());
for (auto predicateIdx : predicateIndices) {
    if (predicateIdx != INVALID_IDX) {
        nonEqualityPredicates.erase(nonEqualityPredicates.begin() + predicateIdx);
    }
}
```

Descending order ensures that erasing the higher-index element first does not shift the lower-index element's position.

### Handling `EXTEND` — Zone Map Predicates

```cpp
std::shared_ptr<LogicalOperator> FilterPushDownOptimizer::visitExtendReplace(
    const std::shared_ptr<LogicalOperator>& op) {
    if (op->ptrCast<BaseLogicalExtend>()->isRecursive() || !context->getClientConfig()->enableZoneMap) {
        return visitChildren(op);  // No push-down for recursive extends or when zone maps disabled
    }
    auto& extend = op->cast<LogicalExtend>();
    auto columnPredicates = getColumnPredicateSets(extend.getProperties(), predicateSet.getAllPredicates());
    extend.setPropertyPredicates(std::move(columnPredicates));
    return visitChildren(op);  // Continue traversal
}
```

Note: zone map predicates on EXTEND do **not** remove the predicates from `predicateSet` — the predicates are still applied as post-scan filters above the extend, but additionally as zone map hints. This is safe because zone maps are advisory (they can only skip, never incorrectly include data).

### Handling `TABLE_FUNCTION_CALL` — Foreign Table Push-Down

```cpp
std::shared_ptr<LogicalOperator> FilterPushDownOptimizer::visitTableFunctionCallReplace(
    const std::shared_ptr<LogicalOperator>& op) {
    if (!tableFunctionCall.getTableFunc().supportsPushDownFunc()) {
        return finishPushDown(op);  // No push-down support
    }
    // For each column in the foreign table, build a ColumnPredicateSet
    // Track which predicates were successfully pushed (to remove them from remainingPredicates)
    std::unordered_set<const Expression*> pushedPredicates;
    for (auto& column : tableFunctionCall.getBindData()->columns) {
        ColumnPredicateSet columnPredicateSet;
        for (auto& predicate : predicates) {
            auto columnPredicate = ColumnPredicateUtil::tryConvert(*column, *predicate);
            if (columnPredicate != nullptr) {
                columnPredicateSet.addPredicate(std::move(columnPredicate));
                pushedPredicates.insert(predicate.get());
            }
        }
        columnPredicates.push_back(std::move(columnPredicateSet));
    }
    tableFunctionCall.setColumnPredicates(std::move(columnPredicates));
    // Only keep predicates NOT pushed into the foreign scan
    predicateSet = remainingPredicates (all predicates not in pushedPredicates);
    return finishPushDown(op);
}
```

Unlike zone map predicates, **pushed predicates are removed** from the predicate set. The foreign table executes them natively and guarantees correct filtering, so they don't need re-evaluation above.

### `visitChildren` — Scope Isolation

When the optimizer reaches an unhandled operator type (HASH_JOIN, AGGREGATE, ORDER_BY, etc.), it calls `visitChildren`:

```cpp
std::shared_ptr<LogicalOperator> FilterPushDownOptimizer::visitChildren(
    const std::shared_ptr<LogicalOperator>& op) {
    for (auto i = 0u; i < op->getNumChildren(); ++i) {
        auto optimizer = FilterPushDownOptimizer(context);  // FRESH optimizer, no predicates
        op->setChild(i, optimizer.visitOperator(op->getChild(i)));
    }
    op->computeFlatSchema();
    return finishPushDown(op);  // Apply accumulated predicates ABOVE this operator
}
```

This does two things:
1. **Applies current predicates** as FILTER nodes above the unhandled operator (they cannot be pushed through it).
2. **Starts fresh push-down scopes** for each child — new predicates from deeper FILTER nodes can still be pushed within each child's subtree.

---

## ProjectionPushDownOptimizer — Complete Reference

**Source:** `src/optimizer/projection_push_down_optimizer.cpp`  
**Header:** `src/include/optimizer/projection_push_down_optimizer.h`

### Overview

`ProjectionPushDownOptimizer` is a **top-down, scope-tracking** optimizer. It maintains three sets of "expressions in use" and propagates them downward through the plan tree, pruning columns from operators that expose more than needed.

```cpp
class ProjectionPushDownOptimizer : public LogicalOperatorVisitor {
    binder::expression_set propertiesInUse;   // ExpressionType::PROPERTY
    binder::expression_set variablesInUse;    // ExpressionType::VARIABLE
    binder::expression_set nodeOrRelInUse;    // ExpressionType::PATTERN
    common::PathSemantic semantic;
};
```

**Why three sets?** The optimizer tracks different granularities of expression use:
- `propertiesInUse`: individual property accesses like `a.name`, `r.weight`
- `variablesInUse`: whole-variable accesses like `a`, `r` (when the full node/rel is referenced)
- `nodeOrRelInUse`: pattern expressions (structured node/rel objects)

For general expressions (functions, aggregates, etc.), the optimizer takes a **conservative approach** — it does not track them and always assumes they are in use. This is noted in the header comment:

```
// ProjectionPushDownOptimizer implements the logic to avoid materializing
// unnecessary properties for hash join build.
// Note the optimization is for properties & variables only but not for
// general expressions. This is because it's hard to figure out what
// expression is in-use, e.g. COUNT(a.age) + 1, it could be either the
// whole expression was evaluated in a WITH clause or only COUNT(a.age)
// was evaluated or only a.age is evaluated.
```

### `collectExpressionsInUse` — Tracking What's Needed

```cpp
void ProjectionPushDownOptimizer::collectExpressionsInUse(
    std::shared_ptr<binder::Expression> expression) {
    switch (expression->expressionType) {
    case ExpressionType::PROPERTY:
        propertiesInUse.insert(expression);
        return;
    case ExpressionType::VARIABLE:
        variablesInUse.insert(expression);
        return;
    case ExpressionType::PATTERN:
        nodeOrRelInUse.insert(expression);
        // Also recurse into children to collect all component properties
        for (auto& child : ExpressionChildrenCollector::collectChildren(*expression)) {
            collectExpressionsInUse(child);
        }
        return;
    default:
        // For all other types: recurse into children to find leaf properties/variables
        for (auto& child : ExpressionChildrenCollector::collectChildren(*expression)) {
            collectExpressionsInUse(child);
        }
    }
}
```

The recursion ensures that even deeply nested property accesses are captured. For example, `COUNT(a.age) + 1` will traverse into `+` → `COUNT(a.age)` → `a.age`, inserting `a.age` into `propertiesInUse`.

### `pruneExpressions` — Filtering Columns

```cpp
expression_vector ProjectionPushDownOptimizer::pruneExpressions(
    const expression_vector& expressions) {
    expression_set expressionsAfterPruning;
    for (auto& expression : expressions) {
        switch (expression->expressionType) {
        case ExpressionType::PROPERTY:
            if (propertiesInUse.contains(expression)) expressionsAfterPruning.insert(expression);
            break;
        case ExpressionType::VARIABLE:
            if (variablesInUse.contains(expression)) expressionsAfterPruning.insert(expression);
            break;
        case ExpressionType::PATTERN:
            if (nodeOrRelInUse.contains(expression)) expressionsAfterPruning.insert(expression);
            break;
        default:
            // Conservative: always keep unknown expression types
            expressionsAfterPruning.insert(expression);
        }
    }
    return expression_vector{expressionsAfterPruning.begin(), expressionsAfterPruning.end()};
}
```

### `preAppendProjection` — Inserting Pruning Projections

When pruning finds that a child operator exposes more columns than needed:

```cpp
void ProjectionPushDownOptimizer::preAppendProjection(LogicalOperator* op, idx_t childIdx,
    expression_vector expressions) {
    if (expressions.empty()) return;  // Cannot handle empty projection
    auto projection = std::make_shared<LogicalProjection>(std::move(expressions), op->getChild(childIdx));
    projection->computeFlatSchema();
    op->setChild(childIdx, std::move(projection));
}
```

This inserts a `LogicalProjection` between `op` and its `childIdx`-th child, carrying only the pruned expressions. The projection's schema is immediately computed.

### Column Set Propagation Algorithm

The full algorithm, showing how pruning flows from root to leaves:

```
1. Start at root (e.g., PROJECTION):
   - visitProjection: create new ProjectionPushDownOptimizer
   - collectExpressionsInUse for each projected expression
   - visitOperator(projection's child)

2. At each non-PROJECTION operator:
   a. Call visitOperatorSwitch(op) — the operator-specific hook collects its own references
   b. If op is not PROJECTION, recurse: for each child, call visitOperator(child)
   c. After recursion: call op->computeFlatSchema()

3. At leaf operators (SCAN_NODE_TABLE, TABLE_FUNCTION_CALL):
   No further recursion. The collected sets in propertiesInUse/variablesInUse
   define which columns to scan.
```

**For PROJECTION restart:** When a PROJECTION node is encountered during traversal, a **completely new** `ProjectionPushDownOptimizer` is created. This new optimizer only knows about expressions referenced by the PROJECTION's output expressions. This ensures that projections act as opacity boundaries — expressions not visible above a PROJECTION are not tracked below it.

### Per-Operator Behaviors

**FILTER:**
```cpp
void visitFilter(LogicalOperator* op) {
    auto& filter = op->constCast<LogicalFilter>();
    collectExpressionsInUse(filter.getPredicate());
    // Adds all properties/variables referenced by the filter predicate
}
```

**HASH_JOIN:**
```cpp
void visitHashJoin(LogicalOperator* op) {
    auto& hashJoin = op->constCast<LogicalHashJoin>();
    // Collect join condition columns
    for (auto& [probeKey, buildKey] : hashJoin.getJoinConditions()) {
        collectExpressionsInUse(probeKey);
        collectExpressionsInUse(buildKey);
    }
    if (hashJoin.getJoinType() == JoinType::MARK) return;  // skip push-down for mark join

    // Prune expressions materialized into hash table
    auto expressionsBeforePruning = hashJoin.getExpressionsToMaterialize();
    auto expressionsAfterPruning = pruneExpressions(expressionsBeforePruning);
    if (expressionsBeforePruning.size() != expressionsAfterPruning.size()) {
        preAppendProjection(op, 1 /* build side */, expressionsAfterPruning);
    }
}
```

Hash join is the **primary target** of projection push-down. The build side materializes all its columns into a hash table; pruning this list directly reduces hash table memory.

**EXTEND:**
```cpp
void visitExtend(LogicalOperator* op) {
    auto& extend = op->cast<LogicalExtend>();
    // The bound node ID is always needed (for join key)
    collectExpressionsInUse(extend.getBoundNode()->getInternalID());
    // Determine if the neighbor node ID is needed downstream
    extend.setScanNbrID(propertiesInUse.contains(nbrNodeID));
}
```

`setScanNbrID(false)` tells the physical extend operator not to output the neighbor node's ID when it is not needed downstream. This avoids a lookup into the CSR adjacency list just to read the neighbor ID.

**ACCUMULATE:**
```cpp
void visitAccumulate(LogicalOperator* op) {
    auto& accumulate = op->constCast<LogicalAccumulate>();
    if (accumulate.getAccumulateType() != AccumulateType::REGULAR) return;
    auto expressionsBeforePruning = accumulate.getPayloads();
    auto expressionsAfterPruning = pruneExpressions(expressionsBeforePruning);
    if (expressionsBeforePruning.size() != expressionsAfterPruning.size()) {
        preAppendProjection(op, 0, expressionsAfterPruning);  // probe side = child 0
    }
}
```

**INTERSECT:** Has special handling to preserve the invariant that `intersectNodeID` and `keyNodeID` appear as the first and second column of each build child (a requirement of the physical Intersect operator).

**ORDER_BY:** Collects all expressions in the ORDER BY clause, then collects all expressions currently in scope from the child schema (to avoid pruning columns that ORDER BY might need).

**TABLE_FUNCTION_CALL:**
```cpp
void visitTableFunctionCall(LogicalOperator* op) {
    auto& tableFunctionCall = op->cast<LogicalTableFunctionCall>();
    std::vector<bool> columnSkips;
    for (auto& column : tableFunctionCall.getBindData()->columns) {
        // Check both variablesInUse and propertiesInUse
        const auto inUse = variablesInUse.contains(column) ||
                           propertiesInUse.contains(column) ||
                           expressionInUseByName(variablesInUse, column) ||
                           expressionInUseByName(propertiesInUse, column);
        columnSkips.push_back(!inUse);
    }
    tableFunctionCall.setColumnSkips(std::move(columnSkips));
}
```

The `columnSkips` vector is passed to the physical `TableFunctionCall` operator to skip fetching unneeded columns from the foreign data source.

### Why Column Index ≠ Property Index

In `ScanNodeTable`, columns are addressed by their `column_id_t` in the catalog, not by their position in the scan's property list. The map from `scan.getProperties()` (a list of `PropertyExpression*`) to storage column IDs happens in `PlanMapper::mapScanNodeTable`:

```cpp
for (auto& expr : scan.getProperties()) {
    auto& property = expr->constCast<PropertyExpression>();
    auto propertyName = property.getPropertyName();
    tableInfo.addColumnInfo(tableEntry->getColumnID(propertyName), std::move(columnCaster));
}
```

ProjectionPushDown reduces the number of entries in `scan.getProperties()`. Each removed property means one fewer `tableEntry->getColumnID()` lookup and one fewer column chunk scan at execution time.

### Performance Impact

For a query like:
```cypher
MATCH (a:Person)-[:KNOWS]->(b:Person)
RETURN a.name, count(b)
```

Without push-down, each Person scan reads all Person properties (name, age, email, birthday, etc.). With push-down, only `a.name` and `b._id` (for count) are needed. On wide tables (many properties), this can reduce I/O by 5–20×.

For hash joins, push-down is critical because the build side materializes data into an in-memory hash table. Pruning unused columns from the build side directly reduces:
- Memory allocation for the hash table
- Memory bandwidth for building and probing
- Cache pressure during probe phase

---

## Related Pages

- [Optimizer](./optimizer.md) — complete optimizer pipeline
- [Physical Planner](./planner.md) — logical to physical mapping
- [Expression Evaluator](./expressions.md) — expression evaluation at runtime
- [Semi-Mask & SIP Optimization](/execution/semi-mask) — SIP execution mechanics

---

## FilterPushDown vs. ProjectionPushDown: Interaction

These two passes interact in a subtle way. Consider:

```cypher
MATCH (a:Person)-[:KNOWS]->(b:Person)
WHERE a.age > 30
RETURN b.name
```

**After FilterPushDown:**
- `WHERE a.age > 30` is pushed below the EXTEND, becoming a post-scan filter on `a`.
- `a.age` must be read from the `a` scan.

**After ProjectionPushDown:**
- Only `b.name` and `b._id` (join key) are needed in output.
- `a._id` is needed as the join key between scan and extend.
- `a.age` is needed for the post-scan filter — ProjectionPushDown sees the FILTER referencing `a.age` and adds it to `propertiesInUse`.
- Other `a` properties (email, birthday, etc.) are pruned from the scan.

The combination: a scan reads only `a._id` and `a.age`; a post-scan filter checks `a.age > 30`; only matching rows' `a._id` values propagate to the extend; the extend produces `b._id`; a final scan reads `b.name` for matching `b`.

---

## Pseudocode: FilterPushDown End-to-End

```
procedure FilterPushDown(root: LogicalOperator) → LogicalOperator:
    optimizer = new FilterPushDownOptimizer(predicateSet = {})
    return optimizer.visit(root)

procedure optimizer.visit(op: LogicalOperator) → LogicalOperator:
    match op.type:
        FILTER:
            pred = op.predicate
            if pred is literal FALSE or NULL:
                return EmptyResult(op.schema)
            if pred is literal TRUE:
                return visit(op.child)
            predicateSet.add(pred)
            return visit(op.child)   // dissolve FILTER, continue with predicate accumulated

        CROSS_PRODUCT:
            (probePreds, buildPreds, remainPreds) = partition(predicateSet, op.probeSchema, op.buildSchema)
            newProbe = FilterPushDown_fresh(probePreds).visit(op.probe)
            newBuild = FilterPushDown_fresh(buildPreds).visit(op.build)
            joinConds = []
            extraPreds = []
            for pred in remainPreds.equalityPreds:
                if pred.left ∈ probeSchema AND pred.right ∈ buildSchema:
                    joinConds.add((pred.left, pred.right))
                elif pred.right ∈ probeSchema AND pred.left ∈ buildSchema:
                    joinConds.add((pred.right, pred.left))
                else:
                    extraPreds.add(pred)
            if joinConds = []:
                result = CROSS_PRODUCT(newProbe, newBuild)
                return applyFilters(remainPreds.all, result)
            hashJoin = HashJoin(INNER, joinConds, newProbe, newBuild)
            hashJoin.SIP = PROHIBIT
            return applyFilters(extraPreds + remainPreds.nonEqualityPreds, hashJoin)

        SCAN_NODE_TABLE:
            if enableZoneMap:
                scan.columnPredicates = extractColumnPredicates(scan.properties, predicateSet)
            if scan has one table:
                pkEqPred = predicateSet.popPKEquality(scan.nodeID)
                if pkEqPred != null AND rhs is constant AND table has index:
                    scan.type = PRIMARY_KEY_SCAN
                    scan.key = pkEqPred.rhs
                elif pkEqPred != null:
                    predicateSet.add(pkEqPred)  // put back, can't use index
                elif table has ART index:
                    range = predicateSet.popPKRange(scan.nodeID)
                    if range.hasBound():
                        scan.type = PRIMARY_KEY_SCAN
                        scan.range = range
            return applyFilters(predicateSet.all, scan)

        EXTEND:
            if not recursive AND enableZoneMap:
                extend.columnPredicates = extractColumnPredicates(extend.properties, predicateSet)
            return visitChildren_fresh(op)  // fresh optimizers for children

        TABLE_FUNCTION_CALL:
            if func.supportsPushDown:
                pushedPreds = pushPredicatesToFunc(func, predicateSet)
                predicateSet = predicateSet - pushedPreds
            return applyFilters(predicateSet.all, op)

        default (HASH_JOIN, AGGREGATE, ORDER_BY, ...):
            result = applyFilters(predicateSet.all, op)   // apply above this operator
            for each child of result:
                child = FilterPushDown_fresh({}).visit(child)  // fresh scope for each child
            return result

procedure applyFilters(preds, op):
    root = op
    for pred in preds:
        root = LogicalFilter(pred, root)
    return root
```

---

## Pseudocode: ProjectionPushDown End-to-End

```
procedure ProjectionPushDown(root: LogicalOperator):
    optimizer = new ProjectionPushDownOptimizer(
        propertiesInUse = {}, variablesInUse = {}, nodeOrRelInUse = {}
    )
    optimizer.visitOperator(root)

procedure optimizer.visitOperator(op: LogicalOperator):
    visitOperatorSwitch(op)    // call per-type hook (collect references)
    if op.type == PROJECTION:
        return               // Don't recurse — PROJECTION creates a new scope
    for each child of op:
        visitOperator(child)
    op.computeFlatSchema()

procedure optimizer.collectExpressionsInUse(expr):
    match expr.type:
        PROPERTY: propertiesInUse.add(expr)
        VARIABLE: variablesInUse.add(expr)
        PATTERN:
            nodeOrRelInUse.add(expr)
            for child in expr.children: collectExpressionsInUse(child)
        default:
            for child in expr.children: collectExpressionsInUse(child)

procedure optimizer.pruneExpressions(exprs: List[Expression]) → List[Expression]:
    result = []
    for expr in exprs:
        match expr.type:
            PROPERTY: if propertiesInUse.contains(expr): result.add(expr)
            VARIABLE: if variablesInUse.contains(expr): result.add(expr)
            PATTERN:  if nodeOrRelInUse.contains(expr): result.add(expr)
            default:  result.add(expr)  // conservative: always keep
    return result

procedure optimizer.visitProjection(op: PROJECTION):
    child_optimizer = new ProjectionPushDownOptimizer()
    for expr in op.expressionsToProject:
        child_optimizer.collectExpressionsInUse(expr)
    child_optimizer.visitOperator(op.child)

procedure optimizer.visitHashJoin(op: HASH_JOIN):
    for (probe_key, build_key) in op.joinConditions:
        collectExpressionsInUse(probe_key)
        collectExpressionsInUse(build_key)
    if op.joinType == MARK: return
    before = op.expressionsToMaterialize
    after = pruneExpressions(before)
    if len(before) != len(after):
        preAppendProjection(op, buildChildIdx=1, after)
```

---

## Debugging Tips

**To see predicates being pushed:**
- Enable verbose logging and watch for `FilterPushDownOptimizer` visiting operators.
- Use `EXPLAIN LOGICAL` to see the plan before and after optimization (`enablePlanOptimizer=false` to see unoptimized).

**To understand why a property is not pruned:**
- Check if any downstream operator references it (FILTER, ORDER_BY, SET, etc. — each calls `collectExpressionsInUse`).
- Non-PROPERTY/VARIABLE/PATTERN expressions are never pruned (conservative).
- The ORDER_BY handler collects **all** child schema expressions into `propertiesInUse` to be safe.

**To verify a primary key scan was applied:**
- `EXPLAIN` the query and check for `PRIMARY_KEY_SCAN` in the plan output.
- The key value and index type are shown in the operator's print info.
