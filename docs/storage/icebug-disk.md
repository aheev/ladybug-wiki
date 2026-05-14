# Icebug-Disk Format

**Source files:** `src/extension/` (icebug-disk extension), `docs/icebug-disk.md`

## Overview

Icebug-Disk is a **read-only columnar graph storage format** built on Parquet files. It stores the graph externally from the LadybugDB data file and maps CSR adjacency lists directly to Parquet file pairs. Designed for large read-only analytical graphs served from local disk or object storage (S3, Azure Blob).

## Version

Format version stored in each Parquet file's metadata footer as a key-value pair:
```
icebug_disk_version = v1
```

## File Mapping

### Node Table
One Parquet file per node table:
```
nodes_{tableName}.parquet
```
Layout: one Parquet column per node property, plus the primary key column. Rows are ordered by node offset (row i = node with offset i).

### Relationship Table
Two Parquet files per relationship table (CSR encoding):

```
indices_{tableName}.parquet    ← one row per edge
  columns: [target (nodeID), prop0, prop1, ...]

indptr_{tableName}.parquet     ← N+1 integer rows (CSR row pointers)
  columns: [ptr (uint64)]
```

This directly encodes the [CSR format](/storage/csr):
```python
# Get all neighbors of source node X:
start = indptr[X]
end   = indptr[X + 1]
neighbors = indices[start:end]["target"]
```

## Schema Declaration

Tables are registered via Cypher `CREATE TABLE` with storage annotations:

```cypher
CREATE NODE TABLE city(
    id INT32, name STRING, population INT64,
    PRIMARY KEY(id)
) WITH (storage = '/data/graph', format = 'icebug-disk');

CREATE REL TABLE follows(
    FROM user TO user,
    since INT32
) WITH (storage = '/data/graph', format = 'icebug-disk');
```

File path resolution:
- `storage = '/data/graph'` → files at `/data/graph/nodes_city.parquet`, `/data/graph/indices_follows.parquet`, etc.
- Object store URIs (`s3://bucket/path`) passed through to the httpfs extension
- Relative paths resolved from current working directory

## Immutability Constraints

Icebug-Disk tables are **strictly read-only**:
- No `ALTER TABLE`
- No `INSERT`, `UPDATE`, `DELETE`
- No `CREATE INDEX`

Write attempts throw a `BinderException` at query compilation time.

Mixed tables (joining Icebug-Disk with native writable tables) in a single `CREATE REL TABLE` statement also throw `BinderException`.

## Scan Integration

Icebug-Disk tables plug into the standard scan operator framework. The scan operator detects `format='icebug-disk'` and delegates to `IcebugDiskNodeTableScanState` / `IcebugDiskRelTableScanState` which:

1. Open the relevant Parquet file via `OverlayFileHandle`
2. Map Parquet row groups → morsel assignments (morsel = one Parquet row group)
3. Decode Parquet columns into `ValueVector`s using the Arrow Parquet reader
4. Apply SelVector filtering at the ValueVector level

The morsel assignment for Icebug-Disk uses `ArrowNodeTableScanSharedState` with a 2048-row morsel size (sub-row-group), the same as the Arrow table scan path.

## Converting From Other Formats

Conversion scripts are available at `https://github.com/Ladybug-Memory/icebug-format` for transforming DuckDB tables or raw Parquet files into the Icebug-Disk CSR layout.

## Related Files

- `docs/icebug-disk.md` — original design notes
- `src/extension/` — extension registration and scan operator
- `src/storage/table/arrow_node_table.cpp` — Arrow-based scan path shared with Icebug-Disk
