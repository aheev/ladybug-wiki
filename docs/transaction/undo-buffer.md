# Undo Buffer

This page is the definitive engineering reference for Ladybug’s `UndoBuffer`: the
transaction-owned log of logical rollback/commit actions that connects MVCC metadata,
local storage staging, and commit timestamp installation. It is not a generic ARIES undo
log, not a user-visible history store, and not a replacement for the WAL. It is the
in-memory structure a transaction uses to remember how to finalize or revert the changes
it has already registered in storage metadata.

The easiest way to misunderstand the undo buffer is to picture it as “a stack of row
images.” The current code is more specific. `UndoBuffer` stores variable-sized records
in blocks, each record has a compact header, and commit/rollback dispatch happens by
interpreting that header and calling storage- or catalog-specific handlers. For
row-presence version metadata, the undo buffer delegates through `VersionRecordHandler`;
for property updates, it dispatches directly to `UpdateInfo`.

## Authoritative sources

- `src/include/storage/undo_buffer.h` — public layout, iterator types, sparse enum, and
    create helpers
- `src/storage/undo_buffer.cpp` — allocation, iteration, private record layouts, commit,
    and rollback dispatch
- `src/include/storage/table/version_record_handler.h` — dispatch surface between undo
    and chunked-node-group MVCC metadata
- `src/storage/table/version_record_handler.cpp` — default rollback insert handler
    implementation
- `src/include/storage/table/update_info.h` — update-chain types used by `UPDATE_INFO`
    records
- `src/storage/table/update_info.cpp` — vector update commit/rollback behavior
- `src/include/storage/table/version_info.h` — insert/delete version payloads and row-
    level visibility helpers
- `src/storage/table/version_info.cpp` — insert/delete commit/rollback behavior
- `src/storage/table/chunked_node_group.cpp` — bridge from undo records to `VersionInfo`
    commit/rollback methods
- `src/transaction/transaction.cpp` — how `UndoBuffer` fits into commit/rollback
    ordering
- `src/include/transaction/transaction.h` — ownership and lifetime from the transaction
    object

Cross-reference pages: MVCC semantics live in [/transaction/mvcc](/transaction/mvcc);
transaction lifecycle and checkpoint coordination live in
[/transaction/transaction-manager](/transaction/transaction-manager); write staging
lives in [/transaction/local-storage](/transaction/local-storage); durability and WAL
interaction live in [/storage/wal-internals](/storage/wal-internals) and
[/storage/shadow-wal](/storage/shadow-wal).

## Where the undo buffer lives

Each `Transaction` owns one `UndoBuffer` instance directly. It is not shared between
transactions, not globally indexed, and not persisted independently.

```cpp
    TransactionType type;
    common::transaction_t ID;
    common::transaction_t startTS;
    common::transaction_t commitTS;
    int64_t currentTS;
    main::ClientContext* clientContext;
    std::unique_ptr<storage::LocalStorage> localStorage;
    std::unique_ptr<storage::UndoBuffer> undoBuffer;
    std::unique_ptr<storage::LocalWAL> localWAL;
```

That ownership model drives the rest of the design:

- all undo records in one buffer belong to exactly one transaction
- record iteration order is transaction-local
- commit converts transaction IDs in MVCC metadata to the transaction’s `commitTS`
- rollback reverts uncommitted metadata and logical side effects for that transaction
    only

## What goes into the buffer

The record type enum is defined directly inside `UndoBuffer`, and it is sparse.
Documentation should preserve the exact numeric values because they show up in debugging
and are easy to misstate.

```cpp
class UndoBuffer {
    friend class UndoBufferIterator;

public:
    enum class UndoRecordType : uint16_t {
        CATALOG_ENTRY = 0,
        SEQUENCE_ENTRY = 1,
        UPDATE_INFO = 6,
        INSERT_INFO = 7,
        DELETE_INFO = 8,
    };

    explicit UndoBuffer(MemoryManager* mm) : mm{mm} {}

    void createCatalogEntry(catalog::CatalogSet& catalogSet, catalog::CatalogEntry& catalogEntry);
    void createSequenceChange(catalog::SequenceCatalogEntry& sequenceEntry,
        const catalog::SequenceRollbackData& data);
    void createInsertInfo(common::node_group_idx_t nodeGroupIdx, common::row_idx_t startRow,
        common::row_idx_t numRows, const VersionRecordHandler* versionRecordHandler);
    void createDeleteInfo(common::node_group_idx_t nodeGroupIdx, common::row_idx_t startRow,
        common::row_idx_t numRows, const VersionRecordHandler* versionRecordHandler);
    void createVectorUpdateInfo(UpdateInfo* updateInfo, common::idx_t vectorIdx,
        VectorUpdateInfo* vectorUpdateInfo, common::transaction_t version);

    void commit(common::transaction_t commitTS) const;
    void rollback(main::ClientContext* context) const;
```

| Enum constant | Numeric value | Meaning |
| --- | --- | --- |
| `CATALOG_ENTRY` | `0` | transaction-local catalog version finalization/rollback record |
| `SEQUENCE_ENTRY` | `1` | rollback record for sequence state |
| `UPDATE_INFO` | `6` | vector update metadata record backed by `UpdateInfo` and `VectorUpdateInfo` |
| `INSERT_INFO` | `7` | insert visibility record for chunked node-group version metadata |
| `DELETE_INFO` | `8` | delete visibility record for chunked node-group version metadata |

There are no values `2`, `3`, `4`, or `5` in the current enum. That is the
implementation, not an omission in this page.

## Physical layout inside `UndoBuffer`

The buffer owns a vector of `UndoMemoryBuffer` blocks. Each block wraps a
`MemoryBuffer`, stores a capacity, and tracks the current append position. Initial
capacity is `common::LBUG_PAGE_SIZE`; oversized records grow the block size
geometrically until the record fits.

```cpp
class UndoMemoryBuffer {
public:
    static constexpr uint64_t UNDO_MEMORY_BUFFER_INIT_CAPACITY = common::LBUG_PAGE_SIZE;

    explicit UndoMemoryBuffer(std::unique_ptr<MemoryBuffer> buffer, uint64_t capacity)
        : buffer{std::move(buffer)}, capacity{capacity} {
        currentPosition = 0;
    }

    uint8_t* getDataUnsafe() const { return buffer->getData(); }
    uint8_t const* getData() const { return buffer->getData(); }
    uint64_t getSize() const { return capacity; }
    uint64_t getCurrentPosition() const { return currentPosition; }
    void moveCurrentPosition(uint64_t offset) {
        DASSERT(currentPosition + offset <= capacity);
        currentPosition += offset;
    }
    bool canFit(uint64_t size_) const { return currentPosition + size_ <= this->capacity; }

private:
    std::unique_ptr<MemoryBuffer> buffer;
    uint64_t capacity;
    uint64_t currentPosition;
};
```

```cpp
uint8_t* UndoBuffer::createUndoRecord(const uint64_t size) {
    std::unique_lock xLck{mtx};
    if (memoryBuffers.empty() || !memoryBuffers.back().canFit(size)) {
        auto capacity = UndoMemoryBuffer::UNDO_MEMORY_BUFFER_INIT_CAPACITY;
        while (size > capacity) {
            capacity *= 2;
        }
        // We need to allocate a new memory buffer.
        memoryBuffers.emplace_back(mm->allocateBuffer(false, capacity), capacity);
    }
    const auto res =
        memoryBuffers.back().getDataUnsafe() + memoryBuffers.back().getCurrentPosition();
    memoryBuffers.back().moveCurrentPosition(size);
    return res;
```

Each appended record starts with a small private `UndoRecordHeader` defined in
`undo_buffer.cpp`. That header stores exactly two fields: the `UndoRecordType` and the
payload `recordSize`. The payload layout after the header depends on the record kind.

```cpp
struct UndoRecordHeader {
    UndoBuffer::UndoRecordType recordType;
    uint32_t recordSize;

    UndoRecordHeader(const UndoBuffer::UndoRecordType recordType, const uint32_t recordSize)
        : recordType{recordType}, recordSize{recordSize} {}
};

struct CatalogEntryRecord {
    CatalogSet* catalogSet;
    CatalogEntry* catalogEntry;
};

struct SequenceEntryRecord {
    SequenceCatalogEntry* sequenceEntry;
    SequenceRollbackData sequenceRollbackData;
};

struct NodeBatchInsertRecord {
    table_id_t tableID;
};

struct VersionRecord {
    row_idx_t startRow;
    row_idx_t numRows;
    node_group_idx_t nodeGroupIdx;
    const VersionRecordHandler* versionRecordHandler;
};

struct VectorUpdateRecord {
    UpdateInfo* updateInfo;
    idx_t vectorIdx;
    VectorUpdateInfo* vectorUpdateInfo;
    transaction_t version; // This is used during roll back.
};
```

| Record kind | Payload struct in `undo_buffer.cpp` | Payload contents |
| --- | --- | --- |
| `CATALOG_ENTRY` | `CatalogEntryRecord` | pointers to `CatalogSet` and the base `CatalogEntry` |
| `SEQUENCE_ENTRY` | `SequenceEntryRecord` | pointer to `SequenceCatalogEntry` plus `SequenceRollbackData` |
| `INSERT_INFO` / `DELETE_INFO` | `VersionRecord` | `startRow`, `numRows`, `nodeGroupIdx`, and `VersionRecordHandler*` |
| `UPDATE_INFO` | `VectorUpdateRecord` | `UpdateInfo*`, `vectorIdx`, `VectorUpdateInfo*`, and the original `version` |

There is no generic “before image” payload type and no extra length/position metadata
beyond what the code above shows.

## Appending records

`UndoBuffer::createUndoRecord()` is the only allocator. It acquires the internal mutex,
appends into the last block when there is enough free space, or allocates a new block
before returning a raw pointer to the reserved region.

```cpp
void UndoBuffer::createCatalogEntry(CatalogSet& catalogSet, CatalogEntry& catalogEntry) {
    auto buffer = createUndoRecord(sizeof(UndoRecordHeader) + sizeof(CatalogEntryRecord));
    const UndoRecordHeader recordHeader{UndoRecordType::CATALOG_ENTRY, sizeof(CatalogEntryRecord)};
    *reinterpret_cast<UndoRecordHeader*>(buffer) = recordHeader;
    buffer += sizeof(UndoRecordHeader);
    const CatalogEntryRecord catalogEntryRecord{&catalogSet, &catalogEntry};
    *reinterpret_cast<CatalogEntryRecord*>(buffer) = catalogEntryRecord;
}

void UndoBuffer::createSequenceChange(SequenceCatalogEntry& sequenceEntry,
    const SequenceRollbackData& data) {
    auto buffer = createUndoRecord(sizeof(UndoRecordHeader) + sizeof(SequenceEntryRecord));
    const UndoRecordHeader recordHeader{UndoRecordType::SEQUENCE_ENTRY,
        sizeof(SequenceEntryRecord)};
    *reinterpret_cast<UndoRecordHeader*>(buffer) = recordHeader;
    buffer += sizeof(UndoRecordHeader);
    const SequenceEntryRecord sequenceEntryRecord{&sequenceEntry, data};
    *reinterpret_cast<SequenceEntryRecord*>(buffer) = sequenceEntryRecord;
}

void UndoBuffer::createInsertInfo(node_group_idx_t nodeGroupIdx, row_idx_t startRow,
    row_idx_t numRows, const VersionRecordHandler* versionRecordHandler) {
    createVersionInfo(UndoRecordType::INSERT_INFO, startRow, numRows, versionRecordHandler,
        nodeGroupIdx);
}

void UndoBuffer::createDeleteInfo(node_group_idx_t nodeGroupIdx, row_idx_t startRow,
    row_idx_t numRows, const VersionRecordHandler* versionRecordHandler) {
    createVersionInfo(UndoRecordType::DELETE_INFO, startRow, numRows, versionRecordHandler,
        nodeGroupIdx);
}

void UndoBuffer::createVersionInfo(const UndoRecordType recordType, row_idx_t startRow,
    row_idx_t numRows, const VersionRecordHandler* versionRecordHandler,
    node_group_idx_t nodeGroupIdx) {
    DASSERT(versionRecordHandler);
    auto buffer = createUndoRecord(sizeof(UndoRecordHeader) + sizeof(VersionRecord));
    const UndoRecordHeader recordHeader{recordType, sizeof(VersionRecord)};
    *reinterpret_cast<UndoRecordHeader*>(buffer) = recordHeader;
    buffer += sizeof(UndoRecordHeader);
    *reinterpret_cast<VersionRecord*>(buffer) =
        VersionRecord{startRow, numRows, nodeGroupIdx, versionRecordHandler};
}

void UndoBuffer::createVectorUpdateInfo(UpdateInfo* updateInfo, const idx_t vectorIdx,
    VectorUpdateInfo* vectorUpdateInfo, transaction_t version) {
    auto buffer = createUndoRecord(sizeof(UndoRecordHeader) + sizeof(VectorUpdateRecord));
    const UndoRecordHeader recordHeader{UndoRecordType::UPDATE_INFO, sizeof(VectorUpdateRecord)};
    *reinterpret_cast<UndoRecordHeader*>(buffer) = recordHeader;
    buffer += sizeof(UndoRecordHeader);
    const VectorUpdateRecord vectorUpdateRecord{updateInfo, vectorIdx, vectorUpdateInfo, version};
    *reinterpret_cast<VectorUpdateRecord*>(buffer) = vectorUpdateRecord;
}

uint8_t* UndoBuffer::createUndoRecord(const uint64_t size) {
    std::unique_lock xLck{mtx};
    if (memoryBuffers.empty() || !memoryBuffers.back().canFit(size)) {
        auto capacity = UndoMemoryBuffer::UNDO_MEMORY_BUFFER_INIT_CAPACITY;
        while (size > capacity) {
            capacity *= 2;
        }
        // We need to allocate a new memory buffer.
        memoryBuffers.emplace_back(mm->allocateBuffer(false, capacity), capacity);
    }
    const auto res =
        memoryBuffers.back().getDataUnsafe() + memoryBuffers.back().getCurrentPosition();
    memoryBuffers.back().moveCurrentPosition(size);
    return res;
```

The high-level append properties are:

- records are append-only for the lifetime of the transaction
- allocation is monotonic within each buffer block
- the block vector grows as needed; records are never compacted in place
- each `create*` helper writes a header and then serializes its payload directly into
    the reserved space

## Iteration model

`UndoBufferIterator` provides forward and reverse traversal. Forward traversal walks
each block from offset 0 to `currentPosition`; reverse traversal first materializes
entries in a temporary vector for the block, then invokes callbacks from newest to
oldest within that block and proceeds block-by-block in reverse.

```cpp
class UndoBuffer;
class UndoBufferIterator {
public:
    explicit UndoBufferIterator(const UndoBuffer& undoBuffer) : undoBuffer{undoBuffer} {}

    template<typename F>
    void iterate(F&& callback);
    template<typename F>
    void reverseIterate(F&& callback);

private:
    const UndoBuffer& undoBuffer;
};

class UpdateInfo;
class VersionInfo;
struct VectorUpdateInfo;
class WAL;
```

```cpp
template<typename F>
void UndoBufferIterator::iterate(F&& callback) {
    idx_t bufferIdx = 0;
    while (bufferIdx < undoBuffer.memoryBuffers.size()) {
        auto& currentBuffer = undoBuffer.memoryBuffers[bufferIdx];
        auto current = currentBuffer.getData();
        const auto end = current + currentBuffer.getCurrentPosition();
        while (current < end) {
            UndoRecordHeader recordHeader = *reinterpret_cast<UndoRecordHeader const*>(current);
            current += sizeof(UndoRecordHeader);
            callback(recordHeader.recordType, current);
            current += recordHeader.recordSize; // Skip the current entry.
        }
        bufferIdx++;
    }
}

template<typename F>
void UndoBufferIterator::reverseIterate(F&& callback) {
    idx_t numBuffersLeft = undoBuffer.memoryBuffers.size();
    while (numBuffersLeft > 0) {
        const auto bufferIdx = numBuffersLeft - 1;
        auto& currentBuffer = undoBuffer.memoryBuffers[bufferIdx];
        auto current = currentBuffer.getData();
        const auto end = current + currentBuffer.getCurrentPosition();
        std::vector<std::pair<UndoBuffer::UndoRecordType, uint8_t const*>> entries;
        while (current < end) {
            UndoRecordHeader recordHeader = *reinterpret_cast<UndoRecordHeader const*>(current);
            current += sizeof(UndoRecordHeader);
            entries.push_back({recordHeader.recordType, current});
            current += recordHeader.recordSize; // Skip the current entry.
        }
        for (auto i = entries.size(); i >= 1; i--) {
            callback(entries[i - 1].first, entries[i - 1].second);
        }
        numBuffersLeft--;
    }
}
```

| Direction | Method | Used by |
| --- | --- | --- |
| forward | `iterate()` | `UndoBuffer::commit()` |
| reverse | `reverseIterate()` | `UndoBuffer::rollback()` |

That ordering is intentional: commit finalizes records in creation order, while rollback
unwinds them in reverse creation order.

## Commit dispatch

`Transaction::commit()` calls `undoBuffer->commit(commitTS)` after local storage commit
and before shared WAL persistence. `UndoBuffer::commit()` then dispatches each record by
type.

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

```cpp
void UndoBuffer::commit(transaction_t commitTS) const {
    UndoBufferIterator iterator{*this};
    iterator.iterate([&](UndoRecordType entryType, uint8_t const* entry) {
        commitRecord(entryType, entry, commitTS);
    });
}

void UndoBuffer::rollback(ClientContext* context) const {
    UndoBufferIterator iterator{*this};
    iterator.reverseIterate([&](UndoRecordType entryType, uint8_t const* entry) {
        rollbackRecord(context, entryType, entry);
    });
}

void UndoBuffer::commitRecord(UndoRecordType recordType, const uint8_t* record,
    transaction_t commitTS) {
    switch (recordType) {
    case UndoRecordType::CATALOG_ENTRY: {
        commitCatalogEntryRecord(record, commitTS);
    } break;
    case UndoRecordType::SEQUENCE_ENTRY: {
        commitSequenceEntry(record, commitTS);
    } break;
    case UndoRecordType::INSERT_INFO:
    case UndoRecordType::DELETE_INFO: {
        commitVersionInfo(recordType, record, commitTS);
    } break;
    case UndoRecordType::UPDATE_INFO: {
        commitVectorUpdateInfo(record, commitTS);
    } break;
    default:
        UNREACHABLE_CODE;
    }
}

void UndoBuffer::commitCatalogEntryRecord(const uint8_t* record, const transaction_t commitTS) {
    const auto& [_, catalogEntry] = *reinterpret_cast<CatalogEntryRecord const*>(record);
    const auto newCatalogEntry = catalogEntry->getNext();
    DASSERT(newCatalogEntry);
    newCatalogEntry->setTimestamp(commitTS);
}

void UndoBuffer::commitVersionInfo(UndoRecordType recordType, const uint8_t* record,
    transaction_t commitTS) {
    const auto& undoRecord = *reinterpret_cast<VersionRecord const*>(record);
    switch (recordType) {
    case UndoRecordType::INSERT_INFO: {
        undoRecord.versionRecordHandler->applyFuncToChunkedGroups(&ChunkedNodeGroup::commitInsert,
            undoRecord.nodeGroupIdx, undoRecord.startRow, undoRecord.numRows, commitTS);
    } break;
    case UndoRecordType::DELETE_INFO: {
        undoRecord.versionRecordHandler->applyFuncToChunkedGroups(&ChunkedNodeGroup::commitDelete,
            undoRecord.nodeGroupIdx, undoRecord.startRow, undoRecord.numRows, commitTS);
    } break;
    default: {
        UNREACHABLE_CODE;
    }
    }
}

void UndoBuffer::commitVectorUpdateInfo(const uint8_t* record, transaction_t commitTS) {
    auto& undoRecord = *reinterpret_cast<VectorUpdateRecord const*>(record);
    DASSERT(undoRecord.updateInfo);
    DASSERT(undoRecord.vectorUpdateInfo);
    undoRecord.updateInfo->commit(undoRecord.vectorIdx, undoRecord.vectorUpdateInfo, commitTS);
}
```

| Record type | Commit action in current code |
| --- | --- |
| `CATALOG_ENTRY` | read `catalogEntry->getNext()` and stamp that newer catalog entry with `commitTS` |
| `SEQUENCE_ENTRY` | no-op on commit |
| `INSERT_INFO` | delegate to `VersionRecordHandler::applyFuncToChunkedGroups(&ChunkedNodeGroup::commitInsert, ...)` |
| `DELETE_INFO` | delegate to `VersionRecordHandler::applyFuncToChunkedGroups(&ChunkedNodeGroup::commitDelete, ...)` |
| `UPDATE_INFO` | call `UpdateInfo::commit(vectorIdx, vectorUpdateInfo, commitTS)` |

The key idea is that the undo buffer does not own the storage semantics. It owns the
transaction-local list of things that still need finalization once `commitTS` is known.

### Why commit needs the undo buffer at all

Write paths already created MVCC metadata while the transaction was running, but those
metadata entries still carry transaction-owned identity. The undo buffer is the list of
“pending finalizers” that rewrites that identity into the final commit timestamp or
final catalog timestamp.

## Rollback dispatch

Rollback uses reverse iteration and dispatches different helpers for each record kind.
Unlike commit, the catalog rollback path actually edits the in-memory catalog version
chain, and the update rollback path removes version nodes rather than stamping them.

```cpp
void UndoBuffer::rollbackRecord(ClientContext* context, const UndoRecordType recordType,
    const uint8_t* record) {
    switch (recordType) {
    case UndoRecordType::CATALOG_ENTRY: {
        rollbackCatalogEntryRecord(record);
    } break;
    case UndoRecordType::SEQUENCE_ENTRY: {
        rollbackSequenceEntry(record);
    } break;
    case UndoRecordType::INSERT_INFO:
    case UndoRecordType::DELETE_INFO: {
        rollbackVersionInfo(context, recordType, record);
    } break;
    case UndoRecordType::UPDATE_INFO: {
        rollbackVectorUpdateInfo(record);
    } break;
    default: {
        UNREACHABLE_CODE;
    }
    }
}

void UndoBuffer::rollbackCatalogEntryRecord(const uint8_t* record) {
    const auto& [catalogSet, catalogEntry] = *reinterpret_cast<CatalogEntryRecord const*>(record);
    const auto entryToRollback = catalogEntry->getNext();
    DASSERT(entryToRollback);
    if (entryToRollback->getNext()) {
        // If entryToRollback has a newer entry (next) in the version chain. Simple remove
        // entryToRollback from the chain.
        const auto newerEntry = entryToRollback->getNext();
        newerEntry->setPrev(entryToRollback->movePrev());
    } else {
        // This is the beginning of the version chain.
        auto olderEntry = entryToRollback->movePrev();
        catalogSet->eraseNoLock(catalogEntry->getName());
        if (olderEntry) {
            catalogSet->emplaceNoLock(std::move(olderEntry));
        }
    }
}

void UndoBuffer::commitSequenceEntry(const uint8_t*, transaction_t) {
    // DO NOTHING.
}

void UndoBuffer::rollbackSequenceEntry(const uint8_t* entry) {
    const auto& sequenceRecord = *reinterpret_cast<SequenceEntryRecord const*>(entry);
    const auto sequenceEntry = sequenceRecord.sequenceEntry;
    const auto& data = sequenceRecord.sequenceRollbackData;
    sequenceEntry->rollbackVal(data.usageCount, data.currVal);
}

void UndoBuffer::rollbackVersionInfo(ClientContext* context, UndoRecordType recordType,
    const uint8_t* record) {
    auto& undoRecord = *reinterpret_cast<VersionRecord const*>(record);
    switch (recordType) {
    case UndoRecordType::INSERT_INFO: {
        undoRecord.versionRecordHandler->rollbackInsert(context, undoRecord.nodeGroupIdx,
            undoRecord.startRow, undoRecord.numRows);
    } break;
    case UndoRecordType::DELETE_INFO: {
        undoRecord.versionRecordHandler->applyFuncToChunkedGroups(&ChunkedNodeGroup::rollbackDelete,
            undoRecord.nodeGroupIdx, undoRecord.startRow, undoRecord.numRows,
            transaction::Transaction::Get(*context)->getCommitTS());
    } break;
    default: {
        UNREACHABLE_CODE;
    }
    }
}

void UndoBuffer::rollbackVectorUpdateInfo(const uint8_t* record) {
    auto& undoRecord = *reinterpret_cast<VectorUpdateRecord const*>(record);
    DASSERT(undoRecord.updateInfo);
    undoRecord.updateInfo->rollback(undoRecord.vectorIdx, undoRecord.version);
}
```

| Record type | Rollback action in current code |
| --- | --- |
| `CATALOG_ENTRY` | remove or splice out the in-memory catalog entry version created by the transaction |
| `SEQUENCE_ENTRY` | restore the previous sequence state using `SequenceRollbackData` |
| `INSERT_INFO` | call `VersionRecordHandler::rollbackInsert(context, ...)` |
| `DELETE_INFO` | delegate to `ChunkedNodeGroup::rollbackDelete` through `applyFuncToChunkedGroups(...)` |
| `UPDATE_INFO` | call `UpdateInfo::rollback(vectorIdx, version)` |

This is why rollback must run before `LocalStorage::rollback()`: the undo code may still
need access to version structures or node groups that local-storage rollback can shrink,
evict, or free.

## Version records and the role of `VersionRecordHandler`

For row-presence changes, the undo buffer stores a lightweight `VersionRecord` payload
plus a `VersionRecordHandler*`. The handler knows how to route the operation to the
right chunked node groups.

```cpp
using version_record_handler_op_t = void (
    ChunkedNodeGroup::*)(common::row_idx_t, common::row_idx_t, common::transaction_t);

// Note: these handlers are not safe to use in multi-threaded contexts without external locking
class VersionRecordHandler {
public:
    virtual ~VersionRecordHandler() = default;

    virtual void applyFuncToChunkedGroups(version_record_handler_op_t func,
        common::node_group_idx_t nodeGroupIdx, common::row_idx_t startRow,
        common::row_idx_t numRows, common::transaction_t commitTS) const = 0;

    virtual void rollbackInsert(main::ClientContext* context, common::node_group_idx_t nodeGroupIdx,
        common::row_idx_t startRow, common::row_idx_t numRows) const;
};
```

```cpp
void VersionRecordHandler::rollbackInsert(main::ClientContext* context,
    common::node_group_idx_t nodeGroupIdx, common::row_idx_t startRow,
    common::row_idx_t numRows) const {
    applyFuncToChunkedGroups(&ChunkedNodeGroup::rollbackInsert, nodeGroupIdx, startRow, numRows,
        transaction::Transaction::Get(*context)->getCommitTS());
}
```

| Undo record | Handler behavior |
| --- | --- |
| `INSERT_INFO` | commit uses `ChunkedNodeGroup::commitInsert`; rollback uses `VersionRecordHandler::rollbackInsert`, whose default implementation delegates to `ChunkedNodeGroup::rollbackInsert` |
| `DELETE_INFO` | commit uses `ChunkedNodeGroup::commitDelete`; rollback uses `ChunkedNodeGroup::rollbackDelete` through `applyFuncToChunkedGroups` |

Concrete handler subclasses in node and relationship storage may extend rollback
behavior around those chunked-group calls, but the undo buffer itself stays generic.

## Insert and delete records in storage

The chunked node-group methods ultimately forward to `VersionInfo`, which owns the
per-vector insert/delete visibility state.

```cpp
void ChunkedNodeGroup::commitInsert(row_idx_t startRow, row_idx_t numRowsToCommit,
    transaction_t commitTS) {
    versionInfo->commitInsert(startRow, numRowsToCommit, commitTS);
}

void ChunkedNodeGroup::rollbackInsert(row_idx_t startRow, row_idx_t numRows_, transaction_t) {
    if (startRow == 0) {
        truncate(0);
        versionInfo.reset();
        return;
    }
    if (startRow >= numRows) {
        // Nothing to rollback.
        return;
    }
    versionInfo->rollbackInsert(startRow, numRows_);
    numRows = startRow;
}

// NOLINTNEXTLINE(readability-make-member-function-const): Semantically non-const.
void ChunkedNodeGroup::commitDelete(row_idx_t startRow, row_idx_t numRows_,
    transaction_t commitTS) {
    versionInfo->commitDelete(startRow, numRows_, commitTS);
}

// NOLINTNEXTLINE(readability-make-member-function-const): Semantically non-const.
void ChunkedNodeGroup::rollbackDelete(row_idx_t startRow, row_idx_t numRows_, transaction_t) {
    versionInfo->rollbackDelete(startRow, numRows_);
```

```cpp
void VersionInfo::commitInsert(row_idx_t startRow, row_idx_t numRows, transaction_t commitTS) {
    if (numRows == 0) {
        return;
    }
    auto [startVectorIdx, startRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow, DEFAULT_VECTOR_CAPACITY);
    auto [endVectorIdx, endRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow + numRows - 1, DEFAULT_VECTOR_CAPACITY);
    for (auto vectorIdx = startVectorIdx; vectorIdx <= endVectorIdx; vectorIdx++) {
        const auto startRowIdx = vectorIdx == startVectorIdx ? startRowIdxInVector : 0;
        const auto endRowIdx =
            vectorIdx == endVectorIdx ? endRowIdxInVector : DEFAULT_VECTOR_CAPACITY - 1;
        auto& vectorVersionInfo = getOrCreateVersionInfo(vectorIdx);
        vectorVersionInfo.setInsertCommitTS(commitTS, startRowIdx, endRowIdx - startRowIdx + 1);
    }
}

void VersionInfo::rollbackInsert(row_idx_t startRow, row_idx_t numRows) {
    if (numRows == 0) {
        return;
    }
    auto [startVectorIdx, startRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow, DEFAULT_VECTOR_CAPACITY);
    auto [endVectorIdx, endRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow + numRows - 1, DEFAULT_VECTOR_CAPACITY);
    for (auto vectorIdx = startVectorIdx; vectorIdx <= endVectorIdx; vectorIdx++) {
        const auto startRowIdx = vectorIdx == startVectorIdx ? startRowIdxInVector : 0;
        const auto endRowIdx =
            vectorIdx == endVectorIdx ? endRowIdxInVector : DEFAULT_VECTOR_CAPACITY - 1;
        auto& vectorVersionInfo = getOrCreateVersionInfo(vectorIdx);
        vectorVersionInfo.rollbackInsertions(startRowIdx, endRowIdx - startRowIdx + 1);
    }
}

void VersionInfo::commitDelete(row_idx_t startRow, row_idx_t numRows, transaction_t commitTS) {
    if (numRows == 0) {
        return;
    }
    auto [startVectorIdx, startRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow, DEFAULT_VECTOR_CAPACITY);
    auto [endVectorIdx, endRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow + numRows - 1, DEFAULT_VECTOR_CAPACITY);
    for (auto vectorIdx = startVectorIdx; vectorIdx <= endVectorIdx; vectorIdx++) {
        const auto startRowIdx = vectorIdx == startVectorIdx ? startRowIdxInVector : 0;
        const auto endRowIdx =
            vectorIdx == endVectorIdx ? endRowIdxInVector : DEFAULT_VECTOR_CAPACITY - 1;
        auto& vectorVersionInfo = getOrCreateVersionInfo(vectorIdx);
        vectorVersionInfo.setDeleteCommitTS(commitTS, startRowIdx, endRowIdx - startRowIdx + 1);
    }
}

void VersionInfo::rollbackDelete(row_idx_t startRow, row_idx_t numRows) {
    if (numRows == 0) {
        return;
    }
    auto [startVectorIdx, startRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow, DEFAULT_VECTOR_CAPACITY);
    auto [endVectorIdx, endRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow + numRows - 1, DEFAULT_VECTOR_CAPACITY);
    for (auto vectorIdx = startVectorIdx; vectorIdx <= endVectorIdx; vectorIdx++) {
        auto& vectorVersionInfo = getOrCreateVersionInfo(vectorIdx);
```

Commit semantics:

- `VersionInfo::commitInsert()` rewrites inserted-row versions from the transaction ID
    to `commitTS`.
- `VersionInfo::commitDelete()` rewrites delete tombstones from the transaction ID to
    `commitTS`.

Rollback semantics:

- `VersionInfo::rollbackInsert()` clears the inserted-row versions owned by the
    transaction so the rows disappear again.
- `VersionInfo::rollbackDelete()` clears the delete tombstones owned by the transaction
    so previously visible rows remain visible.

## Update records

Property updates use a different payload. `VectorUpdateRecord` stores `UpdateInfo*`, a
vector index, the specific `VectorUpdateInfo*` node, and the original `version`. That is
enough for commit to stamp the node and for rollback to remove the node from the
per-vector chain.

```cpp
struct VectorUpdateRecord {
    UpdateInfo* updateInfo;
    idx_t vectorIdx;
    VectorUpdateInfo* vectorUpdateInfo;
    transaction_t version; // This is used during roll back.
};
```

```cpp
void UpdateInfo::commit(idx_t vectorIdx, VectorUpdateInfo* info, transaction_t commitTS) {
    auto& updateNode = getUpdateNode(vectorIdx);
    std::unique_lock chainLock{updateNode.mtx};
    DASSERT(validateUpdateChain(updateNode, info));
    info->version = commitTS;
}

void UpdateInfo::rollback(idx_t vectorIdx, transaction_t version) {
    UpdateNode* header = nullptr;
    // Note that we lock the entire UpdateInfo structure here because we might modify the
    // head of the version chain. This is just a simplification and should be optimized later.
    {
        std::unique_lock lock{mtx};
        DASSERT(updates.size() > vectorIdx);
        header = updates[vectorIdx].get();
    }
    DASSERT(header);
    std::unique_lock chainLock{header->mtx};
    // First check if this version is still in the chain. It might have been removed by
    // a previous rollback entry of the same transaction.
    // TODO(Guodong): This will be optimized by moving VectorUpdateInfo into UndoBuffer.
    auto current = header->info.get();
    while (current) {
        if (current->version == version) {
            auto prevVersion = current->movePrev();
            if (current->next) {
                // Has newer version. Remove this from the version chain.
                const auto newerVersion = current->next;
                if (prevVersion) {
                    prevVersion->next = newerVersion;
                }
                newerVersion->setPrev(std::move(prevVersion));
            } else {
                DASSERT(header->info.get() == current);
                // This is the beginning of the version chain.
                if (prevVersion) {
                    prevVersion->next = nullptr;
                }
                header->info = std::move(prevVersion);
            }
            break;
        }
        current = current->getPrev();
    }
}
```

Current semantics are precise and smaller than many summaries claim:

1. `UpdateInfo::commit(vectorIdx, info, commitTS)` locks the target vector chain and
      simply sets `info->version = commitTS` after validating the chain position.
2. `UpdateInfo::rollback(vectorIdx, version)` searches the vector chain for the
      matching version and unlinks that node from the chain if it still exists.
3. Rollback does not replay a generic value-by-value before image from the undo buffer;
      it removes transaction-owned update chain nodes.

## Catalog and sequence records

Catalog and sequence entries demonstrate that the undo buffer is broader than table
MVCC. It is a general transaction-finalization structure for several in-memory
subsystems.

```cpp
void UndoBuffer::createCatalogEntry(CatalogSet& catalogSet, CatalogEntry& catalogEntry) {
    auto buffer = createUndoRecord(sizeof(UndoRecordHeader) + sizeof(CatalogEntryRecord));
    const UndoRecordHeader recordHeader{UndoRecordType::CATALOG_ENTRY, sizeof(CatalogEntryRecord)};
    *reinterpret_cast<UndoRecordHeader*>(buffer) = recordHeader;
    buffer += sizeof(UndoRecordHeader);
    const CatalogEntryRecord catalogEntryRecord{&catalogSet, &catalogEntry};
    *reinterpret_cast<CatalogEntryRecord*>(buffer) = catalogEntryRecord;
}

void UndoBuffer::createSequenceChange(SequenceCatalogEntry& sequenceEntry,
    const SequenceRollbackData& data) {
    auto buffer = createUndoRecord(sizeof(UndoRecordHeader) + sizeof(SequenceEntryRecord));
    const UndoRecordHeader recordHeader{UndoRecordType::SEQUENCE_ENTRY,
        sizeof(SequenceEntryRecord)};
    *reinterpret_cast<UndoRecordHeader*>(buffer) = recordHeader;
    buffer += sizeof(UndoRecordHeader);
    const SequenceEntryRecord sequenceEntryRecord{&sequenceEntry, data};
    *reinterpret_cast<SequenceEntryRecord*>(buffer) = sequenceEntryRecord;
}
```

```cpp
void UndoBuffer::commitCatalogEntryRecord(const uint8_t* record, const transaction_t commitTS) {
    const auto& [_, catalogEntry] = *reinterpret_cast<CatalogEntryRecord const*>(record);
    const auto newCatalogEntry = catalogEntry->getNext();
    DASSERT(newCatalogEntry);
    newCatalogEntry->setTimestamp(commitTS);
}

void UndoBuffer::commitVersionInfo(UndoRecordType recordType, const uint8_t* record,
    transaction_t commitTS) {
    const auto& undoRecord = *reinterpret_cast<VersionRecord const*>(record);
    switch (recordType) {
    case UndoRecordType::INSERT_INFO: {
        undoRecord.versionRecordHandler->applyFuncToChunkedGroups(&ChunkedNodeGroup::commitInsert,
            undoRecord.nodeGroupIdx, undoRecord.startRow, undoRecord.numRows, commitTS);
    } break;
    case UndoRecordType::DELETE_INFO: {
        undoRecord.versionRecordHandler->applyFuncToChunkedGroups(&ChunkedNodeGroup::commitDelete,
            undoRecord.nodeGroupIdx, undoRecord.startRow, undoRecord.numRows, commitTS);
    } break;
    default: {
        UNREACHABLE_CODE;
    }
    }
}

void UndoBuffer::commitVectorUpdateInfo(const uint8_t* record, transaction_t commitTS) {
    auto& undoRecord = *reinterpret_cast<VectorUpdateRecord const*>(record);
    DASSERT(undoRecord.updateInfo);
    DASSERT(undoRecord.vectorUpdateInfo);
    undoRecord.updateInfo->commit(undoRecord.vectorIdx, undoRecord.vectorUpdateInfo, commitTS);
}

void UndoBuffer::rollbackRecord(ClientContext* context, const UndoRecordType recordType,
    const uint8_t* record) {
    switch (recordType) {
    case UndoRecordType::CATALOG_ENTRY: {
        rollbackCatalogEntryRecord(record);
    } break;
    case UndoRecordType::SEQUENCE_ENTRY: {
        rollbackSequenceEntry(record);
    } break;
    case UndoRecordType::INSERT_INFO:
    case UndoRecordType::DELETE_INFO: {
        rollbackVersionInfo(context, recordType, record);
    } break;
    case UndoRecordType::UPDATE_INFO: {
        rollbackVectorUpdateInfo(record);
    } break;
    default: {
        UNREACHABLE_CODE;
    }
    }
}

void UndoBuffer::rollbackCatalogEntryRecord(const uint8_t* record) {
    const auto& [catalogSet, catalogEntry] = *reinterpret_cast<CatalogEntryRecord const*>(record);
    const auto entryToRollback = catalogEntry->getNext();
    DASSERT(entryToRollback);
    if (entryToRollback->getNext()) {
        // If entryToRollback has a newer entry (next) in the version chain. Simple remove
        // entryToRollback from the chain.
        const auto newerEntry = entryToRollback->getNext();
        newerEntry->setPrev(entryToRollback->movePrev());
    } else {
        // This is the beginning of the version chain.
        auto olderEntry = entryToRollback->movePrev();
        catalogSet->eraseNoLock(catalogEntry->getName());
        if (olderEntry) {
            catalogSet->emplaceNoLock(std::move(olderEntry));
        }
    }
}

void UndoBuffer::commitSequenceEntry(const uint8_t*, transaction_t) {
    // DO NOTHING.
}

void UndoBuffer::rollbackSequenceEntry(const uint8_t* entry) {
    const auto& sequenceRecord = *reinterpret_cast<SequenceEntryRecord const*>(entry);
    const auto sequenceEntry = sequenceRecord.sequenceEntry;
    const auto& data = sequenceRecord.sequenceRollbackData;
    sequenceEntry->rollbackVal(data.usageCount, data.currVal);
```

Catalog commit stamps the newly linked catalog entry version. Catalog rollback either
splices that newer entry out of the version chain or erases/replaces the name binding in
the catalog set, depending on whether an even newer entry exists. Sequence rollback
restores the saved `usageCount` and `currVal`.

## Interaction with `LocalStorage` and WAL

The undo buffer sits between local staging and durability rather than replacing either
one.

| Component | Primary responsibility | How it relates to `UndoBuffer` |
| --- | --- | --- |
| `LocalStorage` | stage uncommitted table-level data and optimistic allocations | commit runs before undo commit; rollback runs after undo rollback |
| `UndoBuffer` | remember logical finalizers and rollback actions for transaction-owned metadata | commit stamps metadata; rollback removes or rewinds metadata/state |
| `LocalWAL` / `WAL` | persist logical changes for crash recovery | WAL persistence happens after undo commit in `Transaction::commit()` |

The exact lifecycle order from `Transaction` is crucial:

1. commit: `localStorage->commit()` -> `undoBuffer->commit(commitTS)` -> WAL commit
      path
2. rollback: `undoBuffer->rollback(clientContext)` -> `localStorage->rollback()`

## Lifetime

`UndoBuffer` has transaction scope. Its `memoryBuffers` vector owns the backing
`MemoryBuffer` objects, so once the transaction object is destroyed, the undo records
disappear with it. There is no separate persistence path and no shared global undo
store.

## What the buffer is *not*

- It is not the WAL. WAL records serve crash recovery and durability; undo records serve
    transaction-end finalization and rollback.
- It is not a page-image log. The payloads reference logical structures such as catalog
    entries, sequences, chunked node groups, and update chains.
- It is not global history. Each transaction owns exactly one undo buffer.
- It is not optional for write paths that create MVCC metadata. Without it, commit would
    not know which transaction-owned version nodes still need stamping, and rollback
    would not know which ones to remove.

## Representative walkthroughs

### Insert commit

1. A write transaction inserts rows and records their visibility in chunked node-group
      `VersionInfo` under its transaction ID.
2. The write path appends an `INSERT_INFO` record containing row range, node-group
      index, and a `VersionRecordHandler`.
3. On commit, `UndoBuffer::commit()` dispatches that record to
      `ChunkedNodeGroup::commitInsert`, which forwards to
      `VersionInfo::commitInsert(...)` and rewrites the inserted-row version to
      `commitTS`.
4. After that rewrite, ordinary MVCC visibility rules can expose the rows to later
      snapshots.

### Delete rollback

1. A transaction marks rows deleted in `VersionInfo` and appends a `DELETE_INFO` undo
      record.
2. The transaction rolls back.
3. `UndoBuffer::rollback()` visits the delete record in reverse order and routes it to
      `ChunkedNodeGroup::rollbackDelete`, which forwards to
      `VersionInfo::rollbackDelete(...)`.
4. The delete tombstones owned by the transaction are cleared, so the rows remain
      visible.

### Property update rollback

1. A property update creates or links a `VectorUpdateInfo` node inside an `UpdateInfo`
      chain and appends an `UPDATE_INFO` undo record.
2. Rollback dispatches the record to `UpdateInfo::rollback(vectorIdx, version)`.
3. That function searches the version chain for the matching transaction-owned node and
      unlinks it if still present.
4. The undo buffer therefore remembers which chain node belongs to the transaction
      without storing a generic row-image payload.

## Misconceptions to avoid

- Do not describe the undo buffer as a generic list of previous row values. Many records
    only capture pointers and range metadata needed to finalize or remove logical state.
- Do not say commit ignores the undo buffer. Commit depends on it to rewrite
    transaction-owned MVCC metadata to `commitTS` and to stamp catalog versions.
- Do not say rollback only affects table pages. Catalog entries and sequences also
    participate.
- Do not say update rollback restores data from a copied before image. The current
    implementation removes the matching `VectorUpdateInfo` chain node.
- Do not confuse undo records with WAL records. They solve different problems at
    different points in the lifecycle.

## Source map and anchor points

- `src/include/storage/undo_buffer.h:69-95` — sparse `UndoRecordType` enum and create
    helpers.
- `src/storage/undo_buffer.cpp:19-53` — private header/payload structs.
- `src/storage/undo_buffer.cpp:148-161` — append/allocate path.
- `src/storage/undo_buffer.cpp:164-229` — commit dispatch loop and handlers.
- `src/storage/undo_buffer.cpp:231-306` — rollback dispatch loop and handlers.
- `src/include/storage/table/version_record_handler.h:12-26` — handler surface for
    chunked node-group routing.
- `src/storage/table/chunked_node_group.cpp:515-542` and
    `src/storage/table/version_info.cpp:596-656` — insert/delete commit and rollback
    plumbing.
- `src/storage/table/update_info.cpp:157-201` — update commit and rollback.
- `src/transaction/transaction.cpp:66-88` — undo-buffer placement in commit/rollback
    order.
