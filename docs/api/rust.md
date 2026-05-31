# Rust API Reference

The `lbug` crate provides idiomatic Rust bindings to Ladybug. It links to the C++ `liblbug` library via [cxx](https://cxx.rs) and exposes a safe, owned-value interface. Arrow support is gated behind the optional `arrow` feature.

## Cargo dependency

```toml
[dependencies]
lbug = "0.17"          # stable version; link against precompiled liblbug

# Enable Arrow output
lbug = { version = "0.17", features = ["arrow"] }
```

### Build environment variables

| Variable | Effect |
|----------|--------|
| `LBUG_LIBRARY_DIR` | Directory of a prebuilt `liblbug` |
| `LBUG_INCLUDE_DIR` | Directory containing Ladybug headers |
| `LBUG_SHARED` | Link dynamically (`libladybug.so` / `.dylib`) instead of statically |
| `LBUG_BUILD_FROM_SOURCE` / `LBUG_RUST_BUILD_FROM_SOURCE` | Skip precompiled archive, build from source |
| `LBUG_SOURCE_DIR` | Directory of a Ladybug source checkout for source builds |

### Extension support

Binaries that load Ladybug extensions must re-export their own symbols so the extension dynamic library can resolve them. Add to your `build.rs`:

```rust
println!("cargo:rustc-link-arg=-rdynamic");
```

---

## Public API surface

```rust
pub use connection::{Connection, PreparedStatement};
pub use database::{Database, SystemConfig};
pub use error::Error;
pub use logical_type::LogicalType;
pub use query_result::{CSVOptions, QueryResult};
// Arrow feature
pub use query_result::{ArrowIterator, CsrResult};
pub use value::{InternalID, NodeVal, RelVal, Value};
```

---

## Database

```rust
pub struct Database { /* opaque */ }

unsafe impl Send for Database {}
unsafe impl Sync for Database {}
```

```rust
impl Database {
    /// Open or create an on-disk database.
    pub fn new<P: AsRef<Path>>(path: P, config: SystemConfig) -> Result<Self, Error>

    /// Create an in-memory database.
    pub fn in_memory(config: SystemConfig) -> Result<Self, Error>
}
```

`Database` is `Send + Sync` — it may be shared across threads via `Arc<Database>`. The underlying C++ object is lifetime-managed by the Rust wrapper; dropping `Database` destroys the C++ object.

### `SystemConfig`

```rust
#[derive(Clone, Debug, Default)]
pub struct SystemConfig {
    buffer_pool_size:           u64,   // 0 = auto
    max_num_threads:            u64,   // 0 = auto
    enable_compression:         bool,  // default: true
    read_only:                  bool,  // default: false
    max_db_size:                u64,   // default: u32::MAX bytes
    auto_checkpoint:            bool,  // default: true
    checkpoint_threshold:       i64,   // default: -1 (engine default)
    throw_on_wal_replay_failure:bool,  // default: true
    enable_checksums:           bool,  // default: true
    enable_multi_writes:        bool,  // default: false
}
```

Builder pattern — all fields are set via method chaining:

```rust
let config = SystemConfig::default()
    .buffer_pool_size(512 * 1024 * 1024) // 512 MB
    .max_num_threads(8)
    .enable_compression(true)
    .read_only(false)
    .enable_multi_writes(true);

let db = Database::new("/data/mygraph", config)?;
let db_mem = Database::in_memory(SystemConfig::default())?;
```

### Version helpers

```rust
/// Storage format version of the linked liblbug.
pub fn get_storage_version() -> u64

/// Source of the linked precompiled library ("external", "source", "release:...", etc.)
pub fn get_library_source() -> &'static str

/// Directory of the precompiled library, if one was used.
pub fn get_library_dir() -> Option<&'static str>

pub const VERSION: &str;               // crate version from Cargo.toml
pub const LBUG_LIBRARY_SOURCE: &str;   // set by build script
pub const LBUG_LIBRARY_DIR: &str;      // set by build script
```

---

## Connection

```rust
pub struct Connection<'a> { /* opaque */ }

unsafe impl Send for Connection<'_> {}
unsafe impl Sync for Connection<'_> {}
```

```rust
impl<'a> Connection<'a> {
    /// Create a connection to an existing database.
    pub fn new(database: &'a Database) -> Result<Self, Error>

    /// Execute a Cypher query.
    pub fn query(&self, query: &str) -> Result<QueryResult<'a>, Error>

    /// Prepare a query for repeated execution.
    pub fn prepare(&self, query: &str) -> Result<PreparedStatement, Error>

    /// Execute a prepared statement with named parameters.
    pub fn execute(
        &self,
        prepared_statement: &mut PreparedStatement,
        params: Vec<(&str, Value)>,
    ) -> Result<QueryResult<'a>, Error>

    /// Execute with the native Arrow result collector.
    /// Requires `arrow` feature.
    #[cfg(feature = "arrow")]
    pub fn query_as_arrow(&self, query: &str, chunk_size: usize) -> Result<QueryResult<'a>, Error>

    // Arrow memory-backed tables (require `arrow` feature)
    #[cfg(feature = "arrow")]
    pub fn create_arrow_table(
        &self, table_name: &str,
        batches: &[arrow::record_batch::RecordBatch],
    ) -> Result<QueryResult<'a>, Error>

    #[cfg(feature = "arrow")]
    pub fn create_arrow_rel_table(
        &self, table_name: &str,
        batches: &[arrow::record_batch::RecordBatch],
        src_table_name: &str, dst_table_name: &str,
    ) -> Result<QueryResult<'a>, Error>

    #[cfg(feature = "arrow")]
    pub fn create_arrow_rel_table_csr(
        &self, table_name: &str,
        indices_batches: &[RecordBatch],
        indptr_batches:  &[RecordBatch],
        src_table_name: &str, dst_table_name: &str,
        dst_col_name: &str,
    ) -> Result<QueryResult<'a>, Error>

    #[cfg(feature = "arrow")]
    pub fn drop_arrow_table(&self, table_name: &str) -> Result<QueryResult<'a>, Error>

    pub fn set_max_num_threads_for_exec(&mut self, num_threads: u64)
    pub fn get_max_num_threads_for_exec(&self) -> u64
    pub fn set_query_timeout(&self, timeout_ms: u64)
    pub fn interrupt(&self) -> Result<(), Error>
}
```

`Connection<'a>` borrows `&'a Database`, so the connection cannot outlive the database. Multiple connections to the same database may be created and used concurrently from scoped threads.

### Basic query

```rust
let db = Database::new("./testdb", SystemConfig::default())?;
let conn = Connection::new(&db)?;

conn.query("CREATE NODE TABLE Person(name STRING, age INT64, PRIMARY KEY(name));")?;
conn.query("CREATE (:Person {name: 'Alice', age: 25});")?;

let mut result = conn.query(
    "MATCH (n:Person) RETURN n.name AS name, n.age AS age"
)?;

for row in &mut result {
    // row: Vec<Value>
    println!("{:?} {:?}", row[0], row[1]);
}
```

### Prepared statements

```rust
let mut ps = conn.prepare(
    "CREATE (:Person {name: $name, age: $age});"
)?;

conn.execute(&mut ps, vec![
    ("name", Value::String("Alice".into())),
    ("age",  Value::Int64(25)),
])?;

conn.execute(&mut ps, vec![
    ("name", Value::String("Bob".into())),
    ("age",  Value::Int64(30)),
])?;
```

`execute()` constructs a C++-side parameter pack by iterating the `Vec`. The underlying `PreparedStatement` is consumed once per call but the Rust type remains valid for further calls.

### Arrow output

```rust
use lbug::{Connection, Database, SystemConfig};

let mut result = conn.query_as_arrow(
    "MATCH (a:Person)-[r:Knows]->(b:Person) RETURN a.rowid, r.rowid, b.rowid",
    8,
)?;

// Iterate as Arrow RecordBatches
for batch in result.iter_arrow(8)? {
    // batch: arrow::record_batch::RecordBatch
    println!("{} rows", batch.num_rows());
}

// CSR arrays (relationship row-id projections)
let csr = result.csr()?;
// csr.indptr: Int64Array, csr.indices: Int64Array, csr.edge_ids: Option<Int64Array>
```

### Arrow memory-backed tables

```rust
use arrow::array::{Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use std::sync::Arc;

let schema = Arc::new(Schema::new(vec![
    Field::new("name", DataType::Utf8, false),
    Field::new("age",  DataType::Int64, false),
]));
let batch = RecordBatch::try_new(schema, vec![
    Arc::new(StringArray::from(vec!["Alice", "Bob"])),
    Arc::new(Int64Array::from(vec![25i64, 30])),
])?;

conn.create_arrow_table("persons_tmp", &[batch])?;
conn.query("MATCH (n:persons_tmp) RETURN n.name, n.age")?.to_string();
conn.drop_arrow_table("persons_tmp")?;
```

### Thread control

```rust
conn.set_max_num_threads_for_exec(4);
conn.set_query_timeout(5_000); // 5 seconds; 0 = disabled
conn.interrupt()?;             // cancel running query
```

---

## PreparedStatement

```rust
pub struct PreparedStatement { /* opaque */ }

impl PreparedStatement {
    pub fn is_read_only(&self) -> bool
}
```

`PreparedStatement` is created by `Connection::prepare()` and consumed by `Connection::execute()`. It is not `Clone`; pass `&mut PreparedStatement` to `execute()`.

---

## QueryResult

```rust
pub struct QueryResult<'a> { /* opaque */ }

unsafe impl Send for ffi::QueryResult<'_> {}
```

```rust
impl<'db> QueryResult<'db> {
    pub fn get_compiling_time(&self) -> f64   // ms
    pub fn get_execution_time(&self) -> f64   // ms
    pub fn get_num_columns(&self)    -> usize
    pub fn get_num_tuples(&self)     -> u64
    pub fn get_column_names(&self)   -> Vec<String>
    pub fn get_column_data_types(&self) -> Vec<LogicalType>

    // Arrow feature
    #[cfg(feature = "arrow")]
    pub fn iter_arrow<'qr>(&'qr mut self, chunk_size: usize)
        -> Result<ArrowIterator<'qr, 'db>, Error>

    #[cfg(feature = "arrow")]
    pub fn csr(&self) -> Result<CsrResult, Error>
}

impl Iterator for QueryResult<'_> {
    type Item = Vec<Value>;
    fn next(&mut self) -> Option<Self::Item>
}
```

`QueryResult` implements `Iterator<Item = Vec<Value>>` — each element is a row as a `Vec<Value>`. The display trait formats the result as a pipe-delimited table.

```rust
println!("{}", result);
// NAME|AGE
// Alice|25
// Bob|30
```

`QueryResult` borrows `'db` — it may outlive its parent `Connection` (the result holds the data) but must not outlive the `Database`.

### Arrow types

```rust
pub struct CsrResult {
    pub indptr:   arrow::array::Int64Array,
    pub indices:  arrow::array::Int64Array,
    pub edge_ids: Option<arrow::array::Int64Array>,
}

pub struct ArrowIterator<'qr, 'db: 'qr> {
    // implements Iterator<Item = RecordBatch>
}
```

---

## Value

```rust
pub enum Value {
    Null,
    Bool(bool),
    Int8(i8), Int16(i16), Int32(i32), Int64(i64),
    UInt8(u8), UInt16(u16), UInt32(u32), UInt64(u64),
    Int128(i128),
    Float(f32), Double(f64),
    Decimal(rust_decimal::Decimal),
    Date(time::Date),
    Interval { months: i32, days: i32, micros: i64 },
    Timestamp(time::OffsetDateTime),
    TimestampTz(time::OffsetDateTime),
    TimestampNs(time::OffsetDateTime),
    TimestampMs(time::OffsetDateTime),
    TimestampSec(time::OffsetDateTime),
    String(String),
    Blob(Vec<u8>),
    Uuid(uuid::Uuid),
    Json(serde_json::Value),
    Node(NodeVal),
    Rel(RelVal),
    List(Vec<Value>),
    Array(Vec<Value>),
    Struct(Vec<(String, Value)>),
    Map { keys: Vec<Value>, values: Vec<Value> },
    Union { tag: String, value: Box<Value> },
    InternalID(InternalID),
    // ... additional variants for RecursiveRel, etc.
}
```

Standard `From` / `Into` conversions are implemented for common Rust primitives:

```rust
Value::from(42i64)          // Value::Int64(42)
Value::from("hello")        // Value::String("hello".into())
Value::from(true)           // Value::Bool(true)
```

Timestamp variants hold `time::OffsetDateTime`. `ConversionError` is produced if the C++ internal epoch offset cannot be converted:

```rust
pub enum ConversionError {
    Date(i32),             // days since 1970-01-01
    Timestamp(i64),        // microseconds since epoch
    TimestampTz(i64),
    TimestampNs(i64),
    TimestampMs(i64),
    TimestampSec(i64),
    Json(String, serde_json::Error),
}
```

### `NodeVal` and `RelVal`

```rust
pub struct NodeVal {
    id: InternalID,
    label: String,
    properties: Vec<(String, Value)>,
}

impl NodeVal {
    pub fn new(id: impl Into<InternalID>, label: impl Into<String>) -> Self
    pub fn get_node_id(&self) -> &InternalID
    pub fn get_label_name(&self) -> &String
    pub fn add_property(&mut self, key: impl Into<String>, value: impl Into<Value>)
    pub fn get_properties(&self) -> &Vec<(String, Value)>
}

pub struct RelVal {
    src_node: InternalID,
    dst_node: InternalID,
    label: String,
    properties: Vec<(String, Value)>,
}
```

```rust
pub struct InternalID {
    pub table_id: u64,
    pub offset:   u64,
}
```

---

## LogicalType

```rust
pub enum LogicalType {
    Any, Bool, Serial,
    Int8, Int16, Int32, Int64, UInt8, UInt16, UInt32, UInt64, Int128,
    Float, Double, Decimal { precision: u32, scale: u32 },
    Date, Interval,
    Timestamp, TimestampTz, TimestampNs, TimestampMs, TimestampSec,
    InternalID,
    String, Blob,
    List { child_type: Box<LogicalType> },
    Array { child_type: Box<LogicalType>, num_elements: u64 },
    Struct { fields: Vec<(String, LogicalType)> },
    Node, Rel, RecursiveRel,
    Map { key_type: Box<LogicalType>, value_type: Box<LogicalType> },
    Union { types: Vec<(String, LogicalType)> },
    UUID, Json,
}
```

`LogicalType` is derived from a `QueryResult` column's data-type descriptor and carries extra metadata (struct fields, list child types, array size, map key/value types, union branches) beyond what `Value` alone encodes. `Serial` values are returned by the engine as `Int64`.

---

## Error Type

```rust
pub enum Error {
    CxxException(cxx::Exception),
    FailedQuery(String),
    FailedPreparedStatement(String),
    ReadOnlyType(LogicalType),
    JsonError(serde_json::Error),
    #[cfg(feature = "arrow")]
    ArrowError(arrow::error::ArrowError),
}
```

`Error` implements `std::error::Error` and `Display`. `source()` is implemented for `CxxException` and `JsonError`.

Patterns:

```rust
match conn.query("INVALID CYPHER") {
    Err(lbug::Error::FailedQuery(msg)) => eprintln!("Query error: {msg}"),
    Err(lbug::Error::CxxException(e))  => eprintln!("C++ exception: {e}"),
    Err(e) => eprintln!("Other: {e}"),
    Ok(_)  => unreachable!(),
}
```

---

## Transactions

Ladybug does not expose explicit `BEGIN` / `COMMIT` / `ROLLBACK` in the Rust API. Each `query()` / `execute()` call runs in a single auto-committed transaction. Write queries execute sequentially — a second in-flight write on the same or a different connection returns `Error::FailedQuery` unless `enable_multi_writes` was set on the database.

---

## Thread Safety and Concurrency

| Object | `Send` / `Sync` | Notes |
|--------|-----------------|-------|
| `Database` | `Send + Sync` | Share via `Arc<Database>`. |
| `Connection<'a>` | `Send + Sync` | Multiple connections may query concurrently. Create one per thread. |
| `QueryResult<'a>` | `Send` only | Access is not synchronized; do not share across threads. |
| `PreparedStatement` | Not `Sync` | Pass `&mut PreparedStatement` to `execute()`. |

Concurrent threads must use `std::thread::scope` (Rust ≥ 1.63) so that connection lifetimes remain valid:

```rust
use std::thread;
let db = Database::new(path, SystemConfig::default())?;

let (alice_result, bob_result) = thread::scope(|s| {
    let alice = s.spawn(|| {
        let conn = Connection::new(&db)?;
        let mut r = conn.query("MATCH (p:Person {name: 'Alice'}) RETURN p.age")?;
        Ok::<_, lbug::Error>(r.next())
    });
    let bob = s.spawn(|| {
        let conn = Connection::new(&db)?;
        let mut r = conn.query("MATCH (p:Person {name: 'Bob'}) RETURN p.age")?;
        Ok::<_, lbug::Error>(r.next())
    });
    (alice.join().unwrap(), bob.join().unwrap())
});
```

---

## CSV export

```rust
pub struct CSVOptions {
    delimiter:        char,   // default: ','
    escape_character: char,   // default: '"'
    newline:          char,   // default: '\n'
}

impl Default for CSVOptions { ... }
impl CSVOptions {
    pub fn delimiter(self, c: char) -> Self
    pub fn escape_character(self, c: char) -> Self
    pub fn newline(self, c: char) -> Self
}
```

`CSVOptions` is passed to Cypher `COPY` statements via query parameters when writing results to CSV files.

---

## Complete Example

```rust
use lbug::{Connection, Database, SystemConfig, Value};

fn main() -> anyhow::Result<()> {
    let db = Database::new("./mygraph", SystemConfig::default())?;
    let conn = Connection::new(&db)?;

    // Schema
    conn.query(
        "CREATE NODE TABLE Person(name STRING, age INT64, PRIMARY KEY(name));"
    )?;
    conn.query(
        "CREATE REL TABLE Knows(FROM Person TO Person, since INT64);"
    )?;

    // Data via prepared statement
    let mut ps = conn.prepare(
        "CREATE (:Person {name: $name, age: $age});"
    )?;
    conn.execute(&mut ps, vec![
        ("name", Value::String("Alice".into())),
        ("age",  Value::Int64(25)),
    ])?;
    conn.execute(&mut ps, vec![
        ("name", Value::String("Bob".into())),
        ("age",  Value::Int64(30)),
    ])?;

    // Query
    let mut result = conn.query(
        "MATCH (a:Person)-[:Knows]->(b:Person) RETURN a.name, b.name"
    )?;
    println!("Compiled in {:.2} ms", result.get_compiling_time());
    for row in &mut result {
        println!("{:?} knows {:?}", row[0], row[1]);
    }

    Ok(())
}
```
