# WebAssembly API Reference

Ladybug ships a first-class WebAssembly build under the `@ladybugdb/wasm-core` npm package. It supports both browser and Node.js environments, with optional multi-threading and optional synchronous execution.

## Installation

```bash
npm install @ladybugdb/wasm-core
```

---

## Package variants

The package contains **three variants** × **two versions** = **6 build combinations**. They are **not interchangeable** — do not mix objects from different variants or versions.

| Import path | Variant | Mode |
|-------------|---------|------|
| `@ladybugdb/wasm-core` | Default (Emscripten FS) | Async |
| `@ladybugdb/wasm-core/sync` | Default | Sync |
| `@ladybugdb/wasm-core/multithreaded` | Multi-threaded | Async |
| `@ladybugdb/wasm-core/multithreaded/sync` | Multi-threaded | Sync |
| `@ladybugdb/wasm-core/nodejs` | Node.js (NODEFS) | Async |
| `@ladybugdb/wasm-core/nodejs/sync` | Node.js | Sync |

### Variant descriptions

**Default** — Smallest build, widest compatibility. Uses Emscripten's in-memory/IDBFS filesystem. Does not require cross-origin isolation. Single-threaded. Works in both browser and Node.js.

**Multi-threaded** — Enables Emscripten's threading support (SharedArrayBuffer + Atomics). Requires [cross-origin isolation headers](https://web.dev/articles/cross-origin-isolation-guide) in browsers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). Also works in Node.js.

**Node.js** — Uses Node.js's native filesystem (`NODEFS` flag). Multi-threaded. Distributed as CommonJS (`require`). Does **not** work in browsers.

### Version descriptions

**Async** (default) — Every method returns a `Promise`. All WASM calls are dispatched to a Web Worker (browser) or Node.js worker thread (Node.js), keeping the main thread unblocked. The worker script is bundled as a separate file; see [Loading the Worker Script](#loading-the-worker-script) below.

**Sync** — Methods return values directly, not Promises. Runs on the calling thread. Suitable for scripts, CLI tools, or environments where blocking is acceptable. Does not require worker threads.

---

## Module initialization

```javascript
// Async variant (default):
import lbug from "@ladybugdb/wasm-core";
// lbug is ready immediately; the WASM module initializes lazily on first use.

// Node.js variant (CommonJS):
const lbug = require("@ladybugdb/wasm-core/nodejs");

// Sync variant:
import lbug from "@ladybugdb/wasm-core/sync";
```

### Loading the worker script

The async variants bundle the main module as one file and the worker script as a separate file. By default the worker script is resolved from the same directory as the main module. If your bundler copies assets to a different location, set the path explicitly **before any other API call**:

```javascript
import lbug from "@ladybugdb/wasm-core";
lbug.setWorkerPath("/assets/lbug-worker.js");
// Now create Database, Connection, etc.
```

For the **Node.js variant**, the worker script resolves automatically — `setWorkerPath` is not needed.

### Module teardown

```javascript
await lbug.close(); // releases the WASM module and any worker threads
```

Call `lbug.close()` once when the module is no longer needed. Do not make further API calls after closing.

---

## Database

```javascript
// In-memory database:
const db = new lbug.Database(":memory:");

// On-disk database with buffer pool size (bytes):
const db = new lbug.Database("path/to/db", 1 << 30 /* 1 GB */);

// Close when done:
await db.close();
```

Constructor parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | `string` | required | Filesystem path, or `":memory:"` for in-memory |
| `bufferPoolSize` | `number` | engine default | Buffer pool size in bytes |

In browser environments with persistent storage, use the IDBFS path:

```javascript
// browser_persistent example:
const db = new lbug.Database("idbfs://my-graph-db");
```

---

## Connection

```javascript
const conn = new lbug.Connection(db);

// Optionally specify max threads:
const conn = new lbug.Connection(db, 4);

await conn.close();
```

Constructor parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `database` | `Database` | required | Parent database |
| `numThreads` | `number` | auto | Max threads for query execution |

---

## Query execution

### Async version

```javascript
// Simple query:
const result = await conn.query(
    "MATCH (u:User)-[:Follows]->(v:User) RETURN u.name, v.name"
);

// Iterate rows as objects:
const rows = await result.getAllObjects();
for (const row of rows) {
    console.log(row["u.name"], "->", row["v.name"]);
}
await result.close();
```

### Sync version

```javascript
import lbug from "@ladybugdb/wasm-core/sync";
const db   = new lbug.Database(":memory:");
const conn = new lbug.Connection(db);

const result = conn.query(
    "MATCH (u:User) RETURN u.name"
);
const rows = result.getAllObjects();
rows.forEach(row => console.log(row["u.name"]));
result.close();
```

In the sync variant, all methods are identical but return values directly instead of Promises.

---

## QueryResult

```javascript
// Row objects (key = column name, value = JS value):
const rows = await result.getAllObjects();
// Returns: Array<Record<string, any>>

// Stringified table (pipe-delimited):
const table = await result.toString();

// Release native memory:
await result.close();
```

`getAllObjects()` returns all rows as an array of plain JS objects. Column names are used as keys. Nested values (nodes, relationships, lists, structs, maps) are recursively converted to JS objects/arrays.

### Row-by-row iteration

```javascript
while (await result.hasNext()) {
    const tuple = await result.getNext();
    const name = tuple[0];  // index-based access
    const age  = tuple[1];
}
await result.close();
```

> **Note**: Individual tuple values are accessed by index. Each `tuple[i]` returns the column value converted to a JS primitive, object, or array depending on the Ladybug type.

---

## Prepared Statements

```javascript
// Prepare:
const ps = await conn.prepare(
    "CREATE (:User {name: $name, age: $age});"
);

// Execute with parameters:
await conn.execute(ps, { name: "Alice", age: 25 });
await conn.execute(ps, { name: "Bob",   age: 30 });
```

Parameters are passed as a plain JS object keyed by parameter name (without the leading `$`). The prepared statement can be reused across multiple `execute` calls.

---

## OPFS persistent storage (browser)

The Origin Private File System (OPFS) provides fast persistent storage available to all modern browsers. Use the `IDBFS` path prefix for IndexedDB-backed persistence:

```javascript
// Persistent in-browser database:
const db = new lbug.Database("idbfs://my-persistent-db");
```

For OPFS (raw access), use the file system path `/opfs/my-db` inside a browser context with the OPFS adapter enabled (available in the multithreaded variant with SAB/OPFS support).

---

## Cross-origin isolation (multi-threaded variant)

The multi-threaded variant requires `SharedArrayBuffer`, which browsers restrict to cross-origin-isolated contexts. Your server must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Verify isolation with:

```javascript
console.log(crossOriginIsolated); // must be true
```

The default and Node.js variants do not require cross-origin isolation.

---

## Type mapping

| Ladybug type | JavaScript value |
|--------------|-----------------|
| BOOLEAN | `boolean` |
| INT8 – INT64 | `number` |
| UINT8 – UINT64 | `number` |
| INT128 | `BigInt` |
| FLOAT / DOUBLE | `number` |
| STRING | `string` |
| BLOB | `Uint8Array` |
| DATE | `string` (ISO 8601: `"YYYY-MM-DD"`) |
| TIMESTAMP | `string` (ISO 8601 with microseconds) |
| INTERVAL | `{ months, days, micros }` |
| LIST / ARRAY | `Array` |
| STRUCT | `object` (field names as keys) |
| MAP | `Array<{ key, value }>` |
| NODE | `{ _id, _label, ...properties }` |
| REL | `{ _id, _src, _dst, _label, ...properties }` |
| NULL | `null` |

---

## Full Node.js example

```javascript
const lbug = require("@ladybugdb/wasm-core/nodejs");
const fs   = require("fs/promises");

let db, conn;

async function init() {
    db   = new lbug.Database(":memory:", 1 << 30);
    conn = new lbug.Connection(db, 4);

    await conn.query(
        "CREATE NODE TABLE User(name STRING, age INT64, PRIMARY KEY(name));"
    );
    await conn.query(
        "CREATE REL TABLE Follows(FROM User TO User, since INT64);"
    );

    await conn.query(
        "CREATE (:User {name: 'Alice', age: 30});"
    );
    await conn.query(
        "CREATE (:User {name: 'Bob', age: 25});"
    );
    await conn.query(
        "MATCH (a:User {name:'Alice'}), (b:User {name:'Bob'}) " +
        "CREATE (a)-[:Follows {since: 2020}]->(b);"
    );
}

async function run() {
    const result = await conn.query(
        "MATCH (u:User)-[f:Follows]->(v:User) " +
        "RETURN u.name, f.since, v.name"
    );
    const rows = await result.getAllObjects();
    for (const row of rows) {
        console.log(`${row["u.name"]} follows ${row["v.name"]} since ${row["f.since"]}`);
    }
    await result.close();
}

async function cleanup() {
    await conn.close();
    await db.close();
    await lbug.close();
}

(async () => {
    await init();
    await run();
    await cleanup();
})();
```

---

## Full browser example

```html
<script type="module">
import lbug from "https://cdn.jsdelivr.net/npm/@ladybugdb/wasm-core/dist/lbug.js";

const db   = new lbug.Database(":memory:");
const conn = new lbug.Connection(db);

await conn.query(
    "CREATE NODE TABLE Person(name STRING, PRIMARY KEY(name));"
);
await conn.query("CREATE (:Person {name: 'Alice'});");

const result = await conn.query("MATCH (p:Person) RETURN p.name");
const rows   = await result.getAllObjects();
console.log(rows); // [{ "p.name": "Alice" }]
await result.close();

await conn.close();
await db.close();
await lbug.close();
</script>
```

---

## Error handling

```javascript
try {
    const result = await conn.query("INVALID CYPHER");
    await result.close();
} catch (e) {
    console.error("Query failed:", e.message);
}
```

All API errors are thrown as JavaScript `Error` objects. The `message` property contains the Ladybug error message. Always `close()` results in a `finally` block to avoid memory leaks:

```javascript
let result;
try {
    result = await conn.query("MATCH (n) RETURN n LIMIT 10");
    const rows = await result.getAllObjects();
    return rows;
} finally {
    if (result) await result.close();
}
```

---

## Resource lifecycle

Call `close()` on resources in reverse creation order:

1. `result.close()` — before next query on the same connection
2. `conn.close()` — before closing the database
3. `db.close()` — before closing the module
4. `lbug.close()` — final cleanup

Failing to call `lbug.close()` may leave background worker threads running.

---

## Webpack integration

Copy the worker script to your output directory using `copy-webpack-plugin`:

```js
// webpack.config.js
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
    plugins: [
        new CopyPlugin({
            patterns: [
                {
                    from: "node_modules/@ladybugdb/wasm-core/lbug-worker.js",
                    to:   "lbug-worker.js",
                },
            ],
        }),
    ],
};
```

Then tell the module where to find the worker:

```javascript
import lbug from "@ladybugdb/wasm-core";
lbug.setWorkerPath("/lbug-worker.js");
```
