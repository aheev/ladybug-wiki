# Checkpointing

> Status: implementation-oriented engineering reference.
>
> Scope: native database checkpoint flow, not only the external SQL `CHECKPOINT` surface.
>
> Primary sources: `transaction_manager.cpp`, `checkpointer.*`, `storage_manager.cpp`, `node_table.cpp`, `rel_table.cpp`, `shadow_file.*`, `shadow_utils.*`, `wal.cpp`, `wal_replayer.cpp`, `database.*`, and `settings.cpp`.

## Why this document exists

Ladybug’s checkpoint path is no longer a single “stop the world, write everything, truncate WAL” sketch.

The current implementation is a split-phase pipeline with explicit snapshot capture, optional WAL rotation, a shadow-file apply step, and post-checkpoint cleanup.

This page describes that real pipeline.

If you need transaction visibility background first, read [MVCC](/transaction/mvcc).

If you need rollback-record mechanics, read [Undo Buffer](/transaction/undo-buffer).

If you need the lower-level storage crash model, read [Shadow + WAL](/storage/shadow-wal) and [WAL Internals](/storage/wal-internals).

## One-paragraph summary

A checkpoint creates a durable on-disk snapshot of committed database state.

The transaction manager first drains active writers and captures a snapshot timestamp.

The checkpointer rotates the active WAL if possible, remembers catalog/page-manager/table-epoch state, optionally releases the write gate early, materializes changed native tables into shadow pages, serializes catalog and metadata, writes a new database header into shadow storage, logs a checkpoint record, applies shadow pages to the data file, and finally resets in-memory “changed since last checkpoint” baselines and WAL/shadow-file state.

Crash recovery then uses the presence or absence of active/frozen WAL files and shadow files to finish or replay the correct durable state.

## Authoritative code map

The key implementation files are:

- `src/transaction/transaction_manager.cpp`
- `src/include/storage/checkpointer.h`
- `src/storage/checkpointer.cpp`
- `src/storage/storage_manager.cpp`
- `src/storage/table/node_table.cpp`
- `src/storage/table/rel_table.cpp`
- `src/include/storage/shadow_file.h`
- `src/storage/shadow_file.cpp`
- `src/include/storage/shadow_utils.h`
- `src/storage/shadow_utils.cpp`
- `src/storage/wal/wal.cpp`
- `src/storage/wal/wal_replayer.cpp`
- `src/include/main/database.h`
- `src/main/database.cpp`
- `src/main/settings.cpp`

The most important implementation facts verified from code are:

- checkpoint coordination starts in `TransactionManager::checkpointNoLock()`
- only active write transactions are drained before checkpointing
- read transactions are allowed to continue under snapshot isolation
- `beginCheckpoint(snapshotTS)` rotates WAL and captures checkpoint state under the write gate
- `checkpointStoragePhase()` runs table checkpointing
- `finishCheckpoint()` serializes catalog/metadata, writes the header, logs checkpoint, and applies shadow pages
- if WAL was rotated, the write gate can be released before storage materialization
- catalog and metadata serialization use snapshot variants when `snapshotTS > 0`
- node tables and relationship tables participate in storage checkpointing via `StorageManager::checkpoint(...)`
- native checkpointing is change-epoch aware and can skip unchanged tables
- post-checkpoint cleanup resets “changed since last checkpoint” baselines and clears WAL/shadow helpers
- recovery distinguishes active WAL, frozen checkpoint WAL, and shadow-file cases
- Arrow and IceDisk tables are read-only and are outside native writable checkpoint materialization

## What a checkpoint means in Ladybug

A checkpoint is **not** the same thing as a transaction commit.

Transaction commit makes new effects logically committed and WAL-durable.

Checkpoint makes a durable data-file snapshot that already includes committed state, so future recovery can start closer to the final database image.

A checkpoint is **not** the same thing as replaying the WAL.

Replay is recovery-time reconstruction.

Checkpoint is normal-operation data-file materialization.

A checkpoint is **not** the same thing as serializing uncommitted transaction-private state.

Only committed state belongs in a checkpoint.

## Components involved

### `TransactionManager`

`TransactionManager` owns the coordination protocol.

It:

- blocks new writers for the drain phase
- waits for active writers to leave
- captures `lastTimestamp` safely
- constructs the `Checkpointer`
- sequences begin/storage/finish/cleanup
- calls rollback on checkpoint failure

### `Checkpointer`

`Checkpointer` owns the concrete checkpoint algorithm.

It stores:

- `snapshotTS`
- `walRotated`
- `checkpointHeader`
- `hasStorageChanges`
- `hasStorageVersionUpgrade`
- `catalogVersionAtCheckpoint`
- `pageManagerVersionAtCheckpoint`
- `tableEpochWatermarks`

It exposes both:

- the current split API
- a legacy monolithic `writeCheckpoint()` helper that mirrors the same overall flow

### `StorageManager`

`StorageManager` drives per-table checkpoint work.

It:

- iterates visible node tables and relationship groups
- calls each table’s `checkpoint(...)`
- captures table change epochs
- finalizes or rolls back page-manager state
- reclaims dropped tables after checkpoint

### `NodeTable` and `RelTable`

Native node and relationship tables know how to materialize themselves into checkpoint pages.

Node tables checkpoint node groups and indexes.

Relationship tables checkpoint directed relationship storage.

### `ShadowFile` and `ShadowUtils`

Checkpoint does not overwrite the main data file in-place immediately.

Instead it writes shadow copies of changed pages and then applies them in a controlled step.

### `WAL`

WAL rotation and checkpoint-record logging define the crash boundary for the split checkpoint flow.

### `DatabaseHeader`

The database header stores catalog and metadata page ranges plus the durable page count.

A checkpoint writes a new header into shadow storage and then applies it with the rest of the shadow pages.

## Trigger paths

### Explicit checkpoint

A caller can invoke checkpoint explicitly through the transaction manager.

### Auto-checkpoint on commit

After a write transaction commits, `TransactionManager::commit(...)` may decide that checkpointing should run.

The condition is:

- transaction forced checkpoint
- or `Checkpointer::canAutoCheckpoint(...)` returns true

`Checkpointer::canAutoCheckpoint(...)` returns true only when all of these hold:

- the database is not in-memory
- `autoCheckpoint` is enabled
- the transaction is not a recovery transaction
- `transaction.getLocalWAL().getSize() + wal->getFileSize()` exceeds `checkpointThreshold`

### Checkpoint on close

`Database::~Database()` attempts a checkpoint if:

- the database is not read-only
- `forceCheckpointOnClose` is enabled

The destructor catches and ignores exceptions there.

That behavior means “best effort on close”, not “throw on close if checkpoint fails”.

### In-memory databases

In-memory databases skip checkpointing entirely.

The `Checkpointer` checks `isInMemory` at every public phase method.

`TransactionManager::checkpoint()` also returns immediately for in-memory databases.

### `COPY FROM` transactional behavior and checkpoints

`COPY FROM` is checkpoint-relevant because the statement execution path explicitly marks the current transaction for forced checkpointing:

```cpp
if (preparedStatement->getStatementType() == StatementType::COPY_FROM) {
    // Note: We always force checkpoint for COPY_FROM statement.
    Transaction::Get(*this)->setForceCheckpoint();
}
```

Two cases matter:

1. **No explicit transaction is active.** `TransactionHelper::runFuncInTransaction(...)` auto-begins a write transaction for the `COPY FROM`, executes the import, commits it on success, and then `TransactionManager::commit(...)` treats `transaction.shouldForceCheckpoint()` as a reason to try checkpointing immediately after commit. In normal user-facing usage, this means a standalone `COPY FROM` runs in its own transaction and requests a post-commit checkpoint.
2. **An explicit manual transaction is already active.** The `COPY FROM` runs inside that existing transaction. The force-checkpoint flag is set on the active transaction object, so the checkpoint request is deferred until that outer transaction eventually commits.

Failure semantics come from the same wrapper. If the import throws at any point, `runFuncInTransaction(...)` catches the exception and calls `context.rollback()`. That means:

- a standalone `COPY FROM` rolls back its partial inserts, local-storage state, undo records, and local WAL buffer
- a `COPY FROM` inside an explicit transaction rolls back the **entire active transaction**, not just the rows imported by that statement
- because `Transaction::shouldForceCheckpoint()` returns false in in-memory mode, none of this triggers checkpointing there even though the flag may have been set earlier in statement execution

So the crash-durability story for `COPY FROM` is “atomic import transaction first, forced checkpoint attempt second.” A failed import never reaches the checkpoint phase because the transaction is rolled back before commit.

## Relevant settings

The primary runtime settings are:

- `autoCheckpoint`
- `checkpointThreshold`
- `forceCheckpointOnClose`

System-config defaults from `database.h` are currently:

- `autoCheckpoint = true`
- `checkpointThreshold = 16777216` bytes, i.e. 16 MB
- `forceCheckpointOnClose = true`

`settings.cpp` exposes setters/getters for these values on the client context.

## Split-phase checkpoint timeline

The real execution flow in `TransactionManager::checkpointNoLock(...)` is:

```text
1. acquire checkpoint mutex
2. stop new write transactions and wait for active writers to leave
3. capture snapshot timestamp under the public-function mutex
4. checkpointer.beginCheckpoint(snapshotTS)
5. if WAL was rotated, release the write gate early
6. checkpointer.checkpointStoragePhase()
7. checkpointer.finishCheckpoint()
8. release the write gate if still held
9. checkpointer.postCheckpointCleanup()
```

Every phase except cleanup is wrapped so failures trigger `checkpointer->rollback()` and are rethrown as `CheckpointException`.

## Drain and gating rules

### Which transactions are blocked?

Only new write transactions are blocked during checkpoint drain.

Read-only transactions can continue.

The comment in `transaction_manager.cpp` is explicit.

Read transactions use MVCC snapshot isolation and can run during checkpoint.

### Waiting for active writers

`stopNewWriteTransactionsAndWaitUntilAllWriteTransactionsLeave()`:

- locks the “start new transactions” gate
- polls until there is no active write transaction
- throws on timeout

If this step throws, checkpoint aborts before any storage work begins.

### Separate checkpoint mutex

Checkpoint also uses a dedicated checkpoint mutex.

This prevents concurrent checkpoint attempts.

It also allows active writers to commit/rollback during drain without deadlocking on the public-function lock.

## Snapshot timestamp capture

After the writer drain succeeds, the transaction manager captures `lastTimestamp` under `mtxForSerializingPublicFunctionCalls`.

This is done to avoid a data race with write commits that increment `lastTimestamp` under that mutex.

The captured value becomes `snapshotTS`.

This timestamp is the MVCC boundary for snapshot-aware checkpoint serialization.

Anything with commit timestamp greater than `snapshotTS` must not appear in the checkpoint snapshot.

## `beginCheckpoint(snapshotTS)`

`Checkpointer::beginCheckpoint(...)` performs the under-write-gate setup.

It does the following.

### Step 1: record the snapshot timestamp

`snapshotTS` is stored on the checkpointer.

### Step 2: rotate WAL if possible

`mainStorageManager->getWAL().rotateForCheckpoint(...)` is called.

If there is no active WAL writer and no WAL file, the method returns false.

If an active WAL exists, it is flushed/synced if necessary and renamed from the active WAL path to the checkpoint WAL path.

This “frozen WAL” concept is crucial.

It isolates the pre-checkpoint committed write stream from new writes that may start after the write gate is released.

### Step 3: capture the current database header

`checkpointHeader` is copied from `getOrInitDatabaseHeader(...)`.

This is the header that `finishCheckpoint()` will later update and write.

### Step 4: apply storage-version upgrades if needed

The header’s storage version is set to `StorageVersionInfo::getStorageVersion()`.

The checkpointer records whether this is a storage-version upgrade.

That matters because it can force catalog/metadata serialization even if there were no ordinary logical changes.

### Step 5: capture “changed since last checkpoint” baselines

While the write gate is still held, the checkpointer snapshots:

- catalog version
- page-manager version
- per-table change epochs

Those values are used later for cleanup and snapshot-aware table checkpoint decisions.

## Why the write gate may be released early

After `beginCheckpoint(...)`, the transaction manager checks `checkpointer->wasWalRotated()`.

If WAL rotation succeeded, it releases the write gate **before** the storage materialization phase.

This is one of the most important details in the current design.

The reasoning is captured directly in source comments:

- new writers can append to a fresh active WAL
- the frozen checkpoint WAL still represents the pre-snapshot durable stream
- node-data reads during `checkpointStoragePhase()` stay bounded to `snapshotTS`

This reduces checkpoint blocking time.

It also means `finishCheckpoint()` may run while new write transactions exist.

The correctness argument depends on snapshot-aware serialization and the frozen WAL boundary.

## Snapshot caveat called out in source

`transaction_manager.cpp` also documents a known limitation.

`HashIndexLocalStorage` has no per-entry timestamps.

So post-`snapshotTS` inserts that occur after the write gate is released may appear in the live on-disk hash index state even when corresponding node data was not part of the checkpoint snapshot.

The comment calls this a pre-existing limitation that requires timestamp-aware hash-index snapshotting as follow-up work.

Do not ignore this caveat when reasoning about perfect snapshot purity for indexes.

## `checkpointStoragePhase()`

This phase is storage materialization only.

It calls `checkpointStorage()` and stores the boolean `hasStorageChanges`.

The helper uses one of two `StorageManager::checkpoint(...)` overloads.

### No-snapshot variant

If `snapshotTS == 0`, `StorageManager::checkpoint(context, pageAllocator)` is used.

### Snapshot-aware variant

If `snapshotTS > 0`, the checkpointer constructs a dummy `Transaction` of type `CHECKPOINT` with that snapshot timestamp.

Then it calls:

- `StorageManager::checkpoint(context, snapshotTxn, pageAllocator, tableEpochWatermarks)`

That tells native table checkpoint code to materialize a snapshot-bounded view where supported.

## `StorageManager::checkpoint(...)`

### Table discovery

Storage manager fetches node-table entries and relationship-group entries from the catalog visible to the relevant checkpoint transaction.

For snapshot mode this means the catalog view at `snapshotTS`.

### Node tables

For each node table:

- verify the table exists in the storage manager
- compute the relevant epoch watermark if snapshot mode is active
- call `table->checkpoint(...)`
- OR the result into `hasChanges`

### Relationship tables

For each relationship group:

- iterate each concrete relationship table entry in the group
- verify the table exists in the storage manager
- compute the epoch watermark if needed
- call `table->checkpoint(...)`
- OR the result into `hasChanges`

Then the relationship-group catalog entry vacuums deleted column IDs.

### Reclaim dropped tables

After iterating tables, storage manager unlocks and calls `reclaimDroppedTables(...)`.

This frees storage for tables no longer visible in the catalog snapshot and removes them from the storage-manager table map.

## Change epochs and skipping unchanged tables

Both `NodeTable::checkpoint(...)` and `RelTable::checkpoint(...)` use an “effective epoch”.

That value is:

- the supplied watermark if one exists
- otherwise the table’s current `changeEpoch`

If `effectiveEpoch <= lastCheckpointedEpoch`, the table reports “no changes” and the checkpoint skips materialization for that table.

This is the main “do not rewrite unchanged tables” optimization in the native checkpoint path.

## Native node-table checkpointing

`NodeTable::checkpoint(...)` is more than “flush columns”.

It is also written for exception safety.

### Step 1: detect whether work is needed

The change-epoch test happens first.

If nothing changed, the function returns false immediately.

### Step 2: build the checkpoint column list without moving ownership

The code acquires `schemaMtx` and builds:

- the current logical `columnIDs`
- a vector of raw `Column*` pointers for checkpoint work

The source comment explains why ownership is not moved yet.

If checkpoint failed after destructive moves, the in-memory `columns` vector could diverge from catalog column IDs and future checkpoints could crash.

### Step 3: checkpoint node groups

A `NodeGroupCheckpointState` is constructed with:

- column IDs
- raw column pointers
- page allocator
- memory manager
- optional `snapshotTxn`

Then `nodeGroups->checkpoint(...)` runs.

This is where native node-group data is materialized into checkpoint pages.

### Step 4: checkpoint indexes

After node-group checkpointing, each node-table index gets `index.checkpoint(context, pageAllocator)`.

The code comment explicitly says the hash-index checkpoint currently operates on live index state rather than a true snapshot transaction view.

### Step 5: vacuum dropped columns only after successful checkpoint

Only after checkpointing succeeds does the code re-acquire `schemaMtx`, move surviving columns into a compact vector, and call `tableEntry->vacuumColumnIDs(0)`.

Then `lastCheckpointedEpoch` is updated.

## Native relationship-table checkpointing

`RelTable::checkpoint(...)` is simpler than the node-table path.

### Step 1: detect whether work is needed

It uses the same effective-epoch vs last-checkpointed-epoch check.

### Step 2: compute checkpoint column IDs

The relationship checkpoint column list always starts with column `0`.

Then visible property column IDs from the catalog entry are appended.

Deleted columns are not checkpointed or serialized.

### Step 3: checkpoint each directed relationship store

For every `directedRelData` entry, the code calls:

- `directedRelData->checkpoint(columnIDs, pageAllocator, snapshotTxn)`

Then it updates `lastCheckpointedEpoch`.

## What checkpoint does **not** materialize

Checkpoint does not serialize transaction-private `LocalStorage` objects.

Checkpoint does not serialize per-transaction `UndoBuffer` instances.

Checkpoint does not serialize the active `LocalWAL` of an uncommitted transaction.

Checkpoint does not make read-only columnar tables writable.

Checkpoint does not force all tables to rewrite if change epochs say nothing changed.

## Catalog serialization

`Checkpointer::serializeCatalogAndMetadata(...)` decides whether catalog pages must be rewritten.

The catalog is rewritten if any of these hold:

- there was no previous valid catalog page range
- the catalog changed since the last checkpoint
- the storage version changed

The method always uses the **main database’s catalog** explicitly.

The source comment warns not to use convenience accessors that may return a graph-specific catalog instead.

### Snapshot vs non-snapshot catalog serialization

If `snapshotTS > 0`:

- `serializeCatalogSnapshot(...)` is used
- it calls `catalog.serializeSnapshot(serializer, snapshotTS)`

Otherwise:

- `serializeCatalog(...)` is used
- it serializes the live catalog state

The serialized bytes are flushed into shadow-managed page ranges.

## Metadata serialization

Metadata serialization covers storage-manager metadata plus page-manager state.

### Conditions that force metadata rewrite

Metadata pages are rewritten if any of these hold:

- there was no previous valid metadata page range
- storage had changes during table checkpointing
- the catalog changed since the last checkpoint
- the page manager changed since the last checkpoint

### Snapshot vs non-snapshot metadata serialization

If `snapshotTS > 0`:

- `serializeMetadataSnapshot(...)` is used
- it constructs a `CHECKPOINT` transaction at `snapshotTS`
- it calls `storageManager.serialize(catalog, snapshotTxn, serializer)`

Otherwise:

- `serializeMetadata(...)` is used
- it calls `storageManager.serialize(catalog, serializer)`

### Page-manager preallocation detail

Both metadata serializers must preallocate enough pages for the page-manager serialization itself before serializing the page manager.

The comment explains why.

The page manager needs to track the pages used for its own serialization.

Because of that, checkpoint may allocate an extra page that is not eventually written.

The code comment says this can create a discrepancy between tracked pages and physical pages in the file, but should not cause incorrect behavior.

## Writing the database header

After catalog and metadata page ranges are prepared, `writeDatabaseHeader(...)` serializes the `DatabaseHeader` into one page.

Then it uses `ShadowUtils::createShadowVersionIfNecessaryAndPinPage(...)` for the database-header page.

The new header bytes are copied into the shadow frame.

The shadow page is unpinned.

Finally the in-memory storage manager is updated with the new header object.

This is important.

The header update is staged through shadow storage like other checkpoint writes.

## Shadow-file protocol during checkpoint

### Why shadow pages exist

Checkpoint should not partially overwrite the live data file page-by-page without a crash boundary.

Shadow pages give the system a durable intermediate representation.

The new page versions are written somewhere else first.

Then they are atomically applied at the storage-protocol level using WAL checkpoint records and recovery rules.

### Creating or reusing a shadow page

`ShadowUtils::createShadowVersionIfNecessaryAndPinPage(...)` does this:

1. ask whether a shadow page already exists for the original page
2. if not, create one in the shadow file
3. pin the shadow page frame
4. copy original page bytes into the shadow page unless `skipReadingOriginalPage` is true
5. mark the shadow page dirty

Once the frame exists, callers mutate the shadow copy rather than the original page.

### Flushing the shadow file

Before the checkpoint record is logged, `shadowFile.flushAll(context)` writes:

- the shadow-file header page
- all dirty shadow pages
- the appended vector of `ShadowPageRecord` mappings
- an fsync via `writer->sync()`

The header records:

- database UUID
- number of shadow pages

### Applying shadow pages

After the checkpoint record is durable, `shadowFile.applyShadowPages(...)` copies each shadow page back into the original data file page location.

For each shadow page record it:

- reads the shadow page from disk
- writes it to the target original page offset in the data file
- updates any in-memory frame for that page through the buffer manager

The method ends with `dataFileInfo->syncFile()`.

### Clearing vs resetting shadow state

After a successful checkpoint core step, `logCheckpointAndApplyShadowPages(...)` calls `shadowFile.clear(...)`.

Later `postCheckpointCleanup()` calls `shadowFile.reset()`.

The distinction is:

- `clear(...)` truncates/removes buffered page contents while keeping the helper initialized for the current process state
- `reset()` drops the file handle and removes the shadow file from disk if it exists

## WAL protocol during checkpoint

### Active WAL and frozen checkpoint WAL

The WAL class distinguishes two file roles during checkpoint:

- active WAL
- checkpoint WAL, i.e. frozen WAL

`rotateForCheckpoint()` renames the active WAL file to the checkpoint WAL path.

After that:

- new commits use a fresh active WAL
- the frozen WAL is the durable pre-checkpoint write stream

### Logging the checkpoint record

After the shadow file is flushed, the checkpointer logs a checkpoint record.

There are two variants.

If WAL was rotated:

- `wal->logAndFlushCheckpointToFrozen(...)`

Otherwise:

- `wal->logAndFlushCheckpoint(...)`

This distinction matters for crash recovery.

The checkpoint record marks that the corresponding shadow pages can be applied safely.

### Clearing WAL state after success

Inside `logCheckpointAndApplyShadowPages(...)`:

- if WAL was not rotated, the active WAL is cleared immediately after shadow-page apply
- if WAL was rotated, the frozen WAL is not deleted there

Then in `postCheckpointCleanup()`:

- rotated case: `clearFrozenWAL()` removes the checkpoint WAL file
- non-rotated case: `reset()` removes the active WAL helper/file state

## `finishCheckpoint()`

This method is intentionally documented as running after the write gate may already have been released.

The source comment spells out the guarantee.

New DDL/write transactions may be active here.

But they assign timestamps strictly greater than `snapshotTS`.

Because `serializeCatalogAndMetadata(...)` chooses snapshot serializers when `snapshotTS > 0`, post-gate DDL mutations are excluded from the serialized checkpoint snapshot.

`finishCheckpoint()` performs:

1. catalog and metadata serialization
2. update of `checkpointHeader.dataFileNumPages`
3. database-header shadow write
4. checkpoint-record logging
5. shadow-page apply

After this method returns successfully, the checkpoint is durable on disk.

## `postCheckpointCleanup()`

This phase is in-memory cleanup only.

The source comment intentionally says there is no try/catch here.

At this point the checkpoint is already durable.

An exception now indicates a programming error.

The method does the following.

### Step 1: finalize page-manager checkpoint state

`mainStorageManager->finalizeCheckpoint()` delegates to `PageManager::finalizeCheckpoint()`.

### Step 2: remove evicted buffer-manager candidates

The buffer manager drops stale eviction candidates.

### Step 3: reset “changed since last checkpoint” baselines

This is subtle and important.

The method calls:

- `catalog->resetVersion(catalogVersionAtCheckpoint)`
- `pageManager->resetVersion(pageManagerVersionAtCheckpoint)`

These do **not** rewind the current catalog/page-manager versions.

They reset the stored `lastCheckpointVersion` baseline used by `changedSinceLastCheckpoint()` checks.

### Step 4: clear WAL helper state

If WAL was rotated:

- clear the frozen WAL file

Else:

- reset the active WAL helper/file state

### Step 5: reset the shadow-file helper

Finally:

- `mainStorageManager->getShadowFile().reset()`

That removes the on-disk shadow file if present and clears shadow-file handles.

## The monolithic `writeCheckpoint()` helper

`Checkpointer::writeCheckpoint()` still exists.

It effectively performs:

1. rotate WAL
2. copy/update header
3. `checkpointStorage()`
4. serialize catalog and metadata
5. write header
6. log checkpoint and apply shadow pages
7. snapshot versions under the write gate
8. `postCheckpointCleanup()`

This helper is a useful reference when reading the class, but the transaction manager’s split-phase flow is the main concurrency-aware checkpoint path.

## Failure and rollback rules

### Where rollback is triggered

In `TransactionManager::checkpointNoLock(...)`, rollback is triggered if any of these throw:

- `beginCheckpoint(...)`
- `checkpointStoragePhase()`
- `finishCheckpoint()`

Each catch block calls `checkpointer->rollback()` before rethrowing as `CheckpointException`.

### What `Checkpointer::rollback()` does

Rollback is intentionally narrow.

It calls:

- `mainStorageManager->rollbackCheckpoint(*catalog)`

### What `StorageManager::rollbackCheckpoint(...)` does

Storage manager rollback currently:

- iterates node tables visible in the checkpoint catalog view
- calls `table->rollbackCheckpoint()` on each node table
- calls `pageManager->rollbackCheckpoint()`

Notably:

- there is no separate relationship-table rollback hook in this function

That is a real code fact.

Do not invent one in documentation.

### Node-table rollback hook

`NodeTable::rollbackCheckpoint()` currently rolls back index checkpoint state by calling `index.rollbackCheckpoint()` for each node-table index.

### Meaning of rollback here

Checkpoint rollback is not transaction rollback.

It is recovery from a failed attempt to produce a new durable checkpoint image.

The goal is to revert checkpoint-side in-memory/page-manager staging so the existing durable checkpoint remains authoritative.

## Crash scenarios and recovery implications

### No WAL files present at startup

In `WALReplayer::replay(...)`:

- if neither frozen WAL nor active WAL exists, the shadow file is removed if present and the checkpointer simply reads the durable checkpoint from the data file

### Frozen WAL exists

A frozen WAL means checkpoint rotation occurred and recovery must inspect whether checkpoint completion reached the durable checkpoint-record boundary.

`replayFrozenWAL(...)` handles this.

#### If the frozen WAL is empty

Recovery removes the frozen WAL and shadow file and reads the data-file checkpoint.

#### If dry replay finds a final checkpoint record

Recovery:

1. replays shadow-page records onto the original data file
2. removes frozen WAL and shadow file
3. reads the checkpoint from the data file

This means the checkpoint was logically committed and only the shadow-page application needed to be finished.

#### If dry replay does **not** end with a checkpoint record

Recovery:

1. removes the shadow file
2. reads the old data-file checkpoint
3. replays committed WAL records from the frozen WAL up to the last good commit boundary
4. removes the frozen WAL

This means the checkpoint did not complete its durable boundary, so recovery falls back to ordinary WAL replay from the previous data-file checkpoint.

### Active WAL exists

`replayActiveWAL(...)` uses the same “dry replay first” idea.

#### If the active WAL ends with a checkpoint record

Recovery:

1. replays shadow pages
2. removes WAL and shadow files
3. reads the checkpoint from the data file

#### If the active WAL does not end with a checkpoint record

Recovery:

1. replays records up to the last good commit boundary
2. truncates the WAL to the valid deserialized offset

### Corruption handling

Dry replay catches deserialization failures.

If `throwOnWalReplayFailure` is true, recovery rethrows.

Otherwise it replays up to the last safe boundary.

Checksums may also be enabled and are validated against WAL headers and readers.

## Reading a checkpoint on startup

`Checkpointer::readCheckpoint()` initializes the data file handle and, if the data file has pages, reads:

- database header
- catalog from the header’s catalog page range
- storage manager metadata from the header’s metadata page range
- page-manager state

Then it reclaims tail pages if needed based on `dataFileNumPages`.

Finally linked extensions are auto-loaded.

## Read transactions during checkpoint

Read transactions are allowed to continue during checkpoint.

This is safe because:

- they use MVCC snapshot isolation
- checkpoint writes shadow pages rather than overwriting in-place immediately
- applying shadow pages updates in-memory frames with page-state coordination so optimistic readers can retry and observe the new version

The design is therefore “writers drain, readers continue”.

## Native tables vs read-only columnar backends

The checkpoint materialization described here is for native writable `NodeTable` and `RelTable` implementations.

Arrow and IceDisk table classes are read-only.

Their base classes reject insert/update/delete.

They are not using local-write commit paths.

They are also not the source of native checkpoint materialization of writable storage state.

This is the safest way to document the current code.

Do not imply that checkpoint converts Arrow/IceDisk external data into native shadow-page state unless code is added to do that.

## Common misconceptions corrected

### “Checkpoint runs only when the system is completely idle.”

No.

Active writers are drained.

Readers may continue.

And if WAL rotation succeeds, new writers may start before storage materialization finishes.

### “Checkpoint serializes the live catalog after the write gate is released.”

Not in snapshot mode.

`finishCheckpoint()` uses snapshot serializers when `snapshotTS > 0`, so post-gate catalog changes are excluded from the checkpoint snapshot.

### “Checkpoint always truncates the WAL immediately.”

No.

The modern flow may rotate the WAL into a frozen checkpoint WAL, later log a checkpoint record there, and only clear/remove WAL files during post-checkpoint cleanup or recovery.

### “Shadow pages are just an optimization.”

No.

They are part of the correctness story for crash-safe checkpoint application.

### “Rollback after failed checkpoint restores an unfinished new checkpoint as durable state.”

No.

Rollback exists so the previous stable on-disk checkpoint remains authoritative when a new checkpoint attempt fails before durable completion.

## Practical debugging checklist

When a checkpoint bug appears, check these questions in order:

1. Did checkpoint actually drain writers or time out waiting?
2. Was `snapshotTS` captured under the public-function mutex?
3. Did WAL rotation succeed?
4. If the write gate was released early, are you accidentally reading post-snapshot state in a non-snapshot-aware component?
5. Did `StorageManager::checkpoint(...)` skip a table because of `lastCheckpointedEpoch`?
6. Was the catalog or page manager marked changed since last checkpoint?
7. Did metadata serialization preallocate page-manager pages correctly?
8. Was the database header written through shadow storage rather than directly?
9. Was the checkpoint record logged to the correct WAL file variant?
10. Did `postCheckpointCleanup()` run and reset version baselines?
11. On restart, was recovery in the “frozen WAL” path or the “active WAL” path?
12. If indexes look ahead of node data, are you hitting the documented hash-index snapshotting limitation?

## Short worked scenarios

### Scenario: auto-checkpoint after a large commit

1. A write transaction commits.
2. Transaction manager notices the local WAL size plus shared WAL size exceeds `checkpointThreshold`.
3. It calls `tryCheckpoint(...)`.
4. If the checkpoint mutex is available, checkpoint begins.
5. Writers drain.
6. Snapshot timestamp is captured.
7. WAL rotates.
8. The write gate may be released early.
9. Storage materialization runs.
10. Finish writes header/checkpoint record and applies shadow pages.
11. Cleanup clears frozen WAL and shadow state.

### Scenario: crash after checkpoint record but before shadow pages were applied fully

1. The shadow file exists.
2. The frozen or active WAL ends with a checkpoint record.
3. On startup recovery sees that the last durable WAL record is checkpoint.
4. Recovery replays shadow-page records to the original data file.
5. Recovery removes WAL/shadow files.
6. Recovery reads the checkpoint from the data file.

### Scenario: crash during storage materialization before checkpoint record

1. A shadow file may exist with partial new pages.
2. The relevant WAL does **not** end with a checkpoint record.
3. On startup recovery discards the shadow file.
4. Recovery reads the previous data-file checkpoint.
5. Recovery replays committed WAL records up to the last valid commit boundary.

## Quick reference tables

### Phase responsibilities

| Phase | Runs under write gate? | Main responsibility |
| --- | --- | --- |
| drain writers | yes | stop new writers and wait for active writers to leave |
| `beginCheckpoint` | yes | rotate WAL, capture snapshot/header/version baselines |
| `checkpointStoragePhase` | maybe no | materialize changed native tables |
| `finishCheckpoint` | maybe no | serialize catalog/metadata, write header, log checkpoint, apply shadow pages |
| `postCheckpointCleanup` | no | finalize page manager, reset version baselines, clear WAL/shadow helpers |

### Durable artifacts

| Artifact | Purpose |
| --- | --- |
| active WAL | normal commit log for current writes |
| frozen checkpoint WAL | pre-checkpoint WAL stream isolated by rotation |
| shadow file | stores checkpoint page copies before apply |
| database header | points to catalog/metadata page ranges and durable page count |

### Recovery decisions

| Startup state | Recovery behavior |
| --- | --- |
| no WAL files | remove stray shadow file and read checkpoint from data file |
| frozen WAL ends with checkpoint record | replay shadow pages, remove files, read checkpoint |
| frozen WAL without final checkpoint record | discard shadow file, read old checkpoint, replay valid WAL records |
| active WAL ends with checkpoint record | replay shadow pages, remove files, read checkpoint |
| active WAL without final checkpoint record | replay valid WAL records and truncate WAL |

## Source-backed checklist of facts to preserve in future edits

Keep these statements aligned with code unless the implementation changes:

- checkpoint coordination begins in `TransactionManager::checkpointNoLock()`
- only writers are drained; readers may continue
- `snapshotTS` is captured under the public-function mutex
- `beginCheckpoint()` rotates WAL and snapshots versions/epochs under the write gate
- the write gate may be released early if WAL rotation succeeded
- `finishCheckpoint()` can therefore run while newer writers exist
- snapshot serializers are chosen when `snapshotTS > 0`
- node and relationship native tables checkpoint through `StorageManager::checkpoint(...)`
- node-table checkpointing is careful not to destructively move columns until success is known
- checkpoint header writes go through shadow storage
- checkpoint durability boundary is the checkpoint WAL record plus shadow-page apply protocol
- `postCheckpointCleanup()` resets `lastCheckpointVersion` baselines, not current versions
- recovery uses frozen/active WAL and shadow-file combinations to decide whether to apply shadow pages or replay WAL
- Arrow and IceDisk are read-only backends and are outside the native write-checkpoint materialization path

## References

- `src/transaction/transaction_manager.cpp`
- `src/include/storage/checkpointer.h`
- `src/storage/checkpointer.cpp`
- `src/storage/storage_manager.cpp`
- `src/storage/table/node_table.cpp`
- `src/storage/table/rel_table.cpp`
- `src/include/storage/shadow_file.h`
- `src/storage/shadow_file.cpp`
- `src/include/storage/shadow_utils.h`
- `src/storage/shadow_utils.cpp`
- `src/storage/wal/wal.cpp`
- `src/storage/wal/wal_replayer.cpp`
- `src/include/main/database.h`
- `src/main/database.cpp`
- `src/main/settings.cpp`
