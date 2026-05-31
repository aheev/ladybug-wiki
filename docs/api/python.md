# Python API Reference

The Python API ships as the `ladybug` package and wraps Ladybug's C++ core through either a **pybind11** extension (`_lbug`) or a lighter **C-API shim** (`_lbug_capi`). The `backend="auto"` default selects pybind11 when available and falls back to the C-API shim otherwise. Set the `LBUG_PYTHON_BACKEND` environment variable (`"pybind"` / `"capi"`) to override at runtime.

## Installation

```bash
pip install ladybug
```

## Database

```python
class Database:
    def __init__(
        self,
        database_path: str | Path | None = None,
        *,
        buffer_pool_size: int = 0,
        max_num_threads: int = 0,
        compression: bool = True,
        lazy_init: bool = False,
        read_only: bool = False,
        max_db_size: int | None = None,
        auto_checkpoint: bool = True,
        checkpoint_threshold: int = -1,
        throw_on_wal_replay_failure: bool = True,
        enable_checksums: bool = True,
        enable_multi_writes: bool = False,
        backend: str = "auto",
    )
```

### Constructor Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `database_path` | `str \| Path \| None` | `None` | Path to database directory. `None`, `""`, or `":memory:"` opens an in-memory database. |
| `buffer_pool_size` | `int` | `0` | Buffer pool cap in bytes. `0` means ~80 % of detected system RAM. |
| `max_num_threads` | `int` | `0` | Max worker threads per query. `0` auto-detects from CPU count. |
| `compression` | `bool` | `True` | Enable on-disk column compression. |
| `lazy_init` | `bool` | `False` | Defer opening the underlying store until the first query. Useful when the `Database` is constructed in the main process and queries are later executed in a forked child. |
| `read_only` | `bool` | `False` | Open in read-only mode. Multiple read-only `Database` objects may share the same path; a single read-write instance may not coexist with any other opener. |
| `max_db_size` | `int \| None` | `None` | Upper bound for the memory-mapped region. Workaround for environments that cap `mmap` address space. |
| `auto_checkpoint` | `bool` | `True` | Checkpoint automatically when the WAL exceeds `checkpoint_threshold`. |
| `checkpoint_threshold` | `int` | `-1` | WAL byte threshold for auto-checkpoint. `-1` uses the engine default. |
| `throw_on_wal_replay_failure` | `bool` | `True` | Raise on WAL replay errors at startup instead of silently truncating. |
| `enable_checksums` | `bool` | `True` | Verify checksums on WAL pages. |
| `enable_multi_writes` | `bool` | `False` | Allow concurrent write transactions. |
| `backend` | `str` | `"auto"` | `"auto"`, `"pybind"`, or `"capi"`. |

### Lifecycle

```python
# Context manager (recommended)
with Database("./mydb") as db:
    conn = Connection(db)
    ...

# Explicit
db = Database("./mydb")
db.init_database()   # force-initialize; called automatically on first query
db.close()           # release file lock
db.is_closed         # bool

# In-memory
db = Database()  # same as Database(":memory:")
```

`close()` is **optional** — the GC will close the database when all references are dropped. However, if you need to release the exclusive file lock promptly (e.g., to hand the path to another process), call `close()` explicitly and ensure all `Connection` and `QueryResult` objects are closed first.

### Static helpers

```python
Database.get_version() -> str          # Ladybug library version string
Database.get_storage_version() -> int  # On-disk storage format version
```

### PyTorch Geometric remote backend

```python
feature_store, graph_store = db.get_torch_geometric_remote_backend(num_threads=None)
```

Returns a `(LbugFeatureStore, LbugGraphStore)` pair compatible with `torch_geometric` remote backends. The implementation is **read-only** and uses internal node offsets as IDs — do not delete nodes between backend construction and data loading. Set `filter_per_worker=False` in `NeighborLoader` when `num_workers > 1` because the `Database` object is not fork-safe.

---

## Connection

```python
class Connection:
    def __init__(self, database: Database, num_threads: int = 0)
```

Each `Connection` object owns a C++ connection. Multiple connections to the same `Database` are allowed and each is independently thread-safe on the C++ side; however you must not call the **same** Python `Connection` object from multiple threads concurrently.

### Lifecycle

```python
with Connection(db) as conn:
    ...

conn = Connection(db, num_threads=4)
conn.init_connection()   # re-initialise after pickling
conn.close()
conn.is_closed           # bool
```

### Query execution

```python
# Execute a Cypher string
result: QueryResult = conn.execute("MATCH (n:Person) RETURN n.name")

# Execute with parameters
result = conn.execute(
    "MATCH (n:Person) WHERE n.age > $age RETURN n.name",
    parameters={"age": 25},
)

# Multiple semicolon-separated statements → list[QueryResult]
results: list[QueryResult] = conn.execute(
    "CREATE NODE TABLE T(id INT64, PRIMARY KEY(id)); CREATE (:T {id:1});"
)

# Native Arrow path (pybind backend required)
arrow_result: ArrowQueryResult = conn.query_as_arrow(
    "MATCH (a:Person)-[r]->(b:Person) RETURN a.rowid, r.rowid, b.rowid",
    chunk_size=1_000_000,
)
```

`execute()` always raises `RuntimeError` if the query fails (no silent error codes). When `parameters` is supplied and the backend is the C-API shim, `bytes` / `bytearray` / `memoryview` values are automatically hex-escaped and the query is rewritten to `BLOB($param)`. Python objects such as pandas/polars DataFrames or PyArrow tables may be embedded directly in the query by variable name or passed as parameters.

#### Automatic scan rewriting

When the query string contains `LOAD FROM $x` or `COPY ... FROM $x` and `$x` resolves to a pandas/polars/PyArrow object in the caller's frame, the binding automatically registers the object as an in-memory Arrow scan table and rewrites the query.

### Prepared statements

```python
# Deprecated explicit prepare+execute pattern (still functional)
import warnings
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    ps: PreparedStatement = conn.prepare(
        "MATCH (n:Person) WHERE n.age > $age RETURN n.name"
    )
    result = conn.execute(ps, parameters={"age": 30})

# Preferred: pass query string directly to execute()
result = conn.execute(
    "MATCH (n:Person) WHERE n.age > $age RETURN n.name",
    {"age": 30},
)
```

`PreparedStatement.is_success() -> bool` and `PreparedStatement.get_error_message() -> str` let you inspect compilation errors before execution.

### Thread control

```python
conn.set_max_threads_for_exec(num_threads: int)  # cap per-query parallelism
conn.set_query_timeout(timeout_in_ms: int)        # 0 = no timeout
conn.interrupt()                                  # cancel running query
```

### User-defined functions (UDFs)

```python
from ladybug import Type

def double_it(x: int) -> int:
    return x * 2

conn.create_function(
    name="double_it",
    udf=double_it,
    params_type=[Type.INT64],
    return_type=Type.INT64,
    default_null_handling=True,  # null input → null output
    catch_exceptions=False,      # re-raise Python exceptions
)

conn.remove_function("double_it")
```

`params_type` and `return_type` accept either `Type` enum members or their string values (e.g., `"INT64"`).

### Arrow memory-backed tables

```python
import pandas as pd

df = pd.DataFrame({"name": ["Alice", "Bob"], "age": [25, 30]})

conn.create_arrow_table("persons_tmp", df)
# → registers df as a queryable node table

conn.create_arrow_rel_table(
    table_name="knows_tmp",
    dataframe=edge_df,
    src_table_name="Person",
    dst_table_name="Person",
    layout=ArrowRelTableLayout.FLAT,   # FLAT or CSR
    indptr_dataframe=None,             # required for CSR layout
    dst_col_name="to",
)

conn.drop_arrow_table("persons_tmp")
```

Accepted `dataframe` types: `pandas.DataFrame`, `polars.DataFrame`, `pyarrow.Table`.

---

## QueryResult

```python
class QueryResult:
    # Iteration
    def __iter__(self) -> Iterator[list[Any] | dict[str, Any]]
    def __next__(self) -> list[Any] | dict[str, Any]
    def has_next(self) -> bool
    def get_next(self) -> list[Any] | dict[str, Any]
    def get_all(self) -> list[list[Any] | dict[str, Any]]
    def get_n(self, count: int) -> list[list[Any] | dict[str, Any]]
    def reset_iterator(self) -> None
    def rows_as_dict(self, state: bool = True) -> Self   # fluent dict mode

    # Schema
    def get_column_names(self) -> list[str]
    def get_column_data_types(self) -> list[str]
    def get_schema(self) -> dict[str, str]

    # Bulk export
    def get_as_df(self) -> pandas.DataFrame
    def get_as_pl(self) -> polars.DataFrame
    def get_as_arrow(
        self,
        chunk_size: int | None = None,
        *,
        fallbackExtensionTypes: bool = False,
    ) -> pyarrow.Table

    # Graph integrations
    def get_as_networkx(self, directed: bool = True) -> nx.MultiGraph | nx.MultiDiGraph
    def get_as_torch_geometric(
        self,
    ) -> tuple[geo.Data | geo.HeteroData, dict, dict, dict]

    # Timing
    def get_execution_time(self) -> int   # ms
    def get_compiling_time(self) -> int   # ms
    def get_num_tuples(self) -> int

    # Lifecycle
    def close(self) -> None
    def is_closed: bool
```

### Row format

By default each row is a `list[Any]` aligned with `get_column_names()`. Call `result.rows_as_dict()` to switch to `dict[str, Any]` keyed by column name.

### Bulk export

| Method | Notes |
|--------|-------|
| `get_as_df()` | Calls pybind/capi `getAsDF()`. Materialises the full result. |
| `get_as_pl()` | Uses `get_as_arrow(chunk_size=-1, fallbackExtensionTypes=True)` then `polars.from_arrow`. |
| `get_as_arrow(chunk_size)` | `None` → adaptive (~10 M element chunks); `≤0` → single chunk; `>0` → explicit chunk count. Set `fallbackExtensionTypes=True` for Polars compatibility. |

### ArrowQueryResult (native Arrow path)

```python
class ArrowQueryResult(QueryResult):
    def csr(self) -> CSRResult
    # get_as_arrow() reuses the native chunk size from query_as_arrow()
```

```python
@dataclass(frozen=True)
class CSRResult:
    indptr:   pa.Array
    indices:  pa.Array
    edge_ids: pa.Array | None
```

`csr()` is only valid for results produced by `conn.query_as_arrow(...)` on relationship row-id projections.

### Lifetime

`QueryResult` registers itself with the parent `Connection`. Calling `close()` on the `Connection` closes all live `QueryResult` objects first. The `__del__` finaliser also closes open results; it is safe to let results be collected by the GC.

---

## AsyncConnection

```python
class AsyncConnection:
    def __init__(
        self,
        database: Database,
        max_concurrent_queries: int = 4,
        max_threads_per_query: int = 0,
    )

    async def execute(
        self,
        query: str | PreparedStatement,
        parameters: dict[str, Any] | None = None,
    ) -> QueryResult | list[QueryResult]

    def acquire_connection(self) -> Connection
    def release_connection(self, conn: Connection) -> None
    def set_query_timeout(self, timeout_in_ms: int) -> None
    def close(self) -> None
```

`AsyncConnection` maintains a pool of `max_concurrent_queries` synchronous `Connection` objects backed by a `ThreadPoolExecutor`. Each `execute()` call picks the least-loaded connection and runs it on a thread-pool thread. The async wrapper is **not** built on an async C++ backend; it relies entirely on Python threading.

---

## Type System

### `ladybug.Type` enum

```python
class Type(Enum):
    ANY         = "ANY"
    NODE        = "NODE"
    REL         = "REL"
    RECURSIVE_REL = "RECURSIVE_REL"
    SERIAL      = "SERIAL"
    BOOL        = "BOOL"
    INT64       = "INT64"
    INT32       = "INT32"
    INT16       = "INT16"
    INT8        = "INT8"
    UINT64      = "UINT64"
    UINT32      = "UINT32"
    UINT16      = "UINT16"
    UINT8       = "UINT8"
    INT128      = "INT128"
    DOUBLE      = "DOUBLE"
    FLOAT       = "FLOAT"
    DATE        = "DATE"
    TIMESTAMP   = "TIMESTAMP"
    TIMSTAMP_TZ = "TIMESTAMP_TZ"
    TIMESTAMP_NS= "TIMESTAMP_NS"
    TIMESTAMP_MS= "TIMESTAMP_MS"
    TIMESTAMP_SEC="TIMESTAMP_SEC"
    INTERVAL    = "INTERVAL"
    INTERNAL_ID = "INTERNAL_ID"
    STRING      = "STRING"
    BLOB        = "BLOB"
    UUID        = "UUID"
    LIST        = "LIST"
    ARRAY       = "ARRAY"
    STRUCT      = "STRUCT"
    MAP         = "MAP"
    UNION       = "UNION"
```

### Python ↔ Ladybug type mapping

| Ladybug type | Python value type |
|-------------|-------------------|
| `BOOL` | `bool` |
| `INT8`–`INT128`, `UINT8`–`UINT64`, `SERIAL` | `int` |
| `FLOAT`, `DOUBLE` | `float` |
| `STRING` | `str` |
| `BLOB` | `bytes` |
| `UUID` | `str` (UUID string) |
| `DATE` | `datetime.date` |
| `TIMESTAMP`, `TIMESTAMP_TZ`, `TIMESTAMP_NS`, `TIMESTAMP_MS`, `TIMESTAMP_SEC` | `datetime.datetime` |
| `INTERVAL` | `datetime.timedelta` |
| `LIST`, `ARRAY` | `list` |
| `STRUCT` | `dict[str, Any]` |
| `MAP` | `dict` |
| `UNION` | value of the active branch |
| `NODE` | `dict` with `_id`, `_label`, and property keys |
| `REL` | `dict` with `_src`, `_dst`, `_label`, `_id`, and property keys |
| `RECURSIVE_REL` | `dict` with `_nodes: list` and `_rels: list` |
| `INTERNAL_ID` | `dict` with `"table"` and `"offset"` keys |

### `ArrowRelTableLayout` enum

```python
class ArrowRelTableLayout(Enum):
    FLAT = "FLAT"   # Arrow table with "from"/"to" endpoint columns
    CSR  = "CSR"    # Compressed-Sparse-Row with separate indptr array
```

---

## Error Handling

All errors from the query engine surface as Python `RuntimeError`. There are no special exception subclasses in the Python binding; the message string originates from the C++ exception. Patterns to know:

```python
try:
    result = conn.execute("MATCH (n:Nonexistent) RETURN n")
except RuntimeError as e:
    print(e)  # e.g. "Binder exception: Table Nonexistent does not exist."
```

Errors from a failed `PreparedStatement` do **not** raise at prepare time; they are deferred until `execute()` is called. Check `ps.is_success()` / `ps.get_error_message()` proactively if needed.

---

## Transactions

Ladybug does not expose explicit `BEGIN` / `COMMIT` / `ROLLBACK` APIs in the Python binding. Each query that modifies the graph runs in its own auto-committed write transaction. To execute multiple mutations atomically, wrap them in a single Cypher statement (e.g., using multi-line Cypher with `CREATE` … `MERGE` …) or use the semicolon-separated multi-statement form of `execute()`.

Read-only transactions are started implicitly for read queries and may execute concurrently across multiple connections when `enable_multi_writes=True`.

---

## Thread Safety and Concurrency

| Object | Thread safety |
|--------|--------------|
| `Database` | `Send + Sync` — safe to share across threads |
| `Connection` | The underlying C++ connection is thread-safe; however the **Python wrapper** (`Connection`) must not be called from multiple threads simultaneously. Create one `Connection` per thread. |
| `QueryResult` | Must be consumed from the thread that created it; not shared. |
| `AsyncConnection` | Designed for concurrent use from a single async thread; dispatches work to a `ThreadPoolExecutor`. |

Concurrent **read** queries across multiple `Connection` objects are supported by default. Concurrent **write** queries require `enable_multi_writes=True` on the `Database`. Without it, a second write will fail at runtime.

---

## Advanced Features

### Scan from Python data frames

```python
import pandas as pd
df = pd.DataFrame({"name": ["Alice"], "city": ["Paris"]})

# Inline scan (pybind backend, variable in caller's frame)
result = conn.execute("LOAD FROM df RETURN *")

# Explicit parameter (works with both backends)
result = conn.execute("LOAD FROM $df RETURN *", {"df": df})
```

The C-API shim backend registers the frame via `create_arrow_table()` and rewrites the query automatically.

### Direct node table scan (torch_geometric internal)

`Database._scan_node_table(table_name, prop_name, prop_type, dim, indices, num_threads)` reads a node property directly from storage into a NumPy array, bypassing the query engine. Only types `INT64`, `INT32`, `INT16`, `DOUBLE`, `FLOAT` are supported. This API is used exclusively by the torch_geometric remote backend.

### Version introspection

```python
import ladybug
ladybug.Database.get_version()         # e.g. "0.17.0"
ladybug.Database.get_storage_version() # int, e.g. 35
```
