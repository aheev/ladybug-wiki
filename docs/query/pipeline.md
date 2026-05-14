# Full Query Pipeline

**Source files:** `src/parser/`, `src/binder/`, `src/planner/`, `src/optimizer/`, `src/processor/`

## End-to-End Walk-Through

This page traces a single query from text string to result set, touching every subsystem.

**Query:**
```cypher
MATCH (p:Person)-[:KNOWS]->(friend:Person)
WHERE p.age > 30
RETURN friend.name, count(*) AS cnt
ORDER BY cnt DESC
LIMIT 10
```

## Stage 1: Parser

```
Input: raw Cypher string
Output: CST (Concrete Syntax Tree) via ANTLR4

Lexer:  "MATCH" → MATCH token
        "(:Person)" → LP, COLON, identifier, RP
        ...
Parser: applies CypherParser.g4 grammar rules
        → CypherStatementContext (ANTLR parse tree)
```

`CypherParser::parse()` → `RegularQueryContext` containing:
- `MatchClause` with a pattern: `(p:Person)-[:KNOWS]->(friend:Person)`
- `WhereClause`: `p.age > 30`
- `ReturnClause`: `friend.name, count(*)` + `ORDER BY` + `LIMIT`

The parser produces an ANTLR CST. LadybugDB then **transforms the CST into its own AST** (`Statement` hierarchy in `src/parser/`) by visiting the ANTLR tree.

## Stage 2: Binder

```
Input: AST (Statement)
Output: Bound Statement with resolved node/rel types and column IDs
```

The binder resolves symbolic names to catalog entries:

```cpp
// binder.cpp
BoundStatement Binder::bind(const Statement& statement) {
    // 1. Bind MATCH pattern: resolve 'Person' label, 'KNOWS' rel type
    auto boundMatch = bindMatchClause(statement.matchClause);
    // 2. Bind WHERE expression: resolve 'p.age' to Person.age column
    auto boundWhere = bindExpression(statement.whereClause.expression);
    // 3. Bind RETURN: resolve 'friend.name', create count() aggregate node
    auto boundReturn = bindReturnClause(statement.returnClause);
    return BoundStatement{boundMatch, boundWhere, boundReturn};
}
```

Key binder outputs:
- `NodeExpression` for `p` → `NodeTableID=0, name="p"`, `properties={age: INT64 colID=1}`
- `RelExpression` for KNOWS → `RelTableID=2, name="__e0__"`
- `NodeExpression` for `friend` → `NodeTableID=0, name="friend"`
- `FunctionExpression` for `count(*)` → `AggregateFunction::COUNT_STAR`
- `PropertyExpression` for `p.age` → `(NodeTableID=0, colID=1)`

## Stage 3: Logical Planner

```
Input: Bound Statement
Output: LogicalPlan (tree of LogicalOperator nodes)
```

```
LogicalPlan:
  LogicalProjection [friend.name, cnt]
    └─ LogicalOrderBy [cnt DESC]
         └─ LogicalLimit [10]
              └─ LogicalAggregate [count(*) → cnt], group=[friend.name]
                   └─ LogicalFilter [p.age > 30]
                        └─ LogicalHashJoin [p.id = KNOWS.src]
                             ├─ LogicalScanNodeTable [Person, filter: age > 30]
                             └─ LogicalExtend [KNOWS, FORWARD]
                                  └─ LogicalScanNodeTable [Person → friend]
```

Join ordering: the planner enumerates join orderings using a DP-based algorithm seeded by cardinality estimates from `CardinalityEstimator`. For the above query with 2 nodes and 1 edge, the plan is simple — one hash join. For larger patterns with many relationships, the DP considers multiple orderings.

## Stage 4: Optimizer

```
Input: LogicalPlan
Output: Optimized LogicalPlan
```

Optimizer passes applied in order:

```cpp
// optimizer.cpp
void Optimizer::optimize(LogicalPlan& plan) {
    PredicatePushDownOptimizer::optimize(plan);    // push p.age > 30 into scan
    ProjectionPushDownOptimizer::optimize(plan);   // drop unused columns early
    AccHashJoinOptimizer::optimize(plan);          // decide SIP direction
    FlattenRewriter::rewrite(plan);                // handle factorized data
    // ... other passes ...
}
```

After optimization, `p.age > 30` is pushed into the `LogicalScanNodeTable` for `p`, so the filter is evaluated at the storage layer. The `AccHashJoinOptimizer` decides BUILD_TO_PROBE SIP for the hash join.

## Stage 5: Physical Plan Mapper

```
Input: Optimized LogicalPlan
Output: vector<Pipeline> (DAG of PhysicalOperator pipelines)
```

```
Pipeline 1 (build side — blocking):
  [ScanNodeTable Person(p)]        ← applies p.age > 30 filter
  → [SemiMasker]                   ← builds semi-mask from p IDs
  → [HashJoinBuild]                ← materializes p.id into hash table

Pipeline 2 (probe side — pipelined):
  [ScanNodeTable Person(friend)]   ← applies semi-mask from Pipeline 1
  → [Extend KNOWS FORWARD]         ← traverse CSR for each friend
  → [HashJoinProbe]                ← probe p.id → look up p
  → [Filter p.age > 30]            ← already pushed, but confirmed here
  → [Aggregate count(*)]           ← thread-local partial aggregates
  → [HashJoinBuild (aggregate)]    ← group-by key hash table

Pipeline 3 (aggregate finalize):
  [ScanAggregate]
  → [OrderBy cnt DESC]
  → [Limit 10]
  → [ResultCollector]
```

## Stage 6: Execution

```
Scheduler dispatches pipelines in dependency order:
  Pipeline 1 runs on N threads with morsel parallelism
  Pipeline 2 runs on N threads after Pipeline 1 completes
  Pipeline 3 runs single-threaded (ORDER BY, LIMIT are not parallel)
```

Each worker thread:
1. Claims a node group morsel atomically
2. Scans column chunks for that group (decompresses pages)
3. Applies SelectionVector for the age > 30 filter (for pipeline 1)
4. Passes DataChunk through remaining operators
5. Calls `combine()` to merge thread-local state into shared state

## Stage 7: Result Delivery

`ResultCollector` writes final DataChunks to a `FactorizedTable`. The client's `QueryResult` wraps an iterator over that table:

```cpp
// client fetches results:
auto result = conn->query("MATCH ...");
while (result->hasNext()) {
    auto row = result->getNext();
    // row[0] = friend.name (STRING), row[1] = cnt (INT64)
}
```

## Related Files

- `src/parser/cypher_parser.cpp` — ANTLR4 invocation, CST → AST transform
- `src/binder/binder.cpp` — symbol resolution, type checking
- `src/planner/planner.cpp` — logical plan construction, join ordering
- `src/optimizer/optimizer.cpp` — optimization passes
- `src/processor/plan_mapper.cpp` — physical plan mapping, pipeline construction
- `src/processor/pipeline_executor.cpp` — execution loop
