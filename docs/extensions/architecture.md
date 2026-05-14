# Extension Architecture

**Source files:** `src/extension/extension.cpp`, `src/include/extension/extension.h`, `src/main/database.cpp`

## What is an Extension?

Extensions add optional functionality to LadybugDB at runtime without recompiling the core database. Examples:

| Extension | What it adds |
|-----------|--------------|
| `httpfs` | Read/write files from HTTP, S3, Azure Blob |
| `json` | JSON parsing/manipulation functions |
| `icebug-disk` | Parquet-backed read-only graph storage |
| `full-text-search` | Full-text index operator |
| `python-udf` | Python user-defined functions |

## Loading Mechanism

### Dynamic Loading (default)

```cypher
LOAD EXTENSION 'httpfs';
```

This triggers:

```cpp
// extension.cpp
void Extension::load(const string& name, DatabaseInstance& db) {
    // 1. Locate the shared library
    auto path = findExtensionPath(name);  // e.g., ~/.lbug/extensions/httpfs.so

    // 2. dlopen() the shared library
    void* handle = dlopen(path.c_str(), RTLD_LAZY | RTLD_LOCAL);
    if (!handle) {
        throw ExtensionException("Failed to load: " + string(dlerror()));
    }

    // 3. Look up the registration entrypoint
    auto initFunc = (ExtensionInitFunc) dlsym(handle, "init_extension");
    if (!initFunc) {
        dlclose(handle);
        throw ExtensionException("Extension missing init_extension() entrypoint");
    }

    // 4. Call the entrypoint to register everything
    initFunc(db);

    // 5. Record in WAL (so extension is reloaded on crash recovery)
    db.getWAL().appendRecord(LoadExtensionRecord{name, path});
}
```

### Static Linking (WASM / embedded)

Some platforms (WASM, iOS) prohibit `dlopen()`. Extensions can be statically linked:

```cpp
// database.cpp (WASM build)
void Database::loadDefaultExtensions() {
    // Statically linked extensions registered at startup
    HttpfsExtension::init(*this);
    JsonExtension::init(*this);
}
```

The extension's `init_extension()` function is compiled in directly.

## Extension Registration API

An extension's `init_extension()` function receives a `DatabaseInstance&` and registers its contributions:

```cpp
// httpfs extension example
extern "C" void init_extension(lbug::DatabaseInstance& db) {
    // Register scalar functions
    db.getFunctionCatalog().addScalarFunction("http_get", HttpGetFunction{});
    db.getFunctionCatalog().addScalarFunction("s3_scan", S3ScanFunction{});

    // Register table functions (callable as CALL s3_list(...))
    db.getTableFunctionCatalog().add("s3_list", S3ListTableFunction{});

    // Register file system implementation
    db.getVFS().registerFS(make_unique<S3FileSystem>());

    // Register custom scan source type
    db.getScanSourceRegistry().register("s3", S3ScanSource::create);

    // Register custom options / settings
    db.getConfigManager().addOption("s3_region", ConfigOption::STRING, "us-east-1");
}
```

## Registration Hooks

| Hook | Description |
|------|-------------|
| `FunctionCatalog::addScalarFunction` | Adds a scalar function callable in Cypher expressions |
| `AggregateFunctionCatalog::add` | Adds an aggregate function (count, sum, ...) |
| `TableFunctionCatalog::add` | Adds a table-returning function (for `CALL ...`) |
| `VFS::registerFS` | Adds a virtual file system (S3, HTTP, Azure) |
| `ScanSourceRegistry::register` | Adds a new table scan source type |
| `TypeCatalog::add` | Adds a custom data type |
| `CopyFunctionCatalog::add` | Adds a `COPY FROM`/`COPY TO` file format handler |

## WAL & Recovery

When an extension is loaded, a `LOAD_EXTENSION_RECORD` is appended to the WAL:

```cpp
struct LoadExtensionRecord {
    WALRecordType type = WALRecordType::LOAD_EXTENSION_RECORD;
    string name;
    string path;  // resolved path at load time
};
```

On crash recovery, the WAL is replayed and the extension is re-loaded before any data records are applied. This ensures the extension's type system and function catalog are available before the data they operate on is accessed.

## Extension Catalog Persistence

Extensions that register types or modify the schema write a catalog entry:

```cpp
// catalog.cpp
CatalogEntry* Catalog::createExtensionEntry(const string& extName, ...) {
    auto entry = make_unique<ExtensionCatalogEntry>(extName);
    entries[extName] = move(entry);
    // WAL CATALOG_ENTRY record written by the transaction
    return entries[extName].get();
}
```

On startup, the catalog is loaded from the data file, and the extensions listed there are auto-loaded to restore their registrations.

## Custom Table Functions

Extensions can add **table-producing functions** callable with `CALL`:

```cpp
struct TableFunction {
    string name;
    // Called once to produce the first DataChunk of output:
    using ScanFunc = function<void(ClientContext&, TableFunctionInput&, DataChunk&)>;
    ScanFunc scanFunc;
    // Called to initialize per-query state:
    using InitFunc = function<unique_ptr<TableFunctionInitData>(ClientContext&, const TableFunctionBindInput&)>;
    InitFunc initFunc;
};

// Usage in Cypher:
// CALL db_tables() RETURN name, type
```

## Related Files

- `src/extension/extension.cpp` — dlopen(), registration
- `src/include/extension/extension.h` — Extension base class, registration hooks
- `src/main/database.cpp` — extension loading, WASM static init
- `src/catalog/catalog.cpp` — extension catalog entries
- `src/storage/wal/record/load_extension_record.h` — WAL record type
