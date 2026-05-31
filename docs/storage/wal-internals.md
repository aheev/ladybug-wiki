# WAL Internals

**Authoritative source files:**

- `src/include/storage/wal/wal.h`
- `src/include/storage/wal/local_wal.h`
- `src/include/storage/wal/wal_replayer.h`
- `src/include/storage/wal/checksum_writer.h`
- `src/include/storage/wal/checksum_reader.h`
- `src/include/storage/wal/record/*.h`
- `src/storage/wal/wal.cpp`
- `src/storage/wal/local_wal.cpp`
- `src/storage/wal/wal_replayer.cpp`
- `src/storage/wal/checksum_writer.cpp`
- `src/storage/wal/checksum_reader.cpp`
- `src/storage/wal/wal_record.cpp`
- `src/storage/wal/records/*.cpp`
- `src/transaction/transaction.cpp`
- `src/transaction/transaction_manager.cpp`
- `src/include/storage/storage_utils.h`
- `src/include/common/constants.h`
- `src/storage/storage_manager.cpp`
- `src/main/database.cpp`
- `src/main/attached_database.cpp`

This page documents the actual WAL implementation in the tree above.

For checkpoint orchestration, see [Checkpointing](/transaction/checkpointing).

For the in-memory data structures that are committed before WAL bytes are flushed, see [Local Storage](/transaction/local-storage).

For the page-shadowing side of durability, see [Shadow WAL / Shadow File Internals](/storage/shadow-wal).

---

## 1. Scope and terminology

Ladybug has **two different WAL objects** in code:

1. `storage::LocalWAL`
2. `storage::WAL`

They are related, but they are not the same thing.

`LocalWAL` is:

- per transaction
- in memory
- backed by `common::InMemFileWriter`
- discarded on rollback
- appended to the global WAL only on commit

`WAL` is:

- per database
- shared
- on disk unless the database path is in-memory
- the object that owns the active WAL path and the rotated checkpoint WAL path
- the object used by recovery and checkpoint code

The implementation is therefore **transaction-local staging + database-global append-only persistence**, not a single monolithic WAL buffer.

## 2. In-memory mode

The WAL stack is only meaningful for on-disk databases. The code treats an empty database path or `:memory:` as in-memory mode:

```cpp
bool DBConfig::isDBPathInMemory(const std::string& dbPath) {
    return dbPath.empty() || dbPath == ":memory:";
}
```

That choice cascades all the way through transaction and checkpoint control:

- `Transaction::shouldLogToWAL()` returns `false` for every write transaction when `clientContext->isInMemory()` is true.
- `Transaction::shouldForceCheckpoint()` also returns `false` in memory, so a standalone `COPY FROM` cannot force a checkpoint there.
- `TransactionManager::checkpoint(...)` and `TransactionManager::tryCheckpoint(...)` return immediately for in-memory databases.
- `Checkpointer::canAutoCheckpoint(...)` returns `false`, and `Checkpointer::rollback()` becomes a no-op.

The practical effect is simple but important: **all WAL logic is bypassed in in-memory mode**. No `.wal`, `.wal.checkpoint`, or `.shadow` files are part of the transaction lifecycle, durability lasts only for the process lifetime, and recovery has nothing to replay after process exit. Transactions still exist for MVCC, undo, and statement atomicity, but they do not become disk-durable through WAL.

---

## 3. Corrections to common assumptions

These points are easy to get wrong if you only look at high-level docs.

### 2.1 There is no fixed `record_type + payload_size + checksum` wire format

The code does **not** write a hand-rolled header like:

- `uint8 record_type`
- `uint64 payload_size`
- payload bytes
- `uint64 checksum`

Instead, records are serializer-defined objects.

Each record is written as:

1. `Writer::onObjectBegin()`
2. `WALRecord::serialize(...)` plus record-specific field serialization
3. `Writer::onObjectEnd()`

If checksums are enabled, `ChecksumWriter` interprets the object boundary and writes:

- serialized object bytes
- trailing `uint64_t` checksum for that object

There is **no payload-size field in WALRecord itself**.

### 2.2 BEGIN is inserted lazily

`LocalWAL` does **not** log a begin record when the transaction object is created.

The first call to `LocalWAL::addNewWALRecord(...)` inserts `BeginTransactionRecord` automatically **only if**:

- `hasLoggedBegin == false`
- the new record is **not** `BEGIN_TRANSACTION_RECORD`
- the new record is **not** `COMMIT_RECORD`

That means empty write transactions do not create a BEGIN/COMMIT pair.

### 2.3 COMMIT is conditional

`LocalWAL::logCommit()` returns immediately if `hasLoggedBegin` is false.

So the commit record is appended only if something earlier caused BEGIN to be auto-inserted.

### 2.4 The global WAL copies committed local WAL bytes directly

`WAL::logCommittedWAL(LocalWAL&, ...)` does **not** deserialize and reserialize each local record.

It calls:

```cpp
localWAL.inMemWriter->flush(*serializer->getWriter());
```

So the shared WAL appends the already-serialized local WAL bytes directly.

### 2.5 The “frozen WAL” is just the rotated checkpoint WAL file

There is no separate in-memory or logical “frozen WAL snapshot” type.

`WAL::rotateForCheckpoint()` literally renames:

- active: `dbPath.wal`
- rotated checkpoint WAL: `dbPath.wal.checkpoint`

That rotated file is what the code informally treats as the frozen WAL.

### 2.6 `CopyTableRecord` exists, but replay is currently a no-op

The enum value exists.

The serializer exists.

The replay dispatch exists.

But the implementation is:

```cpp
void WALReplayer::replayCopyTableRecord(const WALRecord&) const {}
```

A search in `src/` does not show a normal emission path that constructs or logs this record.

### 2.7 There is no group commit implementation here

The commit path is immediate and synchronous:

- transaction commit enters `TransactionManager::commit(...)`
- local WAL gets a COMMIT record if needed
- `WAL::logCommittedWAL(...)` appends bytes
- `WAL::flushAndSyncNoLock()` flushes and syncs the file

There is no batching queue, no commit leader, and no explicit group-commit coordinator in the inspected code.

---

## 4. Path derivation and file naming

The file names are derived by `StorageUtils` and `StorageConstants`.

From `src/include/common/constants.h`:

```cpp
struct StorageConstants {
    static constexpr page_idx_t DB_HEADER_PAGE_IDX = 0;
    static constexpr char WAL_FILE_SUFFIX[] = "wal";
    static constexpr char CHECKPOINT_WAL_FILE_SUFFIX[] = "wal.checkpoint";
    static constexpr char SHADOWING_SUFFIX[] = "shadow";
    static constexpr char TEMP_FILE_SUFFIX[] = "tmp";
};
```

From `src/include/storage/storage_utils.h`:

```cpp
static std::string getWALFilePath(const std::string& path) {
    return std::format("{}.{}", path, common::StorageConstants::WAL_FILE_SUFFIX);
}
static std::string getCheckpointWALFilePath(const std::string& path) {
    return std::format("{}.{}", path, common::StorageConstants::CHECKPOINT_WAL_FILE_SUFFIX);
}
static std::string getShadowFilePath(const std::string& path) {
    return std::format("{}.{}", path, common::StorageConstants::SHADOWING_SUFFIX);
}
```

So for a database path `/data/demo` the file names are:

| Helper | Result |
|---|---|
| `getWALFilePath("/data/demo")` | `/data/demo.wal` |
| `getCheckpointWALFilePath("/data/demo")` | `/data/demo.wal.checkpoint` |
| `getShadowFilePath("/data/demo")` | `/data/demo.shadow` |

This is the exact suffix set used by the implementation:

- `wal`
- `wal.checkpoint`
- `shadow`

One subtle but important point: the source does **not** enforce a `.lbug` base-file extension. The helpers append suffixes to whatever database path string the caller supplied. If the database path is `/data/demo.lbug`, the derived files are `/data/demo.lbug.wal`, `/data/demo.lbug.wal.checkpoint`, and `/data/demo.lbug.shadow`. If the path is `/data/demo`, the derived files are `/data/demo.wal`, `/data/demo.wal.checkpoint`, and `/data/demo.shadow`.

---

## 5. Lifecycle overview

The WAL path through the system spans:

- `Transaction`
- `TransactionManager`
- `LocalWAL`
- `WAL`
- `Checkpointer`
- `WALReplayer`

A minimal control-flow sketch is:

```text
write statement
  -> LocalStorage / table mutation code
  -> LocalWAL logs logical records in memory
  -> Transaction::commit()
       -> LocalStorage::commit()
       -> UndoBuffer::commit(commitTS)
       -> LocalWAL::logCommit()
       -> WAL::logCommittedWAL(localWAL)
       -> LocalWAL::clear()
  -> later checkpoint
       -> WAL rotate or active checkpoint marker
       -> shadow pages flushed/applied
       -> WAL cleared/reset
  -> startup recovery
       -> WALReplayer::replay(...)
```

This ordering matters.

`Transaction::commit(storage::WAL* wal)` is currently:

```cpp
void Transaction::commit(storage::WAL* wal) {
    localStorage->commit();
    undoBuffer->commit(commitTS);
    if (shouldLogToWAL()) {
        DASSERT(localWAL && wal);
        localWAL->logCommit();
        wal->logCommittedWAL(*localWAL, clientContext);
        localWAL->clear();
    }
    if (hasCatalogChanges) {
        Catalog::Get(*clientContext)->incrementVersion();
        hasCatalogChanges = false;
    }
}
```

Important engineering consequences:

- in-memory committed state is updated before the WAL flush returns
- durability is only established once `WAL::logCommittedWAL(...)` has flushed and synced
- the commit call does not return until the shared WAL sync completes
- rollback never writes a rollback record; it discards local state and undo state in memory

---

## 5. `LocalWAL`: per-transaction in-memory WAL

### 5.1 Construction

From `src/storage/wal/local_wal.cpp`:

```cpp
LocalWAL::LocalWAL(MemoryManager& mm, bool enableChecksums)
    : inMemWriter(std::make_shared<InMemFileWriter>(mm)),
      serializer(enableChecksums ? std::make_shared<ChecksumWriter>(inMemWriter, mm) :
                                   std::static_pointer_cast<Writer>(inMemWriter)) {}
```

Properties:

- storage is `InMemFileWriter`
- serialization is done immediately into the in-memory writer
- when checksums are enabled, the local writer itself is checksum-aware
- the local WAL owns a mutex even though usage is typically single-transaction

### 5.2 Public logging API

`LocalWAL` exposes typed logging methods:

```cpp
void logCreateCatalogEntryRecord(catalog::CatalogEntry* catalogEntry, bool isInternal);
void logDropCatalogEntryRecord(uint64_t tableID, catalog::CatalogEntryType type);
void logAlterCatalogEntryRecord(const binder::BoundAlterInfo* alterInfo);
void logUpdateSequenceRecord(common::sequence_id_t sequenceID, uint64_t kCount);

void logTableInsertion(common::table_id_t tableID, common::TableType tableType,
    common::row_idx_t numRows, const std::vector<common::ValueVector*>& vectors);
void logNodeDeletion(common::table_id_t tableID, common::offset_t nodeOffset,
    common::ValueVector* pkVector);
void logNodeUpdate(common::table_id_t tableID, common::column_id_t columnID,
    common::offset_t nodeOffset, common::ValueVector* propertyVector);
void logRelDelete(common::table_id_t tableID, common::ValueVector* srcNodeVector,
    common::ValueVector* dstNodeVector, common::ValueVector* relIDVector);
void logRelDetachDelete(common::table_id_t tableID, common::RelDataDirection direction,
    common::ValueVector* srcNodeVector);
void logRelUpdate(common::table_id_t tableID, common::column_id_t columnID,
    common::ValueVector* srcNodeVector, common::ValueVector* dstNodeVector,
    common::ValueVector* relIDVector, common::ValueVector* propertyVector);

void logLoadExtension(std::string path);
void logCommit();
```

There is **no public `logBegin()`**.

### 5.3 Lazy BEGIN insertion

The core rule lives in `LocalWAL::addNewWALRecord(...)`:

```cpp
void LocalWAL::addNewWALRecord(const WALRecord& walRecord) {
    std::unique_lock lck{mtx};
    if (!hasLoggedBegin && walRecord.type != WALRecordType::BEGIN_TRANSACTION_RECORD &&
        walRecord.type != WALRecordType::COMMIT_RECORD) {
        BeginTransactionRecord beginRecord;
        addNewWALRecordNoLock(beginRecord);
        hasLoggedBegin = true;
    }
    addNewWALRecordNoLock(walRecord);
}
```

So the first ordinary record causes the transaction-local byte stream to become:

```text
BEGIN
<first logical record>
```

### 5.4 Commit record insertion

`logCommit()` is intentionally conditional:

```cpp
void LocalWAL::logCommit() {
    std::unique_lock lck{mtx};
    if (!hasLoggedBegin) {
        return;
    }
    CommitRecord walRecord;
    addNewWALRecordNoLock(walRecord);
}
```

That means:

- no BEGIN -> no COMMIT
- no WAL bytes at all for an otherwise empty write transaction
- safe to call unconditionally from `Transaction::commit()`

### 5.5 Object-bracketed serialization

Every local record is written with `onObjectBegin()` / `onObjectEnd()`:

```cpp
void LocalWAL::addNewWALRecordNoLock(const WALRecord& walRecord) {
    DASSERT(walRecord.type != WALRecordType::INVALID_RECORD);
    serializer.getWriter()->onObjectBegin();
    walRecord.serialize(serializer);
    serializer.getWriter()->onObjectEnd();
}
```

If checksums are disabled:

- begin/end do nothing
- raw serializer bytes land in the in-memory buffer

If checksums are enabled:

- begin/end delimit exactly one checksummed object
- `ChecksumWriter` accumulates the object payload and appends a trailing `uint64_t` checksum

### 5.6 Size and reset semantics

`getSize()` returns the current serialized size in bytes:

```cpp
uint64_t LocalWAL::getSize() {
    std::unique_lock lck{mtx};
    return serializer.getWriter()->getSize();
}
```

`clear()` resets both the bytes and the begin flag:

```cpp
void LocalWAL::clear() {
    std::unique_lock lck{mtx};
    serializer.getWriter()->clear();
    hasLoggedBegin = false;
}
```

This is the object that `Checkpointer::canAutoCheckpoint(...)` measures together with the shared WAL size.

---

## 6. Where records are emitted from

The WAL records are not emitted by the recovery code.

They are emitted by normal write paths.

### 6.1 Transaction-level catalog and sequence logging

From `src/transaction/transaction.cpp`:

- `pushCreateDropCatalogEntry(...)`
- `pushAlterCatalogEntry(...)`
- `pushSequenceChange(...)`
- `logLoadExtension(...)` through extension management

Examples:

```cpp
localWAL->logCreateCatalogEntryRecord(newCatalogEntry, isInternal);
localWAL->logDropCatalogEntryRecord(catalogEntry.getOID(), catalogEntry.getType());
localWAL->logAlterCatalogEntryRecord(&alterInfo);
localWAL->logUpdateSequenceRecord(sequenceEntry->getOID(), kCount);
```

### 6.2 Node-table DML logging

From `src/storage/table/node_table.cpp`:

```cpp
wal.logTableInsertion(tableID, TableType::NODE,
    nodeInsertState.nodeIDVector.state->getSelVector().getSelSize(),
    insertState.propertyVectors);
```

```cpp
wal.logNodeUpdate(tableID, nodeUpdateState.columnID, nodeOffset,
    &nodeUpdateState.propertyVector);
```

```cpp
wal.logNodeDeletion(tableID, nodeOffset, &nodeDeleteState.pkVector);
```

### 6.3 Relationship-table DML logging

From `src/storage/table/rel_table.cpp`:

```cpp
wal.logTableInsertion(tableID, TableType::REL,
    relInsertState.srcNodeIDVector.state->getSelVector().getSelSize(), vectorsToLog);
```

```cpp
wal.logRelUpdate(tableID, relUpdateState.columnID, &relUpdateState.srcNodeIDVector,
    &relUpdateState.dstNodeIDVector, &relUpdateState.relIDVector,
    &relUpdateState.propertyVector);
```

```cpp
wal.logRelDelete(tableID, &relDeleteState.srcNodeIDVector,
    &relDeleteState.dstNodeIDVector, &relDeleteState.relIDVector);
```

```cpp
wal.logRelDetachDelete(tableID, direction, &deleteState->srcNodeIDVector);
```

### 6.4 What this means architecturally

The WAL is a **logical operation log**, not a physical page-delta log.

Page copying and page replacement are handled by the shadow-file path described in:

- [Checkpointing](/transaction/checkpointing)
- [Local Storage](/transaction/local-storage)
- [Shadow WAL / Shadow File Internals](/storage/shadow-wal)

---

## 7. `WAL`: shared on-disk append-only log

### 7.1 Construction

From `src/storage/wal/wal.cpp`:

```cpp
WAL::WAL(const std::string& dbPath, bool readOnly, bool enableChecksums, VirtualFileSystem* vfs)
    : walPath{StorageUtils::getWALFilePath(dbPath)},
      checkpointWalPath{StorageUtils::getCheckpointWALFilePath(dbPath)},
      inMemory{main::DBConfig::isDBPathInMemory(dbPath)}, readOnly{readOnly}, vfs{vfs},
      enableChecksums(enableChecksums) {}
```

It stores both paths:

- `walPath`
- `checkpointWalPath`

### 7.2 Lazy writer initialization

`WAL::initWriter(...)` opens the file only when needed:

```cpp
fileInfo = vfs->openFile(walPath,
    FileOpenFlags(FileFlags::CREATE_IF_NOT_EXISTS | FileFlags::READ_ONLY | FileFlags::WRITE),
    context);
```

Then it installs either:

- `BufferedFileWriter`
- or `ChecksumWriter(BufferedFileWriter(...))`

If the file is empty, it writes the WAL header.

Finally it sets the file offset to EOF:

```cpp
bufferedWriter.setFileOffset(fileInfo->getFileSize());
```

The WAL is intentionally append-only.

### 7.3 WAL header format

The header type is defined in `wal_record_base.h`:

```cpp
struct WALHeader {
    common::uuid databaseID;
    bool enableChecksums;
};
```

The header is written by `WAL::writeHeader(...)`:

```cpp
void WAL::writeHeader(main::ClientContext& context) {
    serializer->getWriter()->onObjectBegin();
    FileDBIDUtils::writeDatabaseID(*serializer,
        StorageManager::Get(context)->getOrInitDatabaseID(context));
    serializer->write(enableChecksums);
    serializer->getWriter()->onObjectEnd();
}
```

Key details:

- the header is its own serializer object
- it is checksum-wrapped when checksums are enabled
- the database UUID is copied from the persistent database header via `StorageManager`

### 7.4 Commit append path

The hot path is:

```cpp
void WAL::logCommittedWAL(LocalWAL& localWAL, main::ClientContext* context) {
    DASSERT(!readOnly);
    if (inMemory || localWAL.getSize() == 0) {
        return; // No need to log empty WAL.
    }
    std::unique_lock lck{mtx};
    initWriter(context);
    localWAL.inMemWriter->flush(*serializer->getWriter());
    flushAndSyncNoLock();
}
```

Important behavior:

- the shared WAL mutex serializes durable append
- in-memory databases skip this entirely
- empty local WALs are ignored
- the local bytes are appended directly
- the file is flushed and synced before returning

### 7.5 Checksum interaction on commit append

`WAL` has this comment in the header:

```cpp
// Since most writes to the shared WAL will be flushing local WAL (which has its own checksums),
// these writes can go through the normal writer. We do still need a checksum writer though for
// writing COMMIT/CHECKPOINT records
```

The implementation nuance is:

- the shared serializer may own a `ChecksumWriter`
- but `localWAL.inMemWriter->flush(*serializer->getWriter())` writes raw bytes directly to the underlying shared writer while no object is open
- `ChecksumWriter::write(...)` only buffers-and-checksums when `currentEntrySize` is set by `onObjectBegin()`
- therefore already-checksummed local record objects are copied byte-for-byte without being wrapped a second time

This is the reason global WAL append can reuse local serialized bytes.

### 7.6 Checkpoint marker append path

For the active WAL:

```cpp
void WAL::logAndFlushCheckpoint(main::ClientContext* context) {
    std::unique_lock lck{mtx};
    initWriter(context);
    CheckpointRecord walRecord;
    addNewWALRecordNoLock(walRecord);
    flushAndSyncNoLock();
}
```

For the rotated checkpoint WAL:

```cpp
void WAL::logAndFlushCheckpointToFrozen(main::ClientContext* context) {
    auto frozenFileInfo = vfs->openFile(checkpointWalPath,
        FileOpenFlags(FileFlags::READ_ONLY | FileFlags::WRITE), context);

    std::shared_ptr<Writer> writer = std::make_shared<BufferedFileWriter>(*frozenFileInfo);
    auto& bufferedWriter = writer->cast<BufferedFileWriter>();
    if (enableChecksums) {
        writer = std::make_shared<ChecksumWriter>(std::move(writer), *MemoryManager::Get(*context));
    }
    auto frozenSerializer = std::make_unique<Serializer>(std::move(writer));
    bufferedWriter.setFileOffset(frozenFileInfo->getFileSize());

    CheckpointRecord walRecord;
    frozenSerializer->getWriter()->onObjectBegin();
    walRecord.serialize(*frozenSerializer);
    frozenSerializer->getWriter()->onObjectEnd();
    frozenSerializer->getWriter()->flush();
    frozenSerializer->getWriter()->sync();
}
```

This matters because the checkpoint record may be appended either:

- to the active WAL when no rotation happened
- or to the rotated checkpoint WAL when rotation happened

### 7.7 Rotation

`rotateForCheckpoint(...)` is the entire “freeze” operation:

```cpp
bool WAL::rotateForCheckpoint(main::ClientContext* /*context*/) {
    std::unique_lock lck{mtx};
    if (inMemory) {
        return false;
    }
    if (!serializer && !vfs->fileOrPathExists(walPath)) {
        return false;
    }
    if (serializer) {
        flushAndSyncNoLock();
        fileInfo.reset();
        serializer.reset();
    }
    vfs->renameFile(walPath, checkpointWalPath);
    return true;
}
```

Observations:

- rotation is skipped for in-memory DBs
- rotation is skipped when there is neither an open writer nor an on-disk active WAL file
- if a writer exists, it is flushed and torn down before rename
- the rotated file simply becomes `dbPath.wal.checkpoint`

### 7.8 Clear vs reset

`clear()`:

```cpp
void WAL::clear() {
    std::unique_lock lck{mtx};
    serializer->getWriter()->clear();
}
```

`reset()`:

```cpp
void WAL::reset() {
    std::unique_lock lck{mtx};
    fileInfo.reset();
    serializer.reset();
    vfs->removeFileIfExists(walPath);
}
```

So:

- `clear()` truncates the existing active WAL writer buffer/file to zero bytes
- `reset()` destroys the writer state and removes the active WAL file entirely

### 7.9 Shared WAL size used for auto-checkpoint decisions

`WAL::getFileSize()` returns either:

- 0 for in-memory or missing WAL
- actual on-disk file size if no writer is open
- writer size if a writer is open

This is combined with the current transaction’s local WAL size by `Checkpointer::canAutoCheckpoint(...)`.

---

## 8. Auto-checkpoint trigger

The actual code is:

```cpp
bool Checkpointer::canAutoCheckpoint(const main::ClientContext& clientContext,
    const transaction::Transaction& transaction) {
    if (clientContext.isInMemory()) {
        return false;
    }
    if (!clientContext.getDBConfig()->autoCheckpoint) {
        return false;
    }
    if (transaction.isRecovery()) {
        return false;
    }
    auto wal = WAL::Get(clientContext);
    const auto expectedSize = transaction.getLocalWAL().getSize() + wal->getFileSize();
    return expectedSize > clientContext.getDBConfig()->checkpointThreshold;
}
```

So the metric is:

```text
transaction.local_wal_size + global_wal_size > checkpointThreshold
```

Notable details:

- the size includes the current transaction’s not-yet-flushed local WAL bytes
- recovery transactions are excluded
- in-memory DBs are excluded
- the public database constructor defaults `checkpointThreshold` to `16777216 /* 16MB */`

From `src/include/main/database.h`:

```cpp
bool autoCheckpoint = true, uint64_t checkpointThreshold = 16777216 /* 16MB */,
```

---

## 9. WAL record type table

The enum lives in `src/include/storage/wal/record/wal_record_base.h`.

```cpp
enum class WALRecordType : uint8_t {
    INVALID_RECORD = 0,
    BEGIN_TRANSACTION_RECORD = 1,
    COMMIT_RECORD = 2,

    COPY_TABLE_RECORD = 13,
    CREATE_CATALOG_ENTRY_RECORD = 14,
    DROP_CATALOG_ENTRY_RECORD = 16,
    ALTER_TABLE_ENTRY_RECORD = 17,
    UPDATE_SEQUENCE_RECORD = 18,
    TABLE_INSERTION_RECORD = 30,
    NODE_DELETION_RECORD = 31,
    NODE_UPDATE_RECORD = 32,
    REL_DELETION_RECORD = 33,
    REL_DETACH_DELETE_RECORD = 34,
    REL_UPDATE_RECORD = 35,

    LOAD_EXTENSION_RECORD = 100,

    CHECKPOINT_RECORD = 254,
};
```

Reference table:

| Enum value | Symbol | Payload summary | Replay entry point |
|---:|---|---|---|
| 0 | `INVALID_RECORD` | invalid sentinel only | error |
| 1 | `BEGIN_TRANSACTION_RECORD` | none | `beginRecoveryTransaction()` |
| 2 | `COMMIT_RECORD` | none | `TransactionContext::commit()` |
| 13 | `COPY_TABLE_RECORD` | `tableID` | no-op |
| 14 | `CREATE_CATALOG_ENTRY_RECORD` | serialized catalog entry + `isInternal` | `replayCreateCatalogEntryRecord(...)` |
| 16 | `DROP_CATALOG_ENTRY_RECORD` | `entryID`, `entryType` | `replayDropCatalogEntryRecord(...)` |
| 17 | `ALTER_TABLE_ENTRY_RECORD` | alter-type-specific fields | `replayAlterTableEntryRecord(...)` |
| 18 | `UPDATE_SEQUENCE_RECORD` | `sequenceID`, `kCount` | `replayUpdateSequenceRecord(...)` |
| 30 | `TABLE_INSERTION_RECORD` | table id, table type, row count, value vectors | `replayTableInsertionRecord(...)` |
| 31 | `NODE_DELETION_RECORD` | table id, node offset, PK vector | `replayNodeDeletionRecord(...)` |
| 32 | `NODE_UPDATE_RECORD` | table id, column id, node offset, property vector | `replayNodeUpdateRecord(...)` |
| 33 | `REL_DELETION_RECORD` | table id, src/dst/rel vectors | `replayRelDeletionRecord(...)` |
| 34 | `REL_DETACH_DELETE_RECORD` | table id, direction, src vector | `replayRelDetachDeletionRecord(...)` |
| 35 | `REL_UPDATE_RECORD` | table id, column id, src/dst/rel/property vectors | `replayRelUpdateRecord(...)` |
| 100 | `LOAD_EXTENSION_RECORD` | extension path | `replayLoadExtensionRecord(...)` |
| 254 | `CHECKPOINT_RECORD` | none | never replayed directly |

---

## 10. Record serialization reference

This section records the actual field order used by the serializer.

### 10.1 Common prefix for every record

All records start with `WALRecord::serialize(...)`:

```cpp
void WALRecord::serialize(Serializer& serializer) const {
    serializer.writeDebuggingInfo("type");
    serializer.write(type);
}
```

And all records are deserialized by first reading and validating that prefix:

```cpp
deserializer.getReader()->onObjectBegin();
deserializer.validateDebuggingInfo(key, "type");
deserializer.deserializeValue(type);
std::unique_ptr<WALRecord> walRecord;
switch (type) {
case WALRecordType::BEGIN_TRANSACTION_RECORD: {
    walRecord = BeginTransactionRecord::deserialize(deserializer);
} break;
// ... other record-specific deserializers ...
}
deserializer.getReader()->onObjectEnd();
```

So even before type-specific fields, the record contains serializer debugging metadata for `"type"`.

### 10.2 `BEGIN_TRANSACTION_RECORD` (`1`)

Definition:

```cpp
struct BeginTransactionRecord final : WALRecord {
    BeginTransactionRecord() : WALRecord{WALRecordType::BEGIN_TRANSACTION_RECORD} {}
};
```

Serializer:

```cpp
void BeginTransactionRecord::serialize(Serializer& serializer) const {
    WALRecord::serialize(serializer);
}
```

Payload fields after common prefix:

- none

Replay behavior:

```cpp
case WALRecordType::BEGIN_TRANSACTION_RECORD: {
    TransactionContext::Get(clientContext)->beginRecoveryTransaction();
} break;
```

Meaning:

- starts a recovery transaction context
- defines the start of a replayable committed unit

### 10.3 `COMMIT_RECORD` (`2`)

Definition:

```cpp
struct CommitRecord final : WALRecord {
    CommitRecord() : WALRecord{WALRecordType::COMMIT_RECORD} {}
};
```

Serializer:

```cpp
void CommitRecord::serialize(Serializer& serializer) const {
    WALRecord::serialize(serializer);
}
```

Payload fields after common prefix:

- none

Replay behavior:

```cpp
case WALRecordType::COMMIT_RECORD: {
    TransactionContext::Get(clientContext)->commit();
} break;
```

Recovery importance:

- `dryReplay()` advances `offsetDeserialized` to the byte offset after this record
- this is the main safe truncation boundary for crash-tail recovery

### 10.4 `CHECKPOINT_RECORD` (`254`)

Definition:

```cpp
struct CheckpointRecord final : WALRecord {
    CheckpointRecord() : WALRecord{WALRecordType::CHECKPOINT_RECORD} {}
};
```

Serializer:

```cpp
void CheckpointRecord::serialize(Serializer& serializer) const {
    WALRecord::serialize(serializer);
}
```

Payload fields after common prefix:

- none

Replay dispatch intentionally refuses to replay it:

```cpp
case WALRecordType::CHECKPOINT_RECORD: {
    // This record should not be replayed. It is only used to indicate that the previous records
    // had been replayed and shadow files are created.
    UNREACHABLE_CODE;
}
```

Its function is as a recovery sentinel, not a logical redo action.

### 10.5 `COPY_TABLE_RECORD` (`13`)

Definition:

```cpp
struct CopyTableRecord final : WALRecord {
    common::table_id_t tableID;
};
```

Serializer:

```cpp
void CopyTableRecord::serialize(Serializer& serializer) const {
    WALRecord::serialize(serializer);
    serializer.write(tableID);
}
```

Serialized fields after common prefix:

1. `tableID`

Deserializer:

```cpp
deserializer.deserializeValue(retVal->tableID);
```

Replay behavior:

```cpp
void WALReplayer::replayCopyTableRecord(const WALRecord&) const {}
```

Current state:

- record exists in type system and parser of WAL bytes
- replay does nothing
- no obvious production code path in the inspected tree emits it

### 10.6 `CREATE_CATALOG_ENTRY_RECORD` (`14`)

Definition:

```cpp
struct CreateCatalogEntryRecord final : WALRecord {
    catalog::CatalogEntry* catalogEntry;
    std::unique_ptr<catalog::CatalogEntry> ownedCatalogEntry;
    bool isInternal = false;
};
```

Serializer:

```cpp
void CreateCatalogEntryRecord::serialize(Serializer& serializer) const {
    WALRecord::serialize(serializer);
    catalogEntry->serialize(serializer);
    serializer.serializeValue(isInternal);
}
```

Serialized fields after common prefix:

1. polymorphic `CatalogEntry`
2. `bool isInternal`

Replay implementation handles multiple catalog entry kinds:

- node tables
- relationship groups
- scalar macros
- sequences
- types
- indexes
- graphs

Key replay branch:

```cpp
auto newEntry = catalog->createTableEntry(transaction,
    entry.getBoundCreateTableInfo(transaction, record.isInternal));
storageManager->createTable(newEntry->ptrCast<TableCatalogEntry>(), &clientContext);
```

Noteworthy behavior:

- WAL replay rebuilds both catalog metadata and storage-manager table objects for tables
- table creation is not purely catalog-side

### 10.7 `DROP_CATALOG_ENTRY_RECORD` (`16`)

Definition:

```cpp
struct DropCatalogEntryRecord final : WALRecord {
    common::oid_t entryID;
    catalog::CatalogEntryType entryType;
};
```

Serializer:

```cpp
void DropCatalogEntryRecord::serialize(Serializer& serializer) const {
    WALRecord::serialize(serializer);
    serializer.write<oid_t>(entryID);
    serializer.write<catalog::CatalogEntryType>(entryType);
}
```

Serialized fields after common prefix:

1. `entryID`
2. `entryType`

Replay cases:

- node/rel tables -> `catalog->dropTableEntry(...)`
- sequences -> `catalog->dropSequence(...)`
- indexes -> `catalog->dropIndex(...)`
- scalar macros -> `catalog->dropMacroEntry(...)`
- graphs -> empty branch in current code

The graph branch currently does nothing explicitly in the replay switch.

### 10.8 `ALTER_TABLE_ENTRY_RECORD` (`17`)

Definition:

```cpp
struct AlterTableEntryRecord final : WALRecord {
    const binder::BoundAlterInfo* alterInfo;
    std::unique_ptr<binder::BoundAlterInfo> ownedAlterInfo;
};
```

Serializer front matter:

```cpp
serializer.write(alterInfo->alterType);
serializer.write(alterInfo->tableName);
```

Then variant payload by alter type.

Actual serialized payload variants are:

- `ADD_PROPERTY`
  - `propertyDefinition.serialize(serializer)`
- `DROP_PROPERTY`
  - `propertyName`
- `RENAME_PROPERTY`
  - `newName`
  - `oldName`
- `COMMENT`
  - `comment`
- `RENAME`
  - `newName`
- `ADD_FROM_TO_CONNECTION`
  - `fromTableID`
  - `toTableID`
- `DROP_FROM_TO_CONNECTION`
  - `fromTableID`
  - `toTableID`

Replay is more than a catalog mutation.

After:

```cpp
catalog->alterTableEntry(transaction, *ownedAlterInfo);
```

it may also perform physical storage actions.

Examples from replay:

- `ADD_PROPERTY`
  - binds/evaluates the default expression
  - constructs `TableAddColumnState`
  - calls `table->addColumn(...)` on node or rel tables
- `ADD_FROM_TO_CONNECTION`
  - fetches the new relationship entry info
  - calls `storageManager->addRelTable(...)`

### 10.9 `UPDATE_SEQUENCE_RECORD` (`18`)

Definition:

```cpp
struct UpdateSequenceRecord final : WALRecord {
    common::sequence_id_t sequenceID;
    uint64_t kCount;
};
```

Serializer:

```cpp
serializer.write(sequenceID);
serializer.write(kCount);
```

Serialized fields after common prefix:

1. `sequenceID`
2. `kCount`

Replay:

```cpp
const auto entry = Catalog::Get(clientContext)
    ->getSequenceEntry(transaction::Transaction::Get(clientContext), sequenceID);
entry->nextKVal(transaction::Transaction::Get(clientContext), sequenceEntryRecord.kCount);
```

### 10.10 `TABLE_INSERTION_RECORD` (`30`)

Definition:

```cpp
struct TableInsertionRecord final : WALRecord {
    common::table_id_t tableID;
    common::TableType tableType;
    common::row_idx_t numRows;
    std::vector<common::ValueVector*> vectors;
    std::vector<std::unique_ptr<common::ValueVector>> ownedVectors;
};
```

Serializer:

```cpp
serializer.writeDebuggingInfo("table_id");
serializer.write<table_id_t>(tableID);
serializer.writeDebuggingInfo("table_type");
serializer.write<TableType>(tableType);
serializer.writeDebuggingInfo("num_rows");
serializer.write<row_idx_t>(numRows);
serializer.writeDebuggingInfo("num_vectors");
serializer.write<idx_t>(vectors.size());
for (auto& vector : vectors) {
    vector->serialize(serializer);
}
```

Serialized fields after common prefix:

1. debug key `table_id`
2. `tableID`
3. debug key `table_type`
4. `tableType`
5. debug key `num_rows`
6. `numRows`
7. debug key `num_vectors`
8. vector count
9. `ValueVector` payloads in order

Replay dispatches by table type:

```cpp
switch (insertionRecord.tableType) {
case TableType::NODE:
    replayNodeTableInsertRecord(walRecord);
    break;
case TableType::REL:
    replayRelTableInsertRecord(walRecord);
    break;
default:
    throw RuntimeException("Invalid table type for insertion replay in WAL record.");
}
```

Node replay details:

- reads PK column index from the destination node table
- builds `NodeTableInsertState`
- sets selection vector to one row at a time
- calls `table.insert(...)` for each row

Relationship replay details:

- interprets vector layout according to local relationship column conventions
- skips columns before `LOCAL_REL_ID_COLUMN_ID` when collecting property vectors
- calls `table.initInsertState(...)` and `table.insert(...)` one row at a time

### 10.11 `NODE_DELETION_RECORD` (`31`)

Definition:

```cpp
struct NodeDeletionRecord final : WALRecord {
    common::table_id_t tableID;
    common::offset_t nodeOffset;
    common::ValueVector* pkVector;
    std::unique_ptr<common::ValueVector> ownedPKVector;
};
```

Serializer order:

```cpp
serializer.writeDebuggingInfo("table_id");
serializer.write<table_id_t>(tableID);
serializer.writeDebuggingInfo("node_offset");
serializer.write<offset_t>(nodeOffset);
serializer.writeDebuggingInfo("pk_vector");
pkVector->serialize(serializer);
```

Serialized fields after common prefix:

1. `tableID`
2. `nodeOffset`
3. serialized PK vector

Replay behavior:

- constructs a one-row `INTERNAL_ID` vector from `nodeOffset` and `tableID`
- builds `NodeTableDeleteState`
- calls `NodeTable::delete_(recoveryTxn, ...)`

### 10.12 `NODE_UPDATE_RECORD` (`32`)

Definition:

```cpp
struct NodeUpdateRecord final : WALRecord {
    common::table_id_t tableID;
    common::column_id_t columnID;
    common::offset_t nodeOffset;
    common::ValueVector* propertyVector;
    std::unique_ptr<common::ValueVector> ownedPropertyVector;
};
```

Serializer order:

```cpp
serializer.writeDebuggingInfo("table_id");
serializer.write<table_id_t>(tableID);
serializer.writeDebuggingInfo("column_id");
serializer.write<column_id_t>(columnID);
serializer.writeDebuggingInfo("node_offset");
serializer.write<offset_t>(nodeOffset);
serializer.writeDebuggingInfo("property_vector");
propertyVector->serialize(serializer);
```

Replay behavior:

- reconstructs a one-row `INTERNAL_ID` vector
- builds `NodeTableUpdateState`
- calls `NodeTable::update(recoveryTxn, ...)`

### 10.13 `REL_DELETION_RECORD` (`33`)

Definition:

```cpp
struct RelDeletionRecord final : WALRecord {
    common::table_id_t tableID;
    common::ValueVector* srcNodeIDVector;
    common::ValueVector* dstNodeIDVector;
    common::ValueVector* relIDVector;
    std::unique_ptr<common::ValueVector> ownedSrcNodeIDVector;
    std::unique_ptr<common::ValueVector> ownedDstNodeIDVector;
    std::unique_ptr<common::ValueVector> ownedRelIDVector;
};
```

Serializer order:

```cpp
serializer.writeDebuggingInfo("table_id");
serializer.write<table_id_t>(tableID);
serializer.writeDebuggingInfo("src_node_vector");
srcNodeIDVector->serialize(serializer);
serializer.writeDebuggingInfo("dst_node_vector");
dstNodeIDVector->serialize(serializer);
serializer.writeDebuggingInfo("rel_id_vector");
relIDVector->serialize(serializer);
```

Replay behavior:

- constructs `RelTableDeleteState`
- calls `RelTable::delete_(recoveryTxn, ...)`

### 10.14 `REL_DETACH_DELETE_RECORD` (`34`)

Definition:

```cpp
struct RelDetachDeleteRecord final : WALRecord {
    common::table_id_t tableID;
    common::RelDataDirection direction;
    common::ValueVector* srcNodeIDVector;
    std::unique_ptr<common::ValueVector> ownedSrcNodeIDVector;
};
```

Serializer order:

```cpp
serializer.writeDebuggingInfo("table_id");
serializer.write<table_id_t>(tableID);
serializer.writeDebuggingInfo("direction");
serializer.write<RelDataDirection>(direction);
serializer.writeDebuggingInfo("src_node_vector");
srcNodeIDVector->serialize(serializer);
```

Replay behavior is special.

It does **not** log or serialize destination IDs or relationship IDs.

During replay it creates scratch vectors for them:

```cpp
const auto dstNodeIDVector =
    std::make_unique<ValueVector>(LogicalType{LogicalTypeID::INTERNAL_ID});
const auto relIDVector = std::make_unique<ValueVector>(LogicalType{LogicalTypeID::INTERNAL_ID});
dstNodeIDVector->setState(anchorState);
relIDVector->setState(anchorState);
const auto deleteState = std::make_unique<RelTableDeleteState>(
    *deletionRecord.ownedSrcNodeIDVector, *dstNodeIDVector, *relIDVector);
deleteState->detachDeleteDirection = deletionRecord.direction;
table.detachDelete(transaction::Transaction::Get(clientContext), deleteState.get());
```

### 10.15 `REL_UPDATE_RECORD` (`35`)

Definition:

```cpp
struct RelUpdateRecord final : WALRecord {
    common::table_id_t tableID;
    common::column_id_t columnID;
    common::ValueVector* srcNodeIDVector;
    common::ValueVector* dstNodeIDVector;
    common::ValueVector* relIDVector;
    common::ValueVector* propertyVector;
    std::unique_ptr<common::ValueVector> ownedSrcNodeIDVector;
    std::unique_ptr<common::ValueVector> ownedDstNodeIDVector;
    std::unique_ptr<common::ValueVector> ownedRelIDVector;
    std::unique_ptr<common::ValueVector> ownedPropertyVector;
};
```

Serializer order:

```cpp
serializer.writeDebuggingInfo("table_id");
serializer.write<table_id_t>(tableID);
serializer.writeDebuggingInfo("column_id");
serializer.write<column_id_t>(columnID);
serializer.writeDebuggingInfo("src_node_vector");
srcNodeIDVector->serialize(serializer);
serializer.writeDebuggingInfo("dst_node_vector");
dstNodeIDVector->serialize(serializer);
serializer.writeDebuggingInfo("rel_id_vector");
relIDVector->serialize(serializer);
serializer.writeDebuggingInfo("property_vector");
propertyVector->serialize(serializer);
```

Replay behavior:

- validates all vectors share the same `DataChunkState`
- builds `RelTableUpdateState`
- calls `RelTable::update(recoveryTxn, ...)`

### 10.16 `LOAD_EXTENSION_RECORD` (`100`)

Definition:

```cpp
struct LoadExtensionRecord final : WALRecord {
    std::string path;
};
```

Serializer order:

```cpp
serializer.writeDebuggingInfo("path");
serializer.write<std::string>(path);
```

Replay behavior:

```cpp
extension::ExtensionManager::Get(clientContext)
    ->loadExtension(loadExtensionRecord.path, &clientContext);
```

Operational implication:

- extension loading is part of durable logical replay
- recovery may execute extension load logic before the database finishes startup recovery

---

## 11. Deserialization and replay dispatch

`WALRecord::deserialize(...)` is the central parser.

It does the following for each record object:

1. `onObjectBegin()`
2. validate debug info key `"type"`
3. read enum
4. dispatch to the record-specific `deserialize(...)`
5. set `walRecord->type = type`
6. `onObjectEnd()`

This means checksum verification, when enabled, happens at the object boundary after the type-specific bytes have been read.

Invalid type handling is explicit:

```cpp
case WALRecordType::INVALID_RECORD: {
    throw RuntimeException("Corrupted wal file. Read out invalid WAL record type.");
}
```

So enum value `0` is deliberately reserved as a corruption sentinel.

---

## 12. Checksum implementation details

### 12.1 `ChecksumWriter`

`ChecksumWriter` is a `common::Writer` wrapper.

Core fields:

```cpp
common::Serializer outputSerializer;
std::optional<uint64_t> currentEntrySize;
std::unique_ptr<MemoryBuffer> entryBuffer;
```

Key behavior:

```cpp
void ChecksumWriter::onObjectBegin() {
    currentEntrySize.emplace(0);
}
```

```cpp
void ChecksumWriter::write(const uint8_t* data, uint64_t size) {
    if (currentEntrySize.has_value()) {
        resizeBufferIfNeeded(entryBuffer, *currentEntrySize + size);
        std::memcpy(entryBuffer->getData() + *currentEntrySize, data, size);
        *currentEntrySize += size;
    } else {
        outputSerializer.write(data, size);
    }
}
```

```cpp
void ChecksumWriter::onObjectEnd() {
    const auto checksum = common::checksum(entryBuffer->getData(), *currentEntrySize);
    outputSerializer.write(entryBuffer->getData(), *currentEntrySize);
    outputSerializer.serializeValue(checksum);
    currentEntrySize.reset();
}
```

So the checksum covers exactly the serialized bytes emitted between begin/end.

### 12.2 `ChecksumReader`

`ChecksumReader` mirrors the object-boundary logic.

Core verification:

```cpp
void ChecksumReader::onObjectEnd() {
    const uint64_t computedChecksum = common::checksum(entryBuffer->getData(), *currentEntrySize);
    uint64_t storedChecksum{};
    deserializer.deserializeValue(storedChecksum);
    if (storedChecksum != computedChecksum) {
        throw common::StorageException(std::string{checksumMismatchMessage});
    }
    currentEntrySize.reset();
}
```

The mismatch message used by WAL replay is:

```cpp
"Checksum verification failed, the WAL file is corrupted."
```

### 12.3 Header checksums and record checksums use the same object mechanism

Because the WAL header is also written with `onObjectBegin()` / `onObjectEnd()`, checksum mode protects:

- the header object
- each WAL record object

There is no separate checksum regime for the header.

---

## 13. Recovery entry point

Database startup recovery comes from `Database` construction.

From `src/main/database.cpp`:

```cpp
StorageManager::recover(clientContext, dbConfig->throwOnWalReplayFailure,
    dbConfig->enableChecksums);
```

And from `src/storage/storage_manager.cpp`:

```cpp
void StorageManager::recover(main::ClientContext& clientContext, bool throwOnWalReplayFailure,
    bool enableChecksums) {
    const auto walReplayer = std::make_unique<WALReplayer>(clientContext);
    walReplayer->replay(throwOnWalReplayFailure, enableChecksums);
}
```

The `WALReplayer` constructor derives three paths immediately:

```cpp
walPath = StorageUtils::getWALFilePath(clientContext.getDatabasePath());
checkpointWalPath = StorageUtils::getCheckpointWALFilePath(clientContext.getDatabasePath());
shadowFilePath = StorageUtils::getShadowFilePath(clientContext.getDatabasePath());
```

So replay is always coordinated across:

- active WAL
- checkpoint WAL
- shadow file

---

## 14. WAL header verification during replay

The WAL header is parsed by `readWALHeader(...)`:

```cpp
WALHeader header{};
deserializer.deserializeValue(header.databaseID);
uint8_t enableChecksumsBytes = 0;
deserializer.deserializeValue(enableChecksumsBytes);
header.enableChecksums = enableChecksumsBytes != 0;
```

Two checks are then performed.

### 14.1 Checksum-mode compatibility

```cpp
static void checkWALHeader(const WALHeader& header, bool enableChecksums) {
    if (enableChecksums != header.enableChecksums) {
        throw RuntimeException(std::format(
            "The database you are trying to open was serialized with enableChecksums={} but you "
            "are trying to open it with enableChecksums={}. Please open your database using the "
            "correct enableChecksums config. If you wish to change this for your database, please "
            "use the export/import functionality.",
            TypeUtils::toString(header.enableChecksums), TypeUtils::toString(enableChecksums)));
    }
}
```

### 14.2 Database UUID verification

Before actual record replay, the WAL UUID is checked against the database file UUID:

```cpp
FileDBIDUtils::verifyDatabaseID(*fileInfo,
    StorageManager::Get(clientContext)->getOrInitDatabaseID(clientContext),
    walHeader.databaseID);
```

The error from `FileDBIDUtils` is explicit about stale temporary files from another database name reuse.

---

## 15. Dry replay: safe tail detection

`WALReplayer::dryReplay(...)` is the key crash-tail algorithm.

The function scans the file without applying logical changes.

Core behavior:

```cpp
uint64_t offsetDeserialized = 0;
bool isLastRecordCheckpoint = false;
try {
    Deserializer deserializer = initDeserializer(fileInfo, clientContext, enableChecksums);

    deserializer.getReader()->onObjectBegin();
    const auto walHeader = readWALHeader(deserializer);
    checkWALHeader(walHeader, enableChecksums);
    deserializer.getReader()->onObjectEnd();

    bool finishedDeserializing = deserializer.finished();
    while (!finishedDeserializing) {
        auto walRecord = WALRecord::deserialize(deserializer, clientContext);
        finishedDeserializing = deserializer.finished();
        switch (walRecord->type) {
        case WALRecordType::CHECKPOINT_RECORD: {
            DASSERT(finishedDeserializing);
            isLastRecordCheckpoint = true;
            finishedDeserializing = true;
            offsetDeserialized = getReadOffset(deserializer, enableChecksums);
        } break;
        case WALRecordType::COMMIT_RECORD: {
            offsetDeserialized = getReadOffset(deserializer, enableChecksums);
        } break;
        default: {
        }
        }
    }
} catch (...) {
    if (throwOnWalReplayFailure) {
        throw;
    }
}
```

### 15.1 Meaning of `offsetDeserialized`

`offsetDeserialized` tracks the end offset of the last durable replay boundary.

It is updated only when a record is:

- `COMMIT_RECORD`
- `CHECKPOINT_RECORD`

So partial objects or uncommitted tail records do not advance the safe offset.

### 15.2 Meaning of `isLastRecordCheckpoint`

This flag means:

- the last successfully parsed record was a checkpoint record
- and by assertion it must be the logical end of the WAL content being considered

This is used to decide whether recovery should:

- apply shadow pages and discard WAL files
- or replay logical records normally

### 15.3 Exception handling in `dryReplay`

```cpp
} catch (...) {
    // If we hit an exception while deserializing, we assume that the WAL file is (partially)
    // corrupted. This should only happen for records of the last transaction recorded.
    if (throwOnWalReplayFailure) {
        throw;
    }
}
```

This is the code path that turns a torn tail into “stop at last safe commit” when configured not to throw.

---

## 16. Replay of active WAL vs rotated checkpoint WAL

### 16.1 Top-level decision tree

`WALReplayer::replay(...)` checks for the existence of:

- `checkpointWalPath`
- `walPath`

Actual code:

```cpp
bool hasFrozenWAL = vfs->fileOrPathExists(checkpointWalPath, &clientContext);
bool hasActiveWAL = vfs->fileOrPathExists(walPath, &clientContext);
```

Then:

- no WALs -> remove shadow file, read checkpoint, return
- frozen WAL -> replay frozen WAL path first
- no frozen WAL -> remove shadow file, read checkpoint
- active WAL -> replay active WAL path second

### 16.2 No WAL files present

Exact behavior:

```cpp
if (!hasFrozenWAL && !hasActiveWAL) {
    removeFileIfExists(shadowFilePath);
    checkpointer.readCheckpoint();
    return;
}
```

So a stale shadow file is discarded if there is no WAL at all.

### 16.3 Frozen checkpoint WAL replay

`replayFrozenWAL(...)` opens `dbPath.wal.checkpoint` with read/write flags and first checks for zero length.

If the rotated file is empty:

```cpp
if (fileInfo->getFileSize() == 0) {
    removeFileIfExists(checkpointWalPath);
    removeFileIfExists(shadowFilePath);
    checkpointer.readCheckpoint();
    return;
}
```

If dry replay says the last record is a checkpoint record:

```cpp
ShadowFile::replayShadowPageRecords(clientContext);
removeFileIfExists(checkpointWalPath);
removeFileIfExists(shadowFilePath);
checkpointer.readCheckpoint();
```

If not, recovery does this instead:

1. remove shadow file
2. load the durable checkpoint from the data file
3. verify WAL header UUID
4. replay records up to `offsetDeserialized`
5. remove the rotated checkpoint WAL

This matches the crash case “rotation happened but checkpoint did not finish writing the checkpoint sentinel”.

### 16.4 Active WAL replay

`replayActiveWAL(...)` behaves similarly but with different cleanup.

If the active WAL file is empty:

```cpp
if (fileInfo->getFileSize() == 0) {
    removeFileIfExists(walPath);
    return;
}
```

If the last record is a checkpoint record:

```cpp
ShadowFile::replayShadowPageRecords(clientContext);
removeWALAndShadowFiles();
checkpointer.readCheckpoint();
```

Otherwise it:

1. parses/validates the WAL header
2. replays records up to `offsetDeserialized`
3. truncates the active WAL to `offsetDeserialized`

---

## 17. Tail truncation semantics

The active WAL truncation path is:

```cpp
void WALReplayer::truncateWALFile(FileInfo& fileInfo, uint64_t size) const {
    if (StorageManager::Get(clientContext)->isReadOnly()) {
        return;
    }
    if (fileInfo.getFileSize() > size) {
        fileInfo.truncate(size);
        fileInfo.syncFile();
    }
}
```

Important implications:

- truncation is only applied to active WAL, not the rotated checkpoint WAL path
- truncation is skipped in read-only mode
- if `offsetDeserialized == 0`, the file may be truncated to zero bytes, removing even the header
- later writers will recreate the header when they initialize a fresh WAL writer on an empty file

This is why `offsetDeserialized` must be interpreted as “safe durable prefix length”, not “last record payload offset”.

---

## 18. Replay dispatch details

`WALReplayer::replayWALRecord(...)` is the central dispatcher.

It maps record types to actions exactly as follows:

```cpp
BEGIN_TRANSACTION_RECORD  -> beginRecoveryTransaction()
COMMIT_RECORD             -> TransactionContext::commit()
CREATE_CATALOG_ENTRY      -> replayCreateCatalogEntryRecord(...)
DROP_CATALOG_ENTRY        -> replayDropCatalogEntryRecord(...)
ALTER_TABLE_ENTRY         -> replayAlterTableEntryRecord(...)
TABLE_INSERTION           -> replayTableInsertionRecord(...)
NODE_DELETION             -> replayNodeDeletionRecord(...)
NODE_UPDATE               -> replayNodeUpdateRecord(...)
REL_DELETION              -> replayRelDeletionRecord(...)
REL_DETACH_DELETE         -> replayRelDetachDeletionRecord(...)
REL_UPDATE                -> replayRelUpdateRecord(...)
COPY_TABLE                -> replayCopyTableRecord(...)
UPDATE_SEQUENCE           -> replayUpdateSequenceRecord(...)
LOAD_EXTENSION            -> replayLoadExtensionRecord(...)
CHECKPOINT                -> unreachable
```

There is no secondary transaction-boundary state machine hidden elsewhere.

BEGIN and COMMIT literally open and close a recovery transaction using the regular transaction context machinery.

---

## 19. Recovery transaction mechanics

When BEGIN is replayed:

```cpp
TransactionContext::Get(clientContext)->beginRecoveryTransaction();
```

From `src/transaction/transaction_context.cpp`:

```cpp
void TransactionContext::beginRecoveryTransaction() {
    std::unique_lock lck{mtx};
    mode = TransactionMode::MANUAL;
    beginTransactionInternal(TransactionType::RECOVERY);
}
```

So recovery uses a real `Transaction` object of type `RECOVERY`.

When COMMIT is replayed:

```cpp
TransactionContext::Get(clientContext)->commit();
```

That routes through normal transaction-manager commit logic.

This matters because replayed node/rel operations assert that the active transaction is a recovery transaction before mutating storage.

Examples:

```cpp
DASSERT(transaction::Transaction::Get(clientContext) &&
        transaction::Transaction::Get(clientContext)->isRecovery());
```

appears in node-update, node-delete, rel-delete, rel-update, and insertion replay paths.

---

## 20. Checkpoint interaction with WAL

The checkpoint choreography spans `TransactionManager`, `Checkpointer`, `WAL`, and `ShadowFile`.

The WAL-specific pieces are:

1. checkpoint drains active write transactions
2. `Checkpointer::beginCheckpoint(snapshotTS)` calls `WAL::rotateForCheckpoint(...)`
3. checkpoint storage/materialization runs
4. `Checkpointer::finishCheckpoint()` serializes catalog/metadata and writes the database header through shadowing
5. `Checkpointer::logCheckpointAndApplyShadowPages(...)` executes the durability handoff

The exact shadow/WAL order is:

```cpp
void Checkpointer::logCheckpointAndApplyShadowPages(bool walRotated_) {
    auto& shadowFile = mainStorageManager->getShadowFile();
    shadowFile.flushAll(clientContext);
    auto wal = WAL::Get(clientContext);
    if (walRotated_) {
        wal->logAndFlushCheckpointToFrozen(&clientContext);
    } else {
        wal->logAndFlushCheckpoint(&clientContext);
    }
    shadowFile.applyShadowPages(*mainStorageManager, clientContext);
    auto bufferManager = MemoryManager::Get(clientContext)->getBufferManager();
    if (!walRotated_) {
        wal->clear();
    }
    shadowFile.clear(*bufferManager);
}
```

So the exact order is:

1. `shadowFile.flushAll()`
2. checkpoint record to active or rotated WAL
3. `shadowFile.applyShadowPages()`
4. `wal->clear()` only when no rotation happened
5. `shadowFile.clear()`

Later, `postCheckpointCleanup()` performs:

- page-manager finalize/reset logic
- `clearFrozenWAL()` or `reset()` on WAL
- `shadowFile.reset()`

For the full checkpoint protocol and snapshotting caveats, see [Checkpointing](/transaction/checkpointing).

---

## 21. Concurrency and locking reality

### 21.1 Commit serialization

`TransactionManager::commit(...)` holds `mtxForSerializingPublicFunctionCalls` while it calls `transaction->commit(&wal)`.

That means commit paths are serialized at the transaction manager level.

The WAL itself also has its own `std::mutex mtx`.

So the shared append path is doubly serialized:

- by transaction-manager public-call serialization
- by `WAL::mtx`

### 21.2 Multiple write transactions vs commit path

`TransactionManager::beginTransaction(...)` allows multiple active write transactions only if `enableMultiWrites` is enabled.

Even then:

- each transaction keeps its own `LocalWAL`
- shared WAL append remains serialized
- checkpoint drains active write/recovery transactions before the protected phase

### 21.3 Read transactions during checkpoint

The checkpoint drain code is explicit:

```cpp
// We only need to wait for active write transactions to leave the system before
// checkpointing. Read transactions can continue safely because they use MVCC snapshot
// isolation and shadow pages are applied with per-page locking.
```

So the system does **not** stop all transactions for checkpoint.

It drains only active write/recovery transactions and blocks new write transactions while the write gate is held.

### 21.4 Early gate release after WAL rotation

If rotation succeeded:

```cpp
if (checkpointer->wasWalRotated()) {
    writeGate = {};
}
```

Meaning:

- the old WAL is now isolated in `dbPath.wal.checkpoint`
- new writers can create a fresh `dbPath.wal`
- checkpoint storage phase can continue against the snapshot timestamp

This is why the rotated WAL exists at all.

---

## 22. Read-only and attach-mode caveats

### 22.1 Recovery cleanup is skipped in read-only mode

`removeFileIfExists(...)`, `syncWALFile(...)`, and `truncateWALFile(...)` all short-circuit when `StorageManager::isReadOnly()` is true.

So destructive WAL cleanup does not happen in read-only opens.

### 22.2 Shadow replay itself requires write mode

`ShadowFile::replayShadowPageRecords(...)` begins with:

```cpp
if (context.getDBConfig()->readOnly) {
    throw RuntimeException("Couldn't replay shadow pages under read-only mode. Please re-open "
                           "the database with read-write mode to replay shadow pages.");
}
```

Therefore a database that needs shadow-page recovery cannot be successfully opened read-only.

### 22.3 Attached external databases do not run full WAL recovery

`AttachedLbugDatabase` validates that the active WAL is empty before attaching read-only:

```cpp
if (walFile->getFileSize() > 0) {
    throw common::RuntimeException(std::format(
        "Cannot attach an external Lbug database with non-empty wal file. Try manually "
        "checkpointing the external database (i.e., run \"CHECKPOINT;\")."));
}
```

That is an operational constraint worth remembering:

- attached external DBs are expected to be checkpoint-clean
- attach mode does not perform the normal mutable replay/truncation path

---

## 23. Failure handling and rollback on replay exceptions

Both `replayFrozenWAL(...)` and `replayActiveWAL(...)` wrap replay in a `try/catch`.

If an exception is thrown and there is an active replay transaction:

```cpp
auto transactionContext = TransactionContext::Get(clientContext);
if (transactionContext->hasActiveTransaction()) {
    transactionContext->rollback();
}
throw;
```

So replay failure does not leave a half-open recovery transaction active in the client context.

This is separate from `dryReplay()`’s tail-tolerance behavior.

`dryReplay()` may suppress tail errors depending on configuration, but once the engine starts actually applying records, runtime exceptions still unwind through the normal transaction rollback path.

---

## 24. Practical binary format summary

Given all of the above, the actual WAL binary layout is best described as:

```text
WAL file
  object(header)
    serialize(uuid databaseID)
    serialize(bool enableChecksums)
    [uint64 checksum if enabled]

  object(record 0)
    serializeDebuggingInfo("type")
    serialize(enum recordType)
    serialize(record-specific fields)
    [uint64 checksum if enabled]

  object(record 1)
    ...
```

And for the most common transaction pattern:

```text
object(BEGIN)
object(<logical op 1>)
object(<logical op 2>)
...
object(COMMIT)
```

There is no page framing, LSN field, or payload-size header in the WAL record abstraction itself.

---

## 25. Engineering checklist / quick reference

### 25.1 If you need to know whether a transaction wrote anything durable

Check whether `LocalWAL` ever logged a non-control record.

Because:

- BEGIN is lazy
- COMMIT is conditional on BEGIN
- empty local WALs are skipped by `WAL::logCommittedWAL(...)`

### 25.2 If you need to know when a commit becomes durable

Durability point is after:

```cpp
wal->logCommittedWAL(*localWAL, clientContext);
```

returns inside `Transaction::commit()`.

That path flushes and syncs the shared WAL.

### 25.3 If you need to know how startup discards a torn tail

Look at:

- `WALReplayer::dryReplay(...)`
- `offsetDeserialized`
- `truncateWALFile(...)`

The safe prefix is the last COMMIT or CHECKPOINT boundary.

### 25.4 If you need to know how checkpoint and WAL interact

Look at:

- `WAL::rotateForCheckpoint(...)`
- `Checkpointer::logCheckpointAndApplyShadowPages(...)`
- [Checkpointing](/transaction/checkpointing)
- [Shadow WAL / Shadow File Internals](/storage/shadow-wal)

### 25.5 If you need to know why a checksum mismatch aborts replay

Look at:

- `ChecksumReader::onObjectEnd()`
- `checksumMismatchMessage`
- `throwOnWalReplayFailure`

### 25.6 If you need to know why recovery opened the wrong WAL

Check the file UUID verification path:

- WAL header `databaseID`
- persistent database header `databaseID`
- `FileDBIDUtils::verifyDatabaseID(...)`

---

## 26. Summary

The WAL implementation in this tree is a precise, serializer-driven logical log with these properties:

- `LocalWAL` stages bytes in memory per transaction
- BEGIN is inserted lazily on first real record
- COMMIT is appended only if BEGIN exists
- the global `WAL` appends committed local WAL bytes directly and syncs immediately
- the WAL header stores `{databaseID, enableChecksums}`
- checksums are object-level wrappers implemented by `ChecksumWriter` / `ChecksumReader`
- crash-tail recovery uses `dryReplay()` and truncates to the last COMMIT or CHECKPOINT boundary
- checkpoint rotation renames the active WAL to `dbPath.wal.checkpoint`
- a “frozen WAL” is just that rotated file
- `CopyTableRecord` is presently a structural stub with no replay behavior and no obvious emitter
- there is no fixed `type + size + checksum` record envelope and no group commit implementation in the inspected code

When updating or debugging this area, the most important files to read together are:

- `src/storage/wal/local_wal.cpp`
- `src/storage/wal/wal.cpp`
- `src/storage/wal/wal_replayer.cpp`
- `src/storage/checkpointer.cpp`
- `src/transaction/transaction.cpp`
- `src/transaction/transaction_manager.cpp`

Those files collectively define the real durability contract.
