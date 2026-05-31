# Factorization, Schema Groups, and Flattening

**Primary sources read**

- `src/include/planner/operator/schema.h`
- `src/include/planner/operator/logical_flatten.h`, `src/planner/operator/logical_flatten.cpp`
- `src/include/planner/operator/factorization/flatten_resolver.h`, `src/planner/operator/factorization/flatten_resolver.cpp`
- `src/planner/plan/append_flatten.cpp`
- `src/include/planner/operator/factorization/sink_util.h`, `src/planner/operator/factorization/sink_util.cpp`
- `src/planner/operator/scan/logical_scan_node_table.cpp`
- `src/planner/operator/extend/logical_extend.cpp`
- `src/planner/operator/extend/logical_recursive_extend.cpp`
- `src/planner/operator/logical_projection.cpp`
- `src/planner/operator/logical_aggregate.cpp`
- `src/planner/operator/logical_hash_join.cpp`
- `src/planner/operator/logical_intersect.cpp`
- `src/planner/operator/logical_accumulate.cpp`
- `src/planner/operator/logical_order_by.cpp`
- `src/planner/operator/logical_limit.cpp`
- `src/planner/operator/logical_distinct.cpp`
- `src/planner/operator/logical_unwind.cpp`

Factorization is the planner subsystem that lets LadybugDB keep one logical result stream in a compact nested representation instead of flattening to a row-per-combination table after every join or extend.

## 1. Core data model: `Schema` and `FactorizationGroup`

### 1.1 `FactorizationGroup`

A factorization group stores:

- `bool flat`
- `bool singleState`
- `double cardinalityMultiplier`
- `binder::expression_vector expressions`
- `std::unordered_map<std::string, uint32_t> expressionNameToPos`

Interpretation:

- **flat** means the group's expressions are row-aligned with the leading tuple stream
- **singleState** means the group is both flat and guaranteed to have a single value per outer tuple
- **cardinalityMultiplier** records fanout for unflat groups

### 1.2 `Schema`

A `Schema` owns:

- `std::vector<std::unique_ptr<FactorizationGroup>> groups`
- `std::unordered_map<std::string, uint32_t> expressionNameToGroupPos`
- `binder::expression_vector expressionsInScope`

Important methods:

- `createGroup()`
- `insertToScope(...)`
- `insertToGroupAndScope(...)`
- `insertToScopeMayRepeat(...)`
- `getGroupPos(expression)`
- `flattenGroup(pos)`
- `setGroupAsSingleState(pos)`
- `getGroupsPosInScope()`
- `copy()`
- `clearExpressionsInScope()`

## 2. Group invariants

`SchemaUtils` enforces two core assumptions repeatedly used in operators:

- many operators require at most one unflat group among their dependent expressions
- if everything is flat, any group may be treated as the leading group

This is why many planning decisions ask which groups must be flattened before appending an operator.

## 3. How basic operators shape schemas

### 3.1 `LogicalScanNodeTable`

`computeFactorizedSchema()` creates one group, inserts:

- `nodeID`
- scanned `properties`

For primary-key equality scan, it marks the group as `singleState`.

### 3.2 `LogicalExtend`

`computeFactorizedSchema()`:

1. copies the child schema
2. forces the bound node's ID group flat
3. creates a new group for the neighbor node ID and rel properties
4. inserts optional `directionExpr`

Then `appendNonRecursiveExtend(...)` sets the new group's `cardinalityMultiplier` to the estimated extension rate.

### 3.3 `LogicalRecursiveExtend`

Creates a fresh group and inserts all recursive result columns there. Recursive path property stitching is then handled by `LogicalPathPropertyProbe` and later joins.

## 4. Explicit flattening

`LogicalFlatten` is the only operator whose whole purpose is to change one group's physical interpretation.

Its factorized-schema implementation is just:

```cpp
copyChildSchema(0);
schema->flattenGroup(groupPos);
```

The planner inserts it with:

- `appendFlattens(groupsPos, plan)`
- `appendFlattenIfNecessary(groupPos, plan)`

`appendFlattenIfNecessary(...)` checks `group->isFlat()` before inserting a new `LogicalFlatten`.

## 5. Group-dependency analysis

The flattening decisions come from `FlattenAll`, `FlattenAllButOne`, and `GroupDependencyAnalyzer`.

### 5.1 `GroupDependencyAnalyzer`

For any expression, the analyzer collects:

- `dependentGroups`
- `requiredFlatGroups`
- optionally `dependentExprs`

It handles special expression types explicitly:

- scalar functions
- case expressions
- node/rel pattern expressions
- subquery expressions
- lambda expressions

### 5.2 Special cases encoded in source

- list-lambda functions may force all groups referenced inside the lambda body to flatten
- visiting a node pattern also visits its property expressions and internal ID
- visiting a rel pattern also visits source ID, destination ID, and optional direction expression
- visiting a subquery expression traverses all query-node internal IDs plus the subquery `WHERE`

## 6. `FlattenAll` vs `FlattenAllButOne`

### 6.1 `FlattenAll`

Flattens every dependent unflat group.

Used by operators that fundamentally require row-style input over all referenced groups, such as:

- `LogicalDistinct`
- `LogicalUnwind`
- `LogicalAccumulate` over specifically requested flat expressions

### 6.2 `FlattenAllButOne`

Keeps at most one dependent group unflat and flattens the rest.

Used by operators that can still work with one nested dimension, such as aggregation over one remaining key group or limit selection over one leading group.

## 7. Projection and scope reshaping

`LogicalProjection::computeFactorizedSchema()` copies the child schema, clears the scope, and then re-adds projected expressions.

Two cases:

1. projected expression already exists in scope -> reuse its original group position
2. projected expression must be evaluated -> analyze dependent groups; either create a `singleState` group for constants or place it in the leading dependent group

Projection therefore usually does **not** flatten anything by itself.

## 8. Sink-style schema recomputation: `SinkOperatorUtil`

`SinkOperatorUtil` is used by sink-like operators that need to repackage payloads.

### 8.1 `mergeSchema`

Given an input schema and payload expressions:

- flat payloads go into one new group
- each unflat input group gets its own output group
- the output group's multiplier is copied from the corresponding input group
- if flat payloads exist alongside unflat payloads, the flat-payload group is marked `singleState`

### 8.2 `recomputeSchema`

Clears the output schema and then delegates to `mergeSchema(...)`.

This utility is central to:

- `LogicalAccumulate`
- `LogicalOrderBy`
- other sink-like operators that need stable grouped output

## 9. Operator-specific flatten behavior

### 9.1 `LogicalAggregate`

- `computeFactorizedSchema()` creates a fresh single output group containing keys, dependent keys, and aggregates
- `getGroupsPosToFlatten()` uses `FlattenAllButOne` on the key groups
- distinct aggregates may force extra flattening when they depend on groups different from the surviving unflat key group

### 9.2 `LogicalDistinct`

`getGroupsPosToFlatten()` applies `FlattenAll` to keys plus payloads.

### 9.3 `LogicalUnwind`

`getGroupsPosToFlatten()` applies `FlattenAll` to `inExpr`.

After that, it creates a new group for the unwind output expression and optional ID expression.

### 9.4 `LogicalOrderBy`

The source comment in `logical_order_by.cpp` is important: LadybugDB only allows unflat order-by keys in a very limited case where the schema has a single group. If there are multiple groups, it flattens all dependent order-by groups.

Then `computeFactorizedSchema()` rebuilds the schema with `SinkOperatorUtil::recomputeSchema(...)` over all expressions in scope.

### 9.5 `LogicalLimit`

`getGroupsPosToFlatten()` uses `FlattenAllButOne` over all groups in scope. `getGroupPosToSelect()` validates that at most one unflat group remains and chooses the leading group.

### 9.6 `LogicalAccumulate`

`computeFactorizedSchema()` starts from an empty schema and repackages payloads through `SinkOperatorUtil::recomputeSchema(...)`.

If there is a mark expression, it creates a new `singleState` group for that mark.

`getGroupPositionsToFlatten()` uses `FlattenAll` on the explicitly requested `flatExprs`.

### 9.7 `LogicalHashJoin`

Probe-side flattening:

- flatten probe keys when required by `requireFlatProbeKeys()`
- flatten is always required for multiple join keys, left/count joins, non-internal-ID joins, or when build-side uniqueness cannot be proven

Build-side flattening:

- `getGroupsPosToFlattenOnBuildSide()` applies `FlattenAllButOne` over build-side join-key groups

Schema merge behavior:

- join-key groups from build side are merged into the corresponding probe key groups
- non-key build expressions are merged through `SinkOperatorUtil::mergeSchema(...)`
- mark joins add the mark into the probe-side key group

### 9.8 `LogicalIntersect`

- flattens probe-side key groups
- flattens the corresponding build-side key group for each build child
- copies the probe schema
- creates one new output group containing the intersect node plus non-key expressions from each build child

## 10. Factorization and cardinality

Factorization affects cardinality estimation through group multipliers.

Examples from source:

- `appendNonRecursiveExtend(...)` sets the neighbor group's multiplier to the extension rate
- `CardinalityEstimator::estimateFlatten(...)` multiplies child cardinality by the flattened group's multiplier
- `JoinOrderUtil::getJoinKeysFlatCardinality(...)` multiplies operator cardinality by multipliers of unflat join-key groups

## 11. Marks and single-state groups

Several operators add boolean or synthetic expressions into separate `singleState` groups:

- `LogicalAccumulate` for optional-match marks
- projection-generated constants
- some merge/update paths

A `singleState` group is both flat and guaranteed to have one value per outer tuple.

## 12. Why flattening is delayed

The planner tries to avoid explicit `LogicalFlatten` because flattening collapses nested multiplicities into a row stream and can force more tuple-at-a-time behavior downstream.

The code repeatedly chooses “flatten only what this operator strictly requires”, which is why you see helpers like:

- `FlattenAllButOne`
- `requireFlatProbeKeys()`
- order-by's single-group special case
- group-preserving projection reuse

## 13. Mental model

```text
Schema
  = groups of expressions
  + scope list
  + flat/unflat state
  + per-group fanout multiplier
```

Then operators do one of four things:

1. preserve groups (`FILTER`, many projections)
2. add a new nested group (`EXTEND`, `UNWIND`)
3. repackage groups (`ACCUMULATE`, `ORDER_BY`, `HASH_JOIN`, `INTERSECT`)
4. force groups flat (`FLATTEN`, or operator-specific preconditions)
