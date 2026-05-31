# Extension Architecture

**Source files:**
- `src/extension/extension.cpp` — platform detection, URL parsing, `ExtensionLibLoader`
- `src/extension/extension_manager.cpp` — `ExtensionManager` lifecycle
- `src/extension/extension_installer.cpp` — HTTP download, dependency install
- `src/extension/extension_entries.cpp` — official extension catalog lookup table
- `src/extension/loaded_extension.cpp` — `LoadedExtension` serialisation to Cypher
- `src/extension/catalog_extension.cpp` — `CatalogExtension` cache invalidation

---

## What is an Extension?

Extensions add optional functionality to LadybugDB at runtime without recompiling the core
database. The engine ships with a fixed set of built-in functions (see the Functions pages) but
everything else — file-system drivers, graph-algorithm suites, vector index management,
full-text search, JSON manipulation, LLM embeddings, and foreign-database bridges — lives in
extensions that are loaded on demand.

### Official Extensions

These extensions are recognised by name in `extension_entries.cpp` and can be installed directly
from the official repository without a path:

| Extension | Registered functions |
|-----------|----------------------|
| `FTS` | `STEM`, `QUERY_FTS_INDEX`, `CREATE_FTS_INDEX`, `DROP_FTS_INDEX` |
| `JSON` | `TO_JSON`, `JSON_QUOTE`, `ARRAY_TO_JSON`, `ROW_TO_JSON`, `CAST_TO_JSON`, `JSON_ARRAY`, `JSON_OBJECT`, `JSON_MERGE_PATCH`, `COPY_JSON`, `JSON_EXTRACT`, `JSON_ARRAY_LENGTH`, `JSON_CONTAINS`, `JSON_KEYS`, `JSON_STRUCTURE`, `JSON_TYPE`, `JSON_VALID`, `JSON` |
| `DUCKDB` | `CLEAR_ATTACHED_DB_CACHE` |
| `DELTA` | `DELTA_SCAN` |
| `ICEBERG` | `ICEBERG_SCAN`, `ICEBERG_METADATA`, `ICEBERG_SNAPSHOTS` |
| `AZURE` | `AZURE_SCAN` |
| `VECTOR` | `QUERY_VECTOR_INDEX`, `CREATE_VECTOR_INDEX`, `DROP_VECTOR_INDEX` |
| `LLM` | `CREATE_EMBEDDING` |
| `NEO4J` | `NEO4J_MIGRATE` |
| `ALGO` | `K_CORE_DECOMPOSITION`, `PAGE_RANK`, `STRONGLY_CONNECTED_COMPONENTS`, `STRONGLY_CONNECTED_COMPONENTS_KOSARAJU`, `WEAKLY_CONNECTED_COMPONENTS` |

In addition the `JSON` extension registers the `JSON` logical type.

User-supplied extensions loaded via a file path have `ExtensionSource::USER`; extensions compiled
directly into the binary have `ExtensionSource::STATIC_LINKED`.

---

## Loading Pipeline

### 1 — Install

```cypher
INSTALL json;
```

Installation is handled by `ExtensionInstaller` (`src/extension/extension_installer.cpp`).

```
ExtensionInstaller::install()
  └─ installExtension()                    // download the .so / .dylib / .dll
       ├─ resolve local directory          // <extensionDir>/<name>/
       ├─ check if already present         // skip if !forceInstall
       ├─ build ExtensionRepoInfo          // URL = EXTENSION_FILE_REPO_PATH template
       └─ tryDownloadExtensionFile()       // httplib GET, write to local path
  └─ installDependencies()
       ├─ probe for installer shared lib   // <name>_installer suffix
       ├─ tryDownloadExtensionFile()       // downloads installer .so
       └─ dlopen installer + call install  // (*install)(repo, context)
```

The download URL is assembled from:
```
EXTENSION_FILE_REPO_PATH.format(repo, LBUG_EXTENSION_VERSION, platform, name, filename)
```
where `platform` is e.g. `linux_amd64`, `osx_arm64`, `win_amd64`.

HTTP requests carry a `User-Agent: lbug/v<version>` header. The installer respects standard
proxy environment variables:

| Variable | Purpose |
|----------|---------|
| `LADYBUG_HTTPS_PROXY` / `https_proxy` / `HTTPS_PROXY` | Proxy for HTTPS requests |
| `LADYBUG_HTTP_PROXY` / `http_proxy` / `HTTP_PROXY` | Proxy for HTTP requests |
| `LADYBUG_ALL_PROXY` / `all_proxy` / `ALL_PROXY` | Fallback proxy for all requests |
| `LADYBUG_NO_PROXY` / `no_proxy` / `NO_PROXY` | Comma-separated no-proxy list |

The no-proxy list supports wildcards (`*`), domain suffix matching (`.example.com`), and exact
host matching.

### 2 — Load

```cypher
LOAD EXTENSION json;     -- official: resolved to local lib path
LOAD EXTENSION '/path/to/myext.so';   -- user extension
```

`ExtensionManager::loadExtension()` orchestrates the load:

```
ExtensionManager::loadExtension(path, context)
  ├─ if official extension:
  │    ├─ ensure local shared-lib directory exists
  │    └─ executeExtensionLoader()          // optional pre-load shim
  │         └─ dlopen <name>_loader.so
  │              └─ (*load)(context)        // ext_load_func_t
  ├─ ExtensionLibLoader(name, fullPath)
  │    └─ dlopen(path, RTLD_NOW | RTLD_LOCAL)
  ├─ getNameFunc()  → (*name)()            // ext_name_func_t → string
  ├─ check duplicate (already in loadedExtensions)
  ├─ getInitFunc()  → (*init)(context)     // ext_init_func_t
  ├─ push LoadedExtension(name, path, source)
  └─ if transaction should log to WAL:
       └─ localWAL.logLoadExtension(path)
```

The `RTLD_NOW` flag resolves all symbols immediately, giving a clear error at load time rather
than at first call. `RTLD_LOCAL` prevents the extension's symbols from polluting the global
namespace, allowing multiple extensions with internal helpers of the same name.

### 3 — Name lookup (`extension_entries.cpp`)

Before the binder raises a "function not found" error it calls:

```cpp
ExtensionManager::lookupExtensionsByFunctionName(functionName)
ExtensionManager::lookupExtensionsByTypeName(typeName)
```

Both functions upper-case the incoming name and do a linear scan through the compile-time
`functionsForExtensions` / `typesForExtensions` arrays. When a match is found, the engine
surfaces a "did you mean to INSTALL and LOAD extension X?" hint to the user rather than a bare
not-found error.

---

## `ExtensionLibLoader` — Shared Library Abstraction

```cpp
// src/extension/extension.cpp
struct ExtensionLibLoader {
    ExtensionLibLoader(const std::string& extensionName, const std::string& path);

    ext_load_func_t  getLoadFunc();     // symbol: EXTENSION_LOAD_FUNC_NAME
    ext_init_func_t  getInitFunc();     // symbol: EXTENSION_INIT_FUNC_NAME
    ext_name_func_t  getNameFunc();     // symbol: EXTENSION_NAME_FUNC_NAME
    ext_install_func_t getInstallFunc();// symbol: EXTENSION_INSTALL_FUNC_NAME

    void unload();   // dlclose()

private:
    void* getDynamicLibFunc(const std::string& funcName);
    void* libHdl;
    std::string extensionName;
};
```

On Windows the POSIX `dlopen` / `dlsym` / `dlclose` API is emulated using
`LoadLibraryW` / `GetProcAddress` / `FreeLibrary`. Unicode paths are handled by converting
the UTF-8 path to wide-string via `MultiByteToWideChar`.

Every extension shared library must export exactly four C-linkage functions:

| Symbol constant | Signature | Purpose |
|----------------|-----------|---------|
| `EXTENSION_NAME_FUNC_NAME` | `const char*()` | Return the canonical extension name |
| `EXTENSION_INIT_FUNC_NAME` | `void(ClientContext*)` | Register all functions, types, and storage extensions |
| `EXTENSION_LOAD_FUNC_NAME` | `void(ClientContext*)` | Optional pre-load hook (loader shim) |
| `EXTENSION_INSTALL_FUNC_NAME` | `void(const char* repo, ClientContext&)` | Optional dependency installer |

---

## `ExtensionManager`

`ExtensionManager` is owned by the `Database` and accessed via
`ExtensionManager::Get(clientContext)`.

```cpp
class ExtensionManager {
public:
    // Load a shared library and call its init function
    void loadExtension(const std::string& path, main::ClientContext* context);

    // Auto-load all statically linked extensions on startup
    void autoLoadLinkedExtensions(main::ClientContext* context);

    // Extension option management (used by extensions to declare config keys)
    void addExtensionOption(std::string name, common::LogicalTypeID type,
                            common::Value defaultValue, bool isConfidential);
    const main::ExtensionOption* getExtensionOption(std::string name) const;

    // Storage extension registration (e.g., for custom scan sources)
    void registerStorageExtension(std::string name,
                                  std::unique_ptr<storage::StorageExtension>);
    std::vector<storage::StorageExtension*> getStorageExtensions();

    // Binder hint helpers
    std::optional<ExtensionEntry> lookupExtensionsByFunctionName(std::string_view);
    std::optional<ExtensionEntry> lookupExtensionsByTypeName(std::string_view);

    // Serialise all loaded extensions to Cypher INSTALL/LOAD statements
    std::string toCypher();

private:
    std::vector<LoadedExtension> loadedExtensions;
    std::unordered_map<std::string, main::ExtensionOption> extensionOptions;
    std::unordered_map<std::string, std::unique_ptr<storage::StorageExtension>> storageExtensions;
};
```

### Deduplication

`loadExtension` checks `loadedExtensions` by name before calling `init`. If the extension is
already loaded, `unload()` is called on the transient loader handle and the function returns
immediately. This prevents double-registration of functions.

### WAL Logging

If the current transaction has WAL logging enabled
(`transaction->shouldLogToWAL()`), the path is written to the local WAL via
`transaction->getLocalWAL().logLoadExtension(path)`. On crash recovery, the engine replays this
record to re-load the extension before applying any data WAL records.

### Auto-Load on Startup

`autoLoadLinkedExtensions` wraps the load loop in a recovery transaction so that
statically-linked extensions can perform catalog mutations during startup without going through
the normal transaction lifecycle.

---

## Extension Options

Extensions can declare named configuration options visible to `CURRENT_SETTING()`:

```cpp
// Called inside the extension's init function
extensionManager.addExtensionOption(
    "s3_region",            // option name (lowercased internally)
    LogicalTypeID::STRING,  // value type
    Value{"us-east-1"},     // default
    false                   // isConfidential (hides value in SHOW_LOADED_EXTENSIONS)
);
```

Options are stored in an `unordered_map<std::string, ExtensionOption>`. Duplicate registrations
are silently ignored — this allows two extensions that share a common option (e.g. an HTTP
timeout) to both call `addExtensionOption` without conflict.

---

## Storage Extensions

Extensions that add new table scan sources register a `StorageExtension` object:

```cpp
extensionManager.registerStorageExtension("delta", std::make_unique<DeltaStorageExtension>());
```

`getStorageExtensions()` returns a flat `vector<StorageExtension*>` that the scan planner
iterates when resolving table references. Duplicate names are silently ignored.

---

## `CatalogExtension`

`CatalogExtension` is the base class for extensions that need to contribute catalog entries
(tables, functions, types). Subclasses override `init()` to populate a private `CatalogSet`.

```cpp
class CatalogExtension {
public:
    virtual void init() = 0;

    // Called when the underlying data source changes (e.g. DuckDB schema refresh)
    void invalidateCache() {
        tables = std::make_unique<catalog::CatalogSet>();
        init();
    }

protected:
    std::unique_ptr<catalog::CatalogSet> tables;
};
```

The `invalidateCache()` pattern allows extensions like `DUCKDB` to refresh their view of
attached databases without restarting the engine.

---

## `LoadedExtension` Serialisation

`LoadedExtension::toCypher()` produces the Cypher needed to restore the same loaded state after
a `COPY FROM` or database snapshot:

```
OFFICIAL  → "INSTALL <name>;\nLOAD EXTENSION <name>;\n"
USER      → "LOAD EXTENSION '<full-path>';\n"
STATIC    → ""  (compiled in, nothing to emit)
```

This output is used by `ExtensionManager::toCypher()` which concatenates all loaded extensions
into a single bootstrap script.

---

## Platform Detection

```cpp
// src/extension/extension.cpp
std::string getOS();       // "linux" | "linux_old" | "osx" | "win"
std::string getArch();     // "amd64" | "x86" | "arm64"
std::string getPlatform(); // "<os>_<arch>"
```

The `linux_old` variant is emitted when the binary was compiled with
`_GLIBCXX_USE_CXX11_ABI == 0`, ensuring the correct pre-C++11 ABI build is downloaded.

Shared library suffixes per platform:
- Linux/Linux-old: `.so`
- macOS: `.dylib`
- Windows: resolved at compile time (not via `appendLibSuffix`)

---

## Writing an Extension

A minimal extension shared library requires:

```cpp
#include "extension/extension.h"
#include "main/client_context.h"
#include "function/function_collection.h"

// Mandatory: return the canonical name
extern "C" const char* <name>_ext_name() {
    return "myext";
}

// Mandatory: register everything into the database
extern "C" void <name>_ext_init(lbug::main::ClientContext* context) {
    // Register scalar functions via the catalog
    auto& catalog = context->getCatalog();
    catalog.addFunction(..., MyScalarFunction::getFunctionSet());

    // Register table functions
    catalog.addFunction(..., MyTableFunction::getFunctionSet());

    // Register a storage extension
    context->getDatabase()->getExtensionManager()->registerStorageExtension(
        "myfs", std::make_unique<MyStorageExtension>());

    // Declare extension options
    context->getDatabase()->getExtensionManager()->addExtensionOption(
        "myext_timeout", lbug::common::LogicalTypeID::INT64, lbug::common::Value{30L}, false);
}

// Optional: loader shim (runs before init, can load shared deps)
extern "C" void <name>_ext_load(lbug::main::ClientContext* context) { /* ... */ }

// Optional: installer (downloads deps alongside the main .so)
extern "C" void <name>_ext_install(const char* repo, lbug::main::ClientContext& context) { /* ... */ }
```

The symbol names follow the pattern `<lowercased_name>_ext_<role>` as resolved by
`ExtensionLibLoader` using the constants `EXTENSION_INIT_FUNC_NAME`, `EXTENSION_NAME_FUNC_NAME`,
etc.

---

## Function Lookup During Query Compilation

When the binder resolves a function call, it queries `BuiltInFunctionUtils` first. On failure,
`ExtensionManager::lookupExtensionsByFunctionName` performs a case-insensitive scan of the
static `functionsForExtensions` table in `extension_entries.cpp`. If a match is found, the
binder throws a `BinderException` of the form:

> Function `<name>` is not found. This function is provided by the `<extension>` extension. Please install and load the extension first.

This gives users actionable guidance without exposing internal extension tables.

---

## Extension Repository URL Format

```
http://<repo>/<LBUG_EXTENSION_VERSION>/<platform>/<name>/<filename>
```

Helper functions in `ExtensionUtils`:

| Function | What it resolves |
|----------|-----------------|
| `getExtensionLibRepoInfo(name, repo)` | Main `.so`/`.dylib` for the extension |
| `getExtensionLoaderRepoInfo(name, repo)` | Loader shim (`<name>_loader`) |
| `getExtensionInstallerRepoInfo(name, repo)` | Installer shim (`<name>_installer`) |
| `getSharedLibRepoInfo(fileName, repo)` | Arbitrary shared dependency file |

Local paths mirror the structure under `context->getExtensionDir()`:

```
<extensionDir>/
  <name>/
    <name>.so          ← main library
    <name>_loader.so   ← optional loader
    <name>_installer.so← optional installer
  common/
    <shared-deps>.so   ← shared dependencies
```

---

## Source File Reference

| File | Responsibility |
|------|---------------|
| `src/extension/extension.cpp` | `ExtensionLibLoader`, platform detection, URL parsing, proxy config, `ExtensionUtils` helpers |
| `src/extension/extension_manager.cpp` | `ExtensionManager` — load, dedup, WAL logging, option/storage-ext registration, auto-load |
| `src/extension/extension_installer.cpp` | `ExtensionInstaller` — HTTP download, installer shim execution |
| `src/extension/extension_entries.cpp` | Compile-time official extension catalog (function/type → extension name) |
| `src/extension/loaded_extension.cpp` | `LoadedExtension::toCypher()` serialisation |
| `src/extension/catalog_extension.cpp` | `CatalogExtension::invalidateCache()` |
| `src/extension/generated_extension_loader.cpp.in` | CMake template for static-link loader |
| `src/include/extension/extension.h` | `ExtensionUtils`, `ExtensionLibLoader`, `ExtensionRepoInfo`, `ExtensionProxyConfig`, type aliases for entrypoint function pointers |
