# MVCC & Transaction Lifecycle

**Source files:** `src/transaction/transaction_manager.cpp`, `src/include/transaction/transaction_manager.h`, `src/include/transaction/transaction.h`

## Transaction IDs

Every transaction gets a monotonically increasing `transaction_t` (uint64_t):

```cpp
// transaction.h
static constexpr transaction_t START_TRANSACTION_ID = 1ULL << 62;
static constexpr transaction_t MAX_TRANSACTION_ID   = UINT64_MAX;
static constexpr transaction_t INVALID_TRANSACTION  = 0;

// Commit IDs are assigned from a separate sequence:
// commitID < START_TRANSACTION_ID → committed
// commitID >= START_TRANSACTION_ID → in-progress or not yet committed
```

A transaction's `transactionID` is its start ID (used to track in-flight operations). Its `commitID` is assigned at commit time from the commit sequence. Pages written by a transaction carry the `commitID` for visibility checks.

## Snapshot Isolation

LadybugDB implements **snapshot isolation** (SI), not serializable SI. Each read transaction sees a consistent snapshot of committed state as of its start time:

```
txIDs:    1000    1001    1002    1003
          TX-A    TX-B    TX-C    TX-D
          start   start   commit  start
          reads   writes  ────    reads
                  ────            sees C
                                  doesn't see B (in-flight)
```

The rule: TX-D can see a version iff `version.commitID < TX-D.startID`.

## Visibility Check

```cpp
// transaction.h
bool Transaction::isVisible(transaction_t commitID) const {
    // A version is visible if it was committed before this TX started
    return commitID < this->startTransactionID;
}
```

Applied in the scan path when reading from committed storage. Uncommitted local writes are always visible to the writing transaction.

## Read vs Write Transactions

```cpp
enum class TransactionType { READ_ONLY, READ_WRITE };
```

- **Read-only transactions**: no `UndoBuffer`, no WAL writes, no shadow file involvement. Cheap to start and end.
- **Read-write transactions**: get an `UndoBuffer` chain, participate in WAL, write through shadow file.

## TransactionManager

```cpp
class TransactionManager {
    // Active transactions by their start IDs
    unordered_map<transaction_t, unique_ptr<Transaction>> activeTransactions;

    // Monotonic counters
    atomic<transaction_t> currentStartTXID;  // for new TX start IDs
    atomic<transaction_t> currentCommitID;   // for commit IDs

    // Watermark: lowest startTXID of any active TX
    // Used to decide when old versions can be garbage-collected
    transaction_t getLowWatermark();
};
```

### Begin Transaction

```cpp
Transaction* TransactionManager::beginTransaction(TransactionType type) {
    auto txID = currentStartTXID.fetch_add(1, memory_order_relaxed);
    auto tx = make_unique<Transaction>(txID, type);
    if (type == READ_WRITE) {
        tx->undoBuffer = make_unique<UndoBuffer>();
        wal->appendRecord(BeginTransactionRecord{txID});
    }
    activeTransactions[txID] = move(tx);
    return activeTransactions[txID].get();
}
```

### Commit Transaction

```cpp
void TransactionManager::commit(Transaction& tx) {
    auto commitID = currentCommitID.fetch_add(1, memory_order_seq_cst);
    tx.commitID = commitID;

    if (tx.isWriteTransaction()) {
        // 1. Flush local storage to node groups (with commitID stamped)
        tx.localStorage->flush(commitID);
        // 2. Append COMMIT_RECORD to WAL
        wal->appendRecord(CommitRecord{tx.transactionID, commitID});
        wal->flush();
        // 3. Commit shadow pages to original data files
        shadowFile->commitChanges();
    }

    activeTransactions.erase(tx.transactionID);
}
```

### Rollback Transaction

```cpp
void TransactionManager::rollback(Transaction& tx) {
    if (tx.isWriteTransaction()) {
        // Walk undo buffer in reverse, reverting each change
        tx.undoBuffer->reverseIterate([](UndoRecord& record) {
            record.rollback();
        });
        // Discard shadow pages (no writes to original files)
        shadowFile->rollback();
        // Append ROLLBACK record to WAL (optional, for audit)
        wal->appendRecord(RollbackRecord{tx.transactionID});
    }
    activeTransactions.erase(tx.transactionID);
}
```

## Version Vectors

The `commitID` stamped in the local storage flush is the mechanism for MVCC versioning of node property data. Each node group's committed storage records which `commitID` last modified each row:

- The scan path applies `Transaction::isVisible(commitID)` to filter out versions newer than the reader's snapshot
- Only the **latest visible version** is returned

## Garbage Collection (Future Work)

Old versions (visible to no running transaction) are eligible for GC when their `commitID < getLowWatermark()`. The GC path compacts node groups by rewriting column chunks without old versions. (As of 0.16.x, GC is not yet fully implemented for all table types.)

## Concurrency Guarantees

- **Read-read**: fully parallel, no coordination
- **Read-write**: readers never block writers; writers never block readers (MVCC)
- **Write-write**: serialized — only one write transaction at a time via a global write lock in `TransactionManager`

::: warning Single-writer limitation
LadybugDB currently allows only one concurrent write transaction. This is by design for simplicity. Future versions may support multi-writer with OCC/SSI conflict detection.
:::

## Related Files

- `src/transaction/transaction_manager.cpp` — begin, commit, rollback
- `src/include/transaction/transaction.h` — Transaction struct, startTXID, commitID
- `src/storage/local_storage/` — in-memory write staging
- `src/storage/shadow_file.cpp` — page-level commit
- `src/storage/wal/wal.cpp` — WAL records
