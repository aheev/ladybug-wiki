# Transaction Manager

This page is the definitive engineering reference for Ladybug transaction lifecycle
control: transaction admission, transaction cleanup, timestamp assignment, checkpoint
coordination, and the boundary between transaction control and MVCC conflict detection.
It documents what the current code does, not what a generic database textbook might do.

The transaction manager is small but easy to describe incorrectly. It is **not** just a
global single-writer mutex, **not** just a checkpoint trigger, and **not** the place
where row-level update conflicts are detected. It serializes certain public entry
points, coordinates write admission and checkpoint drains, assigns transaction IDs and
snapshot timestamps, and delegates actual storage work to `Transaction`, `LocalStorage`,
`UndoBuffer`, `WAL`, and `Checkpointer`.

## Authoritative sources

- `src/include/transaction/transaction_manager.h` — public state, mutexes, timeout
    default, helper comments
- `src/transaction/transaction_manager.cpp` — begin/commit/rollback/checkpoint
    implementation
- `src/include/transaction/transaction.h` — transaction type enum and transaction-owned
    state
- `src/transaction/transaction.cpp` — local storage / undo / WAL sequencing
- `src/include/main/settings.h` — user-visible option name for multi-write mode
- `src/main/settings.cpp` — setting implementation mapping to
    `DBConfig.enableMultiWrites`
- `src/include/main/database.h` — SystemConfig defaults for checkpoint and multi-write
    settings
- `src/main/database.cpp` — force checkpoint on close in `Database::~Database()`
- `src/include/main/db_config.h` — persisted DB config fields
- `src/main/db_config.cpp` — construction of `DBConfig` from `SystemConfig`
- `src/storage/checkpointer.cpp` — auto-checkpoint condition and checkpoint phase split
- `src/antlr4/Cypher.g4` — grammar entry for `CHECKPOINT`
- `src/parser/transform/transform_transaction.cpp` — statement transformation to
    `TransactionAction::CHECKPOINT`
- `src/processor/operator/transaction.cpp` — runtime validation for
    BEGIN/COMMIT/ROLLBACK/CHECKPOINT
- `src/include/common/constants.h` — default checkpoint wait timeout constant
- `src/include/common/exception/transaction_manager.h` — transaction-manager exception
    type
- `src/include/common/exception/checkpoint.h` — checkpoint exception wrapper

Cross-reference pages: visibility rules live in [/transaction/mvcc](/transaction/mvcc);
write staging lives in [/transaction/local-storage](/transaction/local-storage);
checkpoint materialization lives in
[/transaction/checkpointing](/transaction/checkpointing); durability plumbing lives in
[/storage/wal-internals](/storage/wal-internals) and
[/storage/shadow-wal](/storage/shadow-wal).

## Transaction types and why they matter

The public enum is short but semantically dense. Every transaction-control discussion
should start with the actual enum instead of inventing higher-level categories.

```cpp
namespace transaction {
class TransactionManager;

enum class TransactionType : uint8_t { READ_ONLY, WRITE, CHECKPOINT, DUMMY, RECOVERY };
```

| Type | Created by | Can append undo? | Can write WAL? | Commit advances `lastTimestamp`? |
| --- | --- | --- | --- | --- |
| `READ_ONLY` | regular `BEGIN TRANSACTION READ ONLY` and implicit read transactions | no | no | no |
| `WRITE` | regular write transactions | yes | yes if database is not in-memory | yes |
| `CHECKPOINT` | synthetic snapshot transactions used by checkpoint code | no | no | not via `TransactionManager::commit()` |
| `DUMMY` | helper transaction objects for internal mutation paths | no | no | no |
| `RECOVERY` | WAL replay / recovery paths | yes | special-case, see recovery logic | yes |

Two details are easy to miss. First, `shouldAppendToUndoBuffer()` returns true for both
`WRITE` and `RECOVERY`, not just for `WRITE`. Second, `shouldLogToWAL()` returns true
only for ordinary write transactions and only when the database is not in-memory.
Recovery uses different persistence semantics and does not route through the same
commit-to-WAL path.

```cpp
    void setForceCheckpoint() { forceCheckpoint = true; }
    bool shouldAppendToUndoBuffer() const {
        // Only write transactions and recovery transactions should append to the undo buffer.
        return isWriteTransaction() || isRecovery();
    }
    bool shouldLogToWAL() const;
    storage::LocalWAL& getLocalWAL() const {
        DASSERT(localWAL);
        return *localWAL;
    }

    bool shouldForceCheckpoint() const;
```

```cpp
bool Transaction::shouldLogToWAL() const {
    return isWriteTransaction() && !clientContext->isInMemory();
}

bool Transaction::shouldForceCheckpoint() const {
    return !clientContext->isInMemory() && forceCheckpoint;
}
```

## In-memory mode

When the database path is empty or `:memory:`, `DBConfig::isDBPathInMemory(...)` marks the database as in-memory and `ClientContext::isInMemory()` reports that status back to transaction code. Transaction control still exists in this mode, but the durability branch of the transaction manager is explicitly disabled.

Concretely:

- write transactions still allocate `Transaction`, `LocalStorage`, and `UndoBuffer` objects
- `Transaction::shouldLogToWAL()` is always false, so commit skips WAL append entirely
- `Transaction::shouldForceCheckpoint()` is always false, even if a statement such as `COPY FROM` requested a forced checkpoint
- `TransactionManager::tryCheckpoint(...)` and `TransactionManager::checkpoint(...)` return immediately
- `Checkpointer::canAutoCheckpoint(...)` returns false, so no automatic checkpoint path is entered

So in-memory mode keeps MVCC and rollback semantics, but removes WAL durability, shadow-page checkpointing, and crash-recovery persistence. A successful commit in memory means “visible to later statements in this process,” not “recoverable after restart.”

## Transaction IDs, `startTS`, and `commitTS`

`TransactionManager` maintains two counters: `lastTransactionID` and `lastTimestamp`.
The counters serve different purposes. `lastTransactionID` creates unique transaction
identifiers in the high numeric range starting at `Transaction::START_TRANSACTION_ID`.
`lastTimestamp` tracks committed time in the low numeric range starting at `1`.

```cpp
public:
    // Timestamp starts from 1. 0 is reserved for the dummy system transaction.
    explicit TransactionManager(storage::WAL& wal)
        : wal{wal}, lastTransactionID{Transaction::START_TRANSACTION_ID}, lastTimestamp{1} {
        initCheckpointerFunc = initCheckpointer;
    }

    Transaction* beginTransaction(main::ClientContext& clientContext, TransactionType type);
```

On begin, `startTS` is copied from the current `lastTimestamp`; it is **not**
incremented. That makes `startTS` the snapshot boundary “all commits that were durable
before this transaction started.” On write or recovery commit, `lastTimestamp` is
incremented, then the incremented value is stored in `transaction->commitTS`. Read-only
commit skips both steps entirely.

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

This is the exact rule the MVCC page depends on:

- begin-time `startTS` = current `lastTimestamp`
- write/recovery commit: `lastTimestamp++`, then `commitTS = lastTimestamp`
- read-only commit: no timestamp advancement, just transaction cleanup

## Owned state and synchronization primitives

The manager’s header exposes the concurrency model directly. There are three mutexes,
not one, and each has a different purpose.

```cpp
private:
    bool hasNoActiveTransactions() const;
    void checkpointNoLock(main::ClientContext& clientContext);
    // Try to checkpoint without blocking. Returns immediately if another checkpoint is in
    // progress. Used by auto-checkpoint after commit.
    void tryCheckpoint(main::ClientContext& clientContext);

    // This function locks the mutex to stop new transactions and waits until all transactions
    // (both read and write) leave the system. Used as a fallback.
    common::UniqLock stopNewTransactionsAndWaitUntilAllTransactionsLeave();

    // This function locks the mutex to stop new write transactions and waits until all active
    // write transactions leave the system. Read transactions are allowed to continue.
    common::UniqLock stopNewWriteTransactionsAndWaitUntilAllWriteTransactionsLeave();

    bool hasActiveWriteTransactionNoLock() const {
        return activeWriteTransactionCount.load(std::memory_order_acquire) > 0;
    }

    // Note: Used by DBTest::createDB only.
    void setCheckPointWaitTimeoutForTransactionsToLeaveInMicros(uint64_t waitTimeInMicros) {
        checkpointWaitTimeoutInMicros = waitTimeInMicros;
    }

    void clearTransactionNoLock(common::transaction_t transactionID);

private:
    storage::WAL& wal;
    std::vector<std::unique_ptr<Transaction>> activeTransactions;
    common::transaction_t lastTransactionID;
    common::transaction_t lastTimestamp;
    // This mutex serializes begin/commit/rollback calls to protect activeTransactions.
    std::mutex mtxForSerializingPublicFunctionCalls;
    std::mutex mtxForStartingNewTransactions;
    // Prevents concurrent checkpoints. Separate from mtxForSerializingPublicFunctionCalls so
    // that active writers can commit/rollback while the checkpoint is draining them.
    std::mutex mtxForCheckpoint;
    // Atomic counter tracking active write/recovery transactions so the checkpoint drain loop
    // can poll without holding mtxForSerializingPublicFunctionCalls.
    std::atomic<uint32_t> activeWriteTransactionCount{0};
    uint64_t checkpointWaitTimeoutInMicros = common::DEFAULT_CHECKPOINT_WAIT_TIMEOUT_IN_MICROS;

    init_checkpointer_func_t initCheckpointerFunc;
```

| Field | Role | Why it exists separately |
| --- | --- | --- |
| `mtxForSerializingPublicFunctionCalls` | serializes `beginTransaction`, `commit`, and `rollback` access to `activeTransactions` and `lastTimestamp` | protects shared vectors/counters and makes public lifecycle transitions linearizable |
| `mtxForStartingNewTransactions` | gates admission of new write or all transactions during checkpoint drain helpers | lets checkpoint stop new writers without freezing ongoing commit/rollback work under the public-function mutex |
| `mtxForCheckpoint` | prevents concurrent checkpoints | lets normal commit/rollback continue while one checkpoint is draining active writers |
| `activeWriteTransactionCount` | atomic count of active write/recovery transactions | allows checkpoint drain loops to poll for writers without holding the public-function mutex |

The code comments in the header are authoritative here. The public-function mutex
serializes life-cycle transitions. The start-new-transactions mutex is the checkpoint
gate. The checkpoint mutex prevents overlapping checkpoints. Conflating these into “a
single write lock” misses how checkpoint and commit are allowed to overlap during
specific phases.

## Concurrency model: single writer, multiple readers

From the user-facing system model, Ladybug is **single writer, multiple readers** by default. The manifestation in `TransactionManager` is precise:

- read-only transactions do **not** acquire `mtxForStartingNewTransactions`, so they can start while another read is active and can continue during checkpoint drain
- each read transaction snapshots `lastTimestamp` into `startTS`, so it reads a stable MVCC snapshot instead of blocking writers for shared locks
- write and recovery transactions do acquire `mtxForStartingNewTransactions`, and with `enableMultiWrites == false` the begin path rejects a second active writer
- checkpoint drain temporarily takes the same gate to stop new writers, but existing readers continue because they already hold snapshot timestamps

So the default behavior is many concurrent readers plus at most one writer admitted at a time. If `enableMultiWrites` is enabled, the transaction manager stops enforcing the single-writer admission rule, but row-level MVCC conflict detection still decides whether concurrent writers can touch the same rows safely.

## Begin path

`beginTransaction()` always acquires `mtxForSerializingPublicFunctionCalls`. It
conditionally acquires `mtxForStartingNewTransactions` only when the type is not
`READ_ONLY`. In other words: read-only transactions can start during checkpoint drain
because they use snapshot isolation, while write and recovery transactions are blocked
by the write gate.

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
        // LCOV_EXCL_START
    default: {
        throw TransactionManagerException("Invalid transaction type to begin transaction.");
    }
        // LCOV_EXCL_STOP
    }
}
```

Admission-time multiple-writer behavior is exactly one conditional:

> if (!clientContext.getDBConfig()->enableMultiWrites && hasActiveWriteTransactionNoLock()) {
>     throw TransactionManagerException(
>         "Cannot start a new write transaction in the system. "
>         "Only one write transaction at a time is allowed in the system.");
> }

That means `enableMultiWrites` only toggles whether a second active write/recovery
transaction is rejected **at begin time**. It does not change row-level MVCC conflict
checks in `VersionInfo` and `UpdateInfo`. Those checks still run during updates and
deletes. For the full conflict story, see [/transaction/mvcc](/transaction/mvcc).

## Commit path

`TransactionManager::commit()` is a two-stage function. Stage one runs under
`mtxForSerializingPublicFunctionCalls` and performs cleanup plus transaction-owned
commit work. Stage two runs outside that mutex and optionally tries to checkpoint.

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

Read-only commit is intentionally minimal:

1. clean the client context
2. erase the transaction from `activeTransactions`
3. return without touching `lastTimestamp`, undo, WAL, or checkpoint logic

Write and recovery commit follow a richer path:

1. clean the client context
2. increment `lastTimestamp` and assign `transaction->commitTS`
3. call `transaction->commit(&wal)`
4. decide whether checkpoint should be attempted (`forceCheckpoint` or auto-checkpoint
      threshold)
5. clear the transaction from `activeTransactions`
6. decrement `activeWriteTransactionCount`
7. after releasing the public-function mutex, call `tryCheckpoint()` if needed

The lack of a try/catch around `transaction->commit(&wal)` is deliberate and important.
There is no special WAL-flush recovery path here beyond exception propagation. If the
underlying WAL or local-storage commit throws, the exception propagates out of
`commit()`. Documentation should not imply hidden retry or compensation logic that does
not exist.

### What `Transaction::commit()` actually does

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

The order is exact:

1. `localStorage->commit()` folds staged table changes into persistent storage and
      commits optimistic allocators.
2. `undoBuffer->commit(commitTS)` rewrites MVCC metadata from transaction IDs to commit
      timestamps.
3. If the transaction should log to the WAL, `LocalWAL` writes a commit marker, then
      the shared WAL persists the staged transaction WAL, then the local WAL is
      cleared.
4. If catalog changes were made, the catalog version is incremented.

This order explains why the undo buffer participates in commit even though data pages
may already have been modified in memory. The row metadata must be stamped with the
commit timestamp only after the transaction has been assigned one.

## Rollback path

Rollback is also split between manager-level control flow and transaction-owned storage
logic, but it stays under the public-function mutex throughout.

```cpp
// Note: We take in additional `transaction` here is due to that `transactionContext` might be
// destructed when a transaction throws an exception, while we need to roll back the active
// transaction still.
void TransactionManager::rollback(main::ClientContext& clientContext, Transaction* transaction) {
    std::unique_lock lck{mtxForSerializingPublicFunctionCalls};
    clientContext.cleanUp();
    switch (transaction->getType()) {
    case TransactionType::READ_ONLY: {
        clearTransactionNoLock(transaction->getID());
    } break;
    case TransactionType::RECOVERY:
    case TransactionType::WRITE: {
        transaction->rollback(&wal);
        clearTransactionNoLock(transaction->getID());
        activeWriteTransactionCount.fetch_sub(1, std::memory_order_release);
    } break;
    default: {
        throw TransactionManagerException("Invalid transaction type to rollback.");
    }
    }
}
```

```cpp
void Transaction::rollback(storage::WAL*) {
    // Rolling back the local storage will free + evict all optimistically-allocated pages
    // Since the undo buffer may do some scanning (e.g. to delete inserted keys from the hash index)
    // this must be rolled back first
    undoBuffer->rollback(clientContext);
    localStorage->rollback();
    hasCatalogChanges = false;
}
```

Read-only rollback is just transaction cleanup. Write and recovery rollback call
`transaction->rollback(&wal)`, then erase the active transaction, then decrement
`activeWriteTransactionCount`. The transaction-owned rollback order is non-negotiable:
undo first, local storage second.

The source comment explains why: rolling back local storage can free and evict
optimistically allocated pages, while undo rollback may still need to scan structures
such as hash indexes. Therefore `undoBuffer->rollback(clientContext)` must run before
`localStorage->rollback()`. This page intentionally repeats that point because it is
easy to reverse by mistake when refactoring.

## Checkpoint entry points

Ladybug has three practical checkpoint entry points: explicit `CHECKPOINT`,
auto-checkpoint after write commit, and force-checkpoint in `Database::~Database()` when
`forceCheckpointOnClose` is true. All of them route through
`TransactionManager::checkpoint()` or `TransactionManager::tryCheckpoint()`.

### Explicit `CHECKPOINT` statement

```antlr
iC_Transaction
    : BEGIN SP TRANSACTION
        | BEGIN SP TRANSACTION SP READ SP ONLY
        | COMMIT
        | ROLLBACK
        | CHECKPOINT;
```

```cpp
std::unique_ptr<Statement> Transformer::transformTransaction(
    CypherParser::IC_TransactionContext& ctx) {
    if (ctx.TRANSACTION()) {
        if (ctx.READ()) {
            return std::make_unique<TransactionStatement>(TransactionAction::BEGIN_READ);
        }
        return std::make_unique<TransactionStatement>(TransactionAction::BEGIN_WRITE);
    }
    if (ctx.COMMIT()) {
        return std::make_unique<TransactionStatement>(TransactionAction::COMMIT);
    }
    if (ctx.ROLLBACK()) {
        return std::make_unique<TransactionStatement>(TransactionAction::ROLLBACK);
    }
    if (ctx.CHECKPOINT()) {
        return std::make_unique<TransactionStatement>(TransactionAction::CHECKPOINT);
    }
    UNREACHABLE_CODE;
}
```

```cpp
bool Transaction::getNextTuplesInternal(ExecutionContext* context) {
    if (hasExecuted) {
        return false;
    }
    hasExecuted = true;
    auto clientContext = context->clientContext;
    auto transactionContext = TransactionContext::Get(*clientContext);
    validateActiveTransaction(*transactionContext);
    switch (transactionAction) {
    case TransactionAction::BEGIN_READ: {
        transactionContext->beginReadTransaction();
    } break;
    case TransactionAction::BEGIN_WRITE: {
        transactionContext->beginWriteTransaction();
    } break;
    case TransactionAction::COMMIT: {
        transactionContext->commit();
    } break;
    case TransactionAction::ROLLBACK: {
        transactionContext->rollback();
    } break;
    case TransactionAction::CHECKPOINT: {
        TransactionManager::Get(*clientContext)->checkpoint(*clientContext);
    } break;
    default: {
        UNREACHABLE_CODE;
    }
    }
    return true;
}

void Transaction::validateActiveTransaction(const TransactionContext& context) const {
    switch (transactionAction) {
    case TransactionAction::BEGIN_READ:
    case TransactionAction::BEGIN_WRITE: {
        if (context.hasActiveTransaction()) {
            throw TransactionManagerException(
                "Connection already has an active transaction. Cannot start a transaction within "
                "another one. For concurrent multiple transactions, please open other "
                "connections.");
        }
    } break;
    case TransactionAction::COMMIT:
    case TransactionAction::ROLLBACK: {
        if (!context.hasActiveTransaction()) {
            throw TransactionManagerException(std::format("No active transaction for {}.",
                TransactionActionUtils::toString(transactionAction)));
        }
    } break;
    case TransactionAction::CHECKPOINT: {
        if (context.hasActiveTransaction()) {
            throw TransactionManagerException(std::format("Found active transaction for {}.",
                TransactionActionUtils::toString(transactionAction)));
        }
    } break;
    default: {
        UNREACHABLE_CODE;
    }
    }
}
```

The parser and processor are simple but important. `CHECKPOINT` is a first-class
transaction action. The operator validates that there is **no** active transaction on
the connection before invoking `TransactionManager::checkpoint(*clientContext)`. If
there is an active transaction, a `TransactionManagerException` is thrown.

### Auto-checkpoint after write commit

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
        // Recovery transactions are not allowed to trigger auto checkpoint.
        return false;
    }
    auto wal = WAL::Get(clientContext);
    const auto expectedSize = transaction.getLocalWAL().getSize() + wal->getFileSize();
    return expectedSize > clientContext.getDBConfig()->checkpointThreshold;
}
```

Auto-checkpoint can only be triggered by ordinary write transactions. Recovery
transactions are explicitly excluded. The check is: `transaction.getLocalWAL().getSize()
+ wal->getFileSize() > checkpointThreshold`, and only if `auto_checkpoint` is enabled
and the database is not in-memory.

### Force checkpoint on close

```cpp
Database::~Database() {
    if (!dbConfig->readOnly && dbConfig->forceCheckpointOnClose) {
        try {
            ClientContext clientContext(this);
            transactionManager->checkpoint(clientContext);
        } catch (...) {} // NOLINT
    }
```

`Database::~Database()` attempts a checkpoint when the database is writable and
`forceCheckpointOnClose` is true. The destructor swallows all exceptions. That behavior
is distinct from ordinary checkpoint calls, which propagate exceptions wrapped as
`CheckpointException` or `TransactionManagerException`.

## Checkpoint gating and timeout behavior

The manual or auto checkpoint path acquires `mtxForCheckpoint` and then enters
`checkpointNoLock()`. The function stops new write transactions, waits for active
write/recovery transactions to leave, captures `lastTimestamp`, and delegates the actual
storage work to `Checkpointer`.

```cpp
void TransactionManager::checkpoint(main::ClientContext& clientContext) {
    if (clientContext.isInMemory()) {
        return;
    }
    // Use the dedicated checkpoint mutex so active writers can still commit/rollback
    // during the drain phase.
    std::unique_lock checkpointLck{mtxForCheckpoint};
    checkpointNoLock(clientContext);
}

TransactionManager* TransactionManager::Get(const main::ClientContext& context) {
    if (context.getAttachedDatabase() != nullptr) {
        context.getAttachedDatabase()->getTransactionManager();
    }
    return context.getDatabase()->getTransactionManager();
}

UniqLock TransactionManager::stopNewTransactionsAndWaitUntilAllTransactionsLeave() {
    UniqLock startTransactionLock{mtxForStartingNewTransactions};
    uint64_t numTimesWaited = 0;
    while (true) {
        if (hasNoActiveTransactions()) {
            break;
        }
        numTimesWaited++;
        if (numTimesWaited * THREAD_SLEEP_TIME_WHEN_WAITING_IN_MICROS >
            checkpointWaitTimeoutInMicros) {
            throw TransactionManagerException(
                "Timeout waiting for active transactions to leave the system before "
                "checkpointing. If you have an open transaction, please close it and try "
                "again.");
        }
        std::this_thread::sleep_for(
            std::chrono::microseconds(THREAD_SLEEP_TIME_WHEN_WAITING_IN_MICROS));
    }
    return startTransactionLock;
}

UniqLock TransactionManager::stopNewWriteTransactionsAndWaitUntilAllWriteTransactionsLeave() {
    UniqLock startTransactionLock{mtxForStartingNewTransactions};
    uint64_t numTimesWaited = 0;
    while (true) {
        if (!hasActiveWriteTransactionNoLock()) {
            break;
        }
        numTimesWaited++;
        if (numTimesWaited * THREAD_SLEEP_TIME_WHEN_WAITING_IN_MICROS >
            checkpointWaitTimeoutInMicros) {
            throw TransactionManagerException(
                "Timeout waiting for active write transactions to leave the system before "
                "checkpointing. If you have an open write transaction, please close it and "
                "try again.");
        }
        std::this_thread::sleep_for(
            std::chrono::microseconds(THREAD_SLEEP_TIME_WHEN_WAITING_IN_MICROS));
    }
    return startTransactionLock;
}
```

```cpp
void TransactionManager::tryCheckpoint(main::ClientContext& clientContext) {
    if (clientContext.isInMemory()) {
        return;
    }
    std::unique_lock checkpointLck{mtxForCheckpoint, std::try_to_lock};
    if (!checkpointLck.owns_lock()) {
        return;
    }
    checkpointNoLock(clientContext);
}

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
// This is the default thread sleep time we use when a thread,
// e.g., a worker thread is in TaskScheduler, needs to block.
constexpr uint64_t THREAD_SLEEP_TIME_WHEN_WAITING_IN_MICROS = 500;

constexpr uint64_t DEFAULT_CHECKPOINT_WAIT_TIMEOUT_IN_MICROS = 5000000;
```

Timeouts are governed by `checkpointWaitTimeoutInMicros`, which defaults to
`DEFAULT_CHECKPOINT_WAIT_TIMEOUT_IN_MICROS = 5,000,000`. The polling interval is
`THREAD_SLEEP_TIME_WHEN_WAITING_IN_MICROS = 500`. If the wait exceeds the configured
timeout, the manager throws a `TransactionManagerException`, and the outer checkpoint
code wraps it in `CheckpointException`.

Two drain helpers exist:

- `stopNewTransactionsAndWaitUntilAllTransactionsLeave()` stops **all** new transactions
    and waits for `activeTransactions.empty()`.
- `stopNewWriteTransactionsAndWaitUntilAllWriteTransactionsLeave()` stops only new
    write/recovery transactions and waits for `activeWriteTransactionCount == 0`.

Current checkpointing uses the second helper, not the first. That is why read-only
transactions are allowed to continue during checkpoint. Any documentation that says
“checkpoint waits for every transaction to finish” is out of date for the current code.

## How checkpoint work is phased

Checkpointing is intentionally phased so that the expensive storage materialization step
can continue after the write gate is released if WAL rotation succeeded.

```cpp
    explicit Checkpointer(main::ClientContext& clientContext);
    virtual ~Checkpointer();

    void writeCheckpoint();
    void beginCheckpoint(common::transaction_t snapshotTS);
    // Storage materialization phase. Safe to call after the write gate is released when WAL
    // rotation occurred — node-data reads use the frozen WAL bounded to snapshotTS.
    // See transaction_manager.cpp for the hash-index timestamp caveat.
    void checkpointStoragePhase();
    void finishCheckpoint();
    // Cleanup after the core checkpoint that does not require the write gate.
    void postCheckpointCleanup();
    void rollback();
    bool wasWalRotated() const { return walRotated; }

    void readCheckpoint();

    static bool canAutoCheckpoint(const main::ClientContext& clientContext,
        const transaction::Transaction& transaction);
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

void Checkpointer::postCheckpointCleanup() {
    if (isInMemory) {
        return;
    }
    // NOTE: No try/catch here is intentional. By the time this runs, finishCheckpoint() has
    // already persisted the checkpoint header and applied shadow pages — the database is
    // durable.  Any exception in the in-memory cleanup below indicates a programming error;
    // letting it propagate (and crash the process) is safer than continuing with partially
    // reset in-memory state.  On the next startup the database loads from the stable
    // on-disk checkpoint and is fully consistent.
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

The lifecycle is:

1. `beginCheckpoint(snapshotTS)` rotates the WAL, captures the database header, records
      storage-version information, and captures catalog/page-manager/table epoch
      versions while the write gate is held.
2. `checkpointStoragePhase()` materializes storage state against the checkpoint
      snapshot.
3. `finishCheckpoint()` serializes catalog and metadata snapshots, writes the database
      header, logs a checkpoint record, and applies shadow pages.
4. `postCheckpointCleanup()` resets in-memory versions, clears or rotates WAL state,
      and resets the shadow file.

If WAL rotation succeeded, `TransactionManager::checkpointNoLock()` releases the write
gate early, before `checkpointStoragePhase()`. The code comments explain the remaining
caveat: hash-index checkpointing is not fully timestamp-aware yet, so documentation
should point readers to the checkpointing page rather than claiming perfectly
snapshot-isolated hash-index materialization.

## Configuration knobs and defaults

```cpp
     * @param autoCheckpoint If true, the database will automatically checkpoint when the size of
     * the WAL file exceeds the checkpoint threshold.
     * @param checkpointThreshold The threshold of the WAL file size in bytes. When the size of the
     * WAL file exceeds this threshold, the database will checkpoint if autoCheckpoint is true.
     * @param forceCheckpointOnClose If true, the database will force checkpoint when closing.
     * @param throwOnWalReplayFailure If true, any WAL replaying failure when loading the database
     * will throw an error. Otherwise, Lbug will silently ignore the failure and replay up to where
     * the error occured.
     * @param enableChecksums If true, the database will use checksums to detect corruption in the
     * WAL file.
     * @param enableMultiWrites If true, multiple concurrent write transactions are allowed.
     * Default to false.
     * @param enableDefaultHashIndex If true, node tables create the default primary-key hash
     * index.
     */
    explicit SystemConfig(uint64_t bufferPoolSize = -1u, uint64_t maxNumThreads = 0,
        bool enableCompression = true, bool readOnly = false, uint64_t maxDBSize = -1u,
        bool autoCheckpoint = true, uint64_t checkpointThreshold = 16777216 /* 16MB */,
        bool forceCheckpointOnClose = true, bool throwOnWalReplayFailure = true,
        bool enableChecksums = true, bool enableMultiWrites = false,
        bool enableDefaultHashIndex = true
```

```cpp
struct EnableMVCCSetting {
    static constexpr auto name = "debug_enable_multi_writes";
    static constexpr auto inputType = common::LogicalTypeID::BOOL;
    static void setContext(ClientContext* context, const common::Value& parameter);
    static common::Value getSetting(const ClientContext* context);
};

struct CheckpointThresholdSetting {
    static constexpr auto name = "checkpoint_threshold";
    static constexpr auto inputType = common::LogicalTypeID::INT64;
    static void setContext(ClientContext* context, const common::Value& parameter);
    static common::Value getSetting(const ClientContext* context);
};

struct AutoCheckpointSetting {
    static constexpr auto name = "auto_checkpoint";
    static constexpr auto inputType = common::LogicalTypeID::BOOL;
    static void setContext(ClientContext* context, const common::Value& parameter);
    static common::Value getSetting(const ClientContext* context);
};

struct ForceCheckpointClosingDBSetting {
    static constexpr auto name = "force_checkpoint_on_close";
    static constexpr auto inputType = common::LogicalTypeID::BOOL;
    static void setContext(ClientContext* context, const common::Value& parameter);
    static common::Value getSetting(const ClientContext* context);
```

```cpp
void EnableMVCCSetting::setContext(ClientContext* context, const common::Value& parameter) {
    DASSERT(parameter.getDataType().getLogicalTypeID() == common::LogicalTypeID::BOOL);
    // TODO: This is a temporary solution to make tests of multiple write transactions easier.
    context->getDBConfigUnsafe()->enableMultiWrites = parameter.getValue<bool>();
}

common::Value EnableMVCCSetting::getSetting(const ClientContext* context) {
    return common::Value(context->getDBConfig()->enableMultiWrites);
}

void CheckpointThresholdSetting::setContext(ClientContext* context,
    const common::Value& parameter) {
    parameter.validateType(inputType);
    context->getDBConfigUnsafe()->checkpointThreshold = parameter.getValue<int64_t>();
}

common::Value CheckpointThresholdSetting::getSetting(const ClientContext* context) {
    return common::Value(context->getDBConfig()->checkpointThreshold);
}

void AutoCheckpointSetting::setContext(ClientContext* context, const common::Value& parameter) {
    parameter.validateType(inputType);
    context->getDBConfigUnsafe()->autoCheckpoint = parameter.getValue<bool>();
}

common::Value AutoCheckpointSetting::getSetting(const ClientContext* context) {
    return common::Value(context->getDBConfig()->autoCheckpoint);
}

void ForceCheckpointClosingDBSetting::setContext(ClientContext* context,
    const common::Value& parameter) {
    parameter.validateType(inputType);
    context->getDBConfigUnsafe()->forceCheckpointOnClose = parameter.getValue<bool>();
}

common::Value ForceCheckpointClosingDBSetting::getSetting(const ClientContext* context) {
    return common::Value(context->getDBConfig()->forceCheckpointOnClose);
```

```cpp
DBConfig::DBConfig(const SystemConfig& systemConfig)
    : bufferPoolSize{systemConfig.bufferPoolSize}, maxNumThreads{systemConfig.maxNumThreads},
      enableCompression{systemConfig.enableCompression}, readOnly{systemConfig.readOnly},
      maxDBSize{systemConfig.maxDBSize}, enableMultiWrites{systemConfig.enableMultiWrites},
      autoCheckpoint{systemConfig.autoCheckpoint},
      checkpointThreshold{systemConfig.checkpointThreshold},
      forceCheckpointOnClose{systemConfig.forceCheckpointOnClose},
      throwOnWalReplayFailure(systemConfig.throwOnWalReplayFailure),
      enableChecksums(systemConfig.enableChecksums),
      enableDefaultHashIndex{systemConfig.enableDefaultHashIndex}, enableSpillingToDisk{true} {
```

| Setting / field | Default | Meaning |
| --- | --- | --- |
| `SystemConfig.enableMultiWrites` / `DBConfig.enableMultiWrites` | `false` | allow more than one active write/recovery transaction at begin time |
| `debug_enable_multi_writes` | runtime setting name | maps to `DBConfig.enableMultiWrites` through `EnableMVCCSetting` |
| `SystemConfig.autoCheckpoint` / `DBConfig.autoCheckpoint` | `true` | allow threshold-based auto-checkpoint after write commit |
| `SystemConfig.checkpointThreshold` / `DBConfig.checkpointThreshold` | `16777216` bytes (16 MiB) | WAL-size threshold used by auto-checkpoint |
| `SystemConfig.forceCheckpointOnClose` / `DBConfig.forceCheckpointOnClose` | `true` | try checkpoint in `Database::~Database()` |
| `checkpointWaitTimeoutInMicros` | `5000000` microseconds | drain timeout while waiting for writers to leave before checkpoint |

The public setting name for multi-write mode is intentionally a debug-flavored name:
`debug_enable_multi_writes`. The source comment in `EnableMVCCSetting::setContext()`
says this is a temporary solution to make multiple write transaction tests easier. That
phrasing belongs in docs because users will otherwise search for an option named
`enable_mvcc` and not find it.

## What transaction control does *not* do

- It does not enforce row-level update/delete conflicts by itself. Those are checked in
    storage-layer MVCC code.
- It does not log every operation directly. `Transaction` owns the `LocalWAL` and
    decides whether an operation should reach the global `WAL`.
- It does not store staged table rows. `LocalStorage` owns local tables and optimistic
    allocators.
- It does not attempt to recover from WAL/logging exceptions during commit beyond
    propagating the exception to the caller.

## Representative lifecycle walkthroughs

### Read-only transaction

1. Admission: `beginTransaction(READ_ONLY)` increments `lastTransactionID`, copies
      `startTS = lastTimestamp`, and adds the transaction to `activeTransactions`.
2. Execution: reads use snapshot isolation against `startTS`.
3. Commit: `TransactionManager::commit()` only clears the transaction. No timestamp
      increment, no undo commit, no WAL commit, and no auto-checkpoint trigger.

### Write transaction

1. Admission: `beginTransaction(WRITE)` serializes with public lifecycle calls,
      acquires the new-write gate, enforces `enableMultiWrites`, creates the
      transaction, and increments `activeWriteTransactionCount`.
2. Execution: writes stage rows in local storage, create undo records, and append
      logical records to `LocalWAL` when durability is required.
3. Commit: manager assigns `commitTS`, `Transaction::commit()` folds local storage,
      commits undo, persists the local WAL, then the manager clears the active
      transaction and may try a checkpoint.

### Manual checkpoint

1. Parser recognizes `CHECKPOINT` as a transaction statement.
2. Processor rejects the statement if the connection already has an active transaction.
3. Transaction manager serializes checkpoint entry with `mtxForCheckpoint`, drains
      active writers, captures `snapshotTS`, and runs the phased checkpointer.
4. Read-only transactions may remain active during the checkpoint because snapshot
      isolation is sufficient for their visibility semantics.

## Misconceptions to avoid

- Do not say “commit always advances the global timestamp.” Only write and recovery
    commit do; read-only commit does not.
- Do not say “conflicts are prevented solely by one global writer mutex.” That is only
    the default admission policy. With multi-write enabled, overlapping row updates
    still fail through MVCC conflict checks.
- Do not say “checkpoint is allowed inside an active transaction.” The processor
    explicitly rejects that case.
- Do not say “checkpoint failure is silently handled.” Regular checkpoint calls
    propagate exceptions wrapped in `CheckpointException`; only the database destructor
    swallows exceptions.
- Do not say “all transactions are blocked during checkpoint.” The current
    implementation blocks new write/recovery transactions and waits only for active
    writers to finish.

## Source map and anchor points

- `src/include/transaction/transaction_manager.h:82-91` — the three mutexes and active
    writer counter.
- `src/transaction/transaction_manager.cpp:20-48` — begin path and write admission gate.
- `src/transaction/transaction_manager.cpp:57-88` — read-only versus write/recovery
    commit behavior.
- `src/transaction/transaction_manager.cpp:93-110` — rollback behavior.
- `src/transaction/transaction_manager.cpp:129-169` — checkpoint drain loops and timeout
    exceptions.
- `src/storage/checkpointer.cpp:273-288` — auto-checkpoint threshold calculation.
- `src/include/main/settings.h:99-103` and `src/main/settings.cpp:164-171` —
    `debug_enable_multi_writes` runtime setting.
- `src/main/database.cpp:146-152` — force checkpoint on database close.
- `src/antlr4/Cypher.g4:257-263`,
    `src/parser/transform/transform_transaction.cpp:11-29`,
    `src/processor/operator/transaction.cpp:52-75` — manual `CHECKPOINT` statement flow.
