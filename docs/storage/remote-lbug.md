# Remote Lbug Databases

**Source files:** `src/main/attached_database.cpp`, `src/main/client_context.cpp`, `src/catalog/catalog.cpp`,
`src/storage/storage_manager.cpp`, `src/storage/file_handle.cpp`, `src/storage/buffer_manager/`,
`src/storage/table/`, `src/storage/index/`

This page summarizes how LadybugDB handles an attached remote Lbug database.
It is the same storage engine, just opened through a remote path and forced into read-only mode.

## Attach semantics

`ATTACH ... (dbtype lbug)` requires an alias.
The binder rejects anonymous remote Lbug attachments.

At attach time Ladybug:

1. expands the path through the active VFS
2. rejects in-memory paths
3. rejects missing paths
4. rejects non-empty WAL files
5. opens `StorageManager(..., true /* isReadOnly */)`
6. loads the checkpointed state into memory

So the remote database is not treated as a foreign scanner.
It becomes an attached Ladybug storage root.

## Query routing

Once attached, the session context points at the remote database.
That changes the lookup path for:

- `Catalog::Get()` → attached DB catalog first
- `StorageManager::Get()` → attached DB storage first
- `TransactionManager::Get()` → attached DB transaction manager path

That is why queries like `SELECT * FROM tenant1.person` use the same native table scan path.

## How reads happen

Reads are page-based.
The scan path is:

1. table scan enters `NodeTable::scanInternal()` or `RelTable::scanInternal()`
2. scan state walks node groups / CSR groups
3. column chunks call `Column::scan()` / `Column::scanSegment()`
4. `ColumnReadWriter::readFromPage()` asks the file handle for the page
5. `FileHandle::optimisticReadPage()` routes through the buffer manager
6. `BufferManager::pin()` loads the page if needed
7. `cachePageIntoFrame()` calls `FileInfo::readFromFile()` on the remote VFS file
8. the column code decompresses/copies values into the output `ValueVector`

So remote Lbug does **not** download the whole database.
It reads the specific pages needed for the query.

## What gets cached locally

The buffer manager caches the pages it touched:

- table data pages
- index pages
- overflow-string pages
- any other file pages accessed through the storage path

There is no TTL.
Pages remain resident until they are unpinned and later evicted under memory pressure.
Pinned pages stay resident while in use.

## Indexes

Indexes use the same page cache.

- hash indexes use disk-array pages plus overflow-file pages
- ART primary-key indexes serialize to disk pages and are read back through the same file-handle path

So indexed lookups on a remote Lbug DB still use local page caching; only the backing file path is remote.

## Practical takeaway

Remote Lbug behaves like:

> remote file path + local page cache + native Ladybug execution

That means query semantics, MVCC, scans, and indexes are unchanged.
Only the file transport changes.
