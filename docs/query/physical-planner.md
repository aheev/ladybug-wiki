# Physical Planner

**Source files:** `src/processor/map/plan_mapper.cpp`, `src/processor/map/`, `src/include/processor/plan_mapper.h`

## What This Document Covers

This document is the complete reference for LadybugDB's physical planner — the component that translates an optimized logical plan into an executable physical operator tree. It explains what `PlanMapper` does, covers every logical-to-physical operator mapping, deep-dives on the most complex mappers, and explains the `DataPos` addressing scheme and shared/local state model. For the optimizer that produces the logical plan, see [Optimizer](./optimizer.md). For how physical operators execute, see [Pipeline & Operator Model](/execution/pipeline).

---

## Architecture: The `PlanMapper`

`PlanMapper` lives in `src/processor/map/plan_mapper.cpp`. It is the single entry point for physical planning:

```cpp
class PlanMapper {
public:
    explicit PlanMapper(ExecutionContext* executionContext);

    // Main entry point: converts LogicalPlan → PhysicalPlan
    std::unique_ptr<PhysicalPlan> getPhysicalPlan(
        const LogicalPlan* logicalPlan,
        const expression_vector& expressions,
        main::QueryResultType resultType,
        ArrowResultConfig arrowConfig);

    // Internal dispatch
    std::unique_ptr<PhysicalOperator> mapOperator(const LogicalOperator* logicalOperator);

    // DataPos computation
    static std::vector<DataPos> getDataPos(const expression_vector& expressions, const Schema& schema);
    static DataPos getDataPos(const Expression& expression, const Schema& schema);

    // Hash join build info construction
    HashJoinBuildInfo createHashBuildInfo(const Schema& buildSideSchema,
        const expression_vector& keys, const expression_vector& payloads);

    // Semi-mask creation
    std::unique_ptr<SemiMask> createSemiMask(table_id_t tableID) const;
};
```

### Context Held by `PlanMapper`

```cpp
ExecutionContext* executionContext;
main::ClientContext* clientContext;     // accessed for storage, catalog, transaction, config
uint32_t physicalOperatorID;            // monotonically increasing, assigned to each new op
std::vector<MapperExtension*> mapperExtensions;  // extension-provided mappers
std::unordered_map<const LogicalOperator*, PhysicalOperator*> logicalOpToPhysicalOpMap;
// Maps logical → physical for SIP cross-referencing (e.g., SemiMasker → RecursiveExtend)
```

### `getPhysicalPlan` Flow

1. `mapOperator(logicalPlan->getLastOperator())` — recursively converts the logical tree.
2. If the root is not a sink operator, wraps it in a result collector:
   - `ArrowResultCollector` if `QueryResultType::ARROW`
   - `ResultCollector(AccumulateType::REGULAR, ...)` otherwise
3. If the plan was profiled (`logicalPlan->isProfile()`), wires the `Profile` operator to the physical plan.

---

## `DataPos` — The Vector Addressing Scheme

`DataPos` is the fundamental addressing concept for values in the execution engine:

```cpp
// src/include/processor/data_pos.h
struct DataPos {
    data_chunk_pos_t dataChunkPos;       // which DataChunk in the ResultSet
    value_vector_pos_t valueVectorPos;   // which ValueVector within that DataChunk

    DataPos() : dataChunkPos{INVALID_DATA_CHUNK_POS}, valueVectorPos{INVALID_VALUE_VECTOR_POS} {}
    explicit DataPos(data_chunk_pos_t dataChunkPos, value_vector_pos_t valueVectorPos);
    static DataPos getInvalidPos();
};
```

The `ResultSet` is a collection of `DataChunk`s:
```cpp
// src/include/processor/result/result_set.h
class ResultSet {
    std::vector<std::shared_ptr<DataChunk>> dataChunks;
    std::shared_ptr<ValueVector> getValueVector(const DataPos& dataPos) const {
        return dataChunks[dataPos.dataChunkPos]->valueVectors[dataPos.valueVectorPos];
    }
};
```

A `DataPos` is computed from a logical schema position via `schema.getExpressionPos(*expression)`, which returns a `(dataChunkPos, valueVectorPos)` pair. During `mapOperator`, every expression reference is converted to its `DataPos` in the operator's output schema.

---

## Complete Logical → Physical Operator Mapping

Every `LogicalOperatorType` handled by `PlanMapper::mapOperator`:

| Logical Operator | Physical Operator(s) | Map Function | Key Decisions |
|-----------------|---------------------|--------------|---------------|
| `SCAN_NODE_TABLE` | `ScanNodeTable` / `PrimaryKeyScanNodeTable` | `mapScanNodeTable` | SCAN vs PRIMARY_KEY_SCAN; column cast info; zone map predicates; semi-mask setup |
| `EXTEND` | `ScanRelTable` | `mapExtend` | FWD/BWD direction; property column selection; zone map predicates |
| `RECURSIVE_EXTEND` | `RecursiveExtend` + `FactorizedTableScan` | `mapRecursiveExtend` | GDS algorithm; node mask setup; factorized table for results |
| `HASH_JOIN` | `HashJoinBuild` + `HashJoinProbe` | `mapHashJoin` | Build/probe ordering based on SIP dependency; flat vs unflat payload columns |
| `INTERSECT` | `IntersectBuild` + `IntersectProbe` | `mapIntersect` | Multiple build sides |
| `CROSS_PRODUCT` | `CrossProduct` | `mapCrossProduct` | Simple nested-loop join |
| `AGGREGATE` | `HashAggregate` + `HashAggregateScan` / `SimpleAggregate` + `SimpleAggregateScan` | `mapAggregate` | `hasKeys()` → hash; no keys → simple |
| `DISTINCT` | `HashAggregate` + `HashAggregateScan` | `mapDistinct` | Distinct reuses hash aggregate infrastructure |
| `ORDER_BY` | `OrderBy` + `OrderByScan` | `mapOrderBy` | With/without limit (TopK after `TopKOptimizer`) |
| `LIMIT` | `Limit` | `mapLimit` | Skip + limit values |
| `FILTER` | `Filter` | `mapFilter` | Expression evaluator for predicate |
| `PROJECTION` | `Projection` | `mapProjection` | Evaluators for each projected expression; discarded chunk indices |
| `ACCUMULATE` | `Accumulate` | `mapAccumulate` | Materialize probe side for acc hash join |
| `FLATTEN` | `Flatten` | `mapFlatten` | Group position to flatten |
| `UNION_ALL` | `UnionAll` | `mapUnionAll` | Merge multiple pipelines |
| `SEMI_MASKER` | `SemiMasker` | `mapSemiMasker` | Key type (NODE/NODE_ID_LIST); target operators wired via `logicalOpToPhysicalOpMap` |
| `PATH_PROPERTY_PROBE` | `PathPropertyProbe` | `mapPathPropertyProbe` | Node/rel scan children for path reconstruction |
| `COUNT_REL_TABLE` | `CountRelTable` | `mapCountRelTable` | Direct degree count without scan |
| `REL_DEGREE_TABLE` | `RelDegreeTable` | `mapRelDegreeTable` | Degree lookup for ORDER BY + COUNT |
| `TABLE_FUNCTION_CALL` | `TableFunctionCall` | `mapTableFunctionCall` | Bind data; column skips; push-down predicates/limit/order |
| `EXPRESSIONS_SCAN` | `ExpressionsScan` | `mapExpressionsScan` | Outer accumulate wiring for correlated subqueries |
| `COPY_FROM` (node) | `NodeBatchInsert` | `mapCopyNodeFrom` | Column evaluators; WarningContext |
| `COPY_FROM` (rel) | `Partitioner` + `RelBatchInsert` + `DummySimpleSink` | `mapCopyRelFrom` | FWD+BWD direction; partition by src/dst |
| `PARTITIONER` | `Partitioner` | `mapPartitioner` | Rel offset data pos; partition functions |
| `COPY_TO` | `CopyTo` | `mapCopyTo` | File format writer |
| `INSERT` | `Insert` | `mapInsert` | Node/rel insert; column data evaluators |
| `DELETE` | `Delete` | `mapDelete` | Node/rel delete; primary key evaluators |
| `SET_PROPERTY` | `SetProperty` | `mapSetProperty` | LHS/RHS evaluators per set info |
| `MERGE` | `Merge` | `mapMerge` | Existence mark; on-create/on-match handlers |
| `INDEX_LOOK_UP` | `IndexLookup` | `mapIndexLookup` | PK index lookup for MERGE |
| `MULTIPLICITY_REDUCER` | `MultiplicityReducer` | `mapMultiplicityReducer` | Deduplication after recursive joins |
| `NODE_LABEL_FILTER` | `NodeLabelFilter` | `mapNodeLabelFilter` | Runtime label check |
| `UNWIND` | `Unwind` | `mapUnwind` | List unrolling |
| `UNWIND_DEDUPLICATE` | `UnwindDeduplicate` | `mapUnwindDedup` | Deduplicate before MERGE |
| `EXPLAIN` | `Explain` | `mapExplain` | Plan serialization |
| `DUMMY_SCAN` | `DummyScan` | `mapDummyScan` | Singleton source |
| `DUMMY_SINK` | `DummySimpleSink` | `mapDummySink` | No-op sink |
| `EMPTY_RESULT` | `EmptyResult` | `mapEmptyResult` | Always produces zero rows |
| `CREATE_TABLE`, `DROP`, `ALTER`, etc. | DDL operators | `mapDdl` | Catalog mutations |
| `TRANSACTION` | `Transaction` | `mapTransaction` | BEGIN/COMMIT/ROLLBACK |
| `STANDALONE_CALL` | `StandaloneCall` | `mapStandaloneCall` | CALL procedure |
| `NOOP` | `Noop` | `mapNoop` | No operation |
| `EXTENSION` | Extension-provided | `mapExtension` | Delegated to `mapperExtensions` |

---

## Deep Dive: `mapScanNodeTable`

**Source:** `src/processor/map/map_scan_node_table.cpp`

```cpp
std::unique_ptr<PhysicalOperator> PlanMapper::mapScanNodeTable(
    const LogicalOperator* logicalOperator) {
    auto& scan = logicalOperator->constCast<LogicalScanNodeTable>();
    // ...
}
```

### Steps:

**1. Compute output positions:**
```cpp
auto nodeIDPos = getDataPos(*scan.getNodeID(), *outSchema);
std::vector<DataPos> outVectorsPos;
for (auto& expression : scan.getProperties()) {
    outVectorsPos.emplace_back(getDataPos(*expression, *outSchema));
}
auto scanInfo = ScanOpInfo(nodeIDPos, outVectorsPos);
```

**2. Build `ScanNodeTableInfo` per table:** For each table ID in the scan:
- Look up the catalog entry for column IDs by property name.
- Handle JSON extraction for `data` columns (`prop.getPropertyName()` → JSON key).
- If the property type differs from the column type, create a `ColumnCaster` with a cast expression (binding done via `ExpressionBinder::forceCast`).
- If a property does not exist in this table, add `INVALID_COLUMN_ID` with `ANY` type.

**3. Create shared state per table:** Each table gets a `ScanNodeTableSharedState` with a `SemiMask` sized to the table's total rows. The semi-mask is initially full (all rows visible).

**4. Dispatch by scan type:**
- `SCAN` → `ScanNodeTable` (vectorized morsel-based parallel scan)
- `PRIMARY_KEY_SCAN` → `PrimaryKeyScanNodeTable` with key evaluator and optional upper bound evaluator

**`ScanNodeTable`** implements morsel-driven parallelism: a shared state hands out `[start, end)` row ranges (morsels) to worker threads. Each thread scans its morsel independently.

---

## Deep Dive: `mapHashJoin`

**Source:** `src/processor/map/map_hash_join.cpp`

### Build vs. Probe Side Ordering

The mapping of build and probe sides depends on `SIPDependency`:

```cpp
if (hashJoin->getSIPInfo().dependency == SIPDependency::PROBE_DEPENDS_ON_BUILD) {
    // Build must materialize first (probe needs to wait for semi-mask from build)
    buildSidePrevOperator = mapOperator(hashJoin->getChild(1).get());
    probeSidePrevOperator = mapOperator(hashJoin->getChild(0).get());
} else {
    // Default: probe first, then build
    probeSidePrevOperator = mapOperator(hashJoin->getChild(0).get());
    buildSidePrevOperator = mapOperator(hashJoin->getChild(1).get());
}
```

The mapped side is added to the physical operator tree first, ensuring its pipeline runs before the dependent side.

### `createHashBuildInfo`

```cpp
HashJoinBuildInfo PlanMapper::createHashBuildInfo(const Schema& buildSideSchema,
    const expression_vector& keys, const expression_vector& payloads) {
    // Keys: always stored as flat columns in FactorizedTable
    // Payloads: stored as flat if in same chunk as a key OR if their group is flat;
    //           stored as unflat (overflow_value_t pointer) otherwise
}
```

**Unflat payloads** use `overflow_value_t` (an offset into an overflow buffer), allowing the hash table to store variable-length or multi-value data without per-row materialization.

### SIP Wiring at Physical Level

When `SIPDirection::PROBE_TO_BUILD` (probe-to-build SIP):
```cpp
if (hashJoin->getSIPInfo().direction == SIPDirection::PROBE_TO_BUILD) {
    mapSIPJoin(hashJoinProbe.get());
}
```

`mapSIPJoin` traverses the probe's physical operator tree to find the `TableFunctionCall` (the foreign scan in an acc hash join), moves its `ResultCollector` child to become a child of the hash join probe instead. This restructures the pipeline so the build side accumulates into a result collector that the probe side reads.

---

## Deep Dive: `mapAggregate`

**Source:** `src/processor/map/map_aggregate.cpp`

### Hash Aggregate vs. Simple Aggregate

```cpp
if (agg.hasKeys()) {
    return createHashAggregate(keys, dependentKeys, aggregates, ...);
}
// No GROUP BY keys → simple global aggregate
return createSimpleAggregate(...);
```

**`SimpleAggregate`** pipeline:
```
SimpleAggregateScan
  └── SimpleAggregateFinalize
        └── SimpleAggregate (sink)
              └── child pipeline
```
A single hash table slot per aggregate function.

**`HashAggregate`** pipeline:
```
HashAggregateScan
  └── HashAggregateFinalize
        └── HashAggregate (sink)
              └── child pipeline
```
A hash table keyed on GROUP BY columns, one entry per distinct key combination.

### Key vs. Dependent Key Split

The `AggKeyDependencyOptimizer` has already split keys into `keys` (what we hash/compare) and `dependentKeys` (functionally determined, carried as payload). The mapper passes both to `createHashAggregate`:

```cpp
expression_vector allKeys;
allKeys.insert(allKeys.end(), keys.begin(), keys.end());
allKeys.insert(allKeys.end(), payloads.begin(), payloads.end());
// allKeys = "keys" for GROUP BY semantics; payloads are extra columns
```

### `getAggregateInputInfos`

For each aggregate function, computes:
- `aggregateVectorPos`: DataPos of the aggregate's input value (INVALID for `COUNT(*)`).
- `multiplicityChunksPos`: positions of unflat groups NOT in GROUP BY — these contribute to the multiplicity count for factorized aggregation.

---

## Deep Dive: `mapRecursiveExtend`

**Source:** `src/processor/map/map_recursive_extend.cpp`

### Structure

Recursive (variable-length path) execution uses an `OnDiskGraph` abstraction to traverse CSR adjacency lists. The physical operator is a `RecursiveExtend` that runs a GDS (graph data science) algorithm:

```cpp
auto graph = std::make_unique<OnDiskGraph>(clientContext, bindData.graphEntry.copy());
auto sharedState = std::make_shared<RecursiveExtendSharedState>(
    table,      // FactorizedTable for results
    std::move(graph),
    extend.getLimitNum()  // early termination limit (pushed by LimitPushDownOptimizer)
);
```

### Node Masks

If the logical operator has input or output node masks (set by `HashJoinSIPOptimizer`):
```cpp
if (extend.hasInputNodeMask()) {
    sharedState->setInputNodeMask(createNodeOffsetMaskMap(*bindData.nodeInput, this));
}
if (extend.hasOutputNodeMask()) {
    sharedState->setOutputNodeMask(createNodeOffsetMaskMap(*bindData.nodeOutput, this));
}
```

`createNodeOffsetMaskMap` creates a `NodeOffsetMaskMap` with one `SemiMask` per table ID in the node's type set.

### Node Predicate Pipeline

If the recursive extend has a node predicate (a filter on intermediate path nodes):
1. Maps the node predicate pipeline as a separate physical operator tree.
2. Wires the `LogicalSemiMasker` in the predicate pipeline to target the `RecursiveExtend` physical operator via `logicalOpToPhysicalOpMap`.
3. Creates a `PathNodeMaskMap` on the shared state.

### Result via FactorizedTable

The `RecursiveExtend` writes results into a `FactorizedTable`. A `FactorizedTableScan` is then created (via `createFTableScanAligned`) to read from that table, making the results available to the next pipeline stage.

---

## Deep Dive: `mapCopyFrom`

**Source:** `src/processor/map/map_copy_from.cpp`

### Node Copy

```
NodeBatchInsert (sink)
  └── TableFunctionCall or other reader source
```

1. Maps the source operator (CSV reader, Parquet reader, etc.).
2. Creates `ExpressionEvaluator`s for each column expression.
3. Creates `NodeBatchInsertSharedState` (shared across parallel inserters).
4. If source is a `TableFunctionCall`, shares the table function's shared state (for progress reporting and warning collection).

### Rel Copy

```
DummySimpleSink
  ├── RelBatchInsert FWD
  ├── RelBatchInsert BWD
  └── Partitioner
        └── TableFunctionCall (CSV/Parquet reader)
```

1. Maps the source to a `Partitioner` which sorts relationships by source node ID.
2. Creates one `RelBatchInsert` per direction (FWD and BWD), sharing the `CopyPartitionerSharedState`.
3. All batch inserts share a `BatchInsertSharedState` for error/warning reporting.
4. A `DummySimpleSink` aggregates all batch insert results.

---

## Deep Dive: `expression_mapper.cpp`

**Source:** `src/processor/map/expression_mapper.cpp`

`ExpressionMapper` converts `binder::Expression` trees into `evaluator::ExpressionEvaluator` trees. It is used by every mapper that needs to evaluate expressions at runtime.

### Constructor Context

```cpp
class ExpressionMapper {
    const planner::Schema* schema;          // operator's input schema (for DataPos lookup)
    evaluator::ExpressionEvaluator* parentEvaluator;  // set for lambda sub-expressions
};
```

When `schema == nullptr`, only constant expressions can be evaluated (used for default value evaluators in bulk insert).

### Dispatch Logic

```cpp
std::unique_ptr<ExpressionEvaluator> ExpressionMapper::getEvaluator(
    std::shared_ptr<Expression> expression) {
    if (schema == nullptr) return getConstantEvaluator(expression);
    if (schema->isExpressionInScope(*expression)) return getReferenceEvaluator(expression);
    if (LITERAL == type) return getLiteralEvaluator(expression);
    if (isNodePattern(*expression)) return getNodeEvaluator(expression);
    if (isRelPattern(*expression)) return getRelEvaluator(expression);
    if (PATH == type) return getPathEvaluator(expression);
    if (PARAMETER == type) return getParameterEvaluator(expression);
    if (CASE_ELSE == type) return getCaseEvaluator(expression);
    if (canEvaluateAsFunction(type)) return getFunctionEvaluator(expression);
    if (parentEvaluator != nullptr) return getLambdaParamEvaluator(expression);
    throw NotImplementedException(...);
}
```

**Priority:** Reference (in-scope) check comes first — if the expression is already computed upstream and available in the schema, just read it via `ReferenceExpressionEvaluator`.

### Lambda Handling

For list lambda functions (`list_transform`, `list_filter`, `list_reduce`):
```cpp
if (expression->getNumChildren() == 2 &&
    expression->getChild(1)->expressionType == ExpressionType::LAMBDA) {
    childrenEvaluators.push_back(getEvaluator(expression->getChild(0)));  // list argument
    auto result = std::make_unique<ListLambdaEvaluator>(expression, std::move(childrenEvaluators));
    // Lambda body evaluated with parentEvaluator set so lambda params can be resolved
    auto recursiveExprMapper = ExpressionMapper(schema, result.get());
    auto& lambdaExpr = expression->getChild(1)->constCast<LambdaExpression>();
    result->setLambdaRootEvaluator(recursiveExprMapper.getEvaluator(lambdaExpr.getFunctionExpr()));
    return result;
}
```

The `parentEvaluator` is set in the recursive mapper so that lambda parameter expressions (`x` in `x -> x + 1`) are resolved as `LambdaParamEvaluator` nodes.

---

## Shared State vs. Local State

Physical operators have two kinds of state:

**Shared state** (`PhysicalOperatorSharedState` subclasses):
- Shared across all worker threads executing the same pipeline.
- Contains: hash tables, factorized tables, result collectors, progress counters, semi-masks.
- Protected by internal synchronization (mutexes, atomics).
- Examples: `HashJoinSharedState`, `ScanNodeTableSharedState`, `HashAggregateSharedState`.

**Local state** (per-thread operator state):
- Each worker thread has its own copy of the operator's local state.
- Contains: current morsel range, local hash table shard (for parallel hash build), current output position.
- Initialized per-thread via `initLocalStateInternal()`.
- Never shared — no synchronization needed.

The `PlanMapper` creates shared state objects during physical planning. Local states are created lazily during execution when each thread initializes its pipeline.

---

## Extension Mapper Support

`PlanMapper` supports extension-provided logical operators via `mapExtension`:

```cpp
case LogicalOperatorType::EXTENSION: {
    physicalOperator = mapExtension(logicalOperator);
}
```

Each `MapperExtension` in `mapperExtensions` is given the chance to handle the operator. If no extension handles it, an error is thrown. This allows external extensions (GDS algorithms, foreign scanners) to register custom logical→physical mappings without modifying core code.

---

## See Also

- [Optimizer](./optimizer.md) — produces the logical plan that PlanMapper consumes
- [Expression Evaluator](./expressions.md) — detailed reference for all evaluator types
- [Pipeline & Operator Model](/execution/pipeline) — how physical operators execute
- [Vectorized Execution Model](/execution/vectorized) — DataChunk and ValueVector model
- [Semi-Mask & SIP Optimization](/execution/semi-mask) — SIP physical execution
- [GDS & Recursive Traversals](/execution/gds) — RecursiveExtend execution details

---

## ResultSet and DataChunk Model

Understanding how data flows through the physical plan requires understanding the ResultSet / DataChunk / ValueVector stack.

### ValueVector

A `ValueVector` holds up to `DEFAULT_VECTOR_CAPACITY` (2048) values of a single type:
```cpp
class ValueVector {
    LogicalType dataType;
    uint8_t* valueBuffer;     // raw typed values
    NullMask nullMask;        // one bit per value
    bool isFlat() const;      // true if this vector has exactly 1 active value
    void setNull(uint64_t pos, bool isNull);
    bool isNull(uint64_t pos) const;
};
```

### DataChunk

A `DataChunk` groups `ValueVector`s that share the same "chunk" in the factorized result model. All vectors in a chunk share the same `state` (flat or unflat, current size, current position):

```cpp
class DataChunk {
    std::vector<std::shared_ptr<ValueVector>> valueVectors;
    std::shared_ptr<DataChunkState> state;
    // state->selVector holds the active selection indices
    // state->getNumSelectedValues() is the current batch size
};
```

### ResultSet

```cpp
class ResultSet {
    std::vector<std::shared_ptr<DataChunk>> dataChunks;
    uint64_t getNumTuples() const;  // product of all DataChunk sizes (factorized)
    std::shared_ptr<ValueVector> getValueVector(const DataPos& dataPos) const;
};
```

The `ResultSet` layout is determined by the `Schema` at the logical level — the `f_group_pos` (factorization group position) of each expression determines which DataChunk it lives in, and the order of expressions in a group determines the `valueVectorPos`.

---

## Schema Computation and DataPos Resolution

During `mapOperator`, the `Schema` of the **output** of each logical operator is used to compute `DataPos` values for every expression that the physical operator needs to produce or consume.

```cpp
// Example: mapping a FILTER operator
auto& logicalFilter = logicalOperator->constCast<LogicalFilter>();
auto childSchema = logicalFilter.getChild(0)->getOperatorSchemaRef();
// Expression evaluator for the predicate:
auto predicateEvaluator = ExpressionMapper(childSchema).getEvaluator(logicalFilter.getPredicate());
// Physical filter wraps the child's output — the schema is the same as the child
auto physicalFilter = std::make_unique<Filter>(
    std::move(predicateEvaluator),
    /* child result set descriptor from childSchema */);
```

The `Schema` has `f_group_pos` per expression. These map directly to `DataPos.dataChunkPos`. Within a factorization group, the expressions are ordered, giving `valueVectorPos`.

---

## Semi-Masker Wiring

The `SemiMasker` physical operator is a special pass-through that populates a `SemiMask` based on node IDs that pass through its pipeline. It must be wired to the physical operator that will later consume the mask.

```cpp
case LogicalOperatorType::SEMI_MASKER: {
    auto& logicalSemiMasker = logicalOperator->constCast<LogicalSemiMasker>();
    auto physicalChild = mapOperator(logicalSemiMasker.getChild(0).get());
    auto inNodeIDPos = getDataPos(*logicalSemiMasker.getNodeID(), *inSchema);
    // Find the target physical operators via logicalOpToPhysicalOpMap:
    std::vector<PhysicalOperator*> targetOpVec;
    for (auto& target : logicalSemiMasker.getTargetOperators()) {
        KU_ASSERT(logicalOpToPhysicalOpMap.contains(target));
        targetOpVec.push_back(logicalOpToPhysicalOpMap.at(target));
    }
    std::unique_ptr<SemiMasker> masker;
    if (logicalSemiMasker.getKeyType() == SemiMaskerKeyType::NODE) {
        masker = std::make_unique<SingleTableSemiMasker>(..., targetOpVec);
    } else {
        masker = std::make_unique<MultiTableSemiMasker>(..., targetOpVec);
    }
    // ...
}
```

The `logicalOpToPhysicalOpMap` is populated when operators that support semi-masking (like `ScanNodeTable`, `RecursiveExtend`) are first mapped. The `SemiMasker` is mapped afterwards and looks up its targets in this map.

---

## COPY FROM Pipeline — Detailed

### Node Copy Pipeline

```
┌─────────────────────────────────────────────────────┐
│  NodeBatchInsert (parallel sinks, one per thread)   │
│  SharedState: NodeBatchInsertSharedState             │
└────────────────────┬────────────────────────────────┘
                     │
         ┌───────────▼───────────┐
         │  TableFunctionCall    │  ← CSV/Parquet/JSON reader
         │  (or PROJECTION node) │
         └───────────────────────┘
```

Column evaluators are created for each target property column. If the source has a PROJECTION (e.g., for type casting), the projection's evaluators handle conversion.

### Rel Copy Pipeline

```
┌─────────────────────────────────────────────────────┐
│                DummySimpleSink                      │
└─────┬─────────────────┬────────────────┬────────────┘
      │                 │                │
  ┌───▼────┐       ┌────▼───┐       ┌────▼───┐
  │RelBatch│       │RelBatch│       │Partition│
  │Insert  │       │Insert  │       │         │
  │ FWD    │       │ BWD    │       │         │
  └────────┘       └────────┘       └────┬────┘
                                         │
                               ┌─────────▼──────────┐
                               │  TableFunctionCall  │
                               └─────────────────────┘
```

The `Partitioner` sorts relationships by source node ID into partitions that correspond to storage pages. Each direction's `RelBatchInsert` reads from the partitioned data independently and in parallel.

---

## Operator ID Assignment

Each physical operator is assigned a monotonically increasing `operatorID` during mapping:

```cpp
std::unique_ptr<SomeOperator> PlanMapper::mapSomething(...) {
    return make_unique<SomeOperator>(..., getOperatorID(), executionContext);
}
uint32_t getOperatorID() { return physicalOperatorID++; }
```

Operator IDs are used for:
- **PROFILE output:** Each operator reports timing/cardinality statistics by ID.
- **Plan printing:** EXPLAIN output labels operators by their ID.
- **Semi-mask registration:** The `logicalOpToPhysicalOpMap` maps logical operator pointers to physical operators; IDs provide a stable reference in output.

---

## Worked Example: Simple `MATCH … WHERE … RETURN`

Consider:
```cypher
MATCH (a:Person)-[:KNOWS]->(b:Person)
WHERE a.age > 30
RETURN b.name
ORDER BY b.name
```

After optimization (see [Optimizer](./optimizer.md)), the logical plan might be:
```
ORDER_BY (b.name ASC)
  └── PROJECTION (b.name)
        └── EXTEND (a → b via KNOWS FWD)
              └── FILTER (a.age > 30)
                    └── SCAN_NODE_TABLE (a:Person; properties: [age, _id])
```

The physical plan produced by `PlanMapper`:

```
OrderByScan (op#0)
  └── OrderByFinalize (op#1)
        └── OrderBy (op#2)               ← sink
              └── Projection (op#3)      ← evaluates b.name
                    └── ScanRelTable (op#4)  ← FWD KNOWS extend
                          └── Filter (op#5) ← evaluates age > 30
                                └── ScanNodeTable (op#6)  ← reads a._id, a.age
```

`DataPos` assignments (illustrative):
- `a._id` → `DataPos(0, 0)` (chunk 0, vector 0)
- `a.age` → `DataPos(0, 1)` (chunk 0, vector 1)
- `b._id` → `DataPos(1, 0)` (chunk 1, vector 0)
- `b.name` → `DataPos(1, 1)` (chunk 1, vector 1)

The `Filter` evaluator: `FunctionExpressionEvaluator(GT, [ReferenceEvaluator(DataPos(0,1)), LiteralEvaluator(30)])`.
The `Projection` evaluator: `[ReferenceEvaluator(DataPos(1,1))]`.
The `OrderBy` receives: `DataPos(1,1)` as the sort key.

---

## Source File Reference

| File | Description |
|------|-------------|
| `src/processor/map/plan_mapper.cpp` | Main dispatch; `getPhysicalPlan`, `mapOperator` switch |
| `src/processor/map/expression_mapper.cpp` | `ExpressionMapper`: BoundExpression → ExpressionEvaluator |
| `src/processor/map/map_scan_node_table.cpp` | `mapScanNodeTable`: SCAN vs PRIMARY_KEY_SCAN, ScanNodeTableInfo, column casters |
| `src/processor/map/map_extend.cpp` | `mapExtend`: ScanRelTable physical operator |
| `src/processor/map/map_hash_join.cpp` | `mapHashJoin`: build/probe ordering, `createHashBuildInfo`, SIP wiring |
| `src/processor/map/map_acc_hash_join.cpp` | `mapSIPJoin`: accumulating hash join SIP pipeline restructure |
| `src/processor/map/map_aggregate.cpp` | `mapAggregate`: SimpleAggregate vs HashAggregate selection |
| `src/processor/map/map_recursive_extend.cpp` | `mapRecursiveExtend`: OnDiskGraph, node masks, GDS algorithm |
| `src/processor/map/map_copy_from.cpp` | `mapCopyNodeFrom`, `mapCopyRelFrom`: batch insert pipelines |
| `src/processor/map/map_copy_to.cpp` | `mapCopyTo`: file format writer |
| `src/processor/map/map_hash_aggregate.cpp` | `createHashAggregate`: evaluators and shared state setup |
| `src/processor/map/map_order_by.cpp` | `mapOrderBy`: with/without TopK limit |
| `src/processor/map/map_projection.cpp` | `mapProjection`: evaluators and discarded chunk tracking |
| `src/processor/map/map_semi_masker.cpp` | `mapSemiMasker`: wiring via `logicalOpToPhysicalOpMap` |
| `src/include/processor/plan_mapper.h` | `PlanMapper` class declaration |
| `src/include/processor/data_pos.h` | `DataPos` struct definition |
| `src/include/processor/result/result_set.h` | `ResultSet`, `DataChunk`, `ValueVector` |

---

## FAQ and Debugging Tips

**Q: Why does `mapScanNodeTable` create a column caster for a property?**
A: When a node table has the same property name in multiple tables (for multi-label scans like `(a:Person|Company)`) but with different column types, a runtime cast expression is inserted. The physical operator calls the cast evaluator before writing to the output vector.

**Q: Why is the build side mapped before the probe side in some hash joins?**
A: When `SIPDependency::PROBE_DEPENDS_ON_BUILD` is set (by `HashJoinSIPOptimizer`), the probe side uses a semi-mask populated during the build pipeline. The build pipeline must complete before the probe pipeline starts. Mapping the build side first ensures it is scheduled first in the execution plan.

**Q: What is `createFlatFTableSchema`?**
A: A helper that creates a `FactorizedTableSchema` where every column is flat (no unflat/overflow columns). Used for `ExpressionsScan` in correlated subquery unnesting — the outer result is materialized with all flat columns so that correlated expressions can be scalar-broadcast to the inner pipeline.

**Q: Can extension-provided operators use `ExpressionMapper`?**
A: Yes. `PlanMapper` passes itself (or an `ExpressionMapper` bound to the appropriate schema) to extension map calls. Extensions call `PlanMapper::mapExpression(expression, schema)` to get evaluators for their operators.

**Q: How does DISTINCT work physically?**
A: `DISTINCT` is mapped identically to `AGGREGATE` with no aggregate functions — just GROUP BY keys. The `createHashAggregate` path is used, producing a hash aggregate that counts nothing but deduplicates all key combinations.
