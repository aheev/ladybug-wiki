# Pipeline & Operator Model

**Source files:** `src/processor/plan_mapper.cpp`, `src/include/processor/`, `docs/morsel_parallelism.md`

## What is a Pipeline?

A **pipeline** is a chain of operators where data flows from a source through a series of transformations without any blocking step. Within a pipeline, a batch (morsel) of rows moves from operator to operator in memory without materializing intermediate results to disk.

Pipelines are separated by **pipeline-breaking operators** — operators that must consume their entire input before producing any output.

```
Query: MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE a.age > 30 RETURN b.name

Pipeline 1 (build side of hash join — blocking):
  [Scan Person nodes]
  → [Filter: age > 30]
  → [Build HashTable on a.id]   ← pipeline break

Pipeline 2 (probe side — pipelined):
  [Scan Person nodes]
  → [Extend via KNOWS edges]
  → [Probe HashTable]
  → [Project b.name]
  → [Result Collector]
```

## Operator Types

```cpp
enum class PhysicalOperatorType {
    // Sources (no input):
    SCAN_NODE_TABLE, SCAN_REL_TABLE, SCAN_FRONTIER,

    // Pipelined transformations:
    FILTER, PROJECTION, EXTEND, FLATTEN, UNWIND,
    HASH_JOIN_PROBE, SEMI_MASKER, MARK_JOIN,

    // Sinks / pipeline-breakers (have a shared state):
    HASH_JOIN_BUILD, AGGREGATE, ORDER_BY, UNION_ALL,
    RESULT_COLLECTOR,
};
```

## Pipeline Execution

Each pipeline executes in **morsel-driven parallel** mode:

```
PipelineExecutor::execute():
  while (source has morsels):
    morsel = source.getNextMorsel()  // atomic fetch
    if morsel is empty: break

    for each operator in pipeline (top to bottom):
      operator.execute(morsel.dataChunk)
      if morsel.dataChunk is exhausted: break
```

Multiple worker threads execute the same pipeline in parallel, each pulling independent morsels from the shared source state.

## Shared State vs Local State

Pipeline operators have two distinct state types:

```cpp
class PhysicalOperator {
    // Shared across all threads — initialized once before pipeline starts:
    shared_ptr<SharedState> sharedState;

    // Per-thread — initialized once per thread when it starts working on this pipeline:
    unique_ptr<LocalState> localState;
};
```

| Shared State Example | Local State Example |
|----------------------|---------------------|
| `HashTable` (built in pipeline 1) | Thread-local probe result buffer |
| `SortedKeyBlock` (output of ORDER BY) | Thread-local sort run |
| `AggregateHashTable` (merged at end) | Thread-local partial aggregates |
| Morsel counter (atomic offset) | Current morsel DataChunk |

## Dependency Graph

Pipelines have dependencies — pipeline 2 (probe) cannot start until pipeline 1 (build) completes:

```cpp
class Pipeline {
    vector<shared_ptr<Pipeline>> dependencies;
    // Pipeline N starts only when all dependencies reach COMPLETED state
};
```

The `Scheduler` topologically sorts pipelines and dispatches them in dependency order.

## Sink Operators

A **sink** is the last operator in a pipeline. It consumes DataChunks but doesn't pass them further:

```cpp
class Sink : public PhysicalOperator {
    virtual void sink(ResultSet& resultSet, ExecutionContext& context) = 0;
    // Called once per DataChunk
    virtual void combine(ExecutionContext& context) = 0;
    // Called once per thread when it finishes all morsels — merges local→shared state
    virtual void finalize(ExecutionContext& context) = 0;
    // Called once after all threads complete — finalizes shared state
};
```

Example: `HashJoinBuild::sink()` inserts the DataChunk into the local hash table; `HashJoinBuild::combine()` merges the local hash table into the shared one.

## Result Collector

The terminal sink for `RETURN` queries is `ResultCollector`, which writes DataChunks into `FactorizedTable` (a columnar in-memory table) for the client to iterate:

```cpp
class ResultCollector : public Sink {
    shared_ptr<FactorizedTable> table;
    void sink(ResultSet& resultSet, ExecutionContext& context) override {
        table->append(resultSet.getDataChunk());
    }
};
```

## PlanMapper

`PlanMapper` converts the physical plan tree into a `Pipeline` DAG:

```cpp
class PlanMapper {
    vector<shared_ptr<Pipeline>> mapLogicalPlanToPipelines(
        const LogicalPlan& logicalPlan,
        ExecutionContext& context
    );
};
```

Rules:
- Leaf operators become sources
- Pipeline-breaking operators become pipeline boundaries
- The last operator in each pipeline is always a sink

## Related Files

- `src/processor/plan_mapper.cpp` — logical → pipeline DAG
- `src/processor/pipeline.cpp` — Pipeline struct, dependency tracking
- `src/processor/pipeline_executor.cpp` — morsel loop, worker thread logic
- `src/processor/operator/sink/` — all sink operators
- `docs/morsel_parallelism.md` — original design doc (in repo)
