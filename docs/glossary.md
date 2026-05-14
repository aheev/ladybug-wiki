# Glossary

A reference for technical terms used throughout the LadybugDB internals documentation.

## A

**AccHashJoinOptimizer**
The optimizer pass that decides the SIP direction for each hash join. `ACC` stands for "accumulate". See [SIP Optimization](/execution/semi-mask).

**ANTLR4**
The parser generator used to build LadybugDB's Cypher parser. Grammar file: `src/antlr4/Cypher.g4`.

## B

**BitPacking**
A column compression codec that stores integer values using only as many bits as needed for the range. A column with values 0–7 uses 3 bits per value instead of 8.

**Binder**
The compiler stage that resolves symbolic names (label strings, property names, variable names) to catalog entries and column IDs. Runs after parsing, before logical planning.

**Buffer Manager (BM)**
The subsystem that manages a fixed pool of in-memory page frames, backing all disk I/O. Every read from a storage file goes through pin/unpin. See [Buffer Manager](/storage/buffer-manager).

## C

**Cardinality Estimator**
The component that estimates the number of rows an operator will produce. Used by the join order DP to choose a low-cost query plan.

**Checkpointer**
The component that flushes in-memory committed state to disk and truncates the WAL. See [Checkpointing](/transaction/checkpointing).

**Column Chunk**
One column's data for a single node group (up to 131,072 values). Stored compressed in the data file with a dedicated page range. See [Node Groups](/storage/node-groups).

**Committed Storage**
The set of node groups and their column chunks that have been flushed to the data file and are visible to transactions according to MVCC rules. Contrast with [Local Storage](#local-storage).

**Compression Codec**
One of: `Uncompressed`, `BitPacking`, `RLE` (Run-Length Encoding), `Dictionary`. Chosen per-column at checkpoint time based on the value distribution.

**CSR (Compressed Sparse Row)**
The format used to store relationship adjacency lists on disk. An `indptr[]` array gives the start of each source node's edge list; an `indices[]` array holds destination node IDs. See [CSR Adjacency Lists](/storage/csr).

## D

**DataChunk**
The in-memory batch of rows passed between operators. Contains one `ValueVector` per column and a `SelectionVector` indicating which rows are active. Capacity: 2,048 rows by default. See [Vectorized Execution](/execution/vectorized).

**Dictionary Encoding**
A compression codec that replaces repeated values with small integer codes. Effective for low-cardinality string columns.

## E

**EvictionQueue**
A circular buffer of eviction candidates used by the buffer manager's 2-hand clock eviction algorithm. Batch size: 64 candidates per scan. See [Buffer Manager](/storage/buffer-manager).

**Expression Evaluator**
The runtime component that executes bound expressions on DataChunks. Each expression type has a corresponding evaluator class. See [Expression Evaluator](/query/expressions).

## F

**Factorization**
A query execution technique where intermediate results are represented compactly rather than expanded into full row sets. `(a, {b1,b2}, {c1,c2})` represents 4 tuples as one factorized tuple. The `FlattenRewriter` determines when expansion is needed.

**FileHandle**
The storage abstraction over a single OS file. Holds file descriptor, page states, and VM region. Flags control behavior (read-only, large-paged, in-memory, etc.). See [Buffer Manager](/storage/buffer-manager).

**Filterer**
The storage-layer struct that applies pushed-down predicates during column chunk decompression, allowing entire compressed blocks to be skipped. See [Node Groups](/storage/node-groups).

**Fingerprint (Hash Index)**
A 1-byte hash of a key stored in each `SlotHeader`. Used as a fast rejection filter before doing a full key comparison. 20 fingerprints per slot. See [Hash Index](/storage/hash-index).

## G

**Global Offset**
A node's absolute identifier: `global_offset = node_group_idx × NODE_GROUP_SIZE + offset_within_group`. Used as the primary node ID throughout the system.

## H

**Hash Index**
The primary key index for node tables. Dual-layer: a header page with 2 arrays (entry slots + overflow slots), plus an OverflowFile for string keys. See [Hash Index](/storage/hash-index).

**Hyperedge**
An edge that connects more than two nodes, representing a group relationship. Used internally in the graphify knowledge graph of the codebase, not a native LadybugDB concept.

## I

**Icebug-Disk**
A read-only columnar graph format backed by Parquet files. CSR adjacency lists stored as `indptr_*.parquet` + `indices_*.parquet` pairs. See [Icebug-Disk Format](/storage/icebug-disk).

## L

**Local Storage**
The in-memory staging area for uncommitted writes within a write transaction. Includes `LocalNodeTable`, `LocalRelTable`, `LocalHashIndex`. Flushed to committed storage on commit. See [Local Storage](/transaction/local-storage).

**Logical Plan**
The intermediate representation between the binder and the physical operator tree. A tree of `LogicalOperator` nodes (e.g., `LogicalScanNodeTable`, `LogicalHashJoin`, `LogicalAggregate`). See [Logical Planner](/query/planner).

## M

**Morsel**
The unit of work assigned to a worker thread during parallel execution. For native tables, a morsel is one full node group (~131K rows). For Arrow/Icebug-Disk tables, a morsel is 2,048 rows. See [Morsel-Driven Parallelism](/execution/morsel).

**MVCC (Multi-Version Concurrency Control)**
The isolation mechanism that allows readers to see a consistent snapshot of the database without blocking writers. Implemented via `commitID` stamping and `UndoBuffer` chains. See [MVCC](/transaction/mvcc).

## N

**NullMask**
A bit-packed array within `ValueVector` marking which rows are `NULL`. One bit per row. Allows branchless SIMD operations on value buffers. See [Vectorized Execution](/execution/vectorized).

**NodeGroup**
The fundamental storage unit: up to `NODE_GROUP_SIZE = 131,072` nodes with their properties stored in compressed column chunks. Corresponds to one horizontal partition of a node table.

**NODE_GROUP_SIZE**
`1 << 17 = 131,072`. The number of nodes per node group. Configurable via `NODE_GROUP_SIZE_LOG2`.

## O

**Overflow File**
A side-car file for variable-length data (strings longer than 12 bytes, lists). Accessed via `OverflowFileHandle` and buffer-managed. See [Overflow & String Storage](/storage/overflow).

## P

**PageState**
An atomic `uint64_t` encoding both the page's lock state (UNLOCKED/LOCKED/MARKED/EVICTED) and a version counter for ABA detection. See [Buffer Manager](/storage/buffer-manager).

**Pipeline**
A sequence of pipelined operators that process data without materializing intermediate results to disk. Separated from adjacent pipelines by pipeline-breaking (blocking) operators. See [Pipeline & Operator Model](/execution/pipeline).

**Predicate Push-Down**
Optimizer pass that moves `WHERE` filters as close to the data source as possible, reducing the amount of data flowing through the pipeline.

## R

**RLE (Run-Length Encoding)**
A compression codec that replaces consecutive identical values with a `(value, count)` pair. Effective for sorted or mostly-sorted columns.

**Roaring Bitmap**
The data structure used for semi-masks. A hybrid compressed bitset that stores sparse data as sorted arrays and dense data as bitsets. Supports fast `contains()` and `hasAnyBitInRange()` operations. See [Semi-Mask](/execution/semi-mask).

## S

**SelectionVector (SelVector)**
An indirection array within `DataChunkState` that records which rows in a `ValueVector` are currently active. Filtering updates the SelVector without physically compacting memory. See [Vectorized Execution](/execution/vectorized).

**Semi-Mask**
A Roaring bitmap over node offsets that allows the scan operator to skip entire node groups that contain no relevant nodes. Built during hash join execution. See [Semi-Mask & SIP Optimization](/execution/semi-mask).

**Shadow File**
The durability mechanism for data page writes. Modified pages are written here first; on commit they are atomically swapped into the original data file. See [Shadow File & WAL](/storage/shadow-wal).

**Sink**
The last operator in a pipeline. Consumes DataChunks and accumulates results. Examples: `HashJoinBuild`, `Aggregate`, `ResultCollector`. See [Pipeline & Operator Model](/execution/pipeline).

**SIP (Semi-mask Intersection Pushdown)**
The optimization technique that uses semi-masks to skip node groups during scan, reducing I/O for selective graph joins. See [Semi-Mask & SIP Optimization](/execution/semi-mask).

**SlotHeader**
The header of a hash index slot. Contains a 20-byte fingerprint array and a 32-bit validity mask. See [Hash Index](/storage/hash-index).

**Snapshot Isolation (SI)**
The isolation level used by LadybugDB. Each read transaction sees a consistent snapshot as of its start time, unaffected by concurrent writes. See [MVCC](/transaction/mvcc).

## T

**Transaction ID (txID)**
A monotonically increasing `uint64_t` assigned when a transaction begins. In-progress transactions have `txID >= START_TRANSACTION_ID = 1ULL << 62`. Committed transactions have a `commitID < START_TRANSACTION_ID`.

## U

**UndoBuffer**
A chain of memory buffers recording before-images of all mutations in a write transaction. Iterated in reverse for rollback. See [UndoBuffer Chain](/transaction/undo-buffer).

## V

**ValueVector**
One column's data for a DataChunk batch (up to 2,048 values). Contains a value buffer, a NullMask, and a reference to the shared DataChunkState. See [Vectorized Execution](/execution/vectorized).

**VFS (Virtual File System)**
The file system abstraction layer. Extensions register custom VFS implementations to add S3, HTTP, Azure Blob, and other storage backends. See [Extension Architecture](/extensions/architecture).

## W

**WAL (Write-Ahead Log)**
A sequential log of logical operations (catalog changes, extension loads, table insertions). Used for crash recovery. Data pages use the shadow file mechanism instead. See [Shadow File & WAL](/storage/shadow-wal).
