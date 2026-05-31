# Java API Reference

The Java API lives in the `com.ladybugdb` package (JAR: `ladybug-java`). It wraps Ladybug's C++ core via JNI through `com.ladybugdb.Native`. Every public class implements `AutoCloseable`, making try-with-resources the canonical ownership idiom.

## Installation

Gradle:
```gradle
implementation 'com.ladybugdb:ladybug-java:<version>'
```

Maven:
```xml
<dependency>
  <groupId>com.ladybugdb</groupId>
  <artifactId>ladybug-java</artifactId>
  <version>VERSION</version>
</dependency>
```

The JAR bundles a native shared library for the current platform; the JNI loader extracts it to a temporary directory at runtime.

---

## Database

```java
package com.ladybugdb;

public class Database implements AutoCloseable {

    // In-memory database with all defaults
    public Database()

    // On-disk database with all defaults
    public Database(String databasePath)

    // Fully parameterised
    public Database(
        String  databasePath,
        long    bufferPoolSize,
        boolean enableCompression,
        boolean readOnly,
        long    maxDBSize,
        boolean autoCheckpoint,
        long    checkpointThreshold,
        boolean throwOnWalReplayFailure,
        boolean enableChecksums
    )

    @Override public void close()
}
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `databasePath` | `String` | `""` | File system path. `""` or `":memory:"` → in-memory. |
| `bufferPoolSize` | `long` | `0` | Buffer pool cap in bytes. `0` = auto. |
| `enableCompression` | `boolean` | `true` | Enable on-disk column compression. |
| `readOnly` | `boolean` | `false` | Open in read-only mode. |
| `maxDBSize` | `long` | `0` | Upper bound for the mmap region. `0` = engine default. |
| `autoCheckpoint` | `boolean` | `true` | Checkpoint when WAL exceeds `checkpointThreshold`. |
| `checkpointThreshold` | `long` | `-1` | WAL byte threshold. `-1` = engine default. |
| `throwOnWalReplayFailure` | `boolean` | `true` | Raise on startup WAL replay errors. |
| `enableChecksums` | `boolean` | `true` | Enable WAL page checksum verification. |

### Usage

```java
// In-memory database (all defaults)
try (Database db = new Database()) {
    // use db
}

// On-disk database with custom buffer pool
try (Database db = new Database(
    "/data/mygraph",
    256 * 1024 * 1024L,  // 256 MB buffer pool
    true,                // compression
    false,               // read-write
    0,                   // default max DB size
    true,                // auto checkpoint
    -1,                  // default threshold
    true,                // throw on WAL replay failure
    true                 // checksums
)) {
    try (Connection conn = new Connection(db)) {
        // use conn
    }
}
```

Once `close()` is called the `Database` object is permanently destroyed (`destroyed = true`). Any subsequent method call on a destroyed instance throws `RuntimeException("Database has been destroyed.")`.

---

## Connection

```java
package com.ladybugdb;

public class Connection implements AutoCloseable {

    public Connection(Database db)

    public QueryResult  query(String queryStr)
    public PreparedStatement prepare(String queryStr)
    public QueryResult  execute(PreparedStatement ps, Map<String, Value> params)

    public long getMaxNumThreadForExec()
    public void setMaxNumThreadForExec(long numThreads)
    public void setQueryTimeout(long timeoutInMs)
    public void interrupt()

    @Override public void close()
}
```

### Query execution

```java
try (Connection conn = new Connection(db)) {
    // Simple query
    try (QueryResult result = conn.query(
            "MATCH (n:Person) RETURN n.name, n.age")) {
        while (result.hasNext()) {
            FlatTuple row = result.getNext();
            System.out.println(row.getValue(0).getValue()); // name
            System.out.println(row.getValue(1).getValue()); // age
        }
    }
}
```

`query()` returns a `QueryResult` synchronously. If the query fails, the error is not thrown — check `QueryResult.isSuccess()` or read `QueryResult.getErrorMessage()`.

### Prepared statements

```java
try (PreparedStatement ps = conn.prepare(
        "MATCH (n:Person) WHERE n.age > $age RETURN n.name")) {

    if (!ps.isSuccess()) {
        throw new RuntimeException(ps.getErrorMessage());
    }

    Map<String, Value> params = new HashMap<>();
    params.put("age", new Value(25L));  // INT64

    try (QueryResult result = conn.execute(ps, params)) {
        while (result.hasNext()) {
            FlatTuple row = result.getNext();
            System.out.println(row.getValue(0).getValue());
        }
    }
}
```

`PreparedStatement` must be closed after use. Re-executing the same prepared statement with different parameters is safe.

### Thread control

```java
conn.setMaxNumThreadForExec(4);   // cap parallelism for this connection
conn.setQueryTimeout(5000L);       // interrupt if query takes > 5 s
conn.interrupt();                  // cancel a running query from another thread
```

`setQueryTimeout(0)` disables the timeout (default). `interrupt()` is safe to call from any thread; if no query is running it is a no-op.

---

## PreparedStatement

```java
package com.ladybugdb;

public class PreparedStatement implements AutoCloseable {

    public boolean isSuccess()
    public String  getErrorMessage()

    @Override public void close()
}
```

`PreparedStatement` is created exclusively via `Connection.prepare(queryStr)`. Calling `close()` after `execute()` is mandatory; forgetting to close leaks native memory.

---

## QueryResult

```java
package com.ladybugdb;

public class QueryResult implements AutoCloseable {

    public boolean     isSuccess()
    public String      getErrorMessage()

    public long        getNumColumns()
    public String      getColumnName(long index)
    public DataType    getColumnDataType(long index)
    public long        getNumTuples()

    public boolean     hasNext()
    public FlatTuple   getNext()
    public boolean     hasNextQueryResult()
    public QueryResult getNextQueryResult()

    public QuerySummary getQuerySummary()
    public void         resetIterator()
    public String       toString()

    @Override public void close()
}
```

### Row iteration

```java
try (QueryResult result = conn.query("MATCH (n:Person) RETURN n.name, n.age")) {
    if (!result.isSuccess()) {
        System.err.println(result.getErrorMessage());
        return;
    }
    while (result.hasNext()) {
        FlatTuple row = result.getNext();
        // FlatTuple is reused across iterations — process or copy before calling getNext() again
        String name = (String) row.getValue(0).getValue();
        long   age  = (long)   row.getValue(1).getValue();
    }
}
```

> **Important:** `getNext()` reuses the same `FlatTuple` object across calls. Copy any values you need to retain before the next `getNext()` call.

### Multi-statement results

```java
try (QueryResult first = conn.query("RETURN 1; RETURN 2;")) {
    // first result
    while (first.hasNextQueryResult()) {
        try (QueryResult next = first.getNextQueryResult()) {
            // subsequent results
        }
    }
}
```

### Timing

```java
QuerySummary summary = result.getQuerySummary();
double compilingMs  = summary.getCompilingTime();
double executionMs  = summary.getExecutionTime();
```

---

## FlatTuple

```java
package com.ladybugdb;

public class FlatTuple implements AutoCloseable {

    public Value  getValue(long index)
    public String toString()

    @Override public void close()
}
```

`FlatTuple` is an opaque wrapper around a single result row. The object is **reused** by the engine on each `QueryResult.getNext()` call — do not cache the `FlatTuple` reference; only cache the `Value` objects extracted from it (or clone them via `value.clone()`).

---

## Value

```java
package com.ladybugdb;

public class Value implements AutoCloseable {

    public <T> Value(T val)                              // construct from Java value
    public static Value createNull()                     // null (ANY type)
    public static Value createNullWithDataType(DataType) // null with explicit type
    public static Value createDefault(DataType)          // zero/empty value for type

    public boolean    isNull()
    public void       setNull(boolean flag)
    public <T> T      getValue()                         // extract as Java type
    public DataType   getDataType()
    public Value      clone()
    public void       copy(Value other)
    public String     toString()

    @Override public void close()
}
```

### Constructing parameter values

```java
// Scalars
Value boolVal  = new Value(true);
Value intVal   = new Value(42L);              // INT64
Value int32Val = new Value(42);               // INT32
Value dblVal   = new Value(3.14);
Value strVal   = new Value("hello");

// Null
Value nullVal  = Value.createNull();

// Structured types
// Use LbugList, LbugMap, LbugStruct helpers (see Java classes)
```

`getValue()` returns the Java counterpart of the stored Ladybug type. The return type is generic `T` — the caller must cast or use the known type from `getDataType()`.

`clone()` creates an independent deep copy. Without cloning, `copy(other)` overwrites the current value with a copy of `other`.

---

## QuerySummary

```java
package com.ladybugdb;

public class QuerySummary {

    public QuerySummary(double cmpTime, double exeTime)

    public double getCompilingTime()   // milliseconds
    public double getExecutionTime()   // milliseconds
}
```

---

## DataType and DataTypeID

```java
package com.ladybugdb;

public enum DataTypeID {
    ANY(0),
    NODE(10), REL(11), RECURSIVE_REL(12), SERIAL(13),
    BOOL(22),
    INT64(23), INT32(24), INT16(25), INT8(26),
    UINT64(27), UINT32(28), UINT16(29), UINT8(30),
    INT128(31), DOUBLE(32), FLOAT(33),
    DATE(34), TIMESTAMP(35), TIMESTAMP_SEC(36), TIMESTAMP_MS(37),
    TIMESTAMP_NS(38), TIMESTAMP_TZ(39), INTERVAL(40), DECIMAL(41),
    INTERNAL_ID(42),
    STRING(50), BLOB(51),
    LIST(52), ARRAY(53), STRUCT(54), MAP(55), UNION(56),
    UUID(59);

    public final int value;
}
```

`DataType` (not shown in full) wraps a `DataTypeID` plus optional child-type metadata for `LIST`, `ARRAY`, `STRUCT`, `MAP`, and `UNION`.

---

## Type Mapping

| Ladybug type | Java type returned by `Value.getValue()` |
|-------------|------------------------------------------|
| `BOOL` | `Boolean` |
| `INT8` | `Byte` |
| `INT16` | `Short` |
| `INT32` | `Integer` |
| `INT64`, `SERIAL` | `Long` |
| `UINT8` | `Short` |
| `UINT16` | `Integer` |
| `UINT32` | `Long` |
| `UINT64` | `Long` (unsigned semantics must be handled by caller) |
| `INT128` | `Long[]` with `{low, high}` |
| `FLOAT` | `Float` |
| `DOUBLE` | `Double` |
| `STRING` | `String` |
| `BLOB` | `byte[]` |
| `UUID` | `String` (UUID string) |
| `DATE` | `LocalDate` |
| `TIMESTAMP` | `LocalDateTime` |
| `TIMESTAMP_TZ` | `OffsetDateTime` |
| `INTERVAL` | `Duration` |
| `INTERNAL_ID` | `InternalID` |
| `LIST`, `ARRAY` | `LbugList` |
| `MAP` | `LbugMap` |
| `STRUCT` | `LbugStruct` |
| `NODE` | `NodeVal` (via `ValueNodeUtil`) |
| `REL` | `RelVal` (via `ValueRelUtil`) |
| `RECURSIVE_REL` | `RecursiveRelVal` (via `ValueRecursiveRelUtil`) |

---

## Error Handling

The Java API uses two error patterns:

1. **Pre-execution errors** — `Connection.query()` and `Connection.execute()` return a `QueryResult`; the caller must check `result.isSuccess()` and handle `result.getErrorMessage()`.

2. **Runtime exceptions** — `RuntimeException` is thrown when a method is called on a destroyed object (`Database`, `Connection`, `PreparedStatement`, `QueryResult`, or `FlatTuple` after `close()`).

```java
QueryResult result = conn.query("MATCH (n:NONEXISTENT) RETURN n");
if (!result.isSuccess()) {
    System.err.println(result.getErrorMessage());
    result.close();
    return;
}
// proceed to iterate
```

There is no checked exception type. Native JNI errors propagate as unchecked `RuntimeException`.

---

## Transactions

There is no explicit transaction API. Each `conn.query()` / `conn.execute()` call runs in a single auto-committed transaction on the C++ side. Concurrent reads across multiple `Connection` objects to the same `Database` are supported. Concurrent writes require enabling multi-write mode when constructing the `Database`.

---

## Thread Safety

| Object | Thread safety |
|--------|--------------|
| `Database` | Safe to share across threads once constructed. |
| `Connection` | Thread-safe per the Javadoc — each `Connection` is independently thread-safe at the C++ layer. |
| `QueryResult` | Not thread-safe; must be consumed from the thread that created it. |
| `PreparedStatement` | Not safe to execute concurrently from multiple threads with the same instance. |

## Resource Ownership

All public classes hold an opaque `long` pointer to a C++ heap object (`db_ref`, `conn_ref`, `ps_ref`, `qr_ref`, `ft_ref`, `v_ref`). Some objects are flagged `isOwnedByCPP = true` — these are managed by a parent object and must **not** have their native destructor called from Java (the `destroy()` method skips `Native.lbug*Destroy` for them).

Calling `close()` on a `QueryResult` or `FlatTuple` that `isOwnedByCPP()` is a no-op on the native side; the Java flag is still set to `destroyed = true`.

Always close in reverse order of acquisition: `QueryResult` → `PreparedStatement` → `Connection` → `Database`.

---

## Complete Example

```java
import com.ladybugdb.*;
import java.util.HashMap;
import java.util.Map;

public class Example {
    public static void main(String[] args) {
        try (Database db = new Database()) {
            try (Connection conn = new Connection(db)) {

                // DDL
                conn.query(
                    "CREATE NODE TABLE Person(name STRING, age INT64, PRIMARY KEY(name));"
                ).close();

                // DML via prepared statement
                try (PreparedStatement ps = conn.prepare(
                        "CREATE (:Person {name: $name, age: $age})")) {

                    Map<String, Value> p1 = new HashMap<>();
                    p1.put("name", new Value("Alice"));
                    p1.put("age",  new Value(25L));
                    conn.execute(ps, p1).close();

                    Map<String, Value> p2 = new HashMap<>();
                    p2.put("name", new Value("Bob"));
                    p2.put("age",  new Value(30L));
                    conn.execute(ps, p2).close();
                }

                // Query
                try (QueryResult result = conn.query(
                        "MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age")) {
                    while (result.hasNext()) {
                        FlatTuple row = result.getNext();
                        System.out.printf("%s: %d%n",
                            row.getValue(0).getValue(),
                            row.getValue(1).getValue());
                    }
                    QuerySummary s = result.getQuerySummary();
                    System.out.printf("Compiled in %.2f ms, ran in %.2f ms%n",
                        s.getCompilingTime(), s.getExecutionTime());
                }
            }
        }
    }
}
```
