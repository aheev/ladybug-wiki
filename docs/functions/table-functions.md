# Table Functions

**Source files:**
- `src/include/function/table/table_function.h` — `TableFunction` struct definition
- `src/function/gds/gds_function_collection.h` — GDS algorithm registrations
- `src/function/gds/` — GDS algorithm implementations
- `src/include/function/gds/gds.h` — `GDSFunction` base class
- `src/processor/operator/table_scan/` — scan-side usage of `TableFunction`
- `src/function/function_collection.cpp` — canonical registration list

---

## Overview

Table functions return a **set of rows** rather than a single scalar value. They appear:

- In the `FROM` clause: `FROM table_function(args)`
- In `CALL` statements (standalone table functions): `CALL show_tables()`

Internally a `TableFunction` is a struct of 12+ function pointers stored in the catalog. The
query planner creates a `TableFunctionCall` logical node that the physical plan converts to a
`TableScanState` / `TableFuncCallOp` operator.

---

## `TableFunction` Struct

```cpp
struct TableFunction : public Function {
    // Required
    table_func_t                    tableFunc;           // emit a batch of rows
    table_func_bind_t               bindFunc;            // resolve types, return TableFuncBindData

    // Optional (may be nullptr)
    table_func_init_shared_t        initSharedStateFunc; // once per query fragment
    table_func_init_local_t         initLocalStateFunc;  // once per thread/morsel
    table_func_can_parallel_t       canParallelFunc;     // default: true
    table_func_finalize_t           finalizeFunc;        // after all threads finish
    table_func_progress_t           progressFunc;        // default: returns 0.0
    table_func_rewrite_t            rewriteFunc;         // rewrite query in-place (CSV only)
    table_func_get_partition_t      getPartitionFunc;    // partition key for parallelism
    table_func_supports_pushdown_t  supportsPushDownFunc;// default: false
    table_func_pushdown_t           pushDownFunc;        // apply pushed-down predicate
    table_func_copy_t               copyFunc;            // copy scan state (for retry/restart)
};
```

### Function pointer signatures

```cpp
// Emit at most maxMorselSize rows; returns true while more rows remain
using table_func_t = std::function<void(TableFuncInput& input, TableFuncOutput& output)>;

// Called once at bind time; returns nullptr or FunctionBindData subclass
using table_func_bind_t = std::function<
    std::unique_ptr<TableFuncBindData>(
        ClientContext*,
        const TableFuncBindInput&,
        std::vector<LogicalType>&   /* out: column types */,
        std::vector<std::string>&   /* out: column names */
    )>;

// Create shared state (one per plan fragment)
using table_func_init_shared_t = std::function<
    std::shared_ptr<TableFuncSharedState>(TableFunctionInitInput&)>;

// Create local (thread-local) state
using table_func_init_local_t = std::function<
    std::unique_ptr<TableFuncLocalState>(TableFunctionInitInput&, TableFuncSharedState*)>;

// Returns current progress in [0.0, 1.0]
using table_func_progress_t = std::function<double(QueryProgress*, const TableFuncSharedState*)>;

// Called after all parallel threads have finished
using table_func_finalize_t = std::function<void(ExecutionContext*, TableFuncSharedState*)>;
```

---

## State Types

### `TableFuncSharedState`

```cpp
struct TableFuncSharedState {
    virtual ~TableFuncSharedState() = default;
};
```

The canonical subclass for simple read-only functions is `SimpleTableFuncSharedState`:

```cpp
struct SimpleTableFuncSharedState : public TableFuncSharedState {
    std::mutex mtx;
    uint64_t   curOffset = 0;  // next row index to read
    uint64_t   maxOffset;      // total row count
};
```

Parallel threads atomically claim morsels via:
```cpp
uint64_t start = curOffset.fetch_add(MORSEL_SIZE);
if (start >= maxOffset) return; // done
```

### `TableFuncLocalState`

```cpp
struct TableFuncLocalState {
    virtual ~TableFuncLocalState() = default;
};
```

Per-thread state. For scan functions this typically holds:
- A file-reader handle (CSV reader, Parquet row-group iterator)
- A local offset into the current morsel
- Decode buffers

### `TableFuncInput` / `TableFuncOutput`

```cpp
struct TableFuncInput {
    FunctionBindData*     bindData;
    TableFuncLocalState*  localState;
    TableFuncSharedState* sharedState;
};

struct TableFuncOutput {
    DataChunk& dataChunk;       // result chunk to write into
};
```

`tableFunc` writes directly into `output.dataChunk`. It calls
`output.dataChunk.state->selVector.selectedSize = N` to report how many rows were written.

### `TableFuncBindData`

```cpp
struct TableFuncBindData : public FunctionBindData {
    // base fields: paramTypes, resultType, clientContext, count
    std::vector<std::string> columnNames;
    std::vector<LogicalType> columnTypes;

    virtual std::unique_ptr<TableFuncBindData> copy() const = 0;
};
```

---

## Parallelism

By default `canParallelFunc` returns `true` — the planner inserts a
`ParallelTableFuncCallOp` that spawns one thread per morsel. Setting `canParallelFunc`
to return `false` forces a serial `TableFuncCallOp` (used for stateful sources such as
`SERIAL_CSV_SCAN`).

The `getPartitionFunc`, when provided, tells the scheduler which partition key to use for
data-affinity scheduling (ensures rows for the same node table arrive in the same thread).

---

## GDS Table Functions (Graph Algorithms)

**Source:** `src/function/gds/`, `src/include/function/gds/`

GDS (Graph Data Science) algorithms extend `GDSFunction`, which in turn is a `TableFunction`
with a pre-wired `tableFunc` that:

1. Projects the requested node/edge tables into an in-memory `Graph` object.
2. Runs the algorithm via `GDSAlgorithm::exec()`.
3. Materialises results into a `FactorizedTablePool` and exposes them as table-function output.

```cpp
class GDSFunction : public TableFunction {
public:
    GDSFunction(const std::string& name,
                std::vector<common::LogicalTypeID> inputTypes,
                std::unique_ptr<GDSAlgorithm> algorithm);
};
```

All GDS functions take a single `STRING` argument — the graph name (or inline Cypher projection).

### Registered GDS algorithms

From `src/function/gds/gds_function_collection.h`:

| Function name | Description |
|---------------|-------------|
| `VAR_LEN_JOINS` | Variable-length join paths (Kleene-star traversal) |
| `ALL_SP_DESTINATIONS` | All-pairs shortest path — destination nodes only |
| `ALL_SP_PATHS` | All-pairs shortest path — full paths |
| `SINGLE_SP_DESTINATIONS` | Single-source shortest path — destination nodes |
| `SINGLE_SP_PATHS` | Single-source shortest path — full paths |
| `WEIGHTED_SP_DESTINATIONS` | Weighted single-source shortest path — destination nodes |
| `WEIGHTED_SP_PATHS` | Weighted single-source shortest path — full paths |
| `ALL_WEIGHTED_SP_PATHS` | All-pairs weighted shortest path — full paths |

### Output schema

All GDS path algorithms share a common output schema:

| Column | Type | Description |
|--------|------|-------------|
| `src` | INTERNAL_ID | Source node internal ID |
| `dst` | INTERNAL_ID | Destination node internal ID |
| `length` | INT64 | Number of hops (unweighted) or total cost (weighted) |
| `path` | PATH (optional) | Full path (only for `*_PATHS` variants) |

For `*_DESTINATIONS` variants, the `path` column is omitted.

### `GDSAlgorithm` interface

```cpp
class GDSAlgorithm {
public:
    virtual void exec(processor::ExecutionContext* context) = 0;
    virtual std::unique_ptr<GDSAlgorithm> copy() const = 0;
    const GDSComputeState& getComputeState() const;
};
```

`GDSComputeState` holds:
- A reference to the projected `Graph`
- A `FactorizedTablePool` for thread-safe result writing
- Frontier sets (active node sets used by BFS/Dijkstra)

### Shortest-path implementations

#### Single-source shortest paths (`ssp_paths.cpp`)

`SingleSPDestinations` and `SingleSPPaths` implement BFS-style layer-by-layer traversal:
1. Seed the frontier with the source node set.
2. For each BFS level: scan all edges from the frontier; record (src, dst, distance) for
   newly-visited destinations.
3. `SingleSPPaths` additionally records parent-pointer edges so the actual path can be
   reconstructed in `finalize()`.

The frontier is represented as a `NodeOffsetSemiMask` bitset — nodes are added with an atomic
CAS, so multiple threads can race to claim them.

#### Weighted shortest paths (`wsp_paths.cpp`)

`WeightedSPDestinations` and `WeightedSPPaths` implement a parallel priority-queue Dijkstra:
1. Min-heap keyed on tentative distance.
2. `updateAll` atomically relaxes edges using `compare_exchange_weak` on a `double[]` distances
   array.
3. `combine` merges per-thread tentative distance arrays into the global array.

---

## Scan Table Functions

Scan functions appear in the `FROM` clause. They read external data and emit rows.

### CSV Scan

| Function | Parallel | Notes |
|----------|---------|-------|
| `SerialCSVScan` | No | Used when parallelism is disabled or when the CSV has quoted newlines |
| `ParallelCSVScan` | Yes | Default; byte-range partitioned reader |

`rewriteFunc` is set on the CSV scan — it runs before bind to detect whether the file can be
scanned in parallel and may switch `SerialCSVScan` ↔ `ParallelCSVScan` based on sniffing.

`CSVScanConfig` (part of `TableFuncBindData`) carries:
- `delimiter`, `quoteChar`, `escapeChar`
- `hasHeader`
- `skipRows`
- `columnTypes`, `columnNames` (from schema inference or explicit LOAD CSV options)

Both CSV scans support `supportsPushDownFunc` / `pushDownFunc` to push filter predicates
into the reader (skipping rows before materialization).

### Parquet Scan

| Function | Notes |
|----------|-------|
| `ParquetScanFunction` | Reads one row-group per morsel; parallel by default |

The Parquet scan is only registered when the Parquet extension is built-in or loaded. It exposes
the Apache Arrow column-format reader via a thin `TableFunction` adapter.

### NPY Scan

| Function | Notes |
|----------|-------|
| `NpyScanFunction` | Reads NumPy `.npy` files; typically used for loading vector embeddings |

---

## Export Table Functions (COPY TO)

Export functions are registered under `EXPORT_FUNCTION` in `function_collection.cpp`. They are
invoked by `COPY ... TO '...'` statements, not by SELECT.

```cpp
struct ExportFunction : public TableFunction {
    export_func_t exportFunc;  // writes a DataChunk to the sink
};
```

| Function | Format |
|----------|--------|
| `ExportCSVFunction` | Writes CSV; honours the same options as CSV scan |
| `ExportParquetFunction` | Writes Parquet (requires Parquet extension) |

---

## Standalone Table Functions (CALL)

Standalone table functions are called via `CALL function_name(args)` with no `FROM` clause.
They are registered as `STANDALONE_TABLE_FUNCTION` in `function_collection.cpp`.

| Function | Arguments | Description |
|----------|-----------|-------------|
| `CLEAR_WARNINGS` | none | Clears the per-session warning accumulator |
| `PROJECT_GRAPH` | `name, nodeTableNames, relTableNames` | Projects an in-memory subgraph by table names |
| `PROJECT_GRAPH_CYPHER` | `name, cypherQuery` | Projects an in-memory subgraph by Cypher pattern |
| `DROP_PROJECTED_GRAPH` | `name` | Drops a named projected graph |
| `_CACHE_ARRAY_COLUMN_LOCALLY` | `tableName, columnName` | Internal: prefetches an array column into CPU cache for vector search |

---

## Catalog / Introspection Table Functions

These are regular table functions (appear in `FROM` or `CALL`). They read from in-memory
catalog data structures and return metadata rows.

| Function | Description |
|----------|-------------|
| `CATALOG_VERSION` | Returns the current catalog version number |
| `DB_VERSION` | Returns the database format version string |
| `STORAGE_VERSION` | Returns the storage layer version number |
| `CURRENT_SETTING` | `(name STRING) → STRING` — returns a system configuration value |
| `SHOW_TABLES` | Lists all node/rel tables: name, type, comment |
| `SHOW_GRAPHS` | Lists all graph schemas |
| `TABLE_INFO` | `(tableName) → columns, types, constraints` |
| `SHOW_CONNECTION` | `(relTableName) → src table, dst table` |
| `STATS_INFO` | `(tableName) → column statistics` |
| `STORAGE_INFO` | `(tableName) → storage layout details (pages, compression)` |
| `FSM_INFO` | `(tableName) → free-space map per page group` |
| `BM_INFO` | Buffer manager page status |
| `FILE_INFO` | `(filePath) → file metadata` |
| `DISK_SIZE_INFO` | Database file sizes on disk |
| `SHOW_WARNINGS` | All warnings accumulated in the current session |
| `SHOW_ATTACHED_DATABASES` | Attached external database names and types |
| `SHOW_SEQUENCES` | Sequences: name, start, increment, current value |
| `SHOW_FUNCTIONS` | All registered functions: name, type, signatures |
| `SHOW_LOADED_EXTENSIONS` | Currently loaded extensions |
| `SHOW_OFFICIAL_EXTENSIONS` | All official extensions with install status |
| `SHOW_INDEXES` | All indexes: table, column, type |
| `SHOW_PROJECTED_GRAPHS` | Named projected graphs in the current session |
| `PROJECTED_GRAPH_INFO` | `(name) → node/rel table details for a projected graph` |
| `SHOW_MACROS` | User-defined macro functions |

### Output schema for common introspection functions

**`SHOW_TABLES`**

| Column | Type |
|--------|------|
| `name` | STRING |
| `type` | STRING (`NODE`, `REL`, `REL_GROUP`, `RDF`) |
| `comment` | STRING |

**`TABLE_INFO`**

| Column | Type |
|--------|------|
| `property id` | INT32 |
| `name` | STRING |
| `type` | STRING |
| `default expression` | STRING |
| `constraint` | STRING |
| `storage type` | STRING |

**`SHOW_FUNCTIONS`**

| Column | Type |
|--------|------|
| `name` | STRING |
| `type` | STRING |
| `signature` | STRING |
| `description` | STRING |

**`SHOW_LOADED_EXTENSIONS`**

| Column | Type |
|--------|------|
| `extension_name` | STRING |
| `extension_version` | STRING |
| `install_mode` | STRING |
| `installed_path` | STRING |

---

## Lifecycle Example

The following illustrates the full lifecycle of a parallel table function call:

```
1. Bind time (one per query)
   ├── bindFunc(args) → TableFuncBindData { columnTypes, columnNames }
   └── resolves argument expressions, sniffs file headers, etc.

2. Init shared state (one per pipeline fragment)
   └── initSharedStateFunc(init) → SimpleTableFuncSharedState { maxOffset = N }

3. For each parallel worker thread:
   a. initLocalStateFunc(init, shared) → unique_ptr<TableFuncLocalState>
   b. Loop:
      ├── tableFunc(input, output)   // emit ≤ MORSEL_SIZE rows
      └── until output.dataChunk.state->selVector.selectedSize == 0

4. After all threads finish:
   └── finalizeFunc(ctx, shared)    // flush buffers, close files, etc.

5. Progress reporting (polled by query monitor):
   └── progressFunc(progress, shared) → double in [0.0, 1.0]
```

---

## Implementing a Custom Table Function

A minimal read-only table function implementation:

```cpp
// Bind: declare output schema
static std::unique_ptr<TableFuncBindData> myBind(
    ClientContext*,
    const TableFuncBindInput& input,
    std::vector<LogicalType>& types,
    std::vector<std::string>& names)
{
    types  = {LogicalType::STRING(), LogicalType::INT64()};
    names  = {"name", "value"};
    return std::make_unique<MyBindData>(input.inputs[0].getValue<std::string>());
}

// Init shared state
static std::shared_ptr<TableFuncSharedState> myInitShared(
    TableFunctionInitInput& input)
{
    auto& bind = input.bindData->constPtrCast<MyBindData>();
    auto state = std::make_shared<SimpleTableFuncSharedState>();
    state->maxOffset = bind.numRows;
    return state;
}

// Emit rows
static void myTableFunc(TableFuncInput& input, TableFuncOutput& output)
{
    auto& shared = input.sharedState->ptrCast<SimpleTableFuncSharedState>();
    auto& bind   = input.bindData->constPtrCast<MyBindData>();
    std::lock_guard lk(shared.mtx);
    uint64_t start = shared.curOffset;
    uint64_t end   = std::min(start + DEFAULT_VECTOR_CAPACITY, shared.maxOffset);
    shared.curOffset = end;

    uint64_t count = end - start;
    for (uint64_t i = 0; i < count; i++) {
        output.dataChunk.getValueVector(0)->setValue(i, bind.rows[start + i].name);
        output.dataChunk.getValueVector(1)->setValue(i, bind.rows[start + i].value);
    }
    output.dataChunk.state->selVector.selectedSize = count;
}

// Register
TableFunction MyTableFunction("MY_TABLE_FUNC", {LogicalTypeID::STRING},
                              myTableFunc, myBind, myInitShared, nullptr);
```

For GDS algorithms, subclass `GDSAlgorithm` and construct a `GDSFunction` instead of a raw
`TableFunction`:

```cpp
class MyGDSAlgorithm : public GDSAlgorithm {
public:
    void exec(ExecutionContext* ctx) override {
        // access graph via getComputeState().graph
        // write results via getComputeState().fTablePool
    }
    std::unique_ptr<GDSAlgorithm> copy() const override {
        return std::make_unique<MyGDSAlgorithm>(*this);
    }
};

GDSFunction MyGDSFunc("MY_ALGO", {LogicalTypeID::STRING},
                       std::make_unique<MyGDSAlgorithm>());
```

---

## Push-Down Support

Table functions that support predicate push-down set two function pointers:

```cpp
bool supportsPushDown(TableFuncSharedState*);              // called before planning
void pushDown(TableFuncBindData*, const binder::Expression&); // called at bind time
```

The CSV scan uses push-down to filter rows before materialising them into `DataChunk`s,
reducing memory pressure for heavily filtered scans.
