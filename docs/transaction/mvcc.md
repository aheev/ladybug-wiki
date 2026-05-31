# MVCC

This page is the definitive engineering reference for Ladybug transactional visibility,
row-version metadata, and in-place property update chains. It is based on the current
implementations of `Transaction`, `TransactionManager`, `VersionInfo`, `UpdateInfo`,
`VersionRecordHandler`, `ChunkedNodeGroup`, `ColumnChunk`, `NodeTable`, `RelTable`, and
`Checkpointer`. It intentionally uses the implementation vocabulary from the source tree
instead of generic textbook terms when the two differ.

The single most important terminology correction is this: Ladybug does **not** keep a
classic per-row linked list named `VersionRecord`. The durable row-version metadata
lives in `VersionInfo`, which is a vector-granularity structure keyed by row position
inside a chunk. Column updates use a separate `UpdateInfo` structure whose per-vector
version chains are made of `VectorUpdateInfo` nodes.

## User-facing transaction semantics first

Before diving into `VersionInfo` and `UpdateInfo`, it helps to anchor the implementation in the semantics a user sees from SQL. `TransactionContext` documents the default connection mode explicitly: new connections start in `AUTO` mode, every statement runs inside a transaction, and the mode switches to `MANUAL` only after an explicit `BEGIN ... TRANSACTION`.

From `src/include/transaction/transaction_context.h`:

```cpp
/**
 * If the connection is in AUTO_COMMIT mode, any query over the connection will be wrapped around
 * a transaction and committed (even if the query is READ_ONLY).
 * If the connection is in MANUAL transaction mode, which happens only if an application
 * manually begins a transaction (see below), then an application has to manually commit or
 * rollback the transaction by calling commit() or rollback().
 */
enum class TransactionMode : uint8_t { AUTO = 0, MANUAL = 1 };
```

That gives the practical user-facing behavior:

- `BEGIN TRANSACTION;` starts an explicit write transaction (`TransactionAction::BEGIN_WRITE`)
- `BEGIN TRANSACTION READ ONLY;` starts an explicit read transaction (`TransactionAction::BEGIN_READ`)
- `COMMIT;` ends the active manual transaction and makes its effects visible
- `ROLLBACK;` ends the active manual transaction and reverts all of its changes
- if there is **no** active manual transaction, each query auto-begins and auto-commits through `ClientContext::TransactionHelper::runFuncInTransaction(...)`

The auto-transaction wrapper is not documentation fiction; it is literally how statement execution is wired:

```cpp
const bool requireNewTransaction =
    context.isAutoTransaction() && !context.hasActiveTransaction() && !isTransactionStatement;
if (requireNewTransaction) {
    context.beginAutoTransaction(readOnlyStatement);
}
...
if ((requireNewTransaction && commitIfNew(action)) ||
    (context.isAutoTransaction() && commitIfAuto(action))) {
    context.commit();
}
```

If execution throws, the same helper calls `context.rollback()`. So MVCC rules in the rest of this page are not only for explicit `BEGIN` / `COMMIT` blocks. They also govern the implicit per-statement transactions that users get by default.

## Scope and source files

- `src/include/transaction/transaction.h` — transaction types, transaction/timestamp
    domains, transaction-local components
- `src/transaction/transaction.cpp` — commit/rollback order, WAL staging, undo/local
    storage integration
- `src/include/storage/table/version_info.h` — public API for insert/delete visibility
    metadata
- `src/storage/table/version_info.cpp` — vector-granularity insertion/deletion
    visibility rules
- `src/include/storage/table/update_info.h` — update chain structures and scanning API
- `src/storage/table/update_info.cpp` — write-write conflict detection, commit/rollback
    of update chains
- `src/include/storage/table/version_record_handler.h` — undo callbacks for
    insert/delete metadata
- `src/storage/table/version_record_handler.cpp` — default rollbackInsert wiring
- `src/storage/table/chunked_node_group.cpp` — append/scan/lookup/update/delete entry
    points
- `src/storage/table/column_chunk.cpp` — base value scan plus update-chain overlay
- `src/storage/table/node_table.cpp` — node write path and commit of local rows into
    persistent groups
- `src/storage/table/rel_table.cpp` — relationship write path and local/committed split
- `src/storage/checkpointer.cpp` — checkpoint snapshot transaction behavior

Cross-reference pages: transactional staging lives in
[/transaction/local-storage](/transaction/local-storage); checkpoint materialization
lives in [/transaction/checkpointing](/transaction/checkpointing); WAL rotation and
shadow-page durability live in [/storage/wal-internals](/storage/wal-internals) and
[/storage/shadow-wal](/storage/shadow-wal). This page focuses on visibility and conflict
rules, not on every storage format detail.

## Executive summary

- Transaction IDs and committed timestamps live in different numeric regions.
    Transaction IDs start at `1 << 63`; committed timestamps start at `1` and never
    cross into the transaction-ID range.
- A transaction snapshot is defined by `startTS`, which is set to the current
    `lastTimestamp` at begin time. Read-only transactions never advance `lastTimestamp`
    when they commit.
- Committed visibility is implemented as `version <= startTS`, while read-your-writes is
    implemented as `version == transactionID`.
- Insert and delete metadata are stored in `VersionInfo`, broken down by vectors of
    `DEFAULT_VECTOR_CAPACITY` rows. The structure tracks insertions and deletions
    separately.
- Property updates are stored in `UpdateInfo`. Each vector index owns a linked chain of
    `VectorUpdateInfo` nodes, newest at the head, older versions through `prev`, and
    newer versions via `next` back-links.
- Write-write conflicts are detected at the row level inside `UpdateInfo::update()` and
    `VectorVersionInfo::delete_()`. Enabling multiple write transactions removes the
    global writer admission restriction, but does not remove per-row conflict detection.
- Undo is the mechanism that converts uncommitted MVCC metadata into committed
    timestamps on commit, or removes it on rollback. The details of the undo container
    are documented in [/transaction/undo-buffer](/transaction/undo-buffer).

## Transaction and timestamp domains

Ladybug deliberately separates transaction identity from committed visibility time. The
split is visible in `Transaction::START_TRANSACTION_ID` and in the way
`TransactionManager` initializes `lastTransactionID` and `lastTimestamp`. Any version
value that is greater than or equal to `START_TRANSACTION_ID` is an uncommitted
transaction ID. Any version value strictly below `START_TRANSACTION_ID` is a committed
timestamp.

This split is what makes the predicates `version == transactionID` and `version <=
startTS` sufficient. The first detects read-your-writes. The second detects any version
that committed before the current transaction began. Because committed timestamps and
live transaction IDs do not overlap, Ladybug does not need an extra
committed/uncommitted flag in `VersionInfo` or `UpdateInfo`.

```cpp
class LBUG_API Transaction {
    friend class TransactionManager;

public:
    static constexpr common::transaction_t DUMMY_TRANSACTION_ID = 0;
    static constexpr common::transaction_t DUMMY_START_TIMESTAMP = 0;
    static constexpr common::transaction_t START_TRANSACTION_ID =
        static_cast<common::transaction_t>(1) << 63;

    Transaction(main::ClientContext& clientContext, TransactionType transactionType,
        common::transaction_t transactionID, common::transaction_t startTS);

    explicit Transaction(TransactionType transactionType) noexcept;
    Transaction(TransactionType transactionType, common::transaction_t ID,
        common::transaction_t startTS) noexcept;

    ~Transaction();

    TransactionType getType() const { return type; }
    bool isReadOnly() const { return TransactionType::READ_ONLY == type; }
    bool isWriteTransaction() const { return TransactionType::WRITE == type; }
    bool isDummy() const { return TransactionType::DUMMY == type; }
    bool isRecovery() const { return TransactionType::RECOVERY == type; }
    common::transaction_t getID() const { return ID; }
    common::transaction_t getStartTS() const { return startTS; }
    common::transaction_t getCommitTS() const { return commitTS; }
    int64_t getCurrentTS() const { return currentTS; }

    void setForceCheckpoint() { forceCheckpoint = true; }
    bool shouldAppendToUndoBuffer() const {
        // Only write transactions and recovery transactions should append to the undo buffer.
        return isWriteTransaction() || isRecovery();
    }
    bool shouldLogToWAL() const;
```

```cpp
public:
    // Timestamp starts from 1. 0 is reserved for the dummy system transaction.
    explicit TransactionManager(storage::WAL& wal)
        : wal{wal}, lastTransactionID{Transaction::START_TRANSACTION_ID}, lastTimestamp{1} {
        initCheckpointerFunc = initCheckpointer;
    }

    Transaction* beginTransaction(main::ClientContext& clientContext, TransactionType type);
```

```cpp
Transaction* TransactionManager::beginTransaction(main::ClientContext& clientContext,
    TransactionType type) {
    std::unique_lock publicFunctionLck{mtxForSerializingPublicFunctionCalls};
    // Only acquire the write gate for write/recovery transactions. Read-only transactions
    // can start freely during checkpoint since they use snapshot isolation.
    std::unique_lock newTransactionLck{mtxForStartingNewTransactions, std::defer_lock};
    if (type != TransactionType::READ_ONLY) {
        newTransactionLck.lock();
    }
    switch (type) {
    case TransactionType::READ_ONLY: {
        auto transaction =
            std::make_unique<Transaction>(clientContext, type, ++lastTransactionID, lastTimestamp);
        activeTransactions.push_back(std::move(transaction));
        return activeTransactions.back().get();
    }
    case TransactionType::RECOVERY:
    case TransactionType::WRITE: {
        if (!clientContext.getDBConfig()->enableMultiWrites && hasActiveWriteTransactionNoLock()) {
            throw TransactionManagerException(
                "Cannot start a new write transaction in the system. "
                "Only one write transaction at a time is allowed in the system.");
        }
        auto transaction =
            std::make_unique<Transaction>(clientContext, type, ++lastTransactionID, lastTimestamp);
        activeWriteTransactionCount.fetch_add(1, std::memory_order_release);
        activeTransactions.push_back(std::move(transaction));
        return activeTransactions.back().get();
    }
```

Begin behavior is exact and easy to miss: both read-only and write/recovery transactions
get a fresh transaction ID (`++lastTransactionID`), but `startTS` is copied from the
current `lastTimestamp` without incrementing it. The timestamp only advances for write
and recovery commit in `TransactionManager::commit()`.

```cpp
void TransactionManager::commit(main::ClientContext& clientContext, Transaction* transaction) {
    bool shouldCheckpoint = false;
    {
        std::unique_lock lck{mtxForSerializingPublicFunctionCalls};
        clientContext.cleanUp();
        switch (transaction->getType()) {
        case TransactionType::READ_ONLY: {
            clearTransactionNoLock(transaction->getID());
        } break;
        case TransactionType::RECOVERY:
        case TransactionType::WRITE: {
            lastTimestamp++;
            transaction->commitTS = lastTimestamp;
            transaction->commit(&wal);
            shouldCheckpoint = transaction->shouldForceCheckpoint() ||
                               Checkpointer::canAutoCheckpoint(clientContext, *transaction);
            clearTransactionNoLock(transaction->getID());
            activeWriteTransactionCount.fetch_sub(1, std::memory_order_release);
        } break;
            // LCOV_EXCL_START
        default: {
            throw TransactionManagerException("Invalid transaction type to commit.");
        }
            // LCOV_EXCL_STOP
        }
    }
    // Checkpoint outside the public function lock so active writers can finish
    // (commit/rollback) during the drain phase instead of deadlocking.
    if (shouldCheckpoint) {
        tryCheckpoint(clientContext);
    }
}
```

Checkpoint code uses the same snapshot notion, but via a synthetic transaction object
rather than a client-visible transaction. `Checkpointer` constructs a
`TransactionType::CHECKPOINT` transaction with `DUMMY_TRANSACTION_ID` and `startTS =
snapshotTS`, so checkpoint scans apply normal visibility logic against the drain-time
snapshot.

```cpp
PageRange Checkpointer::serializeMetadataSnapshot(const catalog::Catalog& catalog,
    StorageManager& storageManager) {
    auto metadataWriter =
        std::make_shared<common::InMemFileWriter>(*MemoryManager::Get(clientContext));
    common::Serializer metadataSerializer(metadataWriter);
    const transaction::Transaction snapshotTxn(transaction::TransactionType::CHECKPOINT,
        transaction::Transaction::DUMMY_TRANSACTION_ID, snapshotTS);
    storageManager.serialize(catalog, snapshotTxn, metadataSerializer);

    auto& pageManager = *storageManager.getDataFH()->getPageManager();
    const auto pagesForPageManager = pageManager.estimatePagesNeededForSerialize();
    auto pageAllocator = storageManager.getDataFH()->getPageManager();
    const auto allocatedPages = pageAllocator->allocatePageRange(
        metadataWriter->getNumPagesToFlush() + pagesForPageManager);
    pageManager.serialize(metadataSerializer);

    metadataWriter->flush(allocatedPages, pageAllocator->getDataFH(),
        storageManager.getShadowFile());
    return allocatedPages;
```

```cpp
Transaction DUMMY_TRANSACTION = Transaction(TransactionType::DUMMY);
Transaction DUMMY_CHECKPOINT_TRANSACTION = Transaction(TransactionType::CHECKPOINT,
    Transaction::DUMMY_TRANSACTION_ID, Transaction::START_TRANSACTION_ID - 1);
```

## What Ladybug means by MVCC

Ladybug uses MVCC for visibility of inserts, deletes, and property updates on committed
storage, but it does not materialize each row as a chain of immutable row versions.
Instead, committed storage keeps the current base row image in column chunks, plus
metadata that says whether a row was inserted or deleted at a visible version, plus
per-column update chains for rows whose property values changed after the base value was
written.

| Concern | Structure | Granularity | Commit representation |
| --- | --- | --- | --- |
| Row insertion visibility | `VersionInfo` / `VectorVersionInfo` | vector + row-in-vector | commit timestamp written back into insertion version slots |
| Row deletion visibility | `VersionInfo` / `VectorVersionInfo` | vector + row-in-vector | commit timestamp written back into deletion version slots |
| Property updates | `UpdateInfo` / `VectorUpdateInfo` | vector + row-in-vector | `VectorUpdateInfo::version` changed from transaction ID to commit timestamp |
| Transaction staging of brand-new rows | local storage first, then committed node/rel groups on transaction commit | table-local | base row moved into persistent storage and version metadata stamped through undo |

That split matters operationally. Insert/delete visibility checks happen before a row is
even scanned into an output vector. Property updates are overlays applied after the base
value is scanned from the column chunk. This means `VersionInfo` answers “is the row
present in my snapshot?” while `UpdateInfo` answers “if it is present, which property
value should I see?”

## `VersionInfo`: vector-granularity insert/delete metadata

`VersionInfo` is a container of `VectorVersionInfo` objects. Each element in
`vectorsInfo` corresponds to one logical row vector inside a chunk. A row offset is
translated into `(vectorIdx, rowIdxInVector)` by dividing by `DEFAULT_VECTOR_CAPACITY`.
Nothing in this structure is a linked list of row versions. Instead, the per-vector
state stores insertion and deletion version arrays or single “same-version” shortcuts.

```cpp
class LBUG_API VersionInfo {
public:
    VersionInfo();
    ~VersionInfo();
    DELETE_BOTH_COPY(VersionInfo);

    void append(common::transaction_t transactionID, common::row_idx_t startRow,
        common::row_idx_t numRows);
    bool delete_(common::transaction_t transactionID, common::row_idx_t rowIdx);

    bool isSelected(common::transaction_t startTS, common::transaction_t transactionID,
        common::row_idx_t rowIdx) const;
    void getSelVectorToScan(common::transaction_t startTS, common::transaction_t transactionID,
        common::SelectionVector& selVector, common::row_idx_t startRow,
        common::row_idx_t numRows) const;

    void clearVectorInfo(common::idx_t vectorIdx);

    bool hasDeletions() const;
    common::row_idx_t getNumDeletions(const transaction::Transaction* transaction,
        common::row_idx_t startRow, common::length_t numRows) const;
    bool hasInsertions() const;
    bool isDeleted(const transaction::Transaction* transaction, common::row_idx_t rowInChunk) const;
    bool isInserted(const transaction::Transaction* transaction,
        common::row_idx_t rowInChunk) const;

    bool hasDeletions(const transaction::Transaction* transaction) const;

    common::idx_t getNumVectors() const { return vectorsInfo.size(); }

    void commitInsert(common::row_idx_t startRow, common::row_idx_t numRows,
        common::transaction_t commitTS);
    void rollbackInsert(common::row_idx_t startRow, common::row_idx_t numRows);
    void commitDelete(common::row_idx_t startRow, common::row_idx_t numRows,
        common::transaction_t commitTS);
    void rollbackDelete(common::row_idx_t startRow, common::row_idx_t numRows);

    void serialize(common::Serializer& serializer) const;
    static std::unique_ptr<VersionInfo> deserialize(common::Deserializer& deSer);

private:
    // Return nullptr when vectorIdx is out of range or when the vector is not created.
    VectorVersionInfo* getVectorVersionInfo(common::idx_t vectorIdx) const;
    VectorVersionInfo& getOrCreateVersionInfo(common::idx_t vectorIdx);

    std::vector<std::unique_ptr<VectorVersionInfo>> vectorsInfo;
};
```

```cpp
struct VectorVersionInfo {
    enum class InsertionStatus : uint8_t { NO_INSERTED, CHECK_VERSION, ALWAYS_INSERTED };
    // TODO(Guodong): ALWAYS_INSERTED is not added for now, but it may be useful as an optimization
    // to mark the vector data after checkpoint is all deleted.
    enum class DeletionStatus : uint8_t { NO_DELETED, CHECK_VERSION };

    // TODO: Keep an additional same insertion/deletion field as an optimization to avoid the need
    // of `array` if all are inserted/deleted in the same transaction.
    // Also, avoid allocate `array` when status are NO_INSERTED and NO_DELETED.
    // We can even consider separating the insertion and deletion into two separate Vectors.
    std::unique_ptr<std::array<transaction_t, DEFAULT_VECTOR_CAPACITY>> insertedVersions;
    std::unique_ptr<std::array<transaction_t, DEFAULT_VECTOR_CAPACITY>> deletedVersions;
    // If all values in the Vector are inserted/deleted in the same transaction, we can use this to
    // avoid the allocation of `array`.
    transaction_t sameInsertionVersion;
    transaction_t sameDeletionVersion;
    InsertionStatus insertionStatus;
    DeletionStatus deletionStatus;

    VectorVersionInfo()
        : sameInsertionVersion{INVALID_TRANSACTION}, sameDeletionVersion{INVALID_TRANSACTION},
          insertionStatus{InsertionStatus::NO_INSERTED},
          deletionStatus{DeletionStatus::NO_DELETED} {}
    DELETE_COPY_DEFAULT_MOVE(VectorVersionInfo);

    void append(transaction_t transactionID, row_idx_t startRow, row_idx_t numRows);
    bool delete_(transaction_t transactionID, row_idx_t rowIdx);
    void setInsertCommitTS(transaction_t commitTS, row_idx_t startRow, row_idx_t numRows);
    void setDeleteCommitTS(transaction_t commitTS, row_idx_t startRow, row_idx_t numRows);

    bool isSelected(transaction_t startTS, transaction_t transactionID, row_idx_t rowIdx) const;
    void getSelVectorForScan(transaction_t startTS, transaction_t transactionID,
        SelectionVector& selVector, row_idx_t startRow, row_idx_t numRows,
        sel_t startOutputPos) const;

    void rollbackInsertions(row_idx_t startRowInVector, row_idx_t numRows);
    void rollbackDeletions(row_idx_t startRowInVector, row_idx_t numRows);

    bool hasDeletions(const transaction::Transaction* transaction) const;

    // Given startTS and transactionID, if the row is deleted to the transaction, return true.
    bool isDeleted(transaction_t startTS, transaction_t transactionID, row_idx_t rowIdx) const;
    // Given startTS and transactionID, if the row is readable to the transaction, return true.
    bool isInserted(transaction_t startTS, transaction_t transactionID, row_idx_t rowIdx) const;

    row_idx_t getNumDeletions(transaction_t startTS, transaction_t transactionID,
        row_idx_t startRow, length_t numRows) const;

    void serialize(Serializer& serializer) const;
    static std::unique_ptr<VectorVersionInfo> deSerialize(Deserializer& deSer);

private:
    void initInsertionVersionArray();
    void initDeletionVersionArray();

    bool isSameInsertionVersion() const;
    bool isSameDeletionVersion() const;
};
```

Two compression ideas are embedded in `VectorVersionInfo`. First, if all insertions or
deletions in a vector share the same version, the implementation keeps only
`sameInsertionVersion` or `sameDeletionVersion` and skips allocating the corresponding
array. Second, if a vector has never seen inserts or deletes, its status stays at
`NO_INSERTED` or `NO_DELETED` and the arrays stay absent.

`VersionInfo::append()` walks every affected vector and marks inserted rows with the
current transaction ID. `VersionInfo::delete_()` resolves the row to a single vector,
lazily creates the vector entry if needed, forces `insertionStatus = ALWAYS_INSERTED`
when the vector previously had no insertion metadata, and then delegates to
`VectorVersionInfo::delete_()` for actual conflict checks.

```cpp
void VersionInfo::append(transaction_t transactionID, const row_idx_t startRow,
    const row_idx_t numRows) {
    if (numRows == 0) {
        return;
    }
    auto [startVectorIdx, startRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow, DEFAULT_VECTOR_CAPACITY);
    auto [endVectorIdx, endRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow + numRows - 1, DEFAULT_VECTOR_CAPACITY);
    for (auto vectorIdx = startVectorIdx; vectorIdx <= endVectorIdx; vectorIdx++) {
        auto& vectorVersionInfo = getOrCreateVersionInfo(vectorIdx);
        const auto startRowIdx = vectorIdx == startVectorIdx ? startRowIdxInVector : 0;
        const auto endRowIdx =
            vectorIdx == endVectorIdx ? endRowIdxInVector : DEFAULT_VECTOR_CAPACITY - 1;
        const auto numRowsInVector = endRowIdx - startRowIdx + 1;
        vectorVersionInfo.append(transactionID, startRowIdx, numRowsInVector);
    }
}

bool VersionInfo::delete_(transaction_t transactionID, const row_idx_t rowIdx) {
    auto [vectorIdx, rowIdxInVector] =
        StorageUtils::getQuotientRemainder(rowIdx, DEFAULT_VECTOR_CAPACITY);
    auto& vectorVersionInfo = getOrCreateVersionInfo(vectorIdx);
    if (vectorVersionInfo.insertionStatus == VectorVersionInfo::InsertionStatus::NO_INSERTED) {
        // Note: The version info is newly created due to `delete_`. There is no newly inserted rows
        // in this vector, thus all are rows checkpointed. We set the insertion status to
        // ALWAYS_INSERTED to avoid checking the version in the future.
        vectorVersionInfo.insertionStatus = VectorVersionInfo::InsertionStatus::ALWAYS_INSERTED;
    }
    return vectorVersionInfo.delete_(transactionID, rowIdxInVector);
}
```

The `ALWAYS_INSERTED` optimization in the delete path is subtle. It means: “this vector
already exists durably, so any row that reaches this code can be treated as inserted for
visibility purposes unless deletion metadata says otherwise.” That avoids inventing
insertion arrays for old checkpointed rows.

### Visibility rule

Visibility for a row is the conjunction of insertion visibility and deletion
invisibility. Both tests are derived from the same two predicates: a row is visible if
the version equals the current transaction ID (read-your-writes) or if the version is
committed at or before the transaction snapshot (`<= startTS`).

```cpp
bool VectorVersionInfo::isSelected(const transaction_t startTS, const transaction_t transactionID,
    const row_idx_t rowIdx) const {
    if (deletionStatus == DeletionStatus::NO_DELETED &&
        insertionStatus == InsertionStatus::ALWAYS_INSERTED) {
        return true;
    }
    if (insertionStatus == InsertionStatus::NO_INSERTED) {
        return false;
    }
    if (isInserted(startTS, transactionID, rowIdx)) {
        return !isDeleted(startTS, transactionID, rowIdx);
    }
    return false;
}

void VectorVersionInfo::getSelVectorForScan(const transaction_t startTS,
    const transaction_t transactionID, SelectionVector& selVector, const row_idx_t startRow,
    const row_idx_t numRows, sel_t startOutputPos) const {
    auto numSelected = selVector.getSelSize();
    if (deletionStatus == DeletionStatus::NO_DELETED &&
        insertionStatus == InsertionStatus::ALWAYS_INSERTED) {
        if (selVector.isUnfiltered()) {
            selVector.setSelSize(selVector.getSelSize() + numRows);
        } else {
            for (auto i = 0u; i < numRows; i++) {
                selVector.getMutableBuffer()[numSelected++] = startOutputPos + i;
            }
            selVector.setToFiltered(numSelected);
        }
    } else if (insertionStatus != InsertionStatus::NO_INSERTED) {
        // If there were no deleted values up to this point the selVector may be unfiltered but have
        // non-zero size, and the mutable buffer may have arbitrary contents
        if (selVector.isUnfiltered()) {
            selVector.makeDynamic();
        }
        for (auto i = 0u; i < numRows; i++) {
            if (const auto rowIdx = startRow + i; isInserted(startTS, transactionID, rowIdx) &&
                                                  !isDeleted(startTS, transactionID, rowIdx)) {
                selVector.getMutableBuffer()[numSelected++] = startOutputPos + i;
            }
        }
        selVector.setToFiltered(numSelected);
    }
}

bool VectorVersionInfo::isDeleted(const transaction_t startTS, const transaction_t transactionID,
    const row_idx_t rowIdx) const {
    switch (deletionStatus) {
    case DeletionStatus::NO_DELETED: {
        return false;
    }
    case DeletionStatus::CHECK_VERSION: {
        transaction_t deletion = INVALID_TRANSACTION;
        if (isSameDeletionVersion()) {
            deletion = sameDeletionVersion;
        } else {
            DASSERT(deletedVersions);
            deletion = deletedVersions->operator[](rowIdx);
        }
        const auto isDeletedWithinSameTransaction = deletion == transactionID;
        const auto isDeletedByPrevCommittedTransaction = deletion <= startTS;
        return isDeletedWithinSameTransaction || isDeletedByPrevCommittedTransaction;
    }
    default: {
        UNREACHABLE_CODE;
    }
    }
}

bool VectorVersionInfo::isInserted(const transaction_t startTS, const transaction_t transactionID,
    const row_idx_t rowIdx) const {
    switch (insertionStatus) {
    case InsertionStatus::ALWAYS_INSERTED: {
        return true;
    }
    case InsertionStatus::NO_INSERTED: {
        return false;
    }
    case InsertionStatus::CHECK_VERSION: {
        transaction_t insertion = INVALID_TRANSACTION;
        if (isSameInsertionVersion()) {
            insertion = sameInsertionVersion;
        } else {
            DASSERT(insertedVersions);
            insertion = insertedVersions->operator[](rowIdx);
        }
        const auto isInsertedWithinSameTransaction = insertion == transactionID;
        const auto isInsertedByPrevCommittedTransaction = insertion <= startTS;
        return isInsertedWithinSameTransaction || isInsertedByPrevCommittedTransaction;
    }
    default: {
        UNREACHABLE_CODE;
    }
```

This is the exact implementation rule that every engineer should remember:

- Inserted rows are visible when `insertion == transactionID` or `insertion <= startTS`.
- Deleted rows are considered deleted when `deletion == transactionID` or `deletion <=
    startTS`.
- Rows with no `VersionInfo` entry are treated as visible committed rows.

Because `startTS` is the `lastTimestamp` value at transaction begin, a transaction never
sees commits that happen after it starts. Because each transaction keeps its own ID, it
still sees its own uncommitted inserts, deletes, and updates.

### Selection-vector based scanning

Chunk scans do not iterate row-by-row and then test visibility externally. Instead,
`ChunkedNodeGroup::scan()` asks `VersionInfo` to build the selection vector for a
contiguous scan range. This is the first stage of MVCC filtering. Only rows that survive
this selection vector are passed to column scanners.

```cpp
void VersionInfo::getSelVectorToScan(const transaction_t startTS, const transaction_t transactionID,
    SelectionVector& selVector, const row_idx_t startRow, const row_idx_t numRows) const {
    if (numRows == 0) {
        return;
    }
    auto [startVectorIdx, startRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow, DEFAULT_VECTOR_CAPACITY);
    auto [endVectorIdx, endRowIdxInVector] =
        StorageUtils::getQuotientRemainder(startRow + numRows - 1, DEFAULT_VECTOR_CAPACITY);
    auto vectorIdx = startVectorIdx;
    selVector.setToUnfiltered(0);
    sel_t outputPos = 0u;
    while (vectorIdx <= endVectorIdx) {
        const auto startRowIdx = vectorIdx == startVectorIdx ? startRowIdxInVector : 0;
        const auto endRowIdx =
            vectorIdx == endVectorIdx ? endRowIdxInVector : DEFAULT_VECTOR_CAPACITY - 1;
        const auto numRowsInVector = endRowIdx - startRowIdx + 1;
        const auto vectorVersion = getVectorVersionInfo(vectorIdx);
        if (!vectorVersion) {
            auto numSelected = selVector.getSelSize();
            if (selVector.isUnfiltered()) {
                selVector.setSelSize(numSelected + numRowsInVector);
            } else {
                for (auto i = 0u; i < numRowsInVector; i++) {
                    selVector.getMutableBuffer()[numSelected++] = outputPos + i;
                }
                selVector.setToFiltered(numSelected);
            }
        } else {
            vectorVersion->getSelVectorForScan(startTS, transactionID, selVector, startRowIdx,
                numRowsInVector, outputPos);
        }
        outputPos += numRowsInVector;
        vectorIdx++;
    }
    DASSERT(outputPos <= DEFAULT_VECTOR_CAPACITY);
}
```

```cpp
void ChunkedNodeGroup::scan(const Transaction* transaction, const TableScanState& scanState,
    const NodeGroupScanState& nodeGroupScanState, offset_t rowIdxInGroup,
    length_t numRowsToScan) const {
    DASSERT(rowIdxInGroup + numRowsToScan <= numRows);
    auto& anchorSelVector = scanState.outState->getSelVectorUnsafe();
    if (getZoneMapResult(scanState, chunks) == ZoneMapCheckResult::SKIP_SCAN) {
        anchorSelVector.setToFiltered(0);
        return;
    }

    if (versionInfo) {
        versionInfo->getSelVectorToScan(transaction->getStartTS(), transaction->getID(),
            anchorSelVector, rowIdxInGroup, numRowsToScan);
    } else {
        anchorSelVector.setToUnfiltered(numRowsToScan);
    }

    if (anchorSelVector.getSelSize() > 0) {
        for (auto i = 0u; i < scanState.columnIDs.size(); i++) {
            const auto columnID = scanState.columnIDs[i];
            if (columnID == INVALID_COLUMN_ID) {
                scanState.outputVectors[i]->setAllNull();
                continue;
            }
            if (columnID == ROW_IDX_COLUMN_ID) {
                for (auto rowIdx = 0u; rowIdx < numRowsToScan; rowIdx++) {
                    scanState.rowIdxVector->setValue<row_idx_t>(rowIdx,
                        rowIdx + rowIdxInGroup + startRowIdx);
                }
                continue;
            }
            DASSERT(columnID < chunks.size());
            chunks[columnID]->scan(transaction, nodeGroupScanState.chunkStates[i],
                *scanState.outputVectors[i], rowIdxInGroup, numRowsToScan);
        }
    }
}
```

If a vector has no version entry, `VersionInfo::getSelVectorToScan()` leaves the rows
unfiltered. If it does have metadata, the vector-specific logic appends only the row
positions that are inserted and not deleted for the current transaction snapshot. The
output selection vector is relative to the scan range, not absolute row IDs.

### Delete conflicts

Delete conflicts are checked inside `VectorVersionInfo::delete_()`. The function throws
when it encounters a different live or future-visible version for the same row. The
exact exception text is `"Write-write conflict: deleting a row that is already deleted
by another transaction."` The conflict check is row-local, not table-global.

```cpp
bool VectorVersionInfo::delete_(const transaction_t transactionID, const row_idx_t rowIdx) {
    deletionStatus = DeletionStatus::CHECK_VERSION;
    if (transactionID == sameDeletionVersion) {
        // All are deleted in the same transaction.
        return false;
    }
    if (isSameDeletionVersion()) {
        // All are deleted in a different transaction.
        throw RuntimeException(
            "Write-write conflict: deleting a row that is already deleted by another transaction.");
    }
    if (!deletedVersions) {
        // No deletions before.
        initDeletionVersionArray();
    }
    if (deletedVersions->operator[](rowIdx) == transactionID) {
        return false;
    }
    if (deletedVersions->operator[](rowIdx) != INVALID_TRANSACTION) {
        throw RuntimeException(
            "Write-write conflict: deleting a row that is already deleted by another transaction.");
    }
    deletedVersions->operator[](rowIdx) = transactionID;
    return true;
```

The important implication is that enabling concurrent write admission through
`enableMultiWrites` does not suddenly make overlapping row deletes safe. Admission
control and row-level conflict detection are different layers.

### Commit and rollback of insert/delete metadata

Insertions and deletions start as transaction IDs in `VersionInfo`. They become
committed timestamps only when the transaction’s undo buffer is committed. Rollback
removes or clears the uncommitted metadata instead. `ChunkedNodeGroup` exposes four
operations that are targeted by undo callbacks: `commitInsert`, `rollbackInsert`,
`commitDelete`, and `rollbackDelete`.

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
}
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
        const auto startRowIdx = vectorIdx == startVectorIdx ? startRowIdxInVector : 0;
        const auto endRowIdx =
            vectorIdx == endVectorIdx ? endRowIdxInVector : DEFAULT_VECTOR_CAPACITY - 1;
        vectorVersionInfo.rollbackDeletions(startRowIdx, endRowIdx - startRowIdx + 1);
```

`rollbackInsert()` is intentionally destructive. If the rollback starts at row `0`, the
chunked group truncates to zero rows and drops `versionInfo` entirely. If rollback
starts in the middle, the function clears insertion metadata for the rolled-back tail
and resets `numRows` back to the original prefix.

## `UpdateInfo`: property-update version chains

Property updates do not rewrite base column data in place for ordinary write
transactions. Instead, each `ColumnChunk` owns an `UpdateInfo` object. `UpdateInfo` is a
vector-indexed directory of `UpdateNode` objects, and each `UpdateNode` owns a linked
chain of `VectorUpdateInfo` nodes. The head of the chain is the newest version. Older
versions are reachable through `prev`, while `next` points back toward newer nodes for
unlinking during rollback.

```cpp
struct VectorUpdateInfo {
    common::transaction_t version;
    std::array<common::sel_t, common::DEFAULT_VECTOR_CAPACITY> rowsInVector;
    common::sel_t numRowsUpdated;
    // Older versions.
    std::unique_ptr<VectorUpdateInfo> prev;
    // Newer versions.
    VectorUpdateInfo* next;

    std::unique_ptr<ColumnChunkData> data;

    VectorUpdateInfo()
        : version{common::INVALID_TRANSACTION}, rowsInVector{}, numRowsUpdated(0), prev(nullptr),
          next{nullptr}, data{nullptr} {}
    VectorUpdateInfo(MemoryManager& memoryManager, const common::transaction_t transactionID,
        common::LogicalType dataType)
        : version{transactionID}, rowsInVector{}, numRowsUpdated{0}, prev{nullptr}, next{nullptr} {
        data = ColumnChunkFactory::createColumnChunkData(memoryManager, std::move(dataType), false,
            common::DEFAULT_VECTOR_CAPACITY, ResidencyState::IN_MEMORY);
    }

    std::unique_ptr<VectorUpdateInfo> movePrev() { return std::move(prev); }
    void setPrev(std::unique_ptr<VectorUpdateInfo> prev_) { this->prev = std::move(prev_); }
    VectorUpdateInfo* getPrev() const { return prev.get(); }
    void setNext(VectorUpdateInfo* next_) { this->next = next_; }
    VectorUpdateInfo* getNext() const { return next; }
};
```

```cpp
class UpdateInfo {
public:
    using iterate_read_from_row_func_t =
        std::function<void(const VectorUpdateInfo&, uint64_t, uint64_t)>;

    UpdateInfo() {}

    VectorUpdateInfo& update(MemoryManager& memoryManager,
        const transaction::Transaction* transaction, common::idx_t vectorIdx,
        common::sel_t rowIdxInVector, const common::ValueVector& values);

    void clearVectorInfo(common::idx_t vectorIdx) {
        std::unique_lock lock{mtx};
        updates[vectorIdx]->clear();
    }

    common::idx_t getNumVectors() const {
        std::shared_lock lock{mtx};
        return updates.size();
    }

    void scan(const transaction::Transaction* transaction, common::ValueVector& output,
        common::offset_t offsetInChunk, common::length_t length) const;
    void lookup(const transaction::Transaction* transaction, common::offset_t rowInChunk,
        common::ValueVector& output, common::sel_t posInOutputVector) const;

    void scanCommitted(const transaction::Transaction* transaction, ColumnChunkData& output,
        common::offset_t startOffsetInOutput, common::row_idx_t startRowScanned,
        common::row_idx_t numRows) const;

    void iterateVectorInfo(const transaction::Transaction* transaction, common::idx_t idx,
        const std::function<void(const VectorUpdateInfo&)>& func) const;

    void commit(common::idx_t vectorIdx, VectorUpdateInfo* info, common::transaction_t commitTS);
    void rollback(common::idx_t vectorIdx, common::transaction_t version);

    common::row_idx_t getNumUpdatedRows(const transaction::Transaction* transaction) const;

    bool hasUpdates(const transaction::Transaction* transaction, common::row_idx_t startRow,
        common::length_t numRows) const;

    bool isSet() const {
        std::shared_lock lock{mtx};
        return !updates.empty();
    }
    void reset() {
        std::unique_lock lock{mtx};
        updates.clear();
    }

    void iterateScan(const transaction::Transaction* transaction, uint64_t startOffsetToScan,
        uint64_t numRowsToScan, uint64_t startPosInOutput,
        const iterate_read_from_row_func_t& readFromRowFunc) const;

private:
    UpdateNode& getUpdateNode(common::idx_t vectorIdx);
    UpdateNode& getOrCreateUpdateNode(common::idx_t vectorIdx);

private:
    mutable std::shared_mutex mtx;
    std::vector<std::unique_ptr<UpdateNode>> updates;
};
```

This is the second important terminology correction for this page. The update chain is
not global for a row and not global for a chunk. It is per vector. Each
`VectorUpdateInfo` contains its own compact list of updated row positions
(`rowsInVector`) plus the replacement values in a `ColumnChunkData` payload.

### How updates are added

`ColumnChunk::update()` converts the row offset into `(vectorIdx, rowIdxInVector)`,
delegates to `UpdateInfo::update()`, and then pushes an undo record that can later
either stamp the update version with `commitTS` or remove the chain node on rollback.

```cpp
void ColumnChunk::update(const Transaction* transaction, offset_t offsetInChunk,
    const ValueVector& values) {
    if (transaction->getType() == TransactionType::DUMMY) {
        rangeSegments(offsetInChunk, 1, [&](auto& segment, auto offsetInSegment, auto, auto) {
            segment->write(&values, values.state->getSelVector().getSelectedPositions()[0],
                offsetInSegment);
        });
        return;
    }

    const auto vectorIdx = offsetInChunk / DEFAULT_VECTOR_CAPACITY;
    const auto rowIdxInVector = offsetInChunk % DEFAULT_VECTOR_CAPACITY;
    auto& vectorUpdateInfo = updateInfo.update(data.front()->getMemoryManager(), transaction,
        vectorIdx, rowIdxInVector, values);
    transaction->pushVectorUpdateInfo(updateInfo, vectorIdx, vectorUpdateInfo,
        transaction->getID());
}
```

```cpp
VectorUpdateInfo& UpdateInfo::update(MemoryManager& memoryManager, const Transaction* transaction,
    const idx_t vectorIdx, const sel_t rowIdxInVector, const ValueVector& values) {
    UpdateNode& header = getOrCreateUpdateNode(vectorIdx);
    // We always lock the head of the chain of vectorUpdateInfo to ensure that we can safely
    // read/write to any part of the chain.
    std::unique_lock chainLock{header.mtx};
    // Traverse the chain of vectorUpdateInfo to find the one that matches the transaction. Also
    // detect if there is any write-write conflicts.
    auto current = header.info.get();
    VectorUpdateInfo* vecUpdateInfo = nullptr;
    while (current) {
        if (current->version == transaction->getID()) {
            // Same transaction, we can update the existing vector info.
            DASSERT(current->version >= Transaction::START_TRANSACTION_ID);
            vecUpdateInfo = current;
        } else if (current->version > transaction->getStartTS()) {
            // Potentially there can be conflicts. `current` can be uncommitted transaction (version
            // is transaction ID) or committed transaction started after this transaction.
            for (auto i = 0u; i < current->numRowsUpdated; i++) {
                if (current->rowsInVector[i] == rowIdxInVector) {
                    throw RuntimeException("Write-write conflict of updating the same row.");
                }
            }
        }
        current = current->prev.get();
    }
    if (!vecUpdateInfo) {
        // Create a new version here if not found in the chain.
        auto newInfo = std::make_unique<VectorUpdateInfo>(memoryManager, transaction->getID(),
            values.dataType.copy());
        vecUpdateInfo = newInfo.get();
        auto currentInfo = std::move(header.info);
        if (currentInfo) {
            currentInfo->next = newInfo.get();
        }
        newInfo->prev = std::move(currentInfo);
        header.info = std::move(newInfo);
    }
    DASSERT(vecUpdateInfo);
    // Check if the row is already updated in this transaction.
    idx_t idxInUpdateData = INVALID_IDX;
    for (auto i = 0u; i < vecUpdateInfo->numRowsUpdated; i++) {
        if (vecUpdateInfo->rowsInVector[i] == rowIdxInVector) {
            idxInUpdateData = i;
            break;
        }
    }
    if (idxInUpdateData != INVALID_IDX) {
        // Overwrite existing update value.
        vecUpdateInfo->data->write(&values, values.state->getSelVector()[0], idxInUpdateData);
    } else {
        // Append new value and update `rowsInVector`.
        vecUpdateInfo->rowsInVector[vecUpdateInfo->numRowsUpdated] = rowIdxInVector;
        vecUpdateInfo->data->write(&values, values.state->getSelVector()[0],
            vecUpdateInfo->numRowsUpdated++);
    }
    return *vecUpdateInfo;
}
```

The chain insertion algorithm is precise:

1. Lock the `UpdateNode` for the vector head.
2. Walk the chain from newest to oldest through `prev`.
3. Reuse the existing node if `current->version == transaction->getID()`.
4. Throw a write-write conflict if a newer visible or uncommitted version
      (`current->version > transaction->getStartTS()`) already updated the same row
      position.
5. Otherwise create a new `VectorUpdateInfo`, make it the new head, and link the old
      head through `prev`/`next`.

That `current->version > transaction->getStartTS()` test is the exact conflict predicate
for property updates. It catches both uncommitted versions (transaction IDs are
numerically huge) and committed versions that were committed after this transaction’s
snapshot. That is why two concurrent writers can exist when `enableMultiWrites` is
enabled but still be forced to serialize on overlapping row updates.

### How update visibility is read

Base values are read first from persistent or in-memory chunk segments. Then update
overlays are applied. `ColumnChunk::scan()` and `ColumnChunk::lookup()` both end with an
`updateInfo.scan()` or `updateInfo.lookup()` call. The overlay only considers versions
visible to the reading transaction: same transaction ID or committed timestamp `<=
startTS`.

```cpp
void ColumnChunk::scan(const Transaction* transaction, const ChunkState& state, ValueVector& output,
    offset_t offsetInChunk, length_t length) const {
    // Check if there is deletions or insertions. If so, update selVector based on transaction.
    switch (getResidencyState()) {
    case ResidencyState::IN_MEMORY: {
        rangeSegments(offsetInChunk, length,
            [&](auto& segment, auto offsetInSegment, auto lengthInSegment, auto dstOffset) {
                segment->scan(output, offsetInSegment, lengthInSegment, dstOffset);
            });
    } break;
    case ResidencyState::ON_DISK: {
        state.column->scan(state, offsetInChunk, length, &output, 0);
    } break;
    default: {
        UNREACHABLE_CODE;
    }
    }
    updateInfo.scan(transaction, output, offsetInChunk, length);
}
```

```cpp
void ColumnChunk::lookup(const Transaction* transaction, const ChunkState& state,
    offset_t rowInChunk, ValueVector& output, sel_t posInOutputVector) const {
    switch (getResidencyState()) {
    case ResidencyState::IN_MEMORY: {
        rangeSegments(rowInChunk, 1, [&](auto& segment, auto offsetInSegment, auto, auto) {
            segment->lookup(offsetInSegment, output, posInOutputVector);
        });
    } break;
    case ResidencyState::ON_DISK: {
        state.column->lookupValue(state, rowInChunk, &output, posInOutputVector);
    } break;
    }
    updateInfo.lookup(transaction, rowInChunk, output, posInOutputVector);
}
```

```cpp
void UpdateInfo::iterateVectorInfo(const Transaction* transaction, idx_t idx,
    const std::function<void(const VectorUpdateInfo&)>& func) const {
    const UpdateNode* head = nullptr;
    {
        std::shared_lock lock{mtx};
        if (idx >= updates.size() || !updates[idx]->isEmpty()) {
            return;
        }
        head = updates[idx].get();
    }
    // We lock the head of the chain to ensure that we can safely read from any part of the
    // chain.
    DASSERT(head);
    std::shared_lock chainLock{head->mtx};
    auto current = head->info.get();
    DASSERT(current);
    while (current) {
        if (current->version == transaction->getID() ||
            current->version <= transaction->getStartTS()) {
            DASSERT((current->version == transaction->getID() &&
                        current->version >= Transaction::START_TRANSACTION_ID) ||
                    (current->version <= transaction->getStartTS() &&
                        current->version < Transaction::START_TRANSACTION_ID));
            func(*current);
        }
        current = current->getPrev();
    }
}
```

```cpp
void UpdateInfo::iterateScan(const Transaction* transaction, uint64_t startOffsetToScan,
    uint64_t numRowsToScan, uint64_t startPosInOutput,
    const iterate_read_from_row_func_t& readFromRowFunc) const {
    if (!isSet()) {
        return;
    }
    auto [startVectorIdx, startOffsetInVector] =
        StorageUtils::getQuotientRemainder(startOffsetToScan, DEFAULT_VECTOR_CAPACITY);
    auto [endVectorIdx, endOffsetInVector] = StorageUtils::getQuotientRemainder(
        startOffsetToScan + numRowsToScan, DEFAULT_VECTOR_CAPACITY);
    idx_t idx = startVectorIdx;
    sel_t posInVector = startPosInOutput;
    while (idx <= endVectorIdx) {
        const auto startOffsetInclusively = idx == startVectorIdx ? startOffsetInVector : 0;
        const auto endOffsetExclusively =
            idx == endVectorIdx ? endOffsetInVector : DEFAULT_VECTOR_CAPACITY;
        const auto numRowsInVector = endOffsetExclusively - startOffsetInclusively;
        // We keep track of the rows that have been applied with updates from updateInfo. The update
        // version chain is maintained with the newest version at the head and the oldest version at
        // the tail. For each tuple, we iterate through the chain to merge the updates from latest
        // visible version. If a row has been updated in the current vectorInfo, we should skip it
        // in older versions.
        std::bitset<DEFAULT_VECTOR_CAPACITY> rowsUpdated;
        iterateVectorInfo(transaction, idx, [&](const VectorUpdateInfo& vecUpdateInfo) -> void {
            if (vecUpdateInfo.numRowsUpdated == 0) {
                return;
            }
            if (rowsUpdated.count() == numRowsInVector) {
                // All rows in this vector have been updated with a newer visible version already.
                return;
            }
            // TODO(Guodong): Ideally we should make sure vecUpdateInfo.rowsInVector is sorted to
            // simplify the checks here.
            for (auto i = 0u; i < vecUpdateInfo.numRowsUpdated; i++) {
                if (vecUpdateInfo.rowsInVector[i] < startOffsetInclusively ||
                    vecUpdateInfo.rowsInVector[i] >= endOffsetExclusively) {
                    // Continue if the row is out of the current scan range.
                    continue;
                }
                auto updatedRowIdx = vecUpdateInfo.rowsInVector[i] - startOffsetInclusively;
                if (rowsUpdated[updatedRowIdx]) {
                    // Skip the rows that have been updated with a newer visible version already.
                    continue;
                }
                readFromRowFunc(vecUpdateInfo, i, posInVector + updatedRowIdx);
                rowsUpdated[updatedRowIdx] = true;
            }
        });
        posInVector += numRowsInVector;
        idx++;
    }
}
```

The scan logic matters. The version chain is newest-first. `iterateScan()` keeps a
`bitset` of rows already satisfied by a newer visible update. Once a row position has
been filled, older visible updates for the same row are skipped. This is how Ladybug
reconstructs “latest visible value” semantics without storing a full row image per
version.

### Commit and rollback of update chains

On commit, the undo layer calls `UpdateInfo::commit(vectorIdx, info, commitTS)`, which
simply mutates `info->version` in place from transaction ID to commit timestamp. On
rollback, `UpdateInfo::rollback(vectorIdx, version)` walks the chain, finds the node
with the matching transaction ID, unlinks it, and splices its neighbors back together
using `prev` and `next`.

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

This means the logical payload of an update never moves during commit. Only the meaning
of its `version` field changes. That is why the transaction ID / commit timestamp split
is so central to the implementation.

## Where MVCC hooks into table code

At the table layer, MVCC is not one monolithic component. Several storage objects
participate: `NodeGroupCollection` records insert undo on persistent collections,
`ChunkedNodeGroup` owns row insert/delete metadata, `ColumnChunk` owns property update
chains, and table classes decide whether an operation targets local storage or committed
storage.

### Persistent append path

Persistent collections append undo-backed insert metadata before appending the base
rows. This happens in `NodeGroupCollection::pushInsertInfo()` and then
`ChunkedNodeGroup::append()`. The append path only pushes undo when the collection
residency is `ON_DISK` and the transaction should append to the undo buffer.

```cpp
void NodeGroupCollection::pushInsertInfo(const Transaction* transaction, const NodeGroup* nodeGroup,
    row_idx_t numRows) {
    pushInsertInfo(transaction, nodeGroup->getNodeGroupIdx(), nodeGroup->getNumRows(), numRows,
        versionRecordHandler, false);
};

void NodeGroupCollection::pushInsertInfo(const Transaction* transaction,
    node_group_idx_t nodeGroupIdx, row_idx_t startRow, row_idx_t numRows,
    const VersionRecordHandler* versionRecordHandler, bool incrementNumRows) {
    // we only append to the undo buffer if the node group collection is persistent
    if (residency == ResidencyState::ON_DISK && transaction->shouldAppendToUndoBuffer()) {
        transaction->pushInsertInfo(nodeGroupIdx, startRow, numRows, versionRecordHandler);
    }
    if (incrementNumRows) {
        numTotalRows += numRows;
    }
}
```

```cpp
uint64_t ChunkedNodeGroup::append(const Transaction* transaction,
    const std::vector<ValueVector*>& columnVectors, row_idx_t startRowInVectors,
    uint64_t numValuesToAppend) {
    DASSERT(residencyState != ResidencyState::ON_DISK);
    DASSERT(columnVectors.size() == chunks.size());
    const auto numRowsToAppendInChunk = std::min(numValuesToAppend, capacity - numRows);
    try {
        for (auto i = 0u; i < columnVectors.size(); i++) {
            const auto columnVector = columnVectors[i];
            chunks[i]->append(columnVector, columnVector->state->getSelVector().slice(
                                                startRowInVectors, numRowsToAppendInChunk));
        }
    } catch ([[maybe_unused]] std::exception& e) {
        handleAppendException(chunks, numRows);
    }
    if (transaction->shouldAppendToUndoBuffer()) {
        if (!versionInfo) {
            versionInfo = std::make_unique<VersionInfo>();
        }
        versionInfo->append(transaction->getID(), numRows, numRowsToAppendInChunk);
    }
    numRows += numRowsToAppendInChunk;
    return numRowsToAppendInChunk;
}
```

New rows are usually staged in local storage first, then moved to persistent groups
during transaction commit. See [/transaction/local-storage](/transaction/local-storage)
for the detailed local-table structures. The point relevant to MVCC is that once rows
are appended into committed storage, their insertion metadata is still a transaction ID
until the undo buffer commits.

### Node-table update and delete path

```cpp
void NodeTable::update(Transaction* transaction, TableUpdateState& updateState) {
    // NOTE: We assume all inputs are flattened now. This is to simplify the implementation.
    // We should optimize this to take unflattened input later.
    auto& nodeUpdateState = updateState.constCast<NodeTableUpdateState>();
    DASSERT(nodeUpdateState.nodeIDVector.state->getSelVector().getSelSize() == 1 &&
            nodeUpdateState.propertyVector.state->getSelVector().getSelSize() == 1);
    const auto pos = nodeUpdateState.nodeIDVector.state->getSelVector()[0];
    if (nodeUpdateState.nodeIDVector.isNull(pos)) {
        return;
    }
    if (nodeUpdateState.columnID == pkColumnID) {
        throw RuntimeException("Cannot update pk.");
    }
    const auto nodeOffset = nodeUpdateState.nodeIDVector.readNodeOffset(pos);
    for (auto i = 0u; i < indexes.size(); i++) {
        auto index = indexes[i].getIndex();
        if (!nodeUpdateState.needToUpdateIndex(i)) {
            continue;
        }
        index->update(transaction, nodeUpdateState.nodeIDVector, nodeUpdateState.propertyVector,
            *nodeUpdateState.indexUpdateState[i]);
    }
    if (transaction->isUnCommitted(tableID, nodeOffset)) {
        const auto localTable = transaction->getLocalStorage()->getLocalTable(tableID);
        DASSERT(localTable);
        localTable->update(&DUMMY_TRANSACTION, updateState);
    } else {
        const auto nodeGroupIdx = StorageUtils::getNodeGroupIdx(nodeOffset);
        const auto rowIdxInGroup =
            nodeOffset - StorageUtils::getStartOffsetOfNodeGroup(nodeGroupIdx);
        nodeGroups->getNodeGroup(nodeGroupIdx)
            ->update(transaction, rowIdxInGroup, nodeUpdateState.columnID,
                nodeUpdateState.propertyVector);
    }
    if (updateState.logToWAL && transaction->shouldLogToWAL()) {
        DASSERT(transaction->isWriteTransaction());
        auto& wal = transaction->getLocalWAL();
        wal.logNodeUpdate(tableID, nodeUpdateState.columnID, nodeOffset,
            &nodeUpdateState.propertyVector);
    }
    setHasChanges();
}

bool NodeTable::delete_(Transaction* transaction, TableDeleteState& deleteState) {
    const auto& nodeDeleteState = dynamic_cast_checked<NodeTableDeleteState&>(deleteState);
    DASSERT(nodeDeleteState.nodeIDVector.state->getSelVector().getSelSize() == 1);
    const auto pos = nodeDeleteState.nodeIDVector.state->getSelVector()[0];
    if (nodeDeleteState.nodeIDVector.isNull(pos)) {
        return false;
    }
    bool isDeleted = false;
    const auto nodeOffset = nodeDeleteState.nodeIDVector.readNodeOffset(pos);
    for (auto& index : indexes) {
        auto indexDeleteState = index.getIndex()->initDeleteState(transaction, memoryManager,
            getVisibleFunc(transaction));
        index.getIndex()->delete_(transaction, nodeDeleteState.nodeIDVector, *indexDeleteState);
    }

    if (transaction->isUnCommitted(tableID, nodeOffset)) {
        const auto localTable = transaction->getLocalStorage()->getLocalTable(tableID);
        isDeleted = localTable->delete_(&DUMMY_TRANSACTION, deleteState);
    } else {
        const auto nodeGroupIdx = StorageUtils::getNodeGroupIdx(nodeOffset);
        const auto rowIdxInGroup =
            nodeOffset - StorageUtils::getStartOffsetOfNodeGroup(nodeGroupIdx);
        isDeleted = nodeGroups->getNodeGroup(nodeGroupIdx)->delete_(transaction, rowIdxInGroup);
        if (transaction->shouldAppendToUndoBuffer()) {
            transaction->pushDeleteInfo(nodeGroupIdx, rowIdxInGroup, 1, &versionRecordHandler);
        }
    }
    if (isDeleted) {
        setHasChanges();
        if (deleteState.logToWAL && transaction->shouldLogToWAL()) {
            DASSERT(transaction->isWriteTransaction());
            auto& wal = transaction->getLocalWAL();
            wal.logNodeDeletion(tableID, nodeOffset, &nodeDeleteState.pkVector);
        }
    }
    return isDeleted;
}
```

Node updates route either to local storage for uncommitted offsets or to
`ChunkedNodeGroup::update()` for committed offsets. Node deletes do the same split, but
committed deletes additionally push `DELETE_INFO` undo records so commit can stamp
delete timestamps and rollback can clear delete markers.

### Local-storage commit into committed storage

```cpp
void NodeTable::commit(main::ClientContext* context, TableCatalogEntry* tableEntry,
    LocalTable* localTable) {
    const auto startNodeOffset = nodeGroups->getNumTotalRows();
    auto& localNodeTable = localTable->cast<LocalNodeTable>();

    std::vector<column_id_t> columnIDsToCommit;
    for (auto& property : tableEntry->getProperties()) {
        auto columnID = tableEntry->getColumnID(property.getName());
        columnIDsToCommit.push_back(columnID);
    }

    auto transaction = transaction::Transaction::Get(*context);
    // 1. Append all tuples from local storage to nodeGroups regardless of deleted or not.
    // Note: We cannot simply remove all deleted tuples in local node table, as they may have
    // connected local rels. Directly removing them will cause shift of committed node offset,
    // leading to an inconsistent result with connected rels.
    nodeGroups->append(transaction, columnIDsToCommit, localNodeTable.getNodeGroups());
    // 2. Set deleted flag for tuples that are deleted in local storage.
    row_idx_t numLocalRows = 0u;
    for (auto localNodeGroupIdx = 0u; localNodeGroupIdx < localNodeTable.getNumNodeGroups();
         localNodeGroupIdx++) {
        const auto localNodeGroup = localNodeTable.getNodeGroup(localNodeGroupIdx);
        if (localNodeGroup->hasDeletions(transaction)) {
            // TODO(Guodong): Assume local storage is small here. Should optimize the loop away by
            // grabbing a set of deleted rows.
            for (auto row = 0u; row < localNodeGroup->getNumRows(); row++) {
                if (localNodeGroup->isDeleted(transaction, row)) {
                    const auto nodeOffset = startNodeOffset + numLocalRows + row;
                    const auto nodeGroupIdx = StorageUtils::getNodeGroupIdx(nodeOffset);
                    const auto rowIdxInGroup =
                        nodeOffset - StorageUtils::getStartOffsetOfNodeGroup(nodeGroupIdx);
                    [[maybe_unused]] const bool isDeleted =
                        nodeGroups->getNodeGroup(nodeGroupIdx)->delete_(transaction, rowIdxInGroup);
                    DASSERT(isDeleted);
                    if (transaction->shouldAppendToUndoBuffer()) {
                        transaction->pushDeleteInfo(nodeGroupIdx, rowIdxInGroup, 1,
                            &versionRecordHandler);
                    }
                }
            }
        }
        numLocalRows += localNodeGroup->getNumRows();
    }

    // 3. Scan index columns for newly inserted tuples.
    for (auto& index : indexes) {
        if (!index.needCommitInsert()) {
            continue;
        }
        if (!index.isLoaded()) {
            throw RuntimeException(
                "Cannot commit index insertions for index " + index.getName() +
                ", because it is not loaded. Please load the extension for the index first.");
        }
        UncommittedIndexInserter indexInserter{startNodeOffset, this, index.getIndex(),
            getVisibleFunc(transaction)};
        // We need to scan from local storage here because some tuples in local node groups might
        // have been deleted.
        scanIndexColumns(context, indexInserter, localNodeTable.getNodeGroups());
    }

    // 4. Clear local table.
    localTable->clear(*MemoryManager::Get(*context));
}
```

Node commit first appends every local row to committed storage, then applies delete
markers for any rows that were deleted while still local, then updates indexes, and
finally clears the local table. That explains why a transaction can see and even delete
its own freshly inserted local rows before commit while the persistent side still
receives durable MVCC metadata during the commit fold-in step.

### Relationship-table path

```cpp
void RelTable::update(Transaction* transaction, TableUpdateState& updateState) {
    const auto& relUpdateState = updateState.cast<RelTableUpdateState>();
    DASSERT(relUpdateState.relIDVector.state->getSelVector().getSelSize() == 1);
    const auto relIDPos = relUpdateState.relIDVector.state->getSelVector()[0];
    if (const auto relOffset = relUpdateState.relIDVector.readNodeOffset(relIDPos);
        relOffset >= StorageConstants::MAX_NUM_ROWS_IN_TABLE) {
        const auto localTable = transaction->getLocalStorage()->getLocalTable(tableID);
        DASSERT(localTable);
        localTable->update(&DUMMY_TRANSACTION, updateState);
    } else {
        for (auto& relData : directedRelData) {
            relData->update(transaction,
                relUpdateState.getBoundNodeIDVector(relData->getDirection()),
                relUpdateState.relIDVector, relUpdateState.columnID, relUpdateState.propertyVector);
        }
    }
    if (updateState.logToWAL && transaction->shouldLogToWAL()) {
        DASSERT(transaction->isWriteTransaction());
        auto& wal = transaction->getLocalWAL();
        wal.logRelUpdate(tableID, relUpdateState.columnID, &relUpdateState.srcNodeIDVector,
            &relUpdateState.dstNodeIDVector, &relUpdateState.relIDVector,
            &relUpdateState.propertyVector);
    }
    setHasChanges();
}

bool RelTable::delete_(Transaction* transaction, TableDeleteState& deleteState) {
    const auto& relDeleteState = deleteState.cast<RelTableDeleteState>();
    DASSERT(relDeleteState.relIDVector.state->getSelVector().getSelSize() == 1);
    const auto relIDPos = relDeleteState.relIDVector.state->getSelVector()[0];
    bool isDeleted = false;
    if (const auto relOffset = relDeleteState.relIDVector.readNodeOffset(relIDPos);
        relOffset >= StorageConstants::MAX_NUM_ROWS_IN_TABLE) {
        const auto localTable = transaction->getLocalStorage()->getLocalTable(tableID);
        DASSERT(localTable);
        isDeleted = localTable->delete_(transaction, deleteState);
    } else {
        for (auto& relData : directedRelData) {
            isDeleted = relData->delete_(transaction,
                relDeleteState.getBoundNodeIDVector(relData->getDirection()),
                relDeleteState.relIDVector);
            if (!isDeleted) {
                break;
            }
        }
    }
    if (isDeleted) {
        setHasChanges();
        if (deleteState.logToWAL && transaction->shouldLogToWAL()) {
            DASSERT(transaction->isWriteTransaction());
            auto& wal = transaction->getLocalWAL();
            wal.logRelDelete(tableID, &relDeleteState.srcNodeIDVector,
                &relDeleteState.dstNodeIDVector, &relDeleteState.relIDVector);
        }
    }
    return isDeleted;
}
```

```cpp
bool RelTableData::delete_(Transaction* transaction, ValueVector& boundNodeIDVector,
    const ValueVector& relIDVector) {
    const auto boundNodePos = boundNodeIDVector.state->getSelVector()[0];
    const auto relIDPos = relIDVector.state->getSelVector()[0];
    if (boundNodeIDVector.isNull(boundNodePos) || relIDVector.isNull(relIDPos)) {
        return false;
    }
    const auto [source, rowIdx] = findMatchingRow(transaction, boundNodeIDVector, relIDVector);
    if (rowIdx == INVALID_ROW_IDX) {
        return false;
    }
    const auto boundNodeOffset = boundNodeIDVector.getValue<nodeID_t>(boundNodePos).offset;
    const auto nodeGroupIdx = StorageUtils::getNodeGroupIdx(boundNodeOffset);
    auto& csrNodeGroup = getNodeGroup(nodeGroupIdx)->cast<CSRNodeGroup>();
    bool isDeleted = csrNodeGroup.delete_(transaction, source, rowIdx);
    if (isDeleted && transaction->shouldAppendToUndoBuffer()) {
        transaction->pushDeleteInfo(nodeGroupIdx, rowIdx, 1, getVersionRecordHandler(source));
    }
    return isDeleted;
```

Relationship updates and deletes follow the same general pattern. Updates on committed
relationships enter the CSR/column update paths. Deletes call through
`RelTableData::delete_()`, which pushes `DELETE_INFO` into the undo buffer when a
committed CSR row is marked deleted.

## Lookup vs scan behavior

A point that often causes confusion: lookup and scan use the same visibility semantics
but different mechanics. Scan first constructs a selection vector from `VersionInfo`,
then scans base values for the surviving positions, then overlays `UpdateInfo`. Lookup
first checks `VersionInfo::isSelected()` for the single row and, only if visible, reads
base values and overlays `UpdateInfo::lookup()`.

```cpp
bool ChunkedNodeGroup::lookup(const Transaction* transaction, const TableScanState& state,
    const NodeGroupScanState& nodeGroupScanState, offset_t rowIdxInChunk, sel_t posInOutput) const {
    DASSERT(rowIdxInChunk + 1 <= numRows);
    const bool hasValuesToRead = versionInfo ? versionInfo->isSelected(transaction->getStartTS(),
                                                   transaction->getID(), rowIdxInChunk) :
                                               true;
    if (!hasValuesToRead) {
        return false;
    }
    for (auto i = 0u; i < state.columnIDs.size(); i++) {
        const auto columnID = state.columnIDs[i];
        if (columnID == INVALID_COLUMN_ID) {
            state.outputVectors[i]->setAllNull();
            continue;
        }
        if (columnID == ROW_IDX_COLUMN_ID) {
            state.rowIdxVector->setValue<row_idx_t>(
                state.rowIdxVector->state->getSelVector()[posInOutput],
                rowIdxInChunk + startRowIdx);
            continue;
        }
        DASSERT(columnID < chunks.size());
        DASSERT(i < nodeGroupScanState.chunkStates.size());
        chunks[columnID]->lookup(transaction, nodeGroupScanState.chunkStates[i], rowIdxInChunk,
            *state.outputVectors[i], state.outputVectors[i]->state->getSelVector()[posInOutput]);
    }
    return true;
}

void ChunkedNodeGroup::update(const Transaction* transaction, row_idx_t rowIdxInChunk,
    column_id_t columnID, const ValueVector& propertyVector) {
    getColumnChunk(columnID).update(transaction, rowIdxInChunk, propertyVector);
}

bool ChunkedNodeGroup::delete_(const Transaction* transaction, row_idx_t rowIdxInChunk) {
    if (!versionInfo) {
        versionInfo = std::make_unique<VersionInfo>();
    }
    return versionInfo->delete_(transaction->getID(), rowIdxInChunk);
}
```

This is why “hidden” rows disappear entirely from lookup results: the code returns
`false` before any column access when `VersionInfo` says the row is not selected.

## Checkpoint interaction

Checkpointing is snapshot-based, not “stop the world and serialize every visible latest
write unconditionally.” `TransactionManager::checkpointNoLock()` captures
`lastTimestamp` under the public-function mutex, passes it to
`Checkpointer::beginCheckpoint(snapshotTimestamp)`, and checkpoint storage then reads
using a synthetic `TransactionType::CHECKPOINT` snapshot transaction.

```cpp
void TransactionManager::checkpointNoLock(main::ClientContext& clientContext) {
    // We only need to wait for active write transactions to leave the system before
    // checkpointing. Read transactions can continue safely because they use MVCC snapshot
    // isolation and shadow pages are applied with per-page locking.
    UniqLock writeGate;
    try {
        writeGate = stopNewWriteTransactionsAndWaitUntilAllWriteTransactionsLeave();
    } catch (std::exception& e) {
        throw CheckpointException{e};
    }
    auto checkpointer = initCheckpointerFunc(clientContext);
    try {
        // Snapshot lastTimestamp under the public-function mutex to avoid a data race:
        // commit() increments lastTimestamp under that mutex, and checkpointNoLock() runs
        // without it.  The acquire/release pattern on activeWriteTransactionCount establishes
        // happens-before ordering for the value itself, but accessing a non-atomic variable
        // concurrently is still UB under the C++ memory model.
        transaction_t snapshotTimestamp;
        {
            std::unique_lock lck{mtxForSerializingPublicFunctionCalls};
            snapshotTimestamp = lastTimestamp;
        }
        checkpointer->beginCheckpoint(snapshotTimestamp);
    } catch (std::exception& e) {
        checkpointer->rollback();
        throw CheckpointException{e};
    }
    // Release the write gate early when WAL was rotated. New writers create a fresh active WAL
    // isolated from the frozen checkpoint WAL, so node-data reads during checkpointStoragePhase
    // remain bounded to snapshotTS.
    // NOTE: HashIndexLocalStorage has no per-entry timestamps, so post-snapshotTS inserts that
    // arrive after the gate is released may appear in the on-disk hash index while the
    // corresponding node data was not included in this checkpoint.  This is a pre-existing
    // limitation of the Vela design; fixing it requires adding timestamp-aware snapshotting
    // to HashIndexLocalStorage (tracked as a follow-up).
    if (checkpointer->wasWalRotated()) {
        writeGate = {};
    }
    try {
        checkpointer->checkpointStoragePhase();
    } catch (std::exception& e) {
        checkpointer->rollback();
        throw CheckpointException{e};
    }
    try {
        checkpointer->finishCheckpoint();
    } catch (std::exception& e) {
        checkpointer->rollback();
        throw CheckpointException{e};
    }
    writeGate = {};
    checkpointer->postCheckpointCleanup();
}
```

```cpp
void Checkpointer::beginCheckpoint(common::transaction_t snapshotTimestamp) {
    if (isInMemory) {
        return;
    }

    snapshotTS = snapshotTimestamp;

    walRotated = mainStorageManager->getWAL().rotateForCheckpoint(&clientContext);

    checkpointHeader = *mainStorageManager->getOrInitDatabaseHeader(clientContext);
    const auto oldStorageVersion = checkpointHeader.storageVersion;
    checkpointHeader.storageVersion = StorageVersionInfo::getStorageVersion();
    hasStorageVersionUpgrade = oldStorageVersion != checkpointHeader.storageVersion;

    // Capture versions while the write gate is still held.
    catalogVersionAtCheckpoint = clientContext.getDatabase()->getCatalog()->getVersion();
    pageManagerVersionAtCheckpoint =
        mainStorageManager->getDataFH()->getPageManager()->getVersion();
    tableEpochWatermarks = mainStorageManager->captureChangeEpochs();
}

void Checkpointer::checkpointStoragePhase() {
    if (isInMemory) {
        return;
    }
    hasStorageChanges = checkpointStorage();
}

void Checkpointer::finishCheckpoint() {
    if (isInMemory) {
        return;
    }
    // NOTE: finishCheckpoint() runs after the write gate has been released (when WAL rotation
    // occurred).  New DDL/write transactions may therefore be active, but they assign timestamps
    // strictly greater than the snapshotTS captured under the gate in beginCheckpoint().
    // serializeCatalogAndMetadata() uses snapshotTS > 0 to choose serializeCatalogSnapshot(),
    // which serializes only catalog entries whose commit timestamp is <= snapshotTS, so no
    // post-gate DDL mutation is visible in the serialized snapshot.
    serializeCatalogAndMetadata(checkpointHeader, hasStorageChanges);
    checkpointHeader.dataFileNumPages = mainStorageManager->getDataFH()->getNumPages();
    writeDatabaseHeader(checkpointHeader);
    logCheckpointAndApplyShadowPages(walRotated);
}
```

During snapshot checkpointing, visibility rules are still expressed through
`VersionInfo` and `UpdateInfo`, just with `transactionID = DUMMY_TRANSACTION_ID` and
`startTS = snapshotTS`. This is what allows read transactions to continue during
checkpoint and also why post-snapshot commits are excluded from the checkpoint image.

For the full checkpoint pipeline, WAL rotation, and shadow-page application, see
[/transaction/checkpointing](/transaction/checkpointing),
[/storage/wal-internals](/storage/wal-internals), and
[/storage/shadow-wal](/storage/shadow-wal). This page only needs one checkpoint fact:
the snapshot transaction uses the same MVCC rules as user transactions, so checkpoint
materialization is not a special-case visibility engine.

## Read-your-writes in practice

Ladybug implements read-your-writes at two layers:

1. Local storage for rows that have not yet been merged into committed storage.
2. Version comparisons against `transactionID` for rows and updates that already live
      in committed structures but are still uncommitted.

The first layer is what makes a newly inserted node visible even before transaction
commit. The second layer is what makes a committed-storage delete or property update
immediately visible to the transaction that issued it. The comparison is explicit in
`VectorVersionInfo::isInserted()`, `VectorVersionInfo::isDeleted()`, and
`UpdateInfo::iterateVectorInfo()`.

## Common misconceptions to avoid

- Do not describe Ladybug as storing a `VersionRecord` linked list per row. The name
    `VersionRecordHandler` is an undo callback abstraction, not the name of the row-
    version data structure.
- Do not claim that a read-only commit advances timestamps.
    `TransactionManager::commit()` only increments `lastTimestamp` for `WRITE` and
    `RECOVERY` transactions.
- Do not claim that multiple-write mode disables conflict detection. It only disables
    admission-time rejection of a second active write transaction. Row-level conflicts
    still throw inside `UpdateInfo` and `VersionInfo`.
- Do not claim that checkpointing invents its own visibility rules. It uses a synthetic
    checkpoint transaction and the same `<= startTS` / `== transactionID` logic.
- Do not claim that all writes go through `VersionInfo`. Property updates go through
    `UpdateInfo`; `VersionInfo` only handles row existence via insertion/deletion
    metadata.

## Design notes for contributors

- If you are changing insert/delete visibility, start in `VersionInfo` and
    `ChunkedNodeGroup`, then trace undo callbacks from `UndoBuffer`.
- If you are changing property-update semantics, start in `ColumnChunk::update()` and
    `UpdateInfo::update()`, then verify `iterateScan()` and `lookup()`.
- If you are changing snapshot behavior, check both user transactions and checkpoint
    snapshots. The checkpoint path uses `TransactionType::CHECKPOINT` and is easy to
    break accidentally.
- If you are touching concurrent write behavior, review both `TransactionManager`
    admission control and the row-level checks in `VersionInfo` and `UpdateInfo`.

## Source map and anchor points

- `src/include/transaction/transaction.h:81-109` — transaction ID boundary and helper
    predicates.
- `src/transaction/transaction_manager.cpp:20-48` — begin-time assignment of transaction
    ID and `startTS`.
- `src/transaction/transaction_manager.cpp:57-88` — commit-time timestamp advancement
    for write/recovery transactions only.
- `src/storage/table/version_info.cpp:147-239` — exact visibility predicates.
- `src/storage/table/version_info.cpp:432-462` — append/delete mutation of row metadata.
- `src/storage/table/version_info.cpp:596-660` — commit/rollback timestamp stamping and
    cleanup.
- `src/storage/table/update_info.cpp:17-74` — update-chain insertion and conflict
    detection.
- `src/storage/table/update_info.cpp:114-141` — visible-chain iteration rule.
- `src/storage/table/update_info.cpp:245-296` — newest-visible-update-wins scan merge.
- `src/storage/table/chunked_node_group.cpp:294-330` — row visibility filtering before
    column scans.
- `src/storage/table/column_chunk.cpp:71-89` — update overlay after base-value scan.
- `src/storage/checkpointer.cpp:124-166` — checkpoint snapshot setup and finish.
