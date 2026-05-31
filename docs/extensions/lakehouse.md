# Lakehouse Extensions

This page covers three extensions that connect LadybugDB to open-table-format and lakehouse catalogs:
**Delta Lake**, **Apache Iceberg**, and **Unity Catalog**.

All three are built on top of the **DuckDB Bridge pattern** described in the [External Database Scanners](./external-scanners) page. Each connector spins up an in-process DuckDB instance, installs the corresponding DuckDB community extension, and delegates format-specific I/O to it while exposing the resulting schema and data through Ladybug's catalog and query engine.

---

## Shared Credential Propagation

Because Delta and Iceberg tables are almost always backed by object storage, all three extensions automatically forward S3 and GCS credentials from the Ladybug session into the DuckDB subprocess.

This is handled by `DuckDBConnector::initRemoteFSSecrets(context)`:

```
for each registered S3FileSystemConfig:
    secret = DuckDBSecretManager::getRemoteS3FSSecret(context, fsConfig)
    conn.execute(secret)   // "CREATE SECRET (TYPE S3, KEY …, SECRET …, …)"
```

Credentials are sourced from `db.setExtensionOption('S3_ACCESS_KEY_ID', …)` or the environment variables `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, etc. (see [httpfs extension](./httpfs) for the full option reference).

---

## Delta Extension

**Source:** `extension/delta/src/`  
**Namespace:** `lbug::delta_extension`  
**Registered function:** `DELTA_SCAN`

### Loading sequence

```
DeltaExtension::load(ClientContext*)
  └─ DeltaConnector::connect()
       ├─ duckdb::DuckDB inMemDB
       ├─ conn.execute("INSTALL delta")
       ├─ conn.execute("LOAD delta")
       ├─ conn.execute("INSTALL httpfs")
       ├─ conn.execute("LOAD httpfs")
       └─ initRemoteFSSecrets(context)
```

### Table function

```cypher
CALL DELTA_SCAN('s3://my-bucket/my-delta-table/') RETURN *;
CALL DELTA_SCAN('file:///local/delta/table') RETURN *;
```

**Bind phase:** The connector issues `SELECT * FROM DELTA_SCAN('<path>') LIMIT 1` to DuckDB to discover the schema. The returned column names and types are translated via `DuckDBTypeConverter::convertDuckDBType`.

**Scan phase:** Each `tableFunc` call acquires `DuckDBScanSharedState::mtx` and calls `queryResult->Fetch()` in a loop until all chunks are consumed. Concurrency is serialised through the mutex because DuckDB's result-set iteration is not thread-safe.

### Predicate push-down

Delta tables **do support** predicate push-down via the DuckDB bridge:

```
DeltaScanFunction::supportsPushDownFunc = [] { return true; }
```

Predicates, column pruning, ORDER BY, and LIMIT are all forwarded to the inner `SELECT … FROM DELTA_SCAN(…)` query.

---

## Iceberg Extension

**Source:** `extension/iceberg/src/`  
**Namespace:** `lbug::iceberg_extension`  
**Registered functions:** `ICEBERG_SCAN`, `ICEBERG_METADATA`, `ICEBERG_SNAPSHOTS`

### Loading sequence

```
IcebergExtension::load(ClientContext*)
  ├─ IcebergConnector::connect()
  │    ├─ conn.execute("INSTALL iceberg")
  │    ├─ conn.execute("LOAD iceberg")
  │    ├─ conn.execute("INSTALL httpfs")
  │    ├─ conn.execute("LOAD httpfs")
  │    └─ initRemoteFSSecrets(context)
  └─ DuckdbExtension::loadRemoteFSOptions(context)  // registers S3/GCS options
```

`loadRemoteFSOptions` is called here so that Iceberg users can set S3 credentials via `db.setExtensionOption(…)` even if the DuckDB extension is not explicitly loaded.

### Table functions

#### `ICEBERG_SCAN`

Returns the row data of an Iceberg table.

```cypher
CALL ICEBERG_SCAN('s3://my-bucket/iceberg-table/', allow_moved_paths := true) RETURN *;
```

| Optional parameter | Type | Default | Description |
|---|---|---|---|
| `allow_moved_paths` | BOOL | `false` | Tolerate tables that have been relocated — fixes absolute path references in old metadata |

All other optional parameters are forwarded to DuckDB as `key = 'value'` string options.

**Generated inner query:**
```sql
SELECT * FROM ICEBERG_SCAN('<path>', allow_moved_paths = true)
```

`ICEBERG_SCAN` uses `ExtraScanTableFuncBindInput`, which means it participates in Ladybug's catalog-level predicate push-down path.

#### `ICEBERG_METADATA`

Returns Iceberg metadata as a table.

```cypher
CALL ICEBERG_METADATA('s3://my-bucket/iceberg-table/') RETURN *;
```

No additional options are supported. Delegates to DuckDB's `ICEBERG_METADATA(…)` function.

#### `ICEBERG_SNAPSHOTS`

Returns the snapshot history of an Iceberg table.

```cypher
CALL ICEBERG_SNAPSHOTS('s3://my-bucket/iceberg-table/') RETURN *;
```

No additional options are supported. Delegates to DuckDB's `ICEBERG_SNAPSHOTS(…)` function.

### Implementation notes

- `ICEBERG_METADATA` and `ICEBERG_SNAPSHOTS` reuse `delta_extension::tableFunc` and `delta_extension::initDeltaScanSharedState` — these two functions share Delta's execution path because the scan mechanism is identical.
- Schema bind uses the same `LIMIT 1` trick: the bind function issues `SELECT * FROM ICEBERG_SCAN('<path>'…) LIMIT 1` to introspect column names and types.
- Thread safety: same mutex-per-`queryResult` serialisation as Delta.

### Predicate push-down

`ICEBERG_SCAN` supports push-down (`supportsPushDownFunc = [] { return true; }`). `ICEBERG_METADATA` and `ICEBERG_SNAPSHOTS` do not (they return metadata, not row data).

---

## Unity Catalog Extension

**Source:** `extension/unity_catalog/src/`  
**Namespace:** `lbug::unity_catalog_extension`  
**DB type constant:** `"UC_CATALOG"`  
**Default schema:** `"default"`

Unity Catalog is a governance layer (originally from Databricks) that can sit in front of Delta tables. This extension attaches a Unity Catalog endpoint as a Ladybug storage database, exposing all catalogued tables as if they were local Ladybug tables.

### Options

These options can be set via `db.setExtensionOption(…)` or the matching environment variables before calling `ATTACH`:

| Option name | Type | Default | Env var | Description |
|---|---|---|---|---|
| `uc_token` | STRING | `"not-used"` | `uc_token` | Personal access token for UC authentication |
| `uc_endpoint` | STRING | `"http://127.0.0.1:8080"` | `uc_endpoint` | Unity Catalog server URL |

```cypher
CALL db.setExtensionOption('uc_token', 'my-databricks-pat');
CALL db.setExtensionOption('uc_endpoint', 'https://my.databricks.workspace');
```

### Attaching a Unity Catalog

```cypher
ATTACH '' AS uc (TYPE UC_CATALOG);
```

The path argument is unused — the connector reads the endpoint and token from extension options.

**Attach options:**

| Option key | Type | Default | Description |
|---|---|---|---|
| `SCHEMA` | STRING | `"default"` | Unity Catalog schema to expose |

### Loading sequence

```
UnityCatalogStorageExtension::attach(…)
  └─ UnityCatalogConnector::connect()
       ├─ duckdb::DuckDB inMemDB
       ├─ conn.execute("INSTALL uc_catalog FROM core_nightly")   // nightly channel
       ├─ conn.execute("LOAD uc_catalog")
       ├─ conn.execute("INSTALL delta")                          // ← installed twice (bug)
       ├─ conn.execute("LOAD delta")
       ├─ conn.execute("INSTALL delta")                          // ← duplicate (bug)
       ├─ conn.execute("LOAD delta")
       ├─ conn.execute("CREATE SECRET (TOKEN '…', ENDPOINT '…', TYPE UC)")
       └─ conn.execute("ATTACH '' AS uc (TYPE UC_CATALOG, read_only)")
```

> **Note:** The `delta` extension is installed and loaded twice. This is a copy-paste bug in `unity_catalog_connector.cpp` and is otherwise harmless (the second install is a no-op).

> **Note:** `uc_catalog` is installed from the `core_nightly` channel, not the stable `core` channel. This means the Unity Catalog DuckDB sub-extension version tracks DuckDB nightly builds. Expect occasional breakage when DuckDB nightly ABI changes.

### Catalog and scan

Once connected, `UnityCatalogConnector` reuses `DuckDBCatalog` and `AttachedDuckDBDatabase` exactly as the plain DuckDB extension does. Table discovery, type mapping, predicate push-down, and shadow catalog entries all follow the same code path described in [External Database Scanners — Shared Architecture](./external-scanners#shared-architecture-duckdb-bridge-pattern).

### Registered functions

| Function | Description |
|---|---|
| `CLEAR_ATTACHED_DB_CACHE` (standalone) | Evict attached-database cache |

### Known bugs

1. **Double delta install** (`unity_catalog_connector.cpp`): `INSTALL delta` / `LOAD delta` is called twice in `connect()`. Harmless but wasteful.
2. **`setEnvValue` bug** (`unity_catalog_options.cpp` line 25): `setEnvValue` sets the `uc_token` environment variable for both the token option and (incorrectly) the endpoint option. The endpoint env-var injection therefore sets `uc_token` instead of `uc_endpoint`. This means `uc_endpoint` cannot be propagated via environment variable — only `db.setExtensionOption('uc_endpoint', …)` works.

---

## Credential Wiring: End-to-End Example

```cypher
-- Set S3 credentials in Ladybug (propagated automatically to DuckDB sub-instance)
CALL db.setExtensionOption('S3_ACCESS_KEY_ID',     'AKIAIOSFODNN7EXAMPLE');
CALL db.setExtensionOption('S3_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG');
CALL db.setExtensionOption('S3_REGION',            'us-west-2');

-- Scan a Delta table on S3
CALL DELTA_SCAN('s3://my-bucket/events/') RETURN *;

-- Scan an Iceberg table on S3
CALL ICEBERG_SCAN('s3://my-bucket/orders/', allow_moved_paths := true) RETURN *;

-- Inspect snapshots
CALL ICEBERG_SNAPSHOTS('s3://my-bucket/orders/') RETURN *;
```

All three functions inherit the S3 credentials set above through `initRemoteFSSecrets`.

---

## Comparison Table

| Feature | Delta | Iceberg | Unity Catalog |
|---|---|---|---|
| Format | Delta Lake | Apache Iceberg | Lakehouse catalog (wraps Delta) |
| DuckDB sub-extension | `delta` | `iceberg` | `uc_catalog` (nightly) + `delta` |
| S3 credential propagation | ✓ | ✓ | ✓ |
| Predicate push-down | ✓ | ✓ (SCAN only) | ✓ |
| Metadata function | ✗ | `ICEBERG_METADATA` | ✗ |
| Snapshot history | ✗ | `ICEBERG_SNAPSHOTS` | ✗ |
| ATTACH semantics | table function | table function | storage extension |
| `allow_moved_paths` option | ✗ | ✓ | ✗ |
| Auth option | None (env) | None (env) | `uc_token`, `uc_endpoint` |
