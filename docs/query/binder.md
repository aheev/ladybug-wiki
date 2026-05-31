# Binder and Semantic Analysis Reference

**Primary sources read**

- `src/include/binder/binder.h`, `src/binder/binder.cpp`
- `src/include/binder/binder_scope.h`, `src/binder/binder_scope.cpp`
- `src/include/binder/bound_statement.h`
- `src/include/binder/bound_statement_rewriter.h`, `src/binder/bound_statement_rewriter.cpp`
- `src/include/binder/query/bound_regular_query.h`
- `src/include/binder/query/normalized_single_query.h`
- `src/include/binder/query/normalized_query_part.h`
- `src/include/binder/query/query_graph.h`
- `src/include/binder/query/reading_clause/bound_reading_clause.h`
- `src/include/binder/query/reading_clause/bound_match_clause.h`
- `src/include/binder/query/reading_clause/bound_load_from.h`
- `src/include/binder/query/reading_clause/bound_table_function_call.h`
- `src/include/binder/query/reading_clause/bound_join_hint.h`
- `src/include/binder/query/return_with_clause/bound_projection_body.h`
- `src/include/binder/expression/expression.h`
- `src/include/binder/expression/node_expression.h`
- `src/include/binder/expression/rel_expression.h`
- `src/binder/bind/bind_query.cpp`
- `src/binder/bind/read/bind_match.cpp`
- `src/binder/bind/bind_projection_clause.cpp`
- `src/binder/bind_expression/bind_property_expression.cpp`
- `src/binder/bind_expression/bind_function_expression.cpp`
- `src/binder/bind_expression/bind_subquery_expression.cpp`
- `src/binder/visitor/property_collector.cpp`
- `src/binder/visitor/default_type_solver.cpp`

The binder is where LadybugDB stops being syntax-driven and starts becoming semantic. It resolves names, constructs typed expressions, normalizes query parts, rewrites pattern sugar, and produces the structures the planner actually consumes.

## 1. Top-level contract

The public entry point is:

```cpp
std::unique_ptr<BoundStatement> Binder::bind(const parser::Statement& statement);
```

`Binder::bind(...)` dispatches by `StatementType` and then always runs:

```cpp
BoundStatementRewriter::rewrite(*boundStatement, *clientContext);
```

So the binder pipeline is really two phases:

1. **initial binding**: produce a structurally valid `BoundStatement`
2. **semantic rewrite/fixup**: normalize the bound tree before planning

## 2. Bound statement layer

### 2.1 `BoundStatement`

Every binder result inherits from `binder::BoundStatement`, which stores:

- `common::StatementType statementType`
- `BoundStatementResult statementResult`

### 2.2 Query-specific bound nodes

Regular queries are represented as:

- `BoundRegularQuery`
- `NormalizedSingleQuery`
- `NormalizedQueryPart`

#### `BoundRegularQuery`

Stores:

- `std::vector<NormalizedSingleQuery> singleQueries`
- `std::vector<bool> isUnionAll`

#### `NormalizedSingleQuery`

Stores:

- `std::vector<NormalizedQueryPart> queryParts`
- `BoundStatementResult statementResult`

#### `NormalizedQueryPart`

Stores:

- `std::vector<std::unique_ptr<BoundReadingClause>> readingClauses`
- `std::vector<std::unique_ptr<BoundUpdatingClause>> updatingClauses`
- `std::optional<BoundProjectionBody> projectionBody`
- `std::shared_ptr<Expression> projectionBodyPredicate`

## 3. Binder entry dispatch

`Binder::bind(...)` covers the full statement language. It binds:

- create table / index / sequence / type
- copy from / copy to
- drop / alter
- query
- standalone call / standalone call function
- explain
- create macro
- transaction
- extension
- export / import database
- attach / detach / use database
- create graph / use graph
- extension clause

For query compilation, the important branch is `StatementType::QUERY -> bindQuery(statement)`.

## 4. Scope model: `BinderScope`

`BinderScope` is the central name-resolution data structure.

Stored state:

- `expression_vector expressions`
- `case_insensitive_map_t<idx_t> nameToExprIdx`
- `case_insensitive_map_t<std::vector<catalog::TableCatalogEntry*>> memorizedNodeNameToEntries`
- `case_insensitive_map_t<std::shared_ptr<NodeExpression>> nodeReplacement`

### 4.1 Why it is more than a symbol table

Besides ordinary variable lookup, the binder keeps:

1. **memorized table entries** for node variables that have gone out of normal scope but whose label/table identity is still useful later
2. **node replacements** for cases where a syntactic node pattern is rebound as a plain variable and later needs to recover node semantics

The source comment's motivating example is:

```cypher
MATCH (a:person)
WITH collect(a) AS list_a
UNWIND list_a AS new_a
MATCH (new_a)-[]->()
```

### 4.2 Core scope operations

Important methods:

- `contains(name)`
- `getExpression(name)`
- `addExpression(name, expr)`
- `replaceExpression(oldName, newName, expr)`
- `memorizeTableEntries(name, entries)`
- `addNodeReplacement(node)`
- `clear()`

## 5. Query binding pipeline

### 5.1 `bindQuery`

`bindQuery(...)` iterates every `RegularQuery` branch, clears scope before each branch, and binds each `SingleQuery` independently.

It then validates:

- all `UNION` branches return the same number of columns
- corresponding union columns have the same exact logical type
- `UNION` and `UNION ALL` are not mixed in the same regular query

### 5.2 `bindSingleQuery`

A `SingleQuery` becomes a `NormalizedSingleQuery` by:

1. binding each `QueryPart`
2. binding the final reading clauses
3. binding the final updating clauses
4. binding the terminal `RETURN` if present
5. copying the `BoundStatementResult`

If there is no `RETURN`, the binder creates `BoundStatementResult::createEmptyResult()`.

### 5.3 `bindQueryPart`

A parser-side `WITH` boundary becomes a `NormalizedQueryPart` containing:

- all bound reading clauses before the `WITH`
- all bound updating clauses before the `WITH`
- a bound projection body copied from the `BoundWithClause`
- an optional projection-body predicate if the `WITH` had a trailing `WHERE`

This is why the planner later treats `WITH ... WHERE ...` as “projection, then filter”.

## 6. Bound expression model

The binder expression root is `binder::Expression`.

Core fields:

- `common::ExpressionType expressionType`
- `common::LogicalType dataType`
- `std::string uniqueName`
- `std::string alias`
- `expression_vector children`

Key behavior:

- `cast(const LogicalType&)` inserts type coercion semantics
- `splitOnAND()` is used heavily for predicate normalization
- equality is defined on `uniqueName`
- `toString()` prefers alias when one exists

## 7. Variable creation and internal naming

The binder uses two related mechanisms:

- `createVariable(...)` -> creates a visible expression and inserts it into scope
- `createInvisibleVariable(...)` -> creates an expression without adding it to scope

Internal names are generated by:

```cpp
std::string Binder::getUniqueExpressionName(const std::string& name) {
    return "_" + std::to_string(lastExpressionId++) + "_" + name;
}
```

## 8. Node and relationship binding

### 8.1 `NodeExpression`

`NodeExpression` extends `NodeOrRelExpression` and adds:

- `std::shared_ptr<PropertyExpression> internalID`
- `getPrimaryKey(tableID)`
- `isMultiLabeled()` based on `entries.size() > 1`

### 8.2 `RelExpression`

`RelExpression` holds:

- `srcNode`, `dstNode`
- `leftNode`, `rightNode`
- `RelDirectionType directionType`
- optional `directionExpr`
- `common::QueryRelType relType`
- optional `RecursiveInfo recursiveInfo`

`RecursiveInfo` contains:

- `node`
- `nodeCopy`
- `rel`
- `nodePredicate`
- `relPredicate`
- `nodeProjectionList`
- `relProjectionList`
- `function`
- `bindData`

## 9. Query graph construction

The binder converts `MATCH` syntax into graph objects in `src/include/binder/query/query_graph.h`.

### 9.1 `QueryGraph`

`QueryGraph` represents one connected pattern component and owns:

- name-to-position maps
- `std::vector<std::shared_ptr<NodeExpression>> queryNodes`
- `std::vector<std::shared_ptr<RelExpression>> queryRels`

Important methods used later by the join-order enumerator:

- `addQueryNode(...)`
- `addQueryRel(...)`
- `canProjectExpression(...)`
- `isConnected(...)`
- `merge(...)`

### 9.2 `QueryGraphCollection`

A full `MATCH` may be disconnected, so the binder stores:

- `std::vector<QueryGraph> queryGraphs`

and provides:

- `addAndMergeQueryGraphIfConnected(...)`
- `merge(...)`
- `finalize()`

### 9.3 `SubqueryGraph`

`SubqueryGraph` uses two `std::bitset<MAX_NUM_QUERY_VARIABLES>` selectors:

- `queryNodesSelector`
- `queryRelsSelector`

The planner later uses this as the subset key in dynamic-programming join enumeration.

## 10. Binding `MATCH`

`Binder::bindMatchClause(...)` performs the following steps:

1. `bindGraphPattern(...)`
2. bind the clause-local `WHERE` with `bindWhereExpression(...)`
3. `rewriteMatchPattern(...)`
4. construct `BoundMatchClause`
5. bind join hints if present
6. attach the final predicate to `BoundReadingClause`

The output `BoundMatchClause` contains:

- `QueryGraphCollection collection`
- `common::MatchClauseType matchClauseType`
- optional `std::shared_ptr<BoundJoinHintNode> hintRoot`
- inherited predicate from `BoundReadingClause`

## 11. Match-pattern rewriting performed in the binder

### 11.1 Self-loop rewriting

Source comment and implementation:

```text
(a)-[e]->(a)
=> [a]-[e]->(b) WHERE id(a) = id(b)
```

The binder:

- clones the destination node with `createQueryNode(...)`
- rewires the relationship destination to the clone
- adds an equality predicate on the two internal-ID expressions

### 11.2 Property-map rewriting

For node or relationship patterns with inline property maps, the binder rewrites each key/value pair into an equality predicate:

```text
(a {age: 30})
=> WHERE a.age = 30
```

### 11.3 ANY-graph label rewriting

For ANY-graph node patterns, original labels are materialized in `_nodes.label` as `STRING[]`. The binder rewrites `(n:A:B)` into a conjunction of `list_contains(labelExpr, 'A')` and `list_contains(labelExpr, 'B')` predicates.

## 12. Join hints

Parser-side `JoinHintNode` stores variable names only.

Binder-side `BoundJoinHintNode` stores actual pattern expressions:

- `std::shared_ptr<Expression> nodeOrRel`
- `std::vector<std::shared_ptr<BoundJoinHintNode>> children`

`bindJoinHint(...)` validates that:

- the match pattern is connected
- every hinted leaf resolves to a bound node/relationship pattern expression
- the hint covers every pattern in the `QueryGraph`
- anonymous patterns cannot be hinted

## 13. Projection binding

Projection binding is where LadybugDB derives grouping and aggregate semantics from a flat expression list.

### 13.1 `bindProjectionList`

The binder expands parser projection items into `(expression, alias)` pairs.

Special handling includes:

- `*` expands to all expressions currently in scope
- `x.*` / property-star expands through `bindPropertyStarExpression(...)`
- otherwise `expressionBinder.bindExpression(...)` is used directly

### 13.2 `WITH` rules

`bindWithClause(...)` enforces two source-level constraints:

- every `WITH` expression must be aliased
- `ORDER BY` inside `WITH` must be followed by `SKIP` or `LIMIT`

After binding, `WITH` also **resets scope** and reintroduces only projected aliases.

### 13.3 `RETURN` rules

`bindReturnClause(...)` creates the final `BoundStatementResult` by adding each output column name plus bound expression.

### 13.4 `BoundProjectionBody`

The binder-side projection body stores derived semantic partitions:

- `projectionExpressions`
- `groupByExpressions`
- `aggregateExpressions`
- `orderByExpressions`
- `isAscOrders`
- `skipNumber`
- `limitNumber`
- `distinct`

## 14. Aggregate and grouping derivation

`bindProjectionBody(...)` walks every projected expression and classifies it as either:

- aggregate-containing -> goes into `aggregateExpressions`
- aggregate-free -> goes into `groupByExpressions`

Additional rules in the source:

- nested aggregates are rejected unless the nested aggregate is already represented by an alias in scope
- if a group-by expression is a node or rel pattern, the binder augments the group keys with the pattern's internal ID
- `COUNT(*)` is represented as an aggregate with zero children and is handled specially later

## 15. `ORDER BY`, `SKIP`, and `LIMIT` binding rules

`bindProjectionBody(...)` applies Cypher scoping rules precisely:

- if the projection has aggregation or `DISTINCT`, `ORDER BY` can only see projected expressions
- otherwise `ORDER BY` can also see pre-projection scope

`bindSkipLimitExpression(...)` accepts only:

- literal expressions
- parameter expressions

`bindOrderByExpressions(...)` rejects unsupported order-by key types including:

- `NODE`
- `REL`
- `RECURSIVE_REL`
- `INTERNAL_ID`
- `LIST`
- `ARRAY`
- `STRUCT`
- `MAP`
- `UNION`
- `POINTER`

## 16. Property collection pass

Before planning a single query, LadybugDB runs `PropertyCollector` over the bound query.

Important behavior from `property_collector.cpp`:

- collects properties needed by `MATCH` predicates
- collects properties needed by `UNWIND` input expressions
- collects properties used by `LOAD FROM` / table-function predicates
- collects RHS expressions for `SET`
- collects primary keys/internal IDs needed by `DELETE`
- collects inserted/merged column-data expressions
- can skip node/rel whole-pattern projections in intermediate `WITH` clauses via `visitSingleQuerySkipNodeRel(...)`

## 17. Default-type solving pass

`DefaultTypeSolver` is intentionally narrow.

Observed behavior:

- only visits projection bodies
- resolves `ANY` typed expressions to `STRING`

The motivating example in the source comment is `RETURN NULL;`.

## 18. Bound-statement rewrite phase

After initial binding, `BoundStatementRewriter::rewrite(...)` runs four passes in this order:

1. `WithClauseProjectionRewriter`
2. `NormalizedQueryPartMatchRewriter`
3. `MatchClausePatternLabelRewriter`
4. `DefaultTypeSolver`

Planning should therefore be reasoned about against the **rewritten** bound tree, not the raw first-pass binder output.

## 19. Reading clauses beyond `MATCH`

The binder also materializes non-pattern reads into planner-friendly structures.

### 19.1 `BoundTableFunctionCall`

Stores `BoundTableScanInfo info` and exposes:

- `getTableFunc()`
- `getBindData()`

### 19.2 `BoundLoadFrom`

Also wraps `BoundTableScanInfo`, but through a dedicated clause type so the planner can distinguish load semantics.

### 19.3 `UNWIND`

The binder creates a dedicated bound reading clause with pre-bound input/output expressions so the planner can append `LogicalUnwind` directly.

## 20. Mental model of binder responsibilities

A useful way to read the source is to separate binder work into six buckets:

1. statement dispatch
2. scope and alias management
3. catalog resolution for tables, labels, properties, functions, macros, and scans
4. expression typing and implicit casts
5. query-graph construction and pattern rewriting
6. projection normalization into group-by / aggregates / order-by / skip / limit

The binder deliberately leaves two things unfinished:

- join order
- factorized schema layout

## 21. End product handed to the planner

By the end of binding, the planner receives a tree built from:

- `BoundStatement`
- `BoundRegularQuery`
- `NormalizedSingleQuery`
- `NormalizedQueryPart`
- `BoundReadingClause` subclasses such as `BoundMatchClause`, `BoundLoadFrom`, and `BoundTableFunctionCall`
- `BoundProjectionBody`
- typed `binder::Expression` objects such as `NodeExpression`, `RelExpression`, `PropertyExpression`, aggregate functions, scalar functions, subqueries, and parameters
- `QueryGraphCollection` / `QueryGraph` / `SubqueryGraph` structures for pattern planning
- fully validated join hints represented as `BoundJoinHintNode`

That is the semantic IR for query compilation in LadybugDB.
