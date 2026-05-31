# Node.js API Reference

The Node.js API exposes Ladybug through a native N-API addon (`src_cpp/`) with a thin JavaScript layer (`src_js/`). The `lbug.d.ts` TypeScript declarations are the authoritative surface; all runtime types mirror those declarations.

## Installation

```bash
npm install ladybug
```

## Module imports

```js
// ESM
import lbug from "ladybug";
const { Database, Connection, QueryResult, PreparedStatement, json } = lbug;

// CJS
const lbug = require("ladybug");
```

`lbug.VERSION` — library version string.  
`lbug.STORAGE_VERSION` — storage format version as `bigint`.

---

## Database

```ts
class Database {
    constructor(
        databasePath?: string,
        bufferManagerSize?: number,
        enableCompression?: boolean,
        readOnly?: boolean,
        maxDBSize?: number,
        autoCheckpoint?: boolean,
        checkpointThreshold?: number,
        throwOnWalReplayFailure?: boolean,
        enableChecksums?: boolean,
        enableDefaultHashIndex?: boolean,
    )

    init(): Promise<void>
    initSync(): void

    close(): Promise<void>
    closeSync(): void

    static getVersion(): string
    static getStorageVersion(): number
}
```

### Constructor parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `databasePath` | `string` | `":memory:"` | File system path. `""`, `undefined`, or `":memory:"` → in-memory. |
| `bufferManagerSize` | `number` | `0` | Buffer pool size in bytes. `0` = auto. |
| `enableCompression` | `boolean` | `true` | Enable on-disk compression. |
| `readOnly` | `boolean` | `false` | Open read-only. |
| `maxDBSize` | `number` | `0` | Cap for the mmap region (temporary workaround). |
| `autoCheckpoint` | `boolean` | `true` | Auto-checkpoint on WAL threshold. |
| `checkpointThreshold` | `number` | `-1` | WAL byte threshold (`-1` = engine default). |
| `throwOnWalReplayFailure` | `boolean` | `true` | Throw on startup WAL replay errors. |
| `enableChecksums` | `boolean` | `true` | Checksum WAL pages. |
| `enableDefaultHashIndex` | `boolean` | `true` | Create default primary-key hash index on node tables. |

### Lazy initialization

`Database` construction is synchronous but the underlying store is opened lazily — the first query triggers `init()` automatically. Call `init()` / `initSync()` explicitly to surface open errors early.

```js
// Async (recommended)
const db = new lbug.Database("/data/mygraph");
await db.init();

// Sync (may block the event loop)
const db = new lbug.Database();
db.initSync();
```

### Lifecycle

```js
// Async close
await db.close();

// Sync close (blocks)
db.closeSync();
```

---

## Connection

```ts
class Connection {
    constructor(database: Database, numThreads?: number)

    init(): Promise<void>
    initSync(): void

    setMaxNumThreadForExec(numThreads: number): void
    setQueryTimeout(timeoutInMs: number): void

    query(statement: string, progressCallback?: ProgressCallback): Promise<QueryResult | QueryResult[]>
    querySync(statement: string): QueryResult | QueryResult[]

    queryArrow(statement: string, chunkSize?: number): Promise<ArrowQueryResult>
    queryArrowSync(statement: string, chunkSize?: number): ArrowQueryResult

    prepare(statement: string): Promise<PreparedStatement>
    prepareSync(statement: string): PreparedStatement

    execute(
        preparedStatement: PreparedStatement,
        params?: Record<string, LbugValue>,
        progressCallback?: ProgressCallback,
    ): Promise<QueryResult | QueryResult[]>
    executeSync(
        preparedStatement: PreparedStatement,
        params?: Record<string, LbugValue>,
    ): QueryResult | QueryResult[]

    createArrowTableSync(
        tableName: string,
        schemaPtr: NativePointer,
        arraysPtr: NativePointer | NativePointer[],
        numArrays?: number,
    ): QueryResult

    createArrowRelTableSync(
        tableName: string,
        srcTableName: string,
        dstTableName: string,
        schemaPtr: NativePointer,
        arraysPtr: NativePointer | NativePointer[],
        numArrays?: number,
        indptrSchemaPtr?: NativePointer | null,
        indptrArraysPtr?: NativePointer | NativePointer[] | null,
        numIndptrArrays?: number,
        dstColName?: string,
    ): QueryResult

    dropArrowTableSync(tableName: string): QueryResult

    close(): Promise<void>
    closeSync(): void
}
```

### Query execution

```js
const conn = new lbug.Connection(db);
await conn.init();

// Simple query
const result = await conn.query(
    "MATCH (n:Person) RETURN n.name, n.age"
);

// With progress callback
const result = await conn.query(
    "MATCH (n:Person) RETURN n.name",
    (pipelineProgress, numFinished, numTotal) => {
        console.log(`Pipeline ${numFinished}/${numTotal}: ${pipelineProgress}%`);
    }
);
```

Multi-statement queries (semicolon-separated) return `QueryResult[]`. Single-statement queries return a single `QueryResult`.

### Prepared statements and parameter binding

```js
const ps = await conn.prepare(
    "MATCH (n:Person) WHERE n.age > $age RETURN n.name"
);
if (!ps.isSuccess()) {
    throw new Error(ps.getErrorMessage());
}

const result = await conn.execute(ps, { age: 25 });

// Sync variants
const psSync = conn.prepareSync("RETURN $x + $y");
const rSync  = conn.executeSync(psSync, { x: 10, y: 20 });
```

Parameter values accept any `LbugValue`: `null`, `boolean`, `number`, `bigint`, `string`, `Date`, `NodeValue`, `RelValue`, arrays, `Map`, or plain objects.

### JSON parameters

```js
import { json } from "ladybug";

// Wrap a string that contains JSON
const result = await conn.query(
    "RETURN $data.name",
    { data: json('{"name": "Alice"}') }
);

// Wrap a JS object as JSON
const result = await conn.query(
    "RETURN $data.count",
    { data: json({ count: 42 }) }
);
```

`json()` signals to the engine that the parameter should be typed as `JSON` rather than the default inferred type.

### Arrow native path

```js
const arrowResult = await conn.queryArrow(
    "MATCH (a:Person)-[r:Knows]->(b:Person) RETURN a.rowid, r.rowid, b.rowid",
    1_000_000 // chunk size
);
// arrowResult is an ArrowQueryResult with a .csr() method
const csrData = arrowResult.csr();
// csrData: { indptr: BigUint64Array, indices: BigUint64Array, edgeIds: BigUint64Array|null }
```

### Arrow memory-backed tables

```js
// schemaPtr and arraysPtr are Arrow C Data Interface pointers
// Ownership transfers to Ladybug upon call
conn.createArrowTableSync("persons_tmp", schemaPtr, arraysPtr, numArrays);

conn.createArrowRelTableSync(
    "knows_tmp",
    "Person", "Person",
    edgeSchemaPtr, edgeArraysPtr, numEdgeArrays,
    null, null, 0,   // no CSR indptr (FLAT layout)
    "to"             // destination column name
);

conn.dropArrowTableSync("persons_tmp");
```

`NativePointer` is either a `bigint` (raw address) or an N-API `External` object produced by a native producer.

---

## PreparedStatement

```ts
class PreparedStatement {
    isSuccess(): boolean
    isReadOnly(): boolean
    getErrorMessage(): string
}
```

`PreparedStatement` instances are created internally by `Connection.prepare()` / `Connection.prepareSync()`. They do not have an explicit `close()` method in the public TypeScript declarations; resources are released when the object is garbage-collected.

---

## QueryResult

```ts
class QueryResult {
    resetIterator(): void
    hasNext(): boolean
    getNumTuples(): number

    getNext(): Promise<Record<string, LbugValue> | null>
    getNextSync(): Record<string, LbugValue> | null

    each(
        resultCallback: (row: Record<string, LbugValue>) => void,
        doneCallback: () => void,
        errorCallback: (error: Error) => void,
    ): void

    getAll(): Promise<Record<string, LbugValue>[]>
    getAllSync(): Record<string, LbugValue>[]

    all(
        resultCallback: (rows: Record<string, LbugValue>[]) => void,
        errorCallback: (error: Error) => void,
    ): void

    getColumnDataTypes(): Promise<string[]>
    getColumnDataTypesSync(): string[]
    getColumnNames(): Promise<string[]>
    getColumnNamesSync(): string[]

    close(): void
}
```

### Row format

Every row is `Record<string, LbugValue>` keyed by column name. Node values include `_label`, `_id`, and property keys. Relationship values include `_src`, `_dst`, `_label`, `_id`, and property keys.

### Iteration patterns

```js
// Async iterator
const result = await conn.query("MATCH (n:Person) RETURN n.name, n.age");
while (result.hasNext()) {
    const row = await result.getNext();
    console.log(row["n.name"], row["n.age"]);
}
result.close();

// Bulk async
const rows = await result.getAll();

// Sync bulk
const rows = result.getAllSync();

// Callback-based streaming
result.each(
    (row) => process(row),
    () => console.log("done"),
    (err) => console.error(err),
);
```

### ArrowQueryResult

```ts
class ArrowQueryResult extends QueryResult {
    csr(): CSRResult
}

interface CSRResult {
    indptr:  BigUint64Array;
    indices: BigUint64Array;
    edgeIds: BigUint64Array | null;
}
```

---

## Type System

### `LbugValue` union

```ts
type LbugValue =
    | null
    | boolean
    | number
    | bigint
    | string
    | Date
    | NodeValue
    | RelValue
    | RecursiveRelValue
    | LbugValue[]
    | Map<LbugValue, LbugValue>
    | { [key: string]: LbugValue };
```

### Ladybug → JavaScript type mapping

| Ladybug type | JavaScript / TypeScript value |
|-------------|-------------------------------|
| `BOOL` | `boolean` |
| `INT8`–`INT32`, `UINT8`–`UINT32`, `FLOAT`, `DOUBLE` | `number` |
| `INT64`, `UINT64`, `INT128` | `bigint` |
| `SERIAL` | `number` or `bigint` |
| `STRING`, `BLOB`, `UUID` | `string` |
| `DATE`, `TIMESTAMP`, `TIMESTAMP_TZ` | `Date` |
| `INTERVAL` | `number` (microseconds) |
| `LIST`, `ARRAY` | `LbugValue[]` |
| `STRUCT` | `{ [key: string]: LbugValue }` |
| `MAP` | `Map<LbugValue, LbugValue>` |
| `UNION` | value of the active branch |
| `NODE` | `NodeValue` |
| `REL` | `RelValue` |
| `RECURSIVE_REL` | `RecursiveRelValue` |
| `INTERNAL_ID` | `{ offset: number, table: number }` |

### Node, Rel, and RecursiveRel shapes

```ts
interface NodeValue {
    _label: string | null;
    _id: NodeID | null;
    [key: string]: any;         // node properties
}

interface RelValue {
    _src: NodeID | null;
    _dst: NodeID | null;
    _label: string | null;
    _id: any;
    [key: string]: any;         // rel properties
}

interface RecursiveRelValue {
    _nodes: any[];
    _rels:  any[];
}

interface NodeID {
    offset: number;
    table:  number;
}
```

### `SystemConfig` alternative constructor form

```ts
interface SystemConfig {
    bufferPoolSize?: number;
    enableCompression?: boolean;
    readOnly?: boolean;
    maxDBSize?: number;
    autoCheckpoint?: boolean;
    checkpointThreshold?: number;
    enableDefaultHashIndex?: boolean;
}
```

The JavaScript `Database` constructor in `database.js` also accepts a `SystemConfig` object as the second argument.

---

## Progress Callbacks

```ts
type ProgressCallback = (
    pipelineProgress: number,    // 0–100
    numPipelinesFinished: number,
    numPipelines: number,
) => void;
```

Pass a progress callback to `conn.query()` or `conn.execute()` to receive pipeline-level progress updates during query execution.

---

## Error Handling

All errors surface as JavaScript `Error` objects thrown from async functions or propagated through error callbacks.

```js
try {
    const result = await conn.query("MATCH (n:Nonexistent) RETURN n");
} catch (e) {
    // e.message = "Binder exception: Table Nonexistent does not exist."
    console.error(e.message);
}

// PreparedStatement validation errors are not thrown;
// check ps.isSuccess() before calling execute()
const ps = await conn.prepare("INVALID CYPHER");
if (!ps.isSuccess()) {
    console.error(ps.getErrorMessage());
}
```

---

## Transactions

There is no explicit transaction API in the Node.js binding. Each `query()` / `execute()` call runs in a single auto-committed transaction. Concurrent reads across multiple `Connection` objects are supported. Concurrent writes require enabling `enable_multi_writes` during database construction.

---

## Thread Safety and the Event Loop

The native N-API addon dispatches blocking C++ calls to libuv worker threads. The async `query()`, `execute()`, `prepare()`, `init()`, and `close()` methods are non-blocking on the main JavaScript thread.

The sync variants (`querySync`, `executeSync`, `prepareSync`, `initSync`, `closeSync`) execute directly on the calling thread and **will block the event loop**. Use sync variants only in scripts, CLI tools, or test harnesses — never in a Node.js HTTP server or GUI application.

Multiple `Connection` objects may coexist on the same `Database`. Each connection's async callbacks are serialised internally by the N-API event queue, but concurrent queries from different connections can run in parallel on different libuv threads.

---

## Complete Example

```js
import lbug from "ladybug";
const { Database, Connection } = lbug;

const db = new Database();
const conn = new Connection(db);

// DDL
await conn.query(
    "CREATE NODE TABLE Person(name STRING, age INT64, PRIMARY KEY(name));"
);

// DML
await conn.query("CREATE (:Person {name: 'Alice', age: 25});");
await conn.query("CREATE (:Person {name: 'Bob', age: 30});");

// Prepared statement with parameters
const ps = await conn.prepare(
    "MATCH (n:Person) WHERE n.age > $minAge RETURN n.name, n.age"
);
const result = await conn.execute(ps, { minAge: 24 });
const rows = await result.getAll();
for (const row of rows) {
    console.log(`${row["n.name"]}: ${row["n.age"]}`);
}
result.close();

// Arrow native path + CSR
const arrowResult = await conn.queryArrow(
    "MATCH (a:Person)-[r:Knows]->(b:Person) RETURN a.rowid, r.rowid, b.rowid",
    512,
);
const { indptr, indices } = arrowResult.csr();
arrowResult.close();

await conn.close();
await db.close();
```
