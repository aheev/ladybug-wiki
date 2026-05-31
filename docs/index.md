# LadybugDB Wiki

Engineering reference for [LadybugDB](https://github.com/LadybugDB/ladybug) — an embeddable, serverless analytical graph database written in C++.

This wiki covers algorithms, data structures, and implementation decisions for contributors and developers. **Not a user guide.**

## Where to Start

| I want to understand… | Read this first |
|-----------------------|-----------------|
| The big picture | [Architecture Overview](/overview) |
| How schema and DDL work | [Catalog System](/catalog) |
| How data is stored on disk | [Node Groups & Columnar Layout](/storage/node-groups) |
| How queries execute across CPU cores | [Morsel-Driven Parallelism](/execution/morsel) |
| How a `MATCH` executes end-to-end | [Cypher Query Walkthroughs](/query/cypher-internals) |
| How transactions and MVCC work | [Transaction Lifecycle](/transaction/mvcc) · [TransactionManager](/transaction/transaction-manager) |
| How the WAL works (LocalWAL vs WAL) | [WAL Internals](/storage/wal-internals) |
| How column data is compressed | [Column Compression](/storage/compression) |
| How `WHERE` filters skip disk reads | [Column Statistics & Zone Maps](/storage/column-stats) |
| How variable-length paths work | [GDS & Recursive Traversals](/execution/gds) |
| What each optimizer pass does | [Optimizer Passes](/query/optimizer-passes) |
| Which storage backend to use | [Storage Backends](/storage/storage-backends) |
| How to build and run tests | [Building](/dev/building) · [Testing](/dev/testing) |
| How DataChunk / ValueVector work internally | [Data Chunk & Vector Layer](/common/data-chunk) |
| How the type system is implemented | [Type System](/common/type-system) |
| How file I/O and serialization work | [File System Abstraction](/common/file-system) |
| How worker threads are scheduled | [Task Scheduler & Progress](/common/task-scheduler) |
| How factorization and schema groups work | [Factorization & Schema Groups](/query/factorization) |
| How join order is enumerated | [Join-Order Enumeration](/query/join-order) |
| How connections and queries are managed | [Connection & Query Lifecycle](/main/connection-lifecycle) |
| How bulk COPY FROM works | [COPY FROM Mechanics](/main/copy-mechanics) |
| How to use the Python / Java / Node.js APIs | [API Bindings](/api/python) |

## Contents

### Storage Engine

Columnar storage partitioned into **node groups** of 131,072 nodes each. Properties are stored in independent column chunks with per-column compression codecs. The `SelectionVector` drives block-level I/O skipping during scans.

- [Node Groups & Columnar Layout](/storage/node-groups) — horizontal partitioning, column chunks, `Filterer` block skipping
- [CSR Adjacency Lists](/storage/csr) — relationship storage, forward/backward adjacency lists
- [Hash Index](/storage/hash-index) — primary key lookup, overflow chaining
- [Overflow & String Storage](/storage/overflow) — variable-length value layout
- [Buffer Manager](/storage/buffer-manager) — page pool, 2-hand clock eviction, pinning
- [Column Compression](/storage/compression) — UNCOMPRESSED, INTEGER_BITPACKING, BOOLEAN_BITPACKING, CONSTANT, ALP; zone map min/max
- [Column Statistics & Zone Maps](/storage/column-stats) — HyperLogLog NDV, `ColumnPredicateSet`, SKIP_SCAN skipping
- [Shadow File & WAL](/storage/shadow-wal) — crash recovery, atomic page swap
- [WAL Internals (Two-Tier)](/storage/wal-internals) — LocalWAL vs shared WAL, record types, recovery algorithm
- [Storage Backends](/storage/storage-backends) — native, Arrow, Icebug-Disk, in-memory
- [Icebug-Disk Format](/storage/icebug-disk) — on-disk file layout
- [Native Rel Tables](/storage/native-rel-tables) — relationship table layout, adjacency list structure, CSR integration

### Transaction & MVCC

- [Transaction Lifecycle](/transaction/mvcc) — begin, commit, rollback, MVCC visibility rules
- [TransactionManager](/transaction/transaction-manager) — three mutexes, write serialization, auto-checkpoint trigger, `enableMultiWrites`
- [UndoBuffer Chain](/transaction/undo-buffer) — per-row version chains, rollback records
- [Local Storage](/transaction/local-storage) — uncommitted write data held in-memory
- [Checkpointing](/transaction/checkpointing) — WAL flush, shadow page swap

### Query Execution

Vectorized, morsel-driven pipeline execution. Each pipeline is a chain of operators that processes DataChunks of 2,048 rows. Pipelines run in parallel: worker threads atomically claim morsels (node groups) and execute the full pipeline on each morsel independently.

- [Vectorized Execution Model](/execution/vectorized) — `DataChunk`, `ValueVector`, `SelectionVector`
- [Pipeline & Operator Model](/execution/pipeline) — pipelines, pipeline-breaking vs pipelined operators
- [Morsel-Driven Parallelism](/execution/morsel) — atomic morsel assignment, worker thread loop
- [Table Scan Internals](/execution/scan) — `ScanNodeTable`, `ScanRelTable`, column read path, MVCC visibility
- [GDS & Recursive Traversals](/execution/gds) — variable-length patterns, BFS frontier, shortest-path algorithms, lock-free parent pointers
- [Semi-Mask & SIP Optimization](/execution/semi-mask) — Roaring bitmap semi-masks, I/O skipping

### Query Compilation

- [Full Query Pipeline](/query/pipeline) — end-to-end: parse → bind → plan → optimize → execute
- [Cypher Query Walkthroughs](/query/cypher-internals) — how specific queries execute internally (MATCH, filter, join, aggregation, DML)
- [Parser & ANTLR4 Grammar](/query/parser) — Cypher tokenization, parse tree, AST construction
- [Binder & Type System](/query/binder) — name resolution, type checking, expression binding
- [Logical Planner](/query/planner) — logical plan tree, operator semantics
- [Optimizer](/query/optimizer) — SIP direction selection, predicate pushdown, join ordering
- [Optimizer Passes (Deep Dive)](/query/optimizer-passes) — all 15 passes in order: RemoveFactorization → SIP → TopK → FactorizationRewriter
- [Expression Evaluator](/query/expressions) — expression compilation and evaluation
- [Factorization & Schema Groups](/query/factorization) — factorization plan nodes, `Schema`, `SchemaGroup`, flattening rules
- [Join-Order Enumeration](/query/join-order) — DP-based join-order search, `QueryGraph`, cardinality estimation, hint planning

### Catalog & Schema

- [Catalog System](/catalog) — CatalogSet namespaces, CatalogEntry MVCC version chains, all 14 entry types, DDL flows

### Common Utilities

Shared infrastructure used across storage, query, and execution layers.

- [Type System](/common/type-system) — `LogicalType`, physical representation, type widening, CAST rules
- [Data Chunk & Vector Layer](/common/data-chunk) — `DataChunk`, `DataChunkState`, `ValueVector`, `SelectionVector`, null masks, auxiliary buffers
- [File System Abstraction](/common/file-system) — `FileSystem` virtual interface, local-file implementation, compressed-file wrapper, gzip reader, serializer layer
- [Task Scheduler & Progress](/common/task-scheduler) — worker-thread pool, `Task`/`Processor` decomposition, terminal progress-bar integration

### Extension System

- [Extension Architecture](/extensions/architecture) — `dlopen()` loading, registration API, WAL integration
- [Vector Index (HNSW)](/extensions/vector-index) — approximate nearest-neighbour search, HNSW graph structure
- [Full-Text Search (BM25)](/extensions/fts) — BM25 ranking, inverted index, phrase queries
- [LLM Embeddings](/extensions/llm) — embedding generation, model integration
- [HTTPFS (HTTP / S3 / GCS / Xet)](/extensions/httpfs) — remote object-store connectors
- [External Scanners](/extensions/external-scanners) — DuckDB, Postgres, SQLite, ADBC, Neo4j bridges
- [Lakehouse (Delta / Iceberg / Unity Catalog)](/extensions/lakehouse) — open table format readers
- [Graph Algorithms (ALGO)](/extensions/algo) — built-in graph algorithm library
- [JSON](/extensions/json) — JSON type support and functions

### Client & Connection

- [Connection & Query Lifecycle](/main/connection-lifecycle) — `Connection`, `ClientContext`, per-query state, result streaming
- [COPY FROM Mechanics](/main/copy-mechanics) — CSV/Parquet bulk-load path, parallel reader, schema inference

### Functions

- [Scalar Functions](/functions/scalar-functions) — built-in scalar function registration, dispatch, and vectorized evaluation
- [Table Functions](/functions/table-functions) — `TableFunction` interface, bind/init/scan callbacks, statistics estimation
- [Aggregate Functions](/functions/aggregate-functions) — aggregation states, partial aggregation, finalize step

### API Bindings

- [Python](/api/python) — `ladybug` Python package, `Database`, `Connection`, `QueryResult` types
- [Java](/api/java) — JDBC-style Java binding, JNI bridge
- [Node.js](/api/nodejs) — Node.js addon, async query API
- [Rust](/api/rust) — `ladybug` Rust crate
- [C API](/api/c-api) — stable C ABI: `ladybug_database`, `ladybug_connection`, `ladybug_result`
- [WebAssembly](/api/wasm) — WASM build, browser and Node.js runtime targets

### Development

- [Building LadybugDB](/dev/building) — CMake targets, build types, sanitizers, flags, Windows
- [Testing Guide](/dev/testing) — `.test` file format, gtest C++ tests, running specific tests, datasets
- [Incident Reports](/dev/incidents) — post-mortems and known failure patterns

### Reference

- [Glossary](/glossary)
