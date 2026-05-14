# TransactionManager

**Source files:** `src/transaction/transaction_manager.cpp`, `src/include/transaction/transaction_manager.h`, `src/include/transaction/transaction.h`

## Overview

`TransactionManager` is the single authority that governs the lifecycle of every transaction in LadybugDB. It owns three mutexes, two monotonic counters, and the list of active transactions. All public entry points — `beginTransaction`, `commit`, `rollback`, and `checkpoint` — are serialized through these primitives.

```
┌─────────────────────────────────────────────────────────────────┐
│  TransactionManager                                             │
│                                                                 │
│  mtxForSerializingPublicFunctionCalls  ← coarse outer lock      │
│  mtxForStartingNewTransactions         ← write-gate / drain     │
│  mtxForCheckpoint                      ← one checkpoint at once │
│                                                                 │
│  lastTransactionID   (monotonic, starts at START_TRANSACTION_ID)│
│  lastTimestamp       (monotonic, starts at 1)                   │
│  activeWriteTransactionCount  (atomic<uint32_t>)                │
│  activeTransactions  (vector<unique_ptr<Transaction>>)          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Transaction Types

```cpp
// transaction.h
enum class TransactionType : uint8_t {
    READ_ONLY,   // standard read; snapshot isolation, no WAL writes
    WRITE,       // mutating transaction; WAL + LocalStorage
    CHECKPOINT,  // internal marker (not started via beginTransaction)
    DUMMY,       // placeholder / system transaction
    RECOVERY,    // WAL replay at startup; treated as a write path
};
```

The three types that flow through `beginTransaction` are:

| Type | WAL writes | LocalStorage | Increments `activeWriteTransactionCount` |
|------|-----------|-------------|------------------------------------------|
| `READ_ONLY` | ✗ | ✗ | ✗ |
| `WRITE` | ✓ | ✓ | ✓ |
| `RECOVERY` | ✓ | ✓ | ✓ |

`RECOVERY` is used by `WALReplayer` on startup when replaying the WAL into the storage engine. From the transaction manager's point of view it is identical to `WRITE`.

---

## The Three Mutexes

### 1. `mtxForSerializingPublicFunctionCalls`

A coarse mutex that serializes all public API calls: `beginTransaction`, `commit`, and `rollback`. It protects the shared mutable state of the manager:

- `activeTransactions` vector (read, push, erase)
- `lastTransactionID` counter (pre-increment)
- `lastTimestamp` counter (pre-increment at commit)

Every operation that touches any of these fields runs under this lock.

### 2. `mtxForStartingNewTransactions`

A second mutex that acts as the **write gate**. It is acquired by every write/recovery transaction at begin time, and by `checkpointNoLock` to drain active writers:

- `beginTransaction(WRITE | RECOVERY)` holds it for the duration of the begin call.
- `checkpointNoLock` acquires it to block *new* write transactions from starting, then spins-polls `activeWriteTransactionCount` until all in-flight writers have committed or rolled back.

Read-only transactions never acquire this mutex. They can start freely even while a checkpoint drain is in progress.

### 3. `mtxForCheckpoint`

A dedicated mutex that ensures at most one checkpoint (auto or explicit) runs at a time.

- `checkpoint()` (explicit, blocks until it owns the lock)
- `tryCheckpoint()` (non-blocking `try_to_lock`; returns if another checkpoint is already in progress)

This mutex is intentionally **separate** from `mtxForSerializingPublicFunctionCalls`. This separation means active write transactions can call `commit()` or `rollback()` — and decrement `activeWriteTransactionCount` — while the checkpoint's drain loop is waiting. Without the separation, writers would deadlock trying to re-acquire the outer lock.

```
checkpoint drain phase:
  mtxForCheckpoint held
  mtxForSerializingPublicFunctionCalls NOT held  ← writers can commit/rollback
  mtxForStartingNewTransactions held             ← new writes blocked
  polling activeWriteTransactionCount == 0
```

---

## Timestamp Semantics

```cpp
// transaction_manager.h
common::transaction_t lastTransactionID;  // next TX's identity (ID)
common::transaction_t lastTimestamp;      // commit clock
```

Two separate counters serve distinct purposes:

| Counter | Incremented when | Stored as |
|---------|-----------------|-----------|
| `lastTransactionID` | Every `beginTransaction` call (`++lastTransactionID`) | `transaction.ID` — used to find the TX in `activeTransactions` |
| `lastTimestamp` | Every write TX commit (`lastTimestamp++`) | `transaction.commitTS` — the logical commit time |

At `beginTransaction`:
```cpp
auto transaction = make_unique<Transaction>(
    clientContext,
    type,
    ++lastTransactionID,  // ID
    lastTimestamp         // startTS = current commit clock (snapshot)
);
```

At `commit` (write TX):
```cpp
lastTimestamp++;
transaction->commitTS = lastTimestamp;
```

So a transaction's **startTS** is the value of `lastTimestamp` at the instant it began — the high-water mark of all commits that happened before this transaction. Its **commitTS** is the incremented value of `lastTimestamp` assigned during commit.

### Visibility Rule

A row is visible to a reader transaction `tx` if:

```
row.createTS  <= tx.startTS   AND
(row.deleteTS >  tx.startTS   OR  row.deleteTS == INVALID)
```

- Rows created by uncommitted transactions carry the creating TX's `ID` (which is `>= START_TRANSACTION_ID = 1ULL << 63`), so they are invisible to all other readers.
- After commit, rows carry `commitTS < START_TRANSACTION_ID`, making them visible to any TX whose `startTS >= commitTS`.

```
Timeline example:
  lastTimestamp:   1    2    3    4    5
                   │    │    │    │    │
  TX-A begins ─────┘(startTS=1)         (reads rows with createTS ≤ 1)
  TX-B begins ──────────┘(startTS=2)
  TX-B commits (commitTS=3) ─────────┘
  TX-C begins ─────────────────┘(startTS=3) sees TX-B's rows
  TX-D begins ──────────────────────────┘(startTS=4) also sees TX-B's rows
```

---

## `beginTransaction` Flow

```cpp
Transaction* TransactionManager::beginTransaction(
    ClientContext& clientContext, TransactionType type)
{
    // 1. Always acquire the outer serialization lock
    std::unique_lock publicFunctionLck{mtxForSerializingPublicFunctionCalls};

    // 2. Write gate: acquired only for WRITE and RECOVERY
    std::unique_lock newTransactionLck{mtxForStartingNewTransactions, std::defer_lock};
    if (type != TransactionType::READ_ONLY) {
        newTransactionLck.lock();
    }

    switch (type) {
    case TransactionType::READ_ONLY: {
        auto transaction = make_unique<Transaction>(
            clientContext, type, ++lastTransactionID, lastTimestamp);
        activeTransactions.push_back(std::move(transaction));
        return activeTransactions.back().get();
    }
    case TransactionType::RECOVERY:
    case TransactionType::WRITE: {
        if (!clientContext.getDBConfig()->enableMultiWrites
                && hasActiveWriteTransactionNoLock()) {
            throw TransactionManagerException(
                "Cannot start a new write transaction in the system. "
                "Only one write transaction at a time is allowed in the system.");
        }
        auto transaction = make_unique<Transaction>(
            clientContext, type, ++lastTransactionID, lastTimestamp);
        activeWriteTransactionCount.fetch_add(1, memory_order_release);
        activeTransactions.push_back(std::move(transaction));
        return activeTransactions.back().get();
    }
    }
}
```

**Read-only path:** acquires only `mtxForSerializingPublicFunctionCalls`. A read TX can start even while `checkpointNoLock` holds `mtxForStartingNewTransactions` because it never needs that gate.

**Write/Recovery path:**
1. Acquires both `mtxForSerializingPublicFunctionCalls` and `mtxForStartingNewTransactions`.
2. If `enableMultiWrites` is false (the default) and there is already an active write transaction, throws immediately.
3. Otherwise creates the transaction, increments `activeWriteTransactionCount`, and adds it to `activeTransactions`.

---

## `commit` Flow

```cpp
void TransactionManager::commit(ClientContext& clientContext, Transaction* transaction) {
    bool shouldCheckpoint = false;
    {
        std::unique_lock lck{mtxForSerializingPublicFunctionCalls};
        clientContext.cleanUp();

        switch (transaction->getType()) {

        case TransactionType::READ_ONLY:
            clearTransactionNoLock(transaction->getID());   // step A
            break;

        case TransactionType::RECOVERY:
        case TransactionType::WRITE:
            lastTimestamp++;                                 // step 1
            transaction->commitTS = lastTimestamp;           // step 2
            transaction->commit(&wal);                       // step 3
            shouldCheckpoint =
                transaction->shouldForceCheckpoint() ||      // step 4
                Checkpointer::canAutoCheckpoint(clientContext, *transaction);
            clearTransactionNoLock(transaction->getID());   // step 5
            activeWriteTransactionCount
                .fetch_sub(1, memory_order_release);         // step 6
            break;
        }
    } // mtxForSerializingPublicFunctionCalls released here

    if (shouldCheckpoint) {
        tryCheckpoint(clientContext);                        // step 7
    }
}
```

Step-by-step for a write commit:

| # | Action | Why |
|---|--------|-----|
| 1 | `lastTimestamp++` | Advance the commit clock before assigning it |
| 2 | `transaction->commitTS = lastTimestamp` | Stamp the TX's logical commit time |
| 3 | `transaction->commit(&wal)` | Flush LocalWAL to disk WAL; flush LocalStorage to NodeTable |
| 4 | Evaluate checkpoint need | Check `shouldForceCheckpoint` flag or WAL size threshold |
| 5 | `clearTransactionNoLock` | Remove TX from `activeTransactions` list |
| 6 | Decrement `activeWriteTransactionCount` | Signal checkpoint drain loop that this writer is done |
| 7 | `tryCheckpoint` (outside the lock) | Run auto-checkpoint without holding the outer mutex |

::: tip Why step 7 runs outside the lock
`tryCheckpoint` calls `checkpointNoLock`, which internally calls
`stopNewWriteTransactionsAndWaitUntilAllWriteTransactionsLeave`, which must wait for
`activeWriteTransactionCount` to reach zero. If this were called inside
`mtxForSerializingPublicFunctionCalls`, any concurrent writer trying to commit or roll back would
deadlock trying to re-acquire the same mutex. Running it outside allows other writers to drain
naturally.
:::

---

## `rollback` Flow

```cpp
void TransactionManager::rollback(ClientContext& clientContext, Transaction* transaction) {
    std::unique_lock lck{mtxForSerializingPublicFunctionCalls};
    clientContext.cleanUp();

    switch (transaction->getType()) {
    case TransactionType::READ_ONLY:
        clearTransactionNoLock(transaction->getID());
        break;

    case TransactionType::RECOVERY:
    case TransactionType::WRITE:
        transaction->rollback(&wal);             // revert LocalStorage, clear LocalWAL
        clearTransactionNoLock(transaction->getID());
        activeWriteTransactionCount.fetch_sub(1, memory_order_release);
        break;
    }
}
```

`transaction->rollback(&wal)` walks the undo buffer in reverse to revert all mutations in `LocalStorage` and discards the `LocalWAL` without flushing it to disk. After rollback the TX is removed from `activeTransactions` and the write counter is decremented — making the checkpoint drain loop eligible to proceed if it is waiting.

::: info No auto-checkpoint after rollback
`shouldCheckpoint` is not evaluated in the rollback path. A rolled-back transaction left no committed data, so the WAL did not grow with durable content, and there is nothing to checkpoint.
:::

---

## Checkpoint Flow

### Explicit checkpoint

```cpp
void TransactionManager::checkpoint(ClientContext& clientContext) {
    if (clientContext.isInMemory()) {
        return;  // in-memory databases have no WAL to checkpoint
    }
    std::unique_lock checkpointLck{mtxForCheckpoint};
    checkpointNoLock(clientContext);
}
```

### Auto-checkpoint (`tryCheckpoint`)

Called after every write commit, outside the outer lock:

```cpp
void TransactionManager::tryCheckpoint(ClientContext& clientContext) {
    if (clientContext.isInMemory()) {
        return;
    }
    // Non-blocking: skip if another checkpoint is already in progress
    std::unique_lock checkpointLck{mtxForCheckpoint, std::try_to_lock};
    if (!checkpointLck.owns_lock()) {
        return;
    }
    checkpointNoLock(clientContext);
}
```

### `checkpointNoLock` — the drain and execute sequence

```
checkpointNoLock(clientContext):
  1. Acquire mtxForStartingNewTransactions
     └─ Blocks new write transactions from starting
  2. Poll activeWriteTransactionCount until it reaches 0 (with timeout)
     └─ Existing writers can still commit/rollback (they do NOT need this lock)
  3. Snapshot lastTimestamp (under mtxForSerializingPublicFunctionCalls for safety)
  4. checkpointer->beginCheckpoint(snapshotTimestamp)
     └─ Rotates WAL: renames lbug.wal → checkpoint.wal.lbug
  5. If WAL was rotated: release mtxForStartingNewTransactions early
     └─ New writers get a fresh active WAL; checkpoint operates on the frozen one
  6. checkpointer->checkpointStoragePhase()
     └─ Flushes committed node groups / rel tables / hash indexes to shadow file
  7. checkpointer->finishCheckpoint()
     └─ Commits shadow file, updates DatabaseHeader, cleans up frozen WAL
  8. checkpointer->postCheckpointCleanup()
     └─ Removes frozen WAL (checkpoint.wal.lbug) and shadow files
```

The drain loop in step 2 polls every 500 µs. If `activeWriteTransactionCount` does not reach zero within `checkpointWaitTimeoutInMicros` (default: 5 seconds), a `TransactionManagerException` is raised and the checkpoint is aborted.

```cpp
// From stopNewWriteTransactionsAndWaitUntilAllWriteTransactionsLeave():
while (true) {
    if (!hasActiveWriteTransactionNoLock()) { break; }
    numTimesWaited++;
    if (numTimesWaited * THREAD_SLEEP_TIME_WHEN_WAITING_IN_MICROS   // 500 µs
            > checkpointWaitTimeoutInMicros) {                      // 5 s
        throw TransactionManagerException(
            "Timeout waiting for active write transactions to leave...");
    }
    std::this_thread::sleep_for(
        std::chrono::microseconds(THREAD_SLEEP_TIME_WHEN_WAITING_IN_MICROS));
}
```

---

## Auto-Checkpoint Trigger

```cpp
// checkpointer.cpp
bool Checkpointer::canAutoCheckpoint(
    const ClientContext& clientContext,
    const Transaction& transaction)
{
    if (clientContext.isInMemory())        return false;
    if (!clientContext.getDBConfig()->autoCheckpoint) return false;
    if (transaction.isRecovery())          return false;

    auto wal = WAL::Get(clientContext);
    const auto expectedSize =
        transaction.getLocalWAL().getSize() + wal->getFileSize();
    return expectedSize > clientContext.getDBConfig()->checkpointThreshold;
}
```

A checkpoint is triggered automatically when the **combined size** of the current transaction's local WAL plus the on-disk WAL exceeds `checkpointThreshold` (default: **16 MB**). This check runs after every write commit. Recovery transactions are explicitly excluded — replaying the WAL should never itself trigger a checkpoint mid-replay.

---

## `enableMultiWrites` Configuration

By default (`enableMultiWrites = false`), starting a second write transaction while one is already active throws:

```
TransactionManagerException: Cannot start a new write transaction in the system.
Only one write transaction at a time is allowed in the system.
```

When `enableMultiWrites = true`, multiple concurrent write transactions are allowed to begin. However, each write TX still acquires `mtxForStartingNewTransactions` during `beginTransaction`. This serializes the *begin* call itself — preventing interleaved assignment of `lastTransactionID` and `lastTimestamp` — but writers can otherwise run concurrently.

::: warning Concurrent write caveat
Concurrent write transactions share the same `LocalStorage` and WAL. At the time of writing, LadybugDB does not perform OCC or SSI conflict detection between concurrent writers. `enableMultiWrites` is intended for controlled scenarios (e.g. bulk-load pipelines) where the application ensures that the writes do not conflict.
:::

---

## Lock Interaction Summary

```
Operation           mtxForSerializing  mtxForStartingNew  mtxForCheckpoint
────────────────────────────────────── ─────────────────  ────────────────
beginTransaction (RO)  acquired         not acquired       not acquired
beginTransaction (W)   acquired         acquired           not acquired
commit (RO)            acquired         not acquired       not acquired
commit (W)             acquired         not acquired       not acquired
rollback (RO)          acquired         not acquired       not acquired
rollback (W)           acquired         not acquired       not acquired
checkpoint (explicit)  not acquired*    acquired (drain)   acquired
tryCheckpoint (auto)   not acquired*    acquired (drain)   try_lock

  * snapshots lastTimestamp with a brief inner lock during checkpointNoLock
```

The key insight: **no commit or rollback operation ever holds `mtxForCheckpoint`**, and **no checkpoint operation ever holds `mtxForSerializingPublicFunctionCalls` during the long drain phase**. This prevents deadlocks during the checkpoint drain.

---

## RECOVERY Transaction

When LadybugDB opens a database that has an unprocessed WAL, `WALReplayer` calls `beginTransaction(RECOVERY)`. The recovery transaction:

- Takes the write gate (`mtxForStartingNewTransactions`) like any other writer.
- Is excluded from auto-checkpoint triggers (`canAutoCheckpoint` returns false for recovery).
- Commits via the normal write commit path, stamping a `commitTS` for all replayed rows.

After WAL replay completes, the recovery transaction is committed and the WAL is truncated.

---

## Related Files

- `src/transaction/transaction_manager.cpp` — `beginTransaction`, `commit`, `rollback`, `checkpoint`, `checkpointNoLock`, `tryCheckpoint`
- `src/include/transaction/transaction_manager.h` — class declaration, mutex and counter fields
- `src/include/transaction/transaction.h` — `Transaction` struct, `TransactionType`, `startTS`, `commitTS`, `START_TRANSACTION_ID`
- `src/include/transaction/transaction_context.h` — per-connection `TransactionContext`, `AUTO`/`MANUAL` mode
- `src/storage/checkpointer.cpp` — `Checkpointer::canAutoCheckpoint`, checkpoint storage phase
- `src/include/storage/checkpointer.h` — `Checkpointer` declaration
- `src/storage/wal/local_wal.h` — `LocalWAL` (per-transaction WAL buffer flushed at commit)
- `src/storage/wal/wal.cpp` — persistent WAL file, WAL rotation
- `src/include/main/db_config.h` — `enableMultiWrites`, `autoCheckpoint`, `checkpointThreshold`
- `src/include/common/constants.h` — `THREAD_SLEEP_TIME_WHEN_WAITING_IN_MICROS`, `DEFAULT_CHECKPOINT_WAIT_TIMEOUT_IN_MICROS`
