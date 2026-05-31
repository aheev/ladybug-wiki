# External Database Scanners

This page covers five extensions that connect LadybugDB to external relational and graph databases:
**DuckDB**, **PostgreSQL**, **SQLite**, **ADBC**, and **Neo4j**.

---

## Shared Architecture: DuckDB Bridge Pattern

Four of these five extensions (DuckDB, PostgreSQL, SQLite, ADBC) share the same two-layer architecture:

```
StorageExtension
  └─ attach(dbPath, dbName, options)
       └─ Connector::connect()
            └─ spins up an in-process DuckDB instance
                 └─ DuckDB attach/install native driver
                      └─ DuckDBCatalog::init()
                           ├─ queries information_schema.tables
                           └─ creates ShadowTag NodeTableCatalogEntry
                                in main Ladybug catalog
```

The in-process DuckDB instance acts as a translation layer: it provides an off-the-shelf SQL dialect, type system, and native C++ driver while Ladybug maps the DuckDB schema into its own catalog and pushes queries through DuckDB at scan time.

### `DuckDBConnector` base class

All four connectors extend `DuckDBConnector` (`extension/duckdb/src/connector/duckdb_connector.h`):

```cpp
class DuckDBConnector {
    duckdb::DuckDB    db;         // the in-process DuckDB instance
    duckdb::Connection conn;      // persistent connection
    duckdb::Connection queryConn; // second connection used for scan queries
    std::string       catalogName;
    AttachedDuckDBDatabase attachedDB;

    void initRemoteFSSecrets(main::ClientContext* context);
};
```

`initRemoteFSSecrets` iterates over every registered `S3FileSystemConfig` in the Ladybug context and executes a matching `CREATE SECRET` statement inside the in-process DuckDB, propagating cloud credentials automatically.

### `DuckDBCatalog::init()`

Once the connector is up, `DuckDBCatalog::init()` discovers tables:

1. Executes `SELECT table_name, schema_name FROM information_schema.tables WHERE schema_name = '<schemaName>'`.
2. For each table creates a `DuckDBTableCatalogEntry` in the attached DuckDB catalog.
3. Also creates a mirrored `NodeTableCatalogEntry` (with `ShadowTag`) in Ladybug's main catalog. This enables Ladybug's catalog-level features (property graphs, joins) to see the foreign table.
4. The **first** column discovered becomes the primary key of the shadow entry.

Schema binding (`bindSchemaName`) checks the `SCHEMA` attach option first; falls back to the extension's `DEFAULT_SCHEMA_NAME` constant.

### `DuckDBScanBindData::getSQL()`

The scan function performs full predicate and projection push-down into the in-process DuckDB:

```sql
SELECT "col_a", "col_c"               -- column pruning
FROM   "<catalog>"."<schema>"."<table>"
WHERE  col_a > 42 AND col_c = 'foo'   -- predicates from Ladybug planner
ORDER BY col_a                         -- ORDER BY push-down
LIMIT  100                             -- LIMIT push-down
```

`supportsPushDownFunc = [] { return true; }` signals to the Ladybug planner that predicates can be forwarded.

### Type mapping

`DuckDBTypeConverter::convertDuckDBType` translates DuckDB column types to Ladybug logical types:

| DuckDB type string | Ladybug type |
|---|---|
| `BIGINT`, `INT8`, `LONG` | `INT64` |
| `BOOLEAN`, `BOOL`, `LOGICAL` | `BOOL` |
| `BLOB`, `BYTEA`, `BINARY`, `VARBINARY` | `BLOB` |
| `DATE` | `DATE` |
| `DOUBLE`, `FLOAT8` | `DOUBLE` |
| `HUGEINT` | `INT128` |
| `INTEGER`, `INT4`, `INT`, `SIGNED` | `INT32` |
| `INTERVAL` | `INTERVAL` |
| `REAL`, `FLOAT`, `FLOAT4` | `FLOAT` |
| `SMALLINT`, `INT2`, `SHORT` | `INT16` |
| `TIMESTAMP`, `DATETIME` | `TIMESTAMP` |
| `TIMESTAMP_NS` | `TIMESTAMP_NS` |
| `TIMESTAMP_MS` | `TIMESTAMP_MS` |
| `TIMESTAMP_S` | `TIMESTAMP_SEC` |
| `TIMESTAMP WITH TIME ZONE`, `TIMESTAMPTZ` | `TIMESTAMP_TZ` |
| `TINYINT`, `INT1` | `INT8` |
| `UBIGINT` | `UINT64` |
| `UINTEGER` | `UINT32` |
| `USMALLINT` | `UINT16` |
| `UTINYINT` | `UINT8` |
| `UUID` | `UUID` |
| `VARCHAR`, `CHAR`, `BPCHAR`, `TEXT`, `STRING` | `STRING` |
| `DECIMAL(w,s)` | `DECIMAL(w,s)` |
| `<type>[]` | `LIST(<type>)` |
| `<type>[N]` | `ARRAY(<type>, N)` |
| `STRUCT(…)` | `STRUCT(…)` |
| `UNION(…)` | `UNION(…)` |
| `MAP(k,v)` | `MAP(k,v)` |
| anything else | throws `BinderException{"Unsupported duckdb type: …"}` |

---

## DuckDB Extension

**Source:** `extension/duckdb/src/`  
**Namespace:** `lbug::duckdb_extension`  
**DB type constant:** `"DUCKDB"`  
**Default schema:** `"main"`

### Attaching a DuckDB database

```cypher
ATTACH 'path/to/file.duckdb' AS mydb (TYPE DUCKDB);
ATTACH 'path/to/file.duckdb' AS mydb (TYPE DUCKDB, SCHEMA 'analytics', SKIP_UNSUPPORTED_TABLE TRUE);
```

**Attach options:**

| Option key | Type | Default | Description |
|---|---|---|---|
| `SCHEMA` | STRING | `"main"` | DuckDB schema to expose |
| `SKIP_UNSUPPORTED_TABLE` | BOOL | `false` | Skip tables with unmappable column types instead of throwing |

### Query pushdown example

Ladybug's planner emits a physical scan with predicates, projections, ORDER BY, and LIMIT. `DuckDBScanBindData::getSQL()` assembles and executes one single SQL string against the in-process DuckDB; all of these are pushed through without row-by-row iteration in Ladybug.

### Remote filesystem options

`DuckdbExtension::loadRemoteFSOptions(context)` registers all S3 and GCS auth options as extension options in the Ladybug database. This function is also called by the Iceberg and Delta extensions so those connectors inherit S3/GCS auth from a single place.

### Registered functions

| Function | Description |
|---|---|
| `CLEAR_ATTACHED_DB_CACHE` (standalone) | Evicts the attached-database object cache |

### Thread safety

`DuckDBScanSharedState::mtx` wraps every call to `queryResult->Fetch()`. DuckDB's result-set iteration is not thread-safe, so Ladybug serialises all fetch calls through this mutex even when the query itself ran in parallel.

---

## PostgreSQL Extension

**Source:** `extension/postgres/src/`  
**Namespace:** `lbug::postgres_extension`  
**DB type constant:** `"POSTGRES"`  
**Default schema:** `"public"`

### Attaching a PostgreSQL database

```cypher
ATTACH 'host=localhost dbname=mydb user=alice password=secret' AS pg (TYPE POSTGRES);
ATTACH 'host=localhost dbname=mydb user=alice password=secret' AS pg
    (TYPE POSTGRES, SCHEMA 'reporting', SKIP_UNSUPPORTED_TABLE TRUE);
```

**Attach options:**

| Option key | Type | Default | Description |
|---|---|---|---|
| `SCHEMA` | STRING | `"public"` | PostgreSQL schema to expose |
| `SKIP_UNSUPPORTED_TABLE` | BOOL | `false` | Skip tables with unmappable column types |

### Catalog name resolution

The catalog name defaults to what the user supplies as `dbName` in `ATTACH`. If the user leaves `dbName` empty, the connector extracts it from the connection string with:

```cpp
std::regex dbNameRegex{"dbname=([^ ]+)"};
```

The connector then issues `ATTACH '<connStr>' AS <dbName> (TYPE postgres, SCHEMA <schema>, read_only)` inside the in-process DuckDB.

### SQL query function

```cypher
CALL sql_query('pg', 'SELECT id, name FROM users WHERE active = true') RETURN *;
```

`SqlQueryFunction` takes two STRING arguments: the attached database name and a raw SQL query string. The query is forwarded verbatim to DuckDB via:

```sql
SELECT {columns} FROM postgres_query(<catalog>, '<query>')
```

Single quotes inside `<query>` are escaped by doubling (`'` → `''`). Column pushdown is applied (`getColumnIndicesToSelect`), so only requested columns are returned.

### Registered functions

| Function | Description |
|---|---|
| `SQL_QUERY(dbName, query)` | Execute arbitrary SQL against the attached Postgres DB |
| `CLEAR_ATTACHED_DB_CACHE` (standalone) | Evict attached-database cache |

---

## SQLite Extension

**Source:** `extension/sqlite/src/`  
**Namespace:** `lbug::sqlite_extension`  
**DB type constant:** `"SQLITE"`  
**Default schema:** `""` (empty — SQLite has no schema concept)

### Attaching a SQLite database

```cypher
ATTACH 'path/to/mydb.sqlite' AS mydb (TYPE SQLITE);
ATTACH 'path/to/mydb.sqlite' AS mydb (TYPE SQLITE, SQLITE_ALL_VARCHAR TRUE);
```

**Attach options:**

| Option key | Type | Default | Description |
|---|---|---|---|
| `SQLITE_ALL_VARCHAR` | BOOL | `false` | Override all column types to STRING |

The `SQLITE_ALL_VARCHAR` option is prepended as `set sqlite_all_varchar=<bool>;` before the template scan query inside the in-process DuckDB.

### Catalog name

The catalog name is derived from the file stem: `mydb.sqlite` → `mydb`. This is computed with `std::filesystem::path::stem()`.

### Connection details

```cpp
DuckDB inMemDB;
inMemDB.loadExtension("sqlite");
inMemDB.execute("ATTACH '<path>' AS <name> (TYPE sqlite, read_only)");
```

No `SCHEMA` parameter is passed since SQLite does not have named schemas.

### Registered functions

| Function | Description |
|---|---|
| `CLEAR_ATTACHED_DB_CACHE` (standalone) | Evict attached-database cache |

---

## ADBC Extension

**Source:** `extension/adbc/src/`  
**Namespace:** `lbug::adbc_extension`  
**DB type constant:** `"ADBC"`  
**Default schema:** `"main"`

The ADBC (Arrow Database Connectivity) extension lets Ladybug attach any database that exposes an [ADBC driver](https://arrow.apache.org/adbc/) and read it through the Arrow C Data Interface.

### Attaching an ADBC database

```cypher
ATTACH 'path/or/uri' AS mydb (TYPE ADBC, DRIVER 'libduckdb.so', TABLES 'orders,customers');
ATTACH 'postgresql://localhost/mydb' AS mydb
    (TYPE ADBC, DRIVER 'libadbc_driver_postgresql.so', TABLES 'orders', SCHEMA 'reporting');
```

**Attach options:**

| Option key | Type | Required | Description |
|---|---|---|---|
| `DRIVER` | STRING | ✓ | Path or name of the ADBC driver `.so`/`.dll` |
| `TABLES` | STRING | ✓ | Comma-separated list of table names to expose |
| `SCHEMA` | STRING | ✗ | Schema to use (default `"main"`) |

All other options in the `ATTACH` clause are forwarded directly to `AdbcDatabaseSetOption`. This allows passing driver-specific parameters (e.g. `username`, `password`, `timeout`).

### URI vs. path routing

Before calling `AdbcDatabaseSetOption`, the connector inspects the path:

- If the path contains `://` or starts with `file:` → option key is `"uri"`.
- Otherwise → option key is `"path"`.

### Connection lifecycle

```
ADBCConnector::connect()
  ├─ AdbcDriverManagerDatabaseInit     (load_flags = ADBC_LOAD_FLAG_DEFAULT)
  ├─ AdbcDatabaseSetOption(DRIVER=…)
  ├─ AdbcDatabaseSetOption(all other options)
  ├─ AdbcDatabaseInit
  ├─ AdbcConnectionInit (shared conn for schema discovery)
  └─ for each executeQuery call:
       ├─ AdbcConnectionInit  (new connection per query — avoids driver state issues)
       ├─ AdbcStatementNew
       ├─ AdbcStatementSetSqlQuery
       ├─ AdbcStatementExecuteQuery  → ArrowArrayStream
       └─ full stream consumption    → result->arrays (eagerly materialised)
```

A new `AdbcConnection` is opened for every `executeQuery` call. This is intentional: some ADBC drivers do not support concurrent statement execution on a shared connection.

### Schema discovery

Schema is retrieved via `AdbcConnectionGetTableSchema`, which returns an `ArrowSchema` struct (Arrow C Data Interface). Ladybug's `ArrowConverter::fromArrowSchema` translates Arrow format strings to Ladybug logical types.

Schema is cached per table name in `ADBCConnector::schemaCache` under `schemaLock` (mutex-protected).

### Column naming

If an Arrow schema field name is null, the column is named `"column<i>"` where `i` is its zero-based index.

### SQL generation

No predicate push-down: `ADBCScanFunction::supportsPushDownFunc = [] { return false; }`.

Generated query:
```sql
SELECT "col1", "col2" FROM "table"
```

All identifiers are double-quoted to avoid reserved-word conflicts.

### Result materialisation

Arrow array streams are **fully consumed** before returning to the Ladybug operator:

```cpp
while (stream.get_next(&array) == 0 && array.length > 0) {
    result->arrays.push_back(std::move(array));
}
```

There is no lazy streaming; all rows are held in memory until the scan operator consumes them.

---

## Neo4j Extension

**Source:** `extension/neo4j/src/`  
**Namespace:** `lbug::neo4j_extension`  
**Registered function:** `NEO4J_MIGRATE`

This extension is **migration-only**: it reads data from a live Neo4j instance via the HTTP Transactional API and returns DDL + COPY strings that the user must execute in Ladybug to create the equivalent graph. It does **not** provide ongoing ATTACH / live-query capability.

### Function signature

```cypher
CALL NEO4J_MIGRATE(
    url       := 'http://localhost:7474',
    userName  := 'neo4j',
    password  := 'neo4j',
    nodes     := ['Person', 'Movie'],     -- or ['*'] for all
    rels      := ['ACTED_IN', 'DIRECTED'] -- or ['*'] for all
) RETURN *;
```

| Parameter | Type | Description |
|---|---|---|
| `url` | STRING | Neo4j HTTP endpoint (e.g. `http://host:7474`) |
| `userName` | STRING | HTTP Basic Auth username |
| `password` | STRING | HTTP Basic Auth password (confidential at runtime) |
| `nodes` | LIST[STRING] | Node labels to import, or `['*']` for all labels |
| `rels` | LIST[STRING] | Relationship type names to import, or `['*']` for all |

`*` wildcard imports all labels / relationship types. It cannot be combined with other names.

### Data flow

```
bindFunc
  ├─ httplib::Client(url, timeout=1000s, read_timeout=1000s)
  ├─ POST /db/neo4j/tx/commit  {"statements": [{"statement": "db.schema.nodeTypeProperties()"}]}
  │    → discover node property schemas
  ├─ POST /db/neo4j/tx/commit  {"statements": [{"statement": "db.schema.relTypeProperties()"}]}
  │    → discover relationship property schemas
  ├─ APOC export: apoc.export.csv.data(nodes, [], '/tmp/<NodeLabel>.csv', {})
  │    → write CSVs for each node label
  ├─ APOC export: apoc.export.csv.data([], rels, '/tmp/<Src>_<Rel>_<Dst>.csv', {})
  │    → write CSVs for each relationship type
  └─ returns DDL + COPY strings

```

> **Requirement:** The Neo4j instance must have the [APOC library](https://neo4j.com/labs/apoc/) installed — node and relationship data is exported to `/tmp/` via APOC's CSV export procedure.

### Generated DDL

**Node tables:**
```cypher
CREATE NODE TABLE `Person` (
    `_id_` INT64,
    `name` STRING,
    `born` INT64,
    PRIMARY KEY(_id_)
);
COPY `Person` FROM '/tmp/Person.csv' (HEADER=TRUE);
```

**Relationship tables:**
```cypher
CREATE REL TABLE `ACTED_IN` (
    FROM Person TO Movie,
    `roles` LIST(STRING)
);
COPY `ACTED_IN` FROM '/tmp/Person_ACTED_IN_Movie.csv' (HEADER=TRUE);
```

- Node primary key is always `_id_` (INT64 — the internal Neo4j node ID).
- Relationship tables support multiple `FROM … TO …` pairs when the same relationship type connects different label pairs.

### Type mapping

| Neo4j type | Ladybug type |
|---|---|
| `Long` | `INT64` |
| `Integer` | `INT32` |
| `Date` | `DATE` |
| `DateTime` | `TIMESTAMP` |
| `Boolean` | `BOOL` |
| `Double` | `DOUBLE` |
| `Float` | `FLOAT` |
| `LongArray` | `LIST(INT64)` |
| `DoubleArray` | `LIST(DOUBLE)` |
| `StringArray` | `LIST(STRING)` |
| all others (String, etc.) | `STRING` |

When a single property has multiple observed Neo4j types (e.g. both `Long` and `String`), `LogicalTypeUtils::combineTypes()` resolves to a common supertype.

### Constraints and limitations

1. **Multi-label nodes are not supported.** If a node has more than one label, the migration throws `RuntimeException`.
2. **APOC required.** Export uses `apoc.export.csv.data`. Without APOC the export step fails.
3. **Export destination is `/tmp/`.** CSV files are written to `/tmp/<name>.csv` on the Neo4j host. Ladybug must be able to read those paths or the COPY statements must be adjusted.
4. **All relationship endpoints must be in `nodes` list.** If a relationship connects a label not present in `nodes`, the bind function throws.
5. **No incremental / streaming.** The entire graph is snapshotted and exported in one call.
