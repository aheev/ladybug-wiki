# Shadow WAL / Shadow File Internals

**Authoritative source files:**

- `src/include/storage/shadow_file.h`
- `src/storage/shadow_file.cpp`
- `src/include/storage/shadow_utils.h`
- `src/storage/shadow_utils.cpp`
- `src/include/storage/checkpointer.h`
- `src/storage/checkpointer.cpp`
- `src/include/storage/storage_utils.h`
- `src/include/common/constants.h`
- `src/transaction/transaction_manager.cpp`
- `src/storage/storage_manager.cpp`
- `src/storage/disk_array.cpp`
- `src/storage/overflow_file.cpp`
- `src/storage/wal/wal.cpp`
- `src/storage/wal/wal_replayer.cpp`
- `src/main/attached_database.cpp`

This page documents the **shadow file** mechanism and its interaction with checkpoints and WAL.

For the checkpoint coordinator itself, see [Checkpointing](/transaction/checkpointing).

For the transaction-local staging area that feeds committed state into checkpoint materialization, see [Local Storage](/transaction/local-storage).

For the logical WAL record catalog and replay logic, see [WAL Internals](/storage/wal-internals).

---

## 1. What this page is about

Ladybug durability is not “WAL only”.

The storage engine uses two different persistence mechanisms for different parts of state:

1. **logical WAL records** for transactional operations
2. **shadow file page copies** for checkpoint-time page replacement

The shadow file is therefore not a side note.

It is the page-level durability bridge between:

- in-memory committed structures
- serialized checkpoint metadata/catalog/header pages
- stable data-file replacement

---

## 2. Corrections to common assumptions

### 2.1 The shadow file is a separate file with suffix `.shadow`

The path is not hardcoded as `shadow.lbug` or similar.

It is derived from the database path:

```cpp
static std::string getShadowFilePath(const std::string& path) {
    return std::format("{}.{}", path, common::StorageConstants::SHADOWING_SUFFIX);
}
```

`SHADOWING_SUFFIX` is:

```cpp
static constexpr char SHADOWING_SUFFIX[] = "shadow";
```

So if the database path is `/data/demo`, the shadow file path is `/data/demo.shadow`.

### 2.2 The shadow file is not a redo log

It stores **full page images** for pages that are being replaced.

It does not store:

- logical operations
- variable-length redo entries
- physical byte patches inside a page

Instead, it stores:

- a header page
- one shadow page per tracked original page
- a serialized vector of `ShadowPageRecord` mappings at the end of the file

### 2.3 The so-called “shadow WAL” is not an actual code type

There is no `ShadowWAL` class.

The actual types are:

- `ShadowFile`
- `ShadowPageRecord`
- `ShadowFileHeader`
- `ShadowUtils`

Any documentation using “shadow WAL” should be read as shorthand for “shadow-file-based page-copy durability adjacent to WAL-driven checkpointing”.

### 2.4 `ShadowPageRecord` contains `originalFileIdx`, but apply/replay currently target the main data file

The record structure is:

```cpp
struct ShadowPageRecord {
    common::file_idx_t originalFileIdx = common::INVALID_PAGE_IDX;
    common::page_idx_t originalPageIdx = common::INVALID_PAGE_IDX;
};
```

However, both apply and recovery paths write page bytes to the main data file handle, not to an arbitrary original file chosen by `originalFileIdx`.

The current code uses `originalFileIdx` primarily for:

- map lookup keys
- buffer-manager frame update bookkeeping

That is an important implementation caveat.

### 2.5 The checkpoint order is exact and not interchangeable

The code path is:

1. `shadowFile.flushAll()`
2. WAL checkpoint record
3. `shadowFile.applyShadowPages()`
4. `shadowFile.clear()` / later `shadowFile.reset()`

Reordering these steps would change crash-recovery semantics.

### 2.6 Only active write transactions are drained for checkpoint

The checkpoint gate does **not** wait for all reads to finish.

`TransactionManager::checkpointNoLock(...)` explicitly drains only write/recovery transactions while read transactions continue under snapshot isolation.

---

## 3. Path derivation and file set

From `StorageUtils` and `StorageConstants`, the durability-related file names are:

| Purpose | Helper | Suffix | Example for `/data/demo` |
|---|---|---|---|
| active WAL | `getWALFilePath()` | `wal` | `/data/demo.wal` |
| rotated checkpoint WAL | `getCheckpointWALFilePath()` | `wal.checkpoint` | `/data/demo.wal.checkpoint` |
| shadow file | `getShadowFilePath()` | `shadow` | `/data/demo.shadow` |
| temp file | `getTmpFilePath()` | `tmp` | `/data/demo.tmp` |

This page focuses on the `.shadow` file and its checkpoint/WAL coordination.

---

## 4. Core types

### 4.1 `ShadowPageRecord`

From `src/include/storage/shadow_file.h`:

```cpp
struct ShadowPageRecord {
    common::file_idx_t originalFileIdx = common::INVALID_PAGE_IDX;
    common::page_idx_t originalPageIdx = common::INVALID_PAGE_IDX;

    void serialize(common::Serializer& serializer) const;
    static ShadowPageRecord deserialize(common::Deserializer& deserializer);
};
```

Serializer implementation:

```cpp
void ShadowPageRecord::serialize(Serializer& serializer) const {
    serializer.write<file_idx_t>(originalFileIdx);
    serializer.write<page_idx_t>(originalPageIdx);
}
```

Deserializer implementation:

```cpp
ShadowPageRecord ShadowPageRecord::deserialize(Deserializer& deserializer) {
    file_idx_t originalFileIdx = INVALID_FILE_IDX;
    page_idx_t originalPageIdx = INVALID_PAGE_IDX;
    deserializer.deserializeValue<file_idx_t>(originalFileIdx);
    deserializer.deserializeValue<page_idx_t>(originalPageIdx);
    return ShadowPageRecord{originalFileIdx, originalPageIdx};
}
```

Each record therefore means:

- “shadow page N corresponds to original file index X and original page index Y”

The record does **not** store the shadow page number itself.

That is positional.

During flush/replay, shadow pages are consumed in order starting at file page `1`.

### 4.2 `ShadowFileHeader`

From the header:

```cpp
struct ShadowFileHeader {
    common::uuid databaseID{0};
    common::page_idx_t numShadowPages = 0;
};
static_assert(std::is_trivially_copyable_v<ShadowFileHeader>);
```

This is copied directly into the first page of the shadow file.

Meaning of fields:

- `databaseID`
  - UUID of the owning database
  - checked during recovery to prevent cross-database misuse
- `numShadowPages`
  - number of shadow page images stored after page 0
  - also equals the length of the serialized `shadowPageRecords` vector

### 4.3 `ShadowFile`

Core definition:

```cpp
class ShadowFile {
public:
    ShadowFile(BufferManager& bm, common::VirtualFileSystem* vfs, const std::string& databasePath);

    bool hasShadowPage(common::file_idx_t originalFile, common::page_idx_t originalPage) const;
    void clearShadowPage(common::file_idx_t originalFile, common::page_idx_t originalPage);
    common::page_idx_t getShadowPage(common::file_idx_t originalFile,
        common::page_idx_t originalPage) const;
    common::page_idx_t getOrCreateShadowPage(common::file_idx_t originalFile,
        common::page_idx_t originalPage);

    FileHandle& getShadowingFH() const { return *shadowingFH; }

    void applyShadowPages(StorageManager& storageManager, main::ClientContext& context) const;

    void flushAll(main::ClientContext& context) const;
    void clear(BufferManager& bm);
    void reset();

    static void replayShadowPageRecords(main::ClientContext& context);

private:
    FileHandle* getOrCreateShadowingFH();

private:
    BufferManager& bm;
    std::string shadowFilePath;
    common::VirtualFileSystem* vfs;
    FileHandle* shadowingFH;
    std::unordered_map<common::file_idx_t,
        std::unordered_map<common::page_idx_t, common::page_idx_t>>
        shadowPagesMap;
    std::vector<ShadowPageRecord> shadowPageRecords;
};
```

Two data structures matter most:

- `shadowPagesMap`
  - original file/page -> shadow page index
- `shadowPageRecords`
  - ordered vector persisted to disk and later replayed

### 4.4 `ShadowUtils`

`ShadowUtils` is the helper layer used by page-based storage structures.

Important APIs:

```cpp
static ShadowPageAndFrame createShadowVersionIfNecessaryAndPinPage(
    common::page_idx_t originalPage, bool skipReadingOriginalPage, FileHandle& fileHandle,
    ShadowFile& shadowFile);

static std::pair<FileHandle*, common::page_idx_t> getFileHandleAndPhysicalPageIdxToPin(
    FileHandle& fileHandle, common::page_idx_t pageIdx, const ShadowFile& shadowFile,
    transaction::TransactionType trxType);

static void readShadowVersionOfPage(const FileHandle& fileHandle,
    common::page_idx_t originalPageIdx, const ShadowFile& shadowFile,
    const std::function<void(uint8_t*)>& readOp);

static void updatePage(FileHandle& fileHandle, common::page_idx_t originalPageIdx,
    bool skipReadingOriginalPage, ShadowFile& shadowFile,
    const std::function<void(uint8_t*)>& updateOp);
```

This is the abstraction that lets storage components work in terms of “original page” while the shadow file intercepts page replacement when needed.

---

## 5. File format of the shadow file

The exact file layout implied by `flushAll(...)` and `replayShadowPageRecords(...)` is:

```text
page 0
  raw ShadowFileHeader copied into the first bytes of the page

pages 1 .. numShadowPages
  page-sized shadow page images

byte offset (numShadowPages + 1) * LBUG_PAGE_SIZE
  Serializer-encoded std::vector<ShadowPageRecord>
```

In expanded form:

```text
/db/path.shadow

  page 0:
    ShadowFileHeader {
      databaseID,
      numShadowPages
    }
    remaining bytes in page are unused padding

  page 1:
    bytes of shadow page for shadowPageRecords[0]

  page 2:
    bytes of shadow page for shadowPageRecords[1]

  ...

  page N:
    bytes of shadow page for shadowPageRecords[N-1]

  trailing serialized vector:
    uint64 vectorSize
    ShadowPageRecord[0]
    ShadowPageRecord[1]
    ...
```

There is no checksum wrapper in `ShadowFile::flushAll(...)`.

The shadow file is not checksum-protected the same way WAL objects are.

Crash safety instead comes from the coordination with the WAL checkpoint record and the database UUID check during replay.

---

## 6. Lazy file creation and reserved header page

The shadow file handle is created only when first needed.

Implementation:

```cpp
FileHandle* ShadowFile::getOrCreateShadowingFH() {
    if (!shadowingFH) {
        shadowingFH = bm.getFileHandle(shadowFilePath,
            FileHandle::O_PERSISTENT_FILE_CREATE_NOT_EXISTS, vfs, nullptr);
        if (shadowingFH->getNumPages() == 0) {
            // Reserve the first page for the header.
            shadowingFH->addNewPage();
        }
    }
    return shadowingFH;
}
```

Consequences:

- `shadowingFH == nullptr` means no shadow file is active yet
- the file always reserves page 0 for `ShadowFileHeader`
- the first real shadow page image is page 1

This is why both apply and replay loops start from `shadowPageIdx = 1`.

---

## 7. Shadow page allocation and mapping

The core method is `getOrCreateShadowPage(...)`:

```cpp
page_idx_t ShadowFile::getOrCreateShadowPage(file_idx_t originalFile, page_idx_t originalPage) {
    if (hasShadowPage(originalFile, originalPage)) {
        return shadowPagesMap[originalFile][originalPage];
    }
    const auto shadowPageIdx = getOrCreateShadowingFH()->addNewPage();
    shadowPagesMap[originalFile][originalPage] = shadowPageIdx;
    shadowPageRecords.push_back({originalFile, originalPage});
    return shadowPageIdx;
}
```

Key behaviors:

- repeated shadowing of the same original page reuses the same shadow page slot
- the persistent replay order is append order in `shadowPageRecords`
- the in-memory lookup structure is a nested map by original file index and page index

There is no deduplication by page contents.

It is purely page-identity based.

---

## 8. Creating a shadow version of a page

The most important helper is:

```cpp
ShadowPageAndFrame ShadowUtils::createShadowVersionIfNecessaryAndPinPage(
    page_idx_t originalPage, bool skipReadingOriginalPage, FileHandle& fileHandle,
    ShadowFile& shadowFile)
```

Implementation summary:

```cpp
const auto hasShadowPage = shadowFile.hasShadowPage(fileHandle.getFileIndex(), originalPage);
auto shadowPage = shadowFile.getOrCreateShadowPage(fileHandle.getFileIndex(), originalPage);
uint8_t* shadowFrame = nullptr;
if (hasShadowPage) {
    shadowFrame = shadowFile.getShadowingFH().pinPage(shadowPage, PageReadPolicy::READ_PAGE);
} else {
    shadowFrame = shadowFile.getShadowingFH().pinPage(shadowPage, PageReadPolicy::DONT_READ_PAGE);
    if (!skipReadingOriginalPage) {
        fileHandle.optimisticReadPage(originalPage, [&](const uint8_t* frame) -> void {
            memcpy(shadowFrame, frame, LBUG_PAGE_SIZE);
        });
    }
}
shadowFile.getShadowingFH().setLockedPageDirty(shadowPage);
return {originalPage, shadowPage, shadowFrame};
```

Operational meaning:

- if a shadow page already exists, pin and reuse it
- otherwise allocate a new shadow page slot
- optionally copy the original page image into the shadow page
- mark the shadow page dirty
- return the writable frame pointer

### 8.1 `skipReadingOriginalPage`

This flag is used when the caller will fully overwrite the page anyway.

Example: database header rewrite during checkpoint uses:

```cpp
ShadowUtils::createShadowVersionIfNecessaryAndPinPage(
    common::StorageConstants::DB_HEADER_PAGE_IDX,
    true /* skipReadingOriginalPage */,
    *dataFH,
    shadowFile);
```

So page 0 is rewritten from scratch rather than copied first.

### 8.2 Existing-shadow-page reuse

The comment in code is important:

```cpp
// The shadow page existing already does not mean that it's already dirty
// It may have been flushed to disk to free memory and then read again
```

So page dirtiness and page shadowing identity are not the same concept.

The method always marks the pinned shadow page dirty before returning.

---

## 9. Transactional page updates through `ShadowUtils::updatePage`

The wrapper is:

```cpp
void ShadowUtils::updatePage(FileHandle& fileHandle, page_idx_t originalPageIdx,
    bool skipReadingOriginalPage, ShadowFile& shadowFile,
    const std::function<void(uint8_t*)>& updateOp)
```

Implementation pattern:

1. create/pin shadow version
2. run caller update lambda on the shadow frame
3. unpin shadow page
4. if update throws, still unpin before rethrow

This is the basic page-update contract used by page-based storage structures.

---

## 10. Reading shadowed pages during checkpoint transactions

`ShadowUtils::getFileHandleAndPhysicalPageIdxToPin(...)` chooses whether checkpoint readers should look at the original file or the shadow file.

```cpp
if (trxType == transaction::TransactionType::CHECKPOINT &&
    shadowFile.hasShadowPage(fileHandle.getFileIndex(), pageIdx)) {
    return std::make_pair(&shadowFile.getShadowingFH(),
        shadowFile.getShadowPage(fileHandle.getFileIndex(), pageIdx));
}
return std::make_pair(&fileHandle, pageIdx);
```

This means a checkpoint transaction sees shadowed page versions when they exist.

That is one of the reasons the code can safely release the write gate early after WAL rotation and continue the checkpoint storage phase against the snapshot state.

A concrete example from `DiskArrayInternal::get(...)`:

```cpp
if (transaction->getType() != TransactionType::CHECKPOINT || !hasTransactionalUpdates ||
    apPageIdx > lastPageOnDisk ||
    !shadowFile->hasShadowPage(fileHandle.getFileIndex(), apPageIdx)) {
    fileHandle.optimisticReadPage(apPageIdx, ...);
} else {
    ShadowUtils::readShadowVersionOfPage(fileHandle, apPageIdx, *shadowFile, ...);
}
```

So checkpoint-time reads are shadow-aware in storage code.

---

## 11. Where the shadow file is used in storage code

The page-shadowing path appears most directly in page-based storage components.

### 11.1 Disk array update path

From `src/storage/disk_array.cpp`:

```cpp
void DiskArrayInternal::updatePage(uint64_t pageIdx, bool isNewPage,
    std::function<void(uint8_t*)> updateOp) {
    // Pages which are new to this transaction are written directly to the file
    // Pages which previously existed are written to the WAL file
    if (pageIdx <= lastPageOnDisk) {
        ShadowUtils::updatePage(fileHandle, pageIdx, isNewPage, *shadowFile, updateOp);
    } else {
        const auto frame = fileHandle.pinPage(pageIdx,
            isNewPage ? PageReadPolicy::DONT_READ_PAGE : PageReadPolicy::READ_PAGE);
        updateOp(frame);
        fileHandle.setLockedPageDirty(pageIdx);
        fileHandle.unpinPage(pageIdx);
    }
}
```

The comment says “written to the WAL file”, but the implementation is actually going through the shadow-file mechanism.

Accurately described:

- existing on-disk pages are updated via shadow pages
- pages beyond `lastPageOnDisk` can be written directly because they are newly allocated for the current durable layout

### 11.2 Header rewrite path

`Checkpointer::writeDatabaseHeader(...)` uses shadowing explicitly for page 0.

```cpp
auto shadowHeader = ShadowUtils::createShadowVersionIfNecessaryAndPinPage(
    common::StorageConstants::DB_HEADER_PAGE_IDX,
    true /* skipReadingOriginalPage */,
    *dataFH,
    shadowFile);
memcpy(shadowHeader.frame, headerPage.data(), common::LBUG_PAGE_SIZE);
shadowFile.getShadowingFH().unpinPage(shadowHeader.shadowPage);
```

This is how checkpoint installs the next durable `DatabaseHeader` without overwriting page 0 in place before the checkpoint is fully committed.

---

## 12. `flushAll()`: materializing the shadow file itself

`ShadowFile::flushAll(main::ClientContext&)` turns the in-memory shadow state into an on-disk `.shadow` file.

Implementation steps:

### 12.1 Write header page

```cpp
ShadowFileHeader header;
header.numShadowPages = shadowPageRecords.size();
header.databaseID = StorageManager::Get(context)->getOrInitDatabaseID(context);
const auto headerBuffer = std::make_unique<uint8_t[]>(LBUG_PAGE_SIZE);
memcpy(headerBuffer.get(), &header, sizeof(ShadowFileHeader));
shadowingFH->writePageToFile(headerBuffer.get(), 0);
```

Meaning:

- database UUID is copied into the shadow file header
- `numShadowPages` is the in-memory record count
- the header is written to page 0 directly

### 12.2 Flush dirty shadow pages

```cpp
shadowingFH->flushAllDirtyPagesInFrames();
```

This pushes page-image contents out to the shadow file.

### 12.3 Append the mapping vector after the page region

```cpp
auto writer = std::make_shared<BufferedFileWriter>(*shadowingFH->getFileInfo());
writer->setFileOffset(shadowingFH->getNumPages() * LBUG_PAGE_SIZE);
Serializer ser(writer);
DASSERT(shadowPageRecords.size() + 1 == shadowingFH->getNumPages());
ser.serializeVector(shadowPageRecords);
writer->flush();
writer->sync();
```

The assertion is a valuable invariant:

```text
num file pages = 1 header page + number of shadow page records
```

The serialized record vector is **not** page-aligned by type; it just begins at the first byte after the last page image.

### 12.4 Durability point for the `.shadow` file itself

The `.shadow` file becomes durable for recovery after `writer->sync()` returns.

This happens **before** the checkpoint record is appended to WAL.

That ordering is critical.

---

## 13. `applyShadowPages()`: copying page images into the data file

The method is:

```cpp
void ShadowFile::applyShadowPages(StorageManager& storageManager, ClientContext& context) const
```

Implementation loop:

```cpp
const auto pageBuffer = std::make_unique<uint8_t[]>(LBUG_PAGE_SIZE);
page_idx_t shadowPageIdx = 1; // Skip header page.
auto dataFH = storageManager.getDataFH();
auto dataFileInfo = dataFH->getFileInfo();
for (const auto& record : shadowPageRecords) {
    shadowingFH->readPageFromDisk(pageBuffer.get(), shadowPageIdx++);
    dataFileInfo->writeFile(pageBuffer.get(), LBUG_PAGE_SIZE,
        record.originalPageIdx * LBUG_PAGE_SIZE);
    MemoryManager::Get(context)->getBufferManager()->updateFrameIfPageIsInFrame(
        record.originalFileIdx, pageBuffer.get(), record.originalPageIdx);
}
dataFileInfo->syncFile();
```

### 13.1 Destination selection caveat

Notice that the destination file is always:

```cpp
auto dataFileInfo = dataFH->getFileInfo();
```

Then writes go to:

```cpp
record.originalPageIdx * LBUG_PAGE_SIZE
```

There is no per-record file-handle selection here.

So `originalFileIdx` is **not** used to choose a target file during apply.

### 13.2 Buffer-manager frame update

After writing page bytes, the code updates an in-memory frame if that page is cached.

The comment explains why:

```cpp
// Acquire page state lock before updating the in-memory frame. This ensures concurrent
// optimistic readers will detect the version change and retry, seeing the new page data.
```

This is the in-memory visibility handoff for optimistic readers.

### 13.3 Sync semantics

`dataFileInfo->syncFile()` happens once after all page copies, not once per page.

---

## 14. Recovery: replaying shadow page records

`ShadowFile::replayShadowPageRecords(ClientContext&)` is the recovery path that applies an already-flushed shadow file after a crash.

### 14.1 Read-only mode is rejected up front

```cpp
if (context.getDBConfig()->readOnly) {
    throw RuntimeException("Couldn't replay shadow pages under read-only mode. Please re-open "
                           "the database with read-write mode to replay shadow pages.");
}
```

### 14.2 Open shadow file and data file

The shadow file is opened read-only.

The main data file is opened read/write with a write lock.

If the data file is missing, the error is converted into a runtime exception explaining that the shadow file may have been left behind from an older database instance with the same name.

### 14.3 Read and verify header

The first page is read into a page-sized buffer and copied into `ShadowFileHeader`:

```cpp
shadowFileInfo->readFromFile(headerBuffer.get(), LBUG_PAGE_SIZE, 0);
memcpy(&header, headerBuffer.get(), sizeof(ShadowFileHeader));
```

Then the shadow-file UUID is verified against the database header UUID:

```cpp
auto oldDatabaseID = getOldDatabaseID(*dataFileInfo);
FileDBIDUtils::verifyDatabaseID(*shadowFileInfo, oldDatabaseID, header.databaseID);
```

### 14.4 Read the mapping vector

The reader seeks to:

```cpp
(header.numShadowPages + 1) * LBUG_PAGE_SIZE
```

Then deserializes the vector of `ShadowPageRecord`.

### 14.5 Copy shadow pages back

Replay loop:

```cpp
page_idx_t shadowPageIdx = 1;
for (const auto& record : shadowPageRecords) {
    shadowFileInfo->readFromFile(pageBuffer.get(), LBUG_PAGE_SIZE,
        shadowPageIdx * LBUG_PAGE_SIZE);
    dataFileInfo->writeFile(pageBuffer.get(), LBUG_PAGE_SIZE,
        record.originalPageIdx * LBUG_PAGE_SIZE);
    shadowPageIdx++;
}
```

Again, just like `applyShadowPages(...)`, the destination is the main data file and the record’s `originalFileIdx` is not used to choose a target handle.

### 14.6 When this function is invoked

It is invoked by `WALReplayer`, not by checkpoint code directly.

The trigger condition is: the last safe replay boundary in the relevant WAL file is a `CHECKPOINT_RECORD`.

That means the shadow file had been fully flushed and the checkpoint sentinel had been durably written before the crash.

---

## 15. Exact checkpoint ordering across shadow file and WAL

The core ordering is encoded in `Checkpointer::logCheckpointAndApplyShadowPages(...)`.

```cpp
shadowFile.flushAll(clientContext);
if (walRotated_) {
    wal->logAndFlushCheckpointToFrozen(&clientContext);
} else {
    wal->logAndFlushCheckpoint(&clientContext);
}
shadowFile.applyShadowPages(*mainStorageManager, clientContext);
if (!walRotated_) {
    wal->clear();
}
shadowFile.clear(*bufferManager);
```

This creates the following crash semantics.

### 15.1 Crash before `flushAll()` completes

- shadow file may be incomplete
- there is no checkpoint record yet
- recovery falls back to stable checkpoint + WAL replay

### 15.2 Crash after `flushAll()` but before checkpoint record

- shadow file may exist and contain valid page images
- but there is no durable checkpoint sentinel
- recovery discards the shadow file and replays logical WAL instead

### 15.3 Crash after checkpoint record but before `applyShadowPages()` completes

- shadow file is durable
- WAL says checkpoint record exists
- recovery replays shadow page records into the data file

### 15.4 Crash after `applyShadowPages()` but before cleanup

- data file may already contain the new pages
- recovery still treats the checkpoint record as authoritative and replays shadow pages again if needed
- page copy is idempotent at the page-image level for the same source bytes

This is why the checkpoint record and shadow file are coordinated so tightly.

---

## 16. `clear()` vs `reset()` on the shadow file

These methods do different things.

### 16.1 `clear(BufferManager&)`

Implementation:

```cpp
bm.removeFilePagesFromFrames(*shadowingFH);
shadowingFH->resetToZeroPagesAndPageCapacity();
shadowPagesMap.clear();
shadowPageRecords.clear();
shadowingFH->addNewPage();
```

Effect:

- remove shadow-file pages from buffer-manager frames
- truncate the shadow file handle to zero pages/capacity
- clear in-memory mapping state
- immediately reserve the header page again

This is a “reuse the current shadow file handle cleanly” operation.

### 16.2 `reset()`

Implementation:

```cpp
shadowingFH->resetFileInfo();
shadowingFH = nullptr;
vfs->removeFileIfExists(shadowFilePath);
```

Effect:

- detach the file handle from the underlying file info
- null the pointer
- remove the `.shadow` file from the VFS

This is the final teardown path used after checkpoint cleanup is complete.

### 16.3 Why both exist

During checkpoint, `clear()` happens immediately after the shadow pages have been applied.

Later, `postCheckpointCleanup()` calls `shadowFile.reset()` after the rest of the durable state has been finalized.

The implementation therefore has both:

- an immediate logical clear for in-process state
- a later final file removal/handle teardown

---

## 17. Checkpointer phases that matter for shadowing

The modern checkpoint implementation is split across several methods.

### 17.1 `beginCheckpoint(snapshotTS)`

Important actions:

- stores `snapshotTS`
- rotates WAL if possible
- snapshots database header
- captures storage-version upgrade state
- captures catalog/page-manager versions while the write gate is held
- captures per-table change-epoch watermarks

Code excerpt:

```cpp
snapshotTS = snapshotTimestamp;
walRotated = mainStorageManager->getWAL().rotateForCheckpoint(&clientContext);
checkpointHeader = *mainStorageManager->getOrInitDatabaseHeader(clientContext);
const auto oldStorageVersion = checkpointHeader.storageVersion;
checkpointHeader.storageVersion = StorageVersionInfo::getStorageVersion();
hasStorageVersionUpgrade = oldStorageVersion != checkpointHeader.storageVersion;
catalogVersionAtCheckpoint = clientContext.getDatabase()->getCatalog()->getVersion();
pageManagerVersionAtCheckpoint =
    mainStorageManager->getDataFH()->getPageManager()->getVersion();
tableEpochWatermarks = mainStorageManager->captureChangeEpochs();
```

### 17.2 `checkpointStoragePhase()`

This materializes committed state into storage structures:

```cpp
hasStorageChanges = checkpointStorage();
```

Under snapshot mode, this calls:

```cpp
mainStorageManager->checkpoint(&clientContext, snapshotTxn, *pageAllocator,
    tableEpochWatermarks);
```

This is where storage components can create/update shadowed pages as they write their checkpointed representation.

### 17.3 `finishCheckpoint()`

This performs:

- catalog serialization
- metadata serialization
- database-header rewrite through shadowing
- shadow/WAL/apply sequence

Key lines:

```cpp
serializeCatalogAndMetadata(checkpointHeader, hasStorageChanges);
checkpointHeader.dataFileNumPages = mainStorageManager->getDataFH()->getNumPages();
writeDatabaseHeader(checkpointHeader);
logCheckpointAndApplyShadowPages(walRotated);
```

### 17.4 `postCheckpointCleanup()`

After the durable work is done:

```cpp
mainStorageManager->finalizeCheckpoint();
auto bufferManager = MemoryManager::Get(clientContext)->getBufferManager();
bufferManager->removeEvictedCandidates();
clientContext.getDatabase()->getCatalog()->resetVersion(catalogVersionAtCheckpoint);
auto* dataFH = mainStorageManager->getDataFH();
dataFH->getPageManager()->resetVersion(pageManagerVersionAtCheckpoint);
if (walRotated) {
    mainStorageManager->getWAL().clearFrozenWAL();
} else {
    mainStorageManager->getWAL().reset();
}
mainStorageManager->getShadowFile().reset();
```

So the shadow file is only finally removed after the rest of the checkpoint cleanup succeeds.

---

## 18. Database header rewrite is shadowed too

The database header is not special-cased to bypass shadowing.

`Checkpointer::writeDatabaseHeader(...)` does this:

1. serialize header into an `InMemFileWriter`
2. take page 0 from that in-memory serializer
3. create/pin a shadow version of database page 0
4. copy the page-sized serialized header into the shadow frame
5. unpin
6. update the in-memory `StorageManager` header pointer

Code excerpt:

```cpp
auto headerWriter = std::make_shared<common::InMemFileWriter>(*MemoryManager::Get(clientContext));
common::Serializer headerSerializer(headerWriter);
header.serialize(headerSerializer);
auto headerPage = headerWriter->getPage(0);

auto dataFH = mainStorageManager->getDataFH();
auto& shadowFile = mainStorageManager->getShadowFile();
auto shadowHeader = ShadowUtils::createShadowVersionIfNecessaryAndPinPage(
    common::StorageConstants::DB_HEADER_PAGE_IDX, true /* skipReadingOriginalPage */, *dataFH,
    shadowFile);
memcpy(shadowHeader.frame, headerPage.data(), common::LBUG_PAGE_SIZE);
shadowFile.getShadowingFH().unpinPage(shadowHeader.shadowPage);
mainStorageManager->setDatabaseHeader(std::make_unique<DatabaseHeader>(header));
```

This means the checkpoint’s authoritative header update is covered by the same shadow + WAL checkpoint protocol as other replaced pages.

---

## 19. Checkpoint gating and read-transaction behavior

`TransactionManager::checkpointNoLock(...)` is the checkpoint gatekeeper.

### 19.1 Only writers are drained

Actual comment:

```cpp
// We only need to wait for active write transactions to leave the system before
// checkpointing. Read transactions can continue safely because they use MVCC snapshot
// isolation and shadow pages are applied with per-page locking.
```

The code calls:

```cpp
writeGate = stopNewWriteTransactionsAndWaitUntilAllWriteTransactionsLeave();
```

not the “all transactions” variant.

### 19.2 Early release after WAL rotation

After `beginCheckpoint(...)`:

```cpp
if (checkpointer->wasWalRotated()) {
    writeGate = {};
}
```

Meaning:

- old committed WAL state is isolated in `dbPath.wal.checkpoint`
- new writers can generate a fresh active WAL
- checkpoint storage reads can consult shadowed pages for snapshot consistency

### 19.3 Snapshot caveat in code

The code documents a limitation for hash-index local storage after the write gate is released:

- new inserts after gate release may appear in an on-disk hash index even though corresponding node data was not included in the checkpoint snapshot
- this is described in a note inside `transaction_manager.cpp`

That caveat belongs to checkpoint snapshotting semantics, not to shadowing alone, but it matters when reasoning about the durability boundary.

For broader checkpoint semantics, see [Checkpointing](/transaction/checkpointing).

---

## 20. Recovery decision points involving the shadow file

The shadow file is only meaningful together with WAL state.

### 20.1 No WAL files

`WALReplayer::replay(...)` removes the shadow file if neither active nor rotated WAL exists:

```cpp
if (!hasFrozenWAL && !hasActiveWAL) {
    removeFileIfExists(shadowFilePath);
    checkpointer.readCheckpoint();
    return;
}
```

A standalone shadow file without WAL is treated as stale garbage.

### 20.2 Rotated checkpoint WAL exists

If replay of the rotated WAL finds a terminal `CHECKPOINT_RECORD`:

- `ShadowFile::replayShadowPageRecords(...)`
- remove rotated WAL
- remove shadow file
- read durable checkpoint from data file

If no terminal checkpoint record exists:

- remove shadow file
- read durable checkpoint from data file
- replay logical records from the rotated WAL safe prefix
- remove rotated WAL

### 20.3 Active WAL exists and ends with `CHECKPOINT_RECORD`

Then replay also uses `ShadowFile::replayShadowPageRecords(...)`, after which:

- WAL and shadow are removed
- checkpoint is read from disk

### 20.4 Active WAL exists without terminal checkpoint record

Then the shadow file is not the source of truth.

Logical WAL records are replayed and the active WAL is truncated to the last safe offset.

---

## 21. Database-ID verification and stale-file defense

The shadow file uses the same database UUID model as WAL.

### 21.1 Source of truth UUID

The durable database header contains:

```cpp
common::uuid databaseID{0};
```

### 21.2 Shadow-file header stores the same UUID

`flushAll()` writes:

```cpp
header.databaseID = StorageManager::Get(context)->getOrInitDatabaseID(context);
```

### 21.3 Recovery compares them

```cpp
auto oldDatabaseID = getOldDatabaseID(*dataFileInfo);
FileDBIDUtils::verifyDatabaseID(*shadowFileInfo, oldDatabaseID, header.databaseID);
```

This prevents accidental application of a stale `.shadow` file left behind from another database that reused the same path.

That protection is essential because the shadow file otherwise contains raw page images that would be dangerous to apply blindly.

---

## 22. Buffer-manager interaction

The shadow file is not invisible to the buffer manager.

Important interactions include:

### 22.1 `getOrCreateShadowingFH()` uses the buffer manager’s file-handle registry

```cpp
shadowingFH = bm.getFileHandle(shadowFilePath,
    FileHandle::O_PERSISTENT_FILE_CREATE_NOT_EXISTS, vfs, nullptr);
```

### 22.2 `clear(BufferManager&)` removes shadow-file pages from frames

```cpp
bm.removeFilePagesFromFrames(*shadowingFH);
```

### 22.3 `applyShadowPages(...)` updates any in-memory frame for pages that were just copied into the data file

```cpp
MemoryManager::Get(context)->getBufferManager()->updateFrameIfPageIsInFrame(
    record.originalFileIdx, pageBuffer.get(), record.originalPageIdx);
```

This means shadow-page application is not just a disk-level operation.

It also updates the buffer-manager view so optimistic readers do not continue seeing stale page contents after checkpoint application.

---

## 23. Relationship to local storage

Ordinary write transactions stage changes in [Local Storage](/transaction/local-storage).

The relevant boundary here is:

1. user writes go into transaction-local structures
2. commit makes those changes part of the committed in-memory state and logs logical WAL records
3. checkpoint materializes committed state to durable storage structures
4. when existing on-disk pages must be replaced, shadow pages are used

So the shadow file is not the first write destination for ordinary DML.

It is the page-replacement mechanism used during durable materialization and checkpoint finishing.

That is why this page and [Local Storage](/transaction/local-storage) need to be read together.

---

## 24. Attached-database caveat

`AttachedLbugDatabase` does not perform normal writable WAL/shadow recovery.

It validates that the active WAL is empty before allowing attach:

```cpp
if (walFile->getFileSize() > 0) {
    throw common::RuntimeException(std::format(
        "Cannot attach an external Lbug database with non-empty wal file. Try manually "
        "checkpointing the external database (i.e., run \"CHECKPOINT;\")."));
}
```

Operational meaning:

- external attached DBs are expected to be checkpoint-clean
- attach mode is read-only for the external DB path
- if shadow replay were required, read-only mode would reject it anyway

---

## 25. Limitations and sharp edges visible in code

### 25.1 `ShadowFile` is explicitly not thread-safe by itself

Header comment:

```cpp
// NOTE: This class is NOT thread-safe for now, as we are not checkpointing in parallel yet.
```

The surrounding checkpoint orchestration provides the required sequencing.

### 25.2 `originalFileIdx` is underused in apply/replay

The current implementation persists it and uses it for lookups/frame updates, but page-copy destinations are still the main data file.

If shadowing were ever extended to multiple persistent files with independent destinations, `applyShadowPages(...)` and `replayShadowPageRecords(...)` would need corresponding changes.

### 25.3 No checksum wrapper around shadow-page records

Unlike WAL, the shadow file currently relies on:

- durable write ordering
- WAL checkpoint sentinel
- database UUID verification

There is no `ChecksumWriter` or `ChecksumReader` in `shadow_file.cpp`.

### 25.4 `clear()` requires an existing shadow file handle

`clear(BufferManager&)` has:

```cpp
DASSERT(shadowingFH);
```

It is not designed to be a no-op before any shadow pages exist.

### 25.5 Recovery writes are page-granular and sequential

Replay reads each shadow page and copies it into the data file one page at a time.

There is no scatter/gather batching or checksum tree.

This is simple and robust, but it is intentionally low-level.

---

## 26. End-to-end sequence diagram

A realistic successful checkpoint with WAL rotation looks like this:

```text
TransactionManager::checkpointNoLock()
  -> stop new write transactions
  -> wait until active writers leave
  -> snapshot lastTimestamp
  -> Checkpointer::beginCheckpoint(snapshotTS)
       -> WAL::rotateForCheckpoint()
       -> snapshot DB header, versions, change epochs
  -> release write gate early if WAL rotated
  -> Checkpointer::checkpointStoragePhase()
       -> StorageManager::checkpoint(... snapshotTxn ...)
       -> storage structures create/update shadow pages as needed
  -> Checkpointer::finishCheckpoint()
       -> serialize catalog/metadata snapshot
       -> writeDatabaseHeader() through shadow page 0
       -> shadowFile.flushAll()
       -> WAL::logAndFlushCheckpointToFrozen()
       -> shadowFile.applyShadowPages()
       -> shadowFile.clear()
  -> Checkpointer::postCheckpointCleanup()
       -> finalizeCheckpoint()
       -> clear frozen WAL
       -> shadowFile.reset()
```

Crash recovery when the crash happens after the checkpoint record but before cleanup is:

```text
startup
  -> WALReplayer::replay(...)
  -> detect terminal CHECKPOINT_RECORD in rotated or active WAL
  -> ShadowFile::replayShadowPageRecords()
  -> remove checkpoint WAL / WAL / shadow file as appropriate
  -> Checkpointer::readCheckpoint()
```

---

## 27. Quick reference

### 27.1 How do I know whether a page has a shadow copy right now?

Use:

```cpp
shadowFile.hasShadowPage(fileIdx, pageIdx)
```

### 27.2 How do I get the shadow page number for an original page?

Use:

```cpp
shadowFile.getShadowPage(fileIdx, pageIdx)
```

### 27.3 How is the mapping persisted?

`ShadowPageRecord` vector at the end of the `.shadow` file.

### 27.4 Where is the number of shadow pages stored?

`ShadowFileHeader::numShadowPages` on page 0.

### 27.5 What makes a shadow file belong to the correct DB?

`ShadowFileHeader::databaseID`, verified against the database header UUID.

### 27.6 What tells recovery to trust the shadow file?

A terminal `CHECKPOINT_RECORD` in the relevant WAL file.

### 27.7 What cleans up the shadow file after success?

- immediate in-process cleanup: `shadowFile.clear(...)`
- final teardown/removal: `shadowFile.reset()` in `postCheckpointCleanup()`

---

## 28. Summary

The shadow-file implementation is a page-copy checkpoint mechanism with these real properties:

- the file path is `dbPath.shadow`
- page 0 stores `ShadowFileHeader { databaseID, numShadowPages }`
- shadow pages start at page index `1`
- the tail of the file stores serialized `ShadowPageRecord` mappings
- `shadowPagesMap` tracks original file/page -> shadow page in memory
- `ShadowUtils` is the main API layer for creating, reading, and updating shadowed pages
- checkpoint transactions can read shadowed page versions directly
- checkpoint durability order is `flushAll -> WAL checkpoint record -> applyShadowPages -> clear/reset`
- recovery only replays shadow pages when WAL proves the checkpoint sentinel was durably written
- only write transactions are drained for checkpoint; reads continue
- the implementation stores `originalFileIdx`, but current apply/replay code still writes into the main data file handle only

If you are debugging checkpoint durability, read these files together:

- `src/storage/shadow_file.cpp`
- `src/storage/shadow_utils.cpp`
- `src/storage/checkpointer.cpp`
- `src/transaction/transaction_manager.cpp`
- `src/storage/wal/wal.cpp`
- `src/storage/wal/wal_replayer.cpp`

Those files define the actual page-level durability contract.
