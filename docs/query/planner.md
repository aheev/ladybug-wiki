# Logical Planner Reference

**Primary sources read**

- `src/include/planner/planner.h`, `src/planner/planner.cpp`
- `src/include/planner/operator/logical_operator.h`, `src/planner/operator/logical_operator.cpp`
- `src/include/planner/operator/logical_plan.h`, `src/planner/operator/logical_plan.cpp`
- `src/include/planner/operator/schema.h`
- `src/planner/plan/plan_single_query.cpp`
- `src/planner/plan/plan_read.cpp`
- `src/planner/plan/plan_projection.cpp`
- `src/planner/plan/plan_update.cpp`
- `src/planner/plan/plan_copy.cpp`
- `src/planner/plan/plan_join_order.cpp`
- `src/planner/plan/append_join.cpp`
- `src/planner/plan/append_scan_node_table.cpp`
- `src/planner/plan/append_extend.cpp`
- logical operator headers under `src/include/planner/operator/**`

This page documents the logical planner proper. Join enumeration and factorization are large enough to have their own deep-dive pages; see [join-order](./join-order) and [factorization](./factorization).

## 1. Planner entry point

The public entry point is:

```cpp
LogicalPlan Planner::planStatement(const binder::BoundStatement& statement);
```

`Planner::planStatement(...)` dispatches by `StatementType` to planners for:

- query
- create/drop/alter family
- copy from / copy to
- standalone call / explain / transaction
- import/export database
- attach/detach/use database
- create/use graph
- extensions

For query compilation, the main path is:

```text
BoundRegularQuery
  -> planQuery
  -> planSingleQuery
  -> planQueryPart
  -> planReadingClause / planUpdatingClause / planProjectionBody
```

## 2. `LogicalPlan` container

`LogicalPlan` stores:

- `std::shared_ptr<LogicalOperator> lastOperator`
- `uint64_t cost`

Important methods:

- `isEmpty()`
- `getLastOperator()` / `getLastOperatorRef()`
- `getSchema()`
- `getCardinality()`
- `setCost(...)`
- `hasUpdate()`
- `isProfile()`

## 3. `LogicalOperator` base class

Every logical operator stores:

- `LogicalOperatorType operatorType`
- `std::unique_ptr<Schema> schema`
- `logical_op_vector_t children`
- `common::cardinality_t cardinality`

Every subclass must implement:

- `computeFactorizedSchema()`
- `computeFlatSchema()`
- `getExpressionsForPrinting()`
- `copy()`

The planner builds plans in **factorized-schema mode** by default. `computeFlatSchema()` exists for consumers that need row-style shape.

## 4. Query planning workflow

### 4.1 `planQuery`

If the bound regular query has one branch, `planQuery` just calls `planSingleQuery`.

If there are multiple branches, it:

1. plans each `NormalizedSingleQuery`
2. creates a `LogicalUnion`
3. flattens child groups as needed via `LogicalUnion::getGroupsPosToFlatten(...)`
4. optionally appends `LogicalDistinct` if the original syntax was `UNION` rather than `UNION ALL`

### 4.2 `planSingleQuery`

`planSingleQuery(...)` first runs `PropertyCollector` and records required property expressions into `propertyExprCollection`, keyed by pattern name. Then it resets `JoinOrderEnumeratorContext` state and plans each query part in order.

### 4.3 `planQueryPart`

For each normalized query part, the planner does three phases in order:

1. plan all reading clauses
2. plan all updating clauses
3. plan projection body, then optional projection-body predicate

## 5. Reading-clause planning

### 5.1 Dispatch

`planReadingClause(...)` switches on `ClauseType` and supports:

- `MATCH`
- `UNWIND`
- `TABLE_FUNCTION_CALL`
- `LOAD_FROM`

### 5.2 `MATCH`

`planMatchClause(...)` distinguishes:

- first `MATCH` when the plan is empty -> plan the graph collection directly
- later `MATCH` clauses -> regular-match planning against an existing left plan
- `OPTIONAL MATCH` -> optional-match planning with mark/outer semantics

Predicates are always taken from `BoundReadingClause::getConjunctivePredicates()`.

### 5.3 `UNWIND`

If the plan is empty, the planner first appends `LogicalDummyScan` so that even constant-only unwinds have one input row source.

### 5.4 table functions and `LOAD FROM`

The planner partitions predicates into:

- predicates depending only on the function output columns
- predicates with external dependencies

Only the first category is pushed into the table-function logical planning callback. Remaining predicates are appended later as `LogicalFilter` operators.

## 6. Projection planning

`planProjectionBody(...)` is the core post-match pipeline builder.

High-level sequence:

1. ensure a dummy scan exists for constant-only projections such as `RETURN 1`
2. if aggregates exist, call `planAggregate(...)`
3. handle `DISTINCT` and/or `ORDER BY`
4. append the final `LogicalProjection`
5. if skip/limit exists, append `LogicalMultiplicityReducer` then `LogicalLimit`

### 6.1 Aggregation sequence

`planAggregate(...)` does:

1. `appendProjection(...)` of aggregate inputs and group-by expressions
2. `appendAggregate(...)`

### 6.2 `DISTINCT` ordering nuance

If both `DISTINCT` and `ORDER BY` exist, the planner deliberately:

1. projects the return list
2. applies `LogicalDistinct`
3. plans `ORDER BY`
4. projects the final return list again

### 6.3 `LIMIT` placement nuance

The planner inserts `LogicalMultiplicityReducer` before `LogicalLimit` so skip/limit operate on the right row-multiplicity semantics rather than raw nested groups.

## 7. Updating-clause planning

`planUpdatingClause(...)` dispatches to:

- `planInsertClause`
- `planMergeClause`
- `planSetClause`
- `planDeleteClause`

### 7.1 `INSERT`

If the plan is empty, insert planning starts from `LogicalDummyScan`. Otherwise it first accumulates the existing input. It then appends node inserts and/or rel inserts.

### 7.2 `MERGE`

`planMergeClause(...)`:

- splits merge predicate on `AND`
- derives hash-table keys from non-literal merge column-data expressions
- may also include in-scope node internal IDs as merge keys
- plans the pattern as an optional match with an existence mark
- builds `LogicalMerge`
- attaches insert infos and on-create/on-match set infos
- flattens groups required by the merge operator

### 7.3 `SET` and `DELETE`

Both first `appendAccumulate(plan)` and then append their respective update operators.

## 8. Copy planning

`planCopyFrom(...)` branches to `planCopyNodeFrom(...)` or `planCopyRelFrom(...)`.

Important behavior:

- file/object copy sources are planned as table-function calls
- query sources are recursively planned as regular queries
- if the input schema has multiple groups, the planner accumulates first because the copy operators assume compatible chunk layout
- relationship copy may append `LogicalPrimaryKeyLookup`, `LogicalPartitioner`, and then `LogicalCopyFrom`

`planCopyTo(...)` first plans the underlying query and then appends `LogicalCopyTo`.

## 9. Query-graph planning state

The planner uses `QueryGraphPlanningInfo` to carry:

- `predicates`
- subquery planning mode (`NONE`, `UNNEST_CORRELATED`, `CORRELATED`) plus correlated expressions/cardinality
- optional join hint (`std::shared_ptr<BoundJoinHintNode> hint`)

Disconnected graph components are handled by `planQueryGraphCollection(...)`, which plans each connected `QueryGraph` separately and then combines them with cross products, applying any leftover predicates afterward.

## 10. Base scan and extend planning

The planner creates seed plans for:

- node scans (`planNodeScan`)
- node-ID-only scans (`planNodeIDScan`)
- relationship scans (`planRelScan`)
- correlated-expression scans (`planCorrelatedExpressionsScan`)

### 10.1 Node scans

`appendScanNodeTable(...)` builds `LogicalScanNodeTable` and strips internal-ID properties from the explicit property list because the operator already carries `nodeID` separately.

### 10.2 Non-recursive extends

`appendNonRecursiveExtend(...)` may insert `LogicalNodeLabelFilter` both before and after the extend when the relationship's direction/table-set knowledge can prune impossible labels.

Then it appends `LogicalExtend`, computes schema, estimates extension rate, and stores that rate as the new neighbor group's `cardinalityMultiplier`.

### 10.3 Recursive extends

`appendRecursiveExtend(...)` constructs a richer pipeline:

- `LogicalRecursiveExtend`
- optional semi-mask plan for recursive node predicates
- optional path-node property scan plan
- optional path-rel property scan plan
- `LogicalPathPropertyProbe`
- a hash join back to the input node stream

## 11. Schema model and factorization

Every logical operator computes a `Schema`, which groups expressions into `FactorizationGroup`s. The full mechanics are in [factorization](./factorization).

The important planner takeaway is:

- operator appends are not just tree rewrites
- they also decide how expressions are grouped, flattened, accumulated, or merged
- cardinality estimates depend on group multipliers

## 12. Full inventory of `LogicalOperatorType`

`LogicalOperatorType` is defined in `src/include/planner/operator/logical_operator.h`. The following is the complete enum inventory.

### 12.1 Query/result and scan operators

- `ACCUMULATE` — grouped materialization for sink-friendly payloads; class `LogicalAccumulate`.
- `AGGREGATE` — grouping/aggregation operator; class `LogicalAggregate`.
- `COUNT_REL_TABLE` — optimized rel-count operator; class `LogicalCountRelTable`.
- `CROSS_PRODUCT` — combines disconnected plans; class `LogicalCrossProduct`.
- `DISTINCT` — deduplicates key/payload rows; class `LogicalDistinct`.
- `DUMMY_SCAN` — single-row seed source for constant-only plans; class `LogicalDummyScan`.
- `DUMMY_SINK` — sink placeholder operator; class `LogicalDummySink`.
- `EMPTY_RESULT` — zero-row result with schema; class `LogicalEmptyResult`.
- `EXPLAIN` — logical/physical/profile explain wrapper; class `LogicalExplain`.
- `EXPRESSIONS_SCAN` — scans correlated expressions from an outer factorized table; class `LogicalExpressionsScan`.
- `EXTEND` — one-hop graph expansion; class `LogicalExtend`.
- `FILTER` — boolean predicate filter; class `LogicalFilter`.
- `FLATTEN` — explicit group-flattening barrier; class `LogicalFlatten`.
- `HASH_JOIN` — hash join / mark join / left-count join carrier; class `LogicalHashJoin`.
- `INDEX_LOOK_UP` — primary-key/index lookup operator; class `LogicalPrimaryKeyLookup`.
- `INTERSECT` — multiway WCOJ-style intersect operator; class `LogicalIntersect`.
- `LIMIT` — skip/limit operator; class `LogicalLimit`.
- `MULTIPLICITY_REDUCER` — normalizes multiplicity before limit/top-k semantics; class `LogicalMultiplicityReducer`.
- `NODE_LABEL_FILTER` — prunes impossible node labels around extends; class `LogicalNodeLabelFilter`.
- `NOOP` — do-nothing logical wrapper; class `LogicalNoop`.
- `ORDER_BY` — sort or top-k planning node; class `LogicalOrderBy`.
- `PARTITIONER` — partitions rel copy input before bulk load; class `LogicalPartitioner`.
- `PATH_PROPERTY_PROBE` — stitches recursive path IDs to scanned properties; class `LogicalPathPropertyProbe`.
- `PROJECTION` — expression evaluation / scope trimming operator; class `LogicalProjection`.
- `RECURSIVE_EXTEND` — recursive traversal operator; class `LogicalRecursiveExtend`.
- `REL_DEGREE_TABLE` — degree-table scan operator; class `LogicalRelDegreeTable`.
- `SCAN_NODE_TABLE` — node-table scan or primary-key/range scan; class `LogicalScanNodeTable`.
- `SEMI_MASKER` — side-way-information-passing mask producer; class `LogicalSemiMasker`.
- `TABLE_FUNCTION_CALL` — generic table-function operator; class `LogicalTableFunctionCall`.
- `UNION_ALL` — union operator used for both `UNION ALL` and the input to `UNION`; class `LogicalUnion`.
- `UNWIND` — list-to-row expansion operator; class `LogicalUnwind`.
- `UNWIND_DEDUPLICATE` — deduplication helper for unwind values; class `LogicalUnwindDeduplicate`.

### 12.2 Update and persistence operators

- `COPY_FROM` — import/copy-into-table operator; class `LogicalCopyFrom`.
- `COPY_TO` — export/copy-query-result operator; class `LogicalCopyTo`.
- `DELETE` — node/rel delete operator; class `LogicalDelete`.
- `INSERT` — node/rel insert operator; class `LogicalInsert`.
- `MERGE` — merge operator carrying existence mark plus create/set payloads; class `LogicalMerge`.
- `SET_PROPERTY` — property update operator; class `LogicalSetProperty`.

### 12.3 DDL, database, and extension operators

- `ALTER` — generic alter operator family; class `LogicalAlter`.
- `ATTACH_DATABASE` — attach external database; class `LogicalAttachDatabase`.
- `CREATE_GRAPH` — create graph statement; class `LogicalCreateGraph`.
- `CREATE_INDEX` — create index; class `LogicalCreateIndex`.
- `CREATE_MACRO` — create macro; class `LogicalCreateMacro`.
- `CREATE_SEQUENCE` — create sequence; class `LogicalCreateSequence`.
- `CREATE_TABLE` — create table / rel-group; class `LogicalCreateTable`.
- `CREATE_TYPE` — create type; class `LogicalCreateType`.
- `DETACH_DATABASE` — detach database; class `LogicalDetachDatabase`.
- `DROP` — drop statement; class `LogicalDrop`.
- `EXTENSION` — extension-managed statement operator; class `LogicalExtension`.
- `EXPORT_DATABASE` — export database operator; class `LogicalExportDatabase`.
- `IMPORT_DATABASE` — import database operator; class `LogicalImportDatabase`.
- `STANDALONE_CALL` — option/configuration call; class `LogicalStandaloneCall`.
- `TRANSACTION` — transaction-control statement operator; class `LogicalTransaction`.
- `USE_DATABASE` — switch current database; class `LogicalUseDatabase`.
- `USE_GRAPH` — switch current graph; class `LogicalUseGraph`.
- `EXTENSION_CLAUSE` — extension clause statement operator.

That is the full enum as defined in the reviewed source.

## 13. Operator-string conventions

`LogicalOperatorUtils::logicalOperatorTypeToString(...)` maps enum values to printed names used by `LogicalOperator::toString(...)`. For single-child operators, `toString()` prints the child beneath the current node; for multi-child operators it prints `CHILD:` blocks.

## 14. What the planner decides vs what it inherits

The planner **inherits** from the binder:

- typed expressions
- normalized query parts
- graph components
- join hints
- projection semantics

The planner **decides**:

- which seed scans to create
- whether a relationship is planned as INL-like extend, hash join, or intersect-based WCOJ
- where to insert flatten/accumulate barriers
- how disconnected graph components are combined
- how updates, copy, and projection pipelines are arranged
- operator cardinalities and plan costs

## 15. Where to go next

- For dynamic-programming join enumeration, hints, cardinality formulas, and WCOJ/intersect planning, see [join-order](./join-order).
- For factorized schemas, flatten decisions, group multipliers, and accumulate/sink behavior, see [factorization](./factorization).
