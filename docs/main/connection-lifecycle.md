# Connection & Query Lifecycle

**Source files:**
- `src/include/main/database.h`, `src/main/database.cpp`
- `src/include/main/connection.h`, `src/main/connection.cpp`
- `src/include/main/client_context.h`, `src/main/client_context.cpp`
- `src/include/main/prepared_statement.h`, `src/main/prepared_statement.cpp`
- `src/include/main/query_result.h`, `src/main/query_result.cpp`
- `src/include/main/query_result/materialized_query_result.h`, `.cpp`

---

## Overview

Every user interaction with LadybugDB passes through exactly three objects:

| Object | Lifetime | Role |
|--------|----------|------|
| `Database` | Process-wide singleton per path | Owns all subsystems (buffer manager, storage, transaction manager, catalog, …) |
| `Connection` | Per-client session | Thread-safe entry point; each `Connection` owns exactly one `ClientContext` |
| `ClientContext` | Bound to a `Connection` | Holds per-session mutable state (active transaction, config, cache, progress bar) |

The separation exists so that one `Database` can serve many concurrent `Connection`s without
locking the shared storage subsystem for per-connection bookkeeping.

---

## 1. `Database` Construction

```cpp
// lbug::main::Database
explicit Database(std::string_view databasePath,
                  SystemConfig systemConfig = SystemConfig());
```

### `SystemConfig` fields

| Field | Default | Meaning |
|-------|---------|---------|
| `bufferPoolSize` | `(uint64_t)-1` | Max buffer pool bytes; `-1` means auto-size |
| `maxNumThreads` | `0` | `0` → detect hardware concurrency |
| `enableCompression` | `true` | Enable columnar compression |
| `readOnly` | `false` | Forbid all write transactions |
| `maxDBSize` | `(uint64_t)-1` | mmap region cap (temporary) |
| `autoCheckpoint` | `true` | Auto-trigger checkpoint at WAL threshold |
| `checkpointThreshold` | `16 MiB` | WAL size that triggers auto-checkpoint |
| `forceCheckpointOnClose` | `true` | Checkpoint on `Database` destructor |
| `throwOnWalReplayFailure` | `true` | Throw if WAL replay encounters an error |
| `enableChecksums` | `true` | Per-page checksums in WAL |
| `enableMultiWrites` | `false` | Allow concurrent write transactions |
| `enableDefaultHashIndex` | `true` | Create PK hash index for every new node table |

### Initialization sequence

```
Database(databasePath, systemConfig)
  └── initMembers(dbPath, initBmFunc)
        ├── dbConfig = make_unique<DBConfig>(systemConfig)
        ├── vfs      = VirtualFileSystem::create()           // pluggable I/O
        ├── bufferManager = initBufferManager(*this)
        ├── memoryManager = MemoryManager(bufferManager)
        ├── catalog       = Catalog::open(vfs, dbPath)       // load schema
        ├── storageManager= StorageManager(catalog, bm, vfs)
        ├── transactionManager = TransactionManager::open()
        ├── queryProcessor= QueryProcessor(maxNumThreads)    // starts thread pool
        ├── databaseManager= DatabaseManager()               // attached DB registry
        └── extensionManager= ExtensionManager()
```

The `Database` acquires an exclusive file lock on `<path>/lbug.lock` during `initMembers`. A
second read-write `Database` on the same path will throw. Multiple `Database`s opened
`readOnly = true` on the same path are permitted.

### `DatabaseLifeCycleManager`

```cpp
// database.h
std::shared_ptr<common::DatabaseLifeCycleManager> dbLifeCycleManager;
```

A reference-counted object handed to every `Connection` (and their `QueryResult`s). It exists
so that iterating a `QueryResult` after the `Database` is destroyed detects the dangling
reference and throws rather than segfaulting.

---

## 2. `Connection` Construction

```cpp
// lbug::main::Connection
explicit Connection(Database* database);
```

The constructor:

1. Increments the `Database`'s `dbLifeCycleManager` reference count.
2. Creates a `ClientContext`:

```cpp
clientContext = make_unique<ClientContext>(database);
```

3. The `ClientContext` constructor:
   - Opens a `TransactionContext` (no active transaction yet).
   - Allocates a `RandomEngine` for UUID generation.
   - Allocates a `ProgressBar`.
   - Allocates a `WarningContext`.
   - Allocates an empty `GraphEntrySet` (for GDS projected graph management).
   - Reads `database->dbConfig->maxNumThreads` into `clientConfig.numThreads`.
   - Copies all other `ClientConfigDefault` constants into `clientConfig`.

### `Connection` is thread-safe

Despite owning a `ClientContext` with a `std::mutex mtx`, `Connection` is documented
as thread-safe. The contract is: calls from multiple threads are serialized via `mtx` inside
`ClientContext::query / prepare / executeWithParams`. No shared mutable state leaks outside the
lock.

The additional `mtxForClose / cvForClose / activeQueryCount` trio handles a subtle race:

```cpp
// ClientContext
std::atomic<uint32_t> activeQueryCount{0};
std::mutex            mtxForClose;
std::condition_variable cvForClose;

void registerQueryStart() { activeQueryCount++; }
void registerQueryEnd() {
    std::lock_guard lck{mtxForClose};
    if (--activeQueryCount == 0) cvForClose.notify_all();
}
void waitForNoActiveQuery() {
    std::unique_lock lck{mtxForClose};
    cvForClose.wait(lck, [this]{ return activeQueryCount == 0; });
}
```

`waitForNoActiveQuery()` is called by the `Connection` destructor (via `ClientContext`
destructor ordering) to drain any in-flight background workers before the `ClientContext` is
freed, preventing worker threads from touching deallocated memory.

---

## 3. `conn.query()` — End-to-End

```cpp
// Connection
std::unique_ptr<QueryResult> query(std::string_view query);
```

### Call chain (abbreviated)

```
Connection::query(query)
  └── ClientContext::query(query, queryID=nullopt, config={FTABLE, {}})
        └── lock_t lck{mtx}          ← serialise per-connection
              └── queryNoLock(query)
                    ├── parseQuery(query)           [PHASE 1: Parse]
                    ├── for each parsedStatement:
                    │     ├── prepareNoLock(stmt)   [PHASE 2: Prepare]
                    │     └── executeNoLock(...)    [PHASE 3: Execute]
                    └── chain results via addNextResult()
```

Multiple statements in a single `query()` call are parsed together and executed sequentially.
Their `QueryResult` objects are linked via `QueryResult::nextQueryResult` (a singly-linked list).

---

## 4. Phase 1 — Parsing

```cpp
// ClientContext
std::vector<std::shared_ptr<parser::Statement>> parseQuery(std::string_view query);
```

Steps:

1. **ANTLR4 parse** — `Parser::parseQuery(query, transformerExtensions)` tokenises and builds
   the CST, then produces a vector of `Statement` objects.
2. **Timing** — a `TimeMetric` records wall-clock parse time; divided equally across statements.
3. **Standalone-call rewrite** — `StandaloneCallRewriter` checks whether a bare
   `CALL function()` should be rewritten (e.g., expanding catalog introspection calls into
   a `MATCH`/`RETURN`). Rewritten statements are tagged `setToInternal()` so their results
   are hidden from the caller.

A parse error short-circuits immediately; `query()` returns a failed `QueryResult` with the
error message.

---

## 5. Phase 2 — Prepare (`prepareNoLock`)

```cpp
ClientContext::PrepareResult prepareNoLock(
    std::shared_ptr<parser::Statement> parsedStatement,
    bool shouldCommitNewTransaction,
    std::unordered_map<std::string, std::shared_ptr<Value>> inputParams = {});
```

Returns a `PrepareResult` containing:
- `unique_ptr<PreparedStatement>` — the client-visible object (error flag, param map, `readOnly`)
- `unique_ptr<CachedPreparedStatement>` — internal object holding the `LogicalPlan` and `columns`

The internal steps all run inside `TransactionHelper::runFuncInTransaction`:

### 5a. Read/write classification

```cpp
auto readWriteAnalyzer = StatementReadWriteAnalyzer(this);
readWriteAnalyzer.visit(*parsedStatement);
preparedStatement->readOnly = readWriteAnalyzer.isReadOnly();
```

This AST visitor inspects `CREATE`, `MERGE`, `SET`, `DELETE`, `COPY FROM`, etc. and sets
`readOnly = false`. `MATCH`/`RETURN`-only queries are `readOnly = true`.

### 5b. Transaction validation

```cpp
validateTransaction(preparedStatement->readOnly, parsedStatement->requireTransaction());
```

Raises `ConnectionException` if:
- A write query is attempted on a `readOnly` `Database`.
- A statement requiring an explicit transaction (e.g., `COMMIT`) is issued outside one.

### 5c. Bind

```cpp
auto binder = Binder(this, localDatabase->getBinderExtensions());
auto expressionBinder = binder.getExpressionBinder();
for (auto& [name, value] : inputParams) {
    expressionBinder->addParameter(name, value);
}
const auto boundStatement = binder.bind(*parsedStatement);
```

`Binder` resolves all table/column/function names against the `Catalog`, type-checks
expressions, and returns a fully resolved `BoundStatement`. Unknown `$param` references are
collected in `preparedStatement->unknownParameters`; known ones go into `parameterMap`.

### 5d. Plan

```cpp
auto planner = Planner(this);
auto bestPlan = planner.planStatement(*boundStatement);
```

`Planner` emits a `LogicalPlan` (a tree of `LogicalOperator` nodes) for the bound statement.
For `MATCH` queries this includes `LogicalScanNode`, `LogicalExtend`, `LogicalHashJoin`,
`LogicalProject`, etc.

### 5e. Optimize

```cpp
optimizer::Optimizer::optimize(&bestPlan, this, planner.getCardinalityEstimator());
```

The optimizer runs a fixed sequence of rewrite passes (predicate pushdown, SIP semi-mask
injection, join reordering, etc.) over the logical plan. The cardinality estimator guides
join-order decisions.

### 5f. Timing

The `preparedSummary.compilingTime` is set to
`parsingTime + prepareTimer.getElapsedTimeMS()`. This is what `QuerySummary::getCompilingTime()`
returns.

---

## 6. Phase 3 — Execute (`executeNoLock`)

```cpp
std::unique_ptr<QueryResult> executeNoLock(
    PreparedStatement* preparedStatement,
    CachedPreparedStatement* cachedStatement,
    std::optional<uint64_t> queryID = std::nullopt,
    QueryConfig queryConfig = {});
```

### 6a. Transaction setup

Everything runs inside another `TransactionHelper::runFuncInTransaction`. For read-only
statements an existing read transaction is reused (or a new one started and committed after
the query). For write statements a write transaction is started.

`COPY FROM` statements additionally call `Transaction::Get(*this)->setForceCheckpoint()` so
a checkpoint is always forced after the bulk load completes.

### 6b. Physical mapping

```cpp
const auto executionContext = make_unique<ExecutionContext>(profiler.get(), this, *queryID);
auto mapper = PlanMapper(executionContext.get());
const auto physicalPlan = mapper.getPhysicalPlan(
    cachedStatement->logicalPlan.get(),
    cachedStatement->columns,
    queryConfig.resultType,
    queryConfig.arrowConfig);
```

`PlanMapper` walks the `LogicalPlan` top-down and creates a matching tree of
`PhysicalOperator`s. The root operator's `ResultSetDescriptor` determines the output schema.

### 6c. Processor execution

```cpp
result = localDatabase->queryProcessor->execute(physicalPlan.get(), executionContext.get());
```

`QueryProcessor::execute` drives the pipeline scheduler:

1. Splits the physical plan into pipelines (a pipeline ends at a sink or a pipeline-breaker
   like `OrderBy`/`HashJoin` build side).
2. Submits `Task`s to the `TaskScheduler` (the thread pool started during `Database` init).
3. Each worker thread pulls a morsel (a node-group-sized range of offsets), executes the full
   pipeline on it, and writes output to a shared `FactorizedTable`.
4. The caller thread blocks on `scheduleTaskAndWaitOrError` until all tasks complete.

### 6d. Result materialization

For `FTABLE` results (default), the output is a `MaterializedQueryResult`:

```cpp
// main/query_result/materialized_query_result.h
class MaterializedQueryResult : public QueryResult {
    std::shared_ptr<processor::FactorizedTable> table;
    std::unique_ptr<processor::FactorizedTableIterator> iterator;
    ...
    std::shared_ptr<FlatTuple> getNext() override;
};
```

The `FactorizedTable` is kept alive by a `shared_ptr` so it survives the lifetime of the
`PlanMapper` and `ExecutionContext`. The caller iterates via `hasNext()` / `getNext()`.

`getNext()` returns a `shared_ptr<FlatTuple>` that is **reused** across calls — the comment
in the header warns: *"all calls to getNext() reuse the same FlatTuple object … complete
processing a FlatTuple or make a copy before calling getNext() again."*

For Arrow results, a `ArrowQueryResult` is produced instead; `getNextArrowChunk(chunkSize)`
materialises batches of rows as `ArrowArray` structs.

### 6e. Summary population

After execution, `QueryResult::getQuerySummary()` returns a `QuerySummary` with:

| Field | Meaning |
|-------|---------|
| `compilingTime` | Phase 1 + 2 wall-clock time (ms) |
| `executionTime` | Phase 3 wall-clock time (ms) |
| `numTuples` | Row count in the result |
| `planAsString` | Physical plan as text (if `PROFILE` was requested) |

---

## 7. Prepared Statements

### `Connection::prepare`

```cpp
std::unique_ptr<PreparedStatement> prepare(std::string_view query);
```

Runs only Phases 1 and 2. The resulting `PreparedStatement` caches the parsed AST and
logical plan in `CachedPreparedStatementManager` (keyed by an auto-generated name).

### `Connection::execute` / `executeWithParams`

```cpp
template<typename... Args>
std::unique_ptr<QueryResult> execute(PreparedStatement* ps, std::pair<std::string, Args>... args);

std::unique_ptr<QueryResult> executeWithParams(PreparedStatement* ps,
    std::unordered_map<std::string, std::unique_ptr<Value>> inputParams);
```

At execute time, the client-visible `PreparedStatement` is used to look up the
`CachedPreparedStatement` by name. The plan is **re-bound** (`prepareNoLock` with the cached
`parsedStatement` and the supplied parameters) to pick up any schema changes since the last
prepare, then immediately executed.

This means `execute` always re-plans. There is no "plan once, run many" optimisation today;
the cache is primarily used to re-parse cheaply.

### `prepareWithParams`

```cpp
std::unique_ptr<PreparedStatement> prepareWithParams(
    std::string_view query,
    std::unordered_map<std::string, std::unique_ptr<Value>> inputParams);
```

Used when parameters influence the scan source (e.g., a `$file` parameter in `COPY FROM`).
Parameters are bound early so the planner can inline them into the scan operator.

---

## 8. Transaction Interaction

### `TransactionHelper::runFuncInTransaction`

```cpp
static void runFuncInTransaction(
    TransactionContext& context,
    const std::function<void()>& fun,
    bool readOnlyStatement,
    bool isTransactionStatement,
    TransactionCommitAction action);
```

The `TransactionCommitAction` enum controls post-execution behaviour:

| Value | Meaning |
|-------|---------|
| `COMMIT_IF_NEW` | Commit only if the transaction was started inside this call |
| `COMMIT_IF_AUTO` | Commit only if the transaction is auto-transaction mode |
| `COMMIT_NEW_OR_AUTO` | Commit if either condition holds |
| `NOT_COMMIT` | Never commit (e.g. prepare phase of an explicit transaction) |

Most `query()` calls use `COMMIT_NEW_OR_AUTO`. Explicit transaction statements (`BEGIN`,
`COMMIT`, `ROLLBACK`) use `NOT_COMMIT` (or `COMMIT_IF_NEW` for `COMMIT` itself).

### Auto-transaction vs. explicit transaction

By default, every `query()` that has no open transaction wraps itself in an
*auto-transaction* that commits immediately after execution. An explicit `BEGIN` puts the
`TransactionContext` into manual mode; subsequent queries join the open transaction until
`COMMIT` or `ROLLBACK`.

### `ClientContext` destructor and rollback

```cpp
ClientContext::~ClientContext() {
    if (preventTransactionRollbackOnDestruction) { return; }
    if (Transaction::Get(*this)) {
        getDatabase()->transactionManager->rollback(*this, Transaction::Get(*this));
    }
}
```

If a `Connection` is destroyed while a write transaction is open (e.g. after an unhandled
exception), the destructor rolls back the transaction automatically. When the `Database` is
shutting down it sets `preventTransactionRollbackOnDestruction = true` on all live
`ClientContext`s to avoid a use-after-free of the already-destroyed `TransactionManager`.

---

## 9. Query Interrupt and Timeout

### Interrupt

```cpp
// Connection
void interrupt();  // → clientContext->interrupt()

// ClientContext
void interrupt() { activeQuery.interrupted = true; }
bool interrupted() const { return activeQuery.interrupted; }
```

`Connection::interrupt()` sets a single `std::atomic<bool>`. The executor's inner loops
call `clientContext->interrupted()` at iteration boundaries and throw `InterruptException` if
set.

### Timeout

```cpp
void setQueryTimeOut(uint64_t timeoutInMS);  // 0 = disabled
```

The `ClientContext` stores the timeout in `clientConfig.timeoutInMS`. When non-zero,
`startTimer()` is called at the start of execution and `getTimeoutRemainingInMS()` is polled
by the executor loop. Expiry throws `TimeoutException`.

Both interrupts and timeouts reset via `resetActiveQuery()` at the beginning of each new
`executeNoLock` call.

---

## 10. UDF Registration

### Scalar functions

```cpp
// Connection (template)
template<typename TR, typename... Args>
void createScalarFunction(std::string name, TR (*udfFunc)(Args...));

// Connection (vectorized)
void createVectorizedFunction(std::string name,
    std::vector<LogicalTypeID> parameterTypes, LogicalTypeID returnType,
    scalar_func_exec_t scalarFunc);
```

Both delegate to `ClientContext::addScalarFunction`, which runs:

```cpp
localDatabase->catalog->addFunction(Transaction::Get(*this),
    CatalogEntryType::SCALAR_FUNCTION_ENTRY, name, definitions);
```

inside a transaction that is committed immediately if auto-mode. The function becomes
visible to all future queries on *this connection's catalog view*. Functions added via
one `Connection` are visible to others through the shared `Catalog`.

`removeScalarFunction` drops the catalog entry symmetrically.

---

## 11. Scan Replacements

```cpp
void addScanReplace(function::ScanReplacement scanReplacement);
```

A `ScanReplacement` is a `(lookupFunc, replaceFunc)` pair. When the binder encounters a name
it cannot resolve in the catalog, it calls `tryReplaceByName(name)` on the `ClientContext`.
If any registered replacement matches, it substitutes a virtual scan source (e.g., a
Pandas/Arrow in-memory table).

Python, Node.js and other language wrappers use this mechanism to inject host-language
objects as query sources without importing data into the database.

---

## 12. Multi-Connection Concurrency

The thread safety model is:

```
Database          [shared, not directly locked — all state behind StorageManager/TransactionManager]
  │
  ├── Connection₁ → ClientContext₁  [mtx serialises per-connection calls]
  ├── Connection₂ → ClientContext₂
  └── Connection₃ → ClientContext₃
```

- **Reads** from multiple connections run concurrently; they acquire separate read
  transactions from `TransactionManager` and operate on snapshot-consistent views.
- **Writes** are serialised by the `TransactionManager`'s writer lock unless
  `enableMultiWrites = true`, in which case OCC-style conflict detection is used.
- **Catalog mutations** (DDL, UDF registration) are protected by the catalog's own
  reader-writer lock.

---

## 13. Attached Databases

```cpp
// ClientContext
void setDefaultDatabase(AttachedLbugDatabase* defaultDatabase_);
AttachedLbugDatabase* getAttachedDatabase() const;
```

The `DatabaseManager` (owned by `Database`) tracks attached databases. A `ATTACH 'path'`
statement registers an `AttachedLbugDatabase` object; subsequent cross-db queries route
catalog lookups through it. The `ClientContext` holds a pointer (`remoteDatabase`) to the
currently active attached database; `isInMemory()` always returns `false` for remote databases.

---

## 14. `GraphEntrySet` and Projected Graphs

```cpp
// ClientContext
std::unique_ptr<graph::GraphEntrySet> graphEntrySet;
```

`GraphEntrySet` is a per-session registry of **projected graphs** — named subgraph views used
by GDS algorithms. A projected graph is created with:

```cypher
CALL project_graph('mygraph', ['Person', 'City'], ['LIVES_IN'])
```

This inserts a `ParsedGraphEntry` into the `GraphEntrySet` under `'mygraph'`. GDS function
calls then look up the entry by name to build an `OnDiskGraph` instance:

```cpp
// graph/graph_entry_set.h
class GraphEntrySet {
    void validateGraphNotExist(const std::string& name) const;
    void validateGraphExist(const std::string& name) const;
    bool hasGraph(const std::string& name) const;
    ParsedGraphEntry* getEntry(const std::string& name) const;
    void addGraph(const std::string& name, unique_ptr<ParsedGraphEntry> entry);
    void dropGraph(const std::string& name);
};
```

The `GraphEntrySet` is session-scoped: projected graphs are not persisted and do not survive
`Connection` destruction.

---

## 15. `QueryResultType` and Arrow Integration

`QueryResultType` is an enum on `QueryResult`:

```cpp
enum class QueryResultType { FTABLE = 0, ARROW = 1 };
```

- `FTABLE` → `MaterializedQueryResult` backed by `FactorizedTable`
- `ARROW` → `ArrowQueryResult` backed by Apache Arrow record batches

The caller selects the mode via `Connection::queryAsArrow`:

```cpp
std::unique_ptr<QueryResult> queryAsArrow(std::string_view query, int64_t chunkSize);
```

`getArrowSchema()` always works on both result types (it derives the schema from
`columnTypes`). `getNextArrowChunk(chunkSize)` batches `chunkSize` rows into an `ArrowArray`.

---

## 16. Key Invariants

1. **One active transaction per `ClientContext`.** Multiple parallel writes require multiple
   `Connection`s, each with its own `ClientContext` and transaction.

2. **`mtx` in `ClientContext` is not recursive.** Public API methods must not call other
   public methods internally (they take the lock themselves). Internal `*NoLock` methods
   bypass the lock and must only be called by code that already holds it.

3. **`FlatTuple` is reused.** Callers iterating with `getNext()` must not hold references
   across calls.

4. **`QueryResult` lifetime.** `MaterializedQueryResult` holds a `shared_ptr<FactorizedTable>`
   and can outlive both the `Connection` and the `Database` (the `DatabaseLifeCycleManager`
   shim detects closed databases and throws on access).

5. **Prepare + execute re-plans.** The current `CachedPreparedStatementManager` caches the
   AST + plan for re-binding but the binder and planner always run at execute time.
