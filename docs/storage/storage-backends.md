# Storage Backends

**Source files:** `src/storage/table/`, `src/include/storage/table/`

LadybugDB supports multiple storage backends for node and relationship tables. Each backend implements the `NodeTable` or `RelTable` interface but differs in where data lives, how it is organized, and how scan morsels are assigned.

## Overview

| Backend | Node class | Rel class | Data location | Morsel size | Mutable? |
|---------|-----------|-----------|---------------|-------------|----------|
| **Native** | `NodeTable` | `RelTable` | Ladybug columnar files on disk | Node group (~131K rows) | ✅ Full read/write |
| **In-memory** | `NodeTable` | `RelTable` | Same as native, no disk flush | Node group | ✅ Full read/write |
| **Arrow** | `ArrowNodeTable` | `ArrowRelTable` | In-process Arrow RecordBatches | 2048 rows | ❌ Read-only |
| **Icebug-Disk** | `IceDiskNodeTable` | `IceDiskRelTable` | Parquet files (local or object store) | One Parquet row group per morsel | ❌ Read-only |
| **Foreign** | — | `ForeignRelTable` | Points to another database's tables | Node group | ❌ Read-only |

---

## Native Storage (default)

The default backend. All data is stored in Ladybug's own columnar format (see [Node Groups](./node-groups) and [CSR](./csr)).

Created with a standard `CREATE TABLE`:

```cypher
CREATE NODE TABLE person(id INT64, name STRING, age INT32, PRIMARY KEY(id));
CREATE REL TABLE knows(FROM person TO person, since INT32);
```

**Key properties:**
- Full MVCC (reads and writes are versioned — see [MVCC](../transaction/mvcc))
- Compressed storage: BitPacking, RLE, Dictionary encoding (see [Checkpointing](../transaction/checkpointing))
- WAL-backed for durability
- Morsel size = one node group (default 131,072 rows) assigned atomically via `fetch_and_add`

### In-Memory Mode

When the database is opened without a file path (or with `:memory:`), the native backend skips all WAL and shadow-file operations. Tables still use the same columnar format in memory. Useful for tests and ephemeral queries.

```cpp
Database db{""};  // empty path = in-memory
```

---

## Arrow Backend

Wraps one or more Arrow `RecordBatch` objects. Used when data is produced in-process by Arrow-based data sources (e.g., DataFrame imports, Arrow IPC).

Created with `format = 'arrow'`:

```cypher
CREATE NODE TABLE df(id INT64, val DOUBLE, PRIMARY KEY(id))
  WITH (storage = ':memory:', format = 'arrow');
```

**Scan morsel assignment (`ArrowNodeTableScanSharedState`):**

```cpp
// morselSize = 2048 (not the node-group size)
while (currentBatchIdx < batchSizes.size()) {
    auto batchLength = batchSizes[currentBatchIdx];
    if (currentMorselStartOffset < batchLength) {
        scanState->currentBatchIdx = currentBatchIdx;
        scanState->currentMorselStartOffset = currentMorselStartOffset;
        scanState->currentMorselEndOffset =
            std::min(currentMorselStartOffset + morselSize, batchLength);
        this->currentMorselStartOffset = scanState->currentMorselEndOffset;
        return true;
    }
    // advance to next batch
    currentBatchIdx++;
    currentMorselStartOffset = 0;
}
```

**Key properties:**
- Morsel size = 2048 rows (matches the VECTOR_CAPACITY default)
- Shared state uses a mutex for thread-safe morsel assignment across parallel scan threads
- No WAL, no shadow file, no MVCC versioning
- Data lives in Arrow's memory, not Ladybug's buffer pool

---

## Icebug-Disk Backend

Read-only graph storage backed by **Parquet files**. Implements the [Icebug-Disk v1 format](https://github.com/Ladybug-Memory/icebug-format). Files can be on local disk or in object storage (S3, HTTPS).

Created with `format = 'icebug-disk'`:

```cypher
CREATE NODE TABLE city(id INT32, name STRING, PRIMARY KEY(id))
  WITH (storage = '/data/graph', format = 'icebug-disk');

CREATE REL TABLE livesin(FROM user TO city)
  WITH (storage = '/data/graph', format = 'icebug-disk');
```

File naming conventions:
- Node data: `<storage>/nodes_<tableName>.parquet`
- Relationship indices (CSR targets): `<storage>/indices_<tableName>.parquet`
- Relationship CSR row pointers: `<storage>/indptr_<tableName>.parquet`

**Scan internals (`IceDiskNodeTableScanState`):**

```cpp
struct IceDiskNodeTableScanState {
    std::unique_ptr<ParquetReader> parquetReader;
    std::unique_ptr<ParquetReaderScanState> parquetScanState;
    bool dataRead = false;
    std::vector<std::vector<std::unique_ptr<Value>>> allData;
    size_t nextRowToDistribute = 0;
    uint64_t lastQueryId = 0;  // reset on new query
};
```

The scan reads the Parquet file in Arrow batch units. `IceDiskNodeTableScanSharedState` atomically assigns one batch per morsel:

```cpp
bool getNextBatch(node_group_idx_t& assignedBatchIdx) {
    std::lock_guard<std::mutex> lock(mtx);
    if (currentBatchIdx < numBatches) {
        assignedBatchIdx = currentBatchIdx++;
        return true;
    }
    return false;
}
```

**Key properties:**
- Immutable — no ALTER, INSERT, UPDATE, DELETE
- Object-store URIs supported (`s3://`, `https://`, `az://`)
- Each query starts a fresh scan (`lastQueryId` tracks this)
- Relationship tables use the Parquet CSR format (same logical layout as native, different physical encoding)
- If the directory moves, the table must be dropped and re-created with the new path

**See also:** [Icebug-Disk](./icebug-disk) page for the full format specification.

---

## Foreign Relationship Tables

`ForeignRelTable` points to relationship data owned by another database instance. It exists to support cross-database joins without copying data. Not commonly used in application code; primarily an internal mechanism.

---

## Choosing a Backend

| Use case | Recommended backend |
|----------|-------------------|
| Application data with writes | **Native** (default) |
| Large static graphs on object storage | **Icebug-Disk** |
| In-process Arrow DataFrames | **Arrow** |
| Unit tests, ephemeral queries | **In-memory (native)** |
| Analytical queries on read-only graph snapshots | **Icebug-Disk** |

---

## Related Files

- `src/storage/table/node_table.cpp` — native NodeTable
- `src/include/storage/table/arrow_node_table.h` — Arrow backend
- `src/include/storage/table/ice_disk_node_table.h` — Icebug-Disk backend
- `src/include/storage/table/columnar_node_table_base.h` — shared scan state base
- `src/storage/local_storage/` — LocalNodeTable / LocalRelTable (uncommitted write buffer)
- [Node Groups](./node-groups) — native columnar storage format
- [CSR](./csr) — native relationship layout
