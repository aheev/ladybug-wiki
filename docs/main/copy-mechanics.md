# COPY FROM Mechanics

**Source files:**
- `src/processor/operator/persistent/node_batch_insert.h/.cpp`
- `src/processor/operator/persistent/copy_rel_batch_insert.h/.cpp`
- `src/processor/operator/persistent/index_builder.h/.cpp`
- `src/processor/map/map_copy_from.cpp`
- `src/storage/table/node_table.h/.cpp`
- `src/storage/table/rel_table.h/.cpp`

---

## Overview

`COPY FROM` bulk-loads data from an external source (CSV, Parquet, JSON, NPS, Arrow, etc.)
into a node or relationship table.  The implementation is deliberately different from
`INSERT`:

- No per-row round-trip through the optimizer/executor.
- Data flows through a vectorized pipeline of `PhysicalOperator`s with minimal locking.
- At the end, a forced checkpoint serialises the in-memory state to disk.

---

## 1. Physical Planning (`mapCopyNodeFrom` / `mapCopyRelFrom`)

```
COPY FROM statement
  └── PlanMapper::getPhysicalPlan()
        ├── mapCopyNodeFrom()   (node table target)
        └── mapCopyRelFrom()    (relationship table target)
```

### Node copy

```cpp
// map_copy_from.cpp
unique_ptr<PhysicalOperator> mapCopyNodeFrom(
    LogicalCopyFrom* op, ExecutionContext* ctx,
    unique_ptr<PhysicalOperator> child);
```

Produces a linear pipeline:

```
Scan (CSV/Parquet/…)
  └── [expressions / casts]
        └── NodeBatchInsert (sink)
```

`NodeBatchInsert` is the pipeline sink.  It carries:

| Object | Shared? | Role |
|--------|---------|------|
| `NodeBatchInsertSharedState` | yes (all threads) | table pointer, PK strategy, error handler |
| `NodeBatchInsertLocalState` | per-thread | current `ChunkedNodeGroup`, expression evaluators |

### Relationship copy

```
Scan (CSV/Parquet/…)
  └── Partitioner (distributes rows by source-node offset → per-partition chunked groups)
        └── CopyRelBatchInsert (sink)
```

`Partitioner` is the pipeline-breaker.  After all rows are scanned and partitioned,
`CopyRelBatchInsert::execute()` rebuilds them in CSR order.

---

## 2. Node Copy Pipeline

### 2.1 `initPKIndex` — Primary-Key Strategy Selection

Called once, before any data flows, with the exclusive lock held:

```cpp
// NodeBatchInsertSharedState::initPKIndex()
if (table->hasPrimaryKeyIndex()) {
    if (table->pkColumnIsSerial()) {
        // Option A: commit-insert path (low overhead, serial PK)
        usePrimaryKeyIndexCommitInsert = true;
    } else {
        // Option B: concurrent IndexBuilder
        indexBuilder = make_unique<IndexBuilder>(
            IndexBuilderSharedState(pkIndex, numWorkers), this);
    }
} else if (!table->isEmpty()) {
    // Option C: error – can't validate duplicates without an index
    throw CopyException("…");
} else {
    // Option D: no-index validator (in-memory std::set, single-threaded)
    noIndexPKValidator = make_unique<NoIndexPKValidator>(columnType);
}
```

The four options trade off between throughput and correctness guarantees:

| Option | When used | Concurrency | Duplicate detection |
|--------|-----------|-------------|---------------------|
| A — serial PK | PK column is `SERIAL` | no locking needed | values are auto-assigned |
| B — `IndexBuilder` | explicit PK, non-serial | multi-thread safe | hash index sub-sharding |
| C — error | explicit PK, table non-empty, no hash index | — | impossible |
| D — `NoIndexPKValidator` | no hash index, empty table | single-threaded | `std::set` |

**Option D is a scalability limit.** The in-memory `std::set` lives for the duration of the
`COPY` and can consume O(N) memory.  For large imports with non-indexed PK columns, options
A or B are strongly preferred.

### 2.2 `executeInternal` — The Main Loop

```cpp
void NodeBatchInsert::executeInternal(ExecutionContext* ctx) {
    while (children[0]->getNextTuple(ctx) == SourceOperatorState::HAS_MORE) {
        localState->evaluateExpressions(resultSet.get());
        copyToNodeGroup();
        if (localState->chunkedGroup->isFull()) {
            writeAndResetNodeGroup(ctx);
        }
    }
    appendIncompleteNodeGroup(ctx);  // flush the partial tail group
}
```

`copyToNodeGroup()` appends the current vector of values to the
`ChunkedNodeGroup`, updating the per-column `ColumnChunk`s.  A `ChunkedNodeGroup` holds
exactly `NODE_GROUP_SIZE` (= 64 K) rows.

### 2.3 `writeAndResetNodeGroup` — Writing a Full Group

```cpp
void NodeBatchInsert::writeAndResetNodeGroup(ExecutionContext* ctx) {
    auto& sharedState = getSharedState();
    // 1. Write to storage (NOT under exclusive lock)
    auto startOffset = table->appendToLastNodeGroup(
        Transaction::Get(*ctx), *localState->chunkedGroup);

    // 2. Build PK index
    switch (sharedState.pkStrategy) {
    case IndexBuilder:
        sharedState.indexBuilder->insert(
            *localState->chunkedGroup, startOffset, startOffset + groupSize);
        break;
    case CommitInsert:
        sharedState.commitPrimaryKeyIndexInsertions(
            Transaction::Get(*ctx), *localState->chunkedGroup, startOffset);
        break;
    case NoIndexValidator:
        sharedState.noIndexPKValidator->validate(
            *localState->chunkedGroup);
        break;
    }

    localState->resetNodeGroup();
}
```

`table->appendToLastNodeGroup()` may allocate a new node-group page if the current one is
full; it returns the absolute starting `offset_t` of the appended rows so the index builder
can map PK values to their storage offsets.

### 2.4 `appendIncompleteNodeGroup` — Tail Flush

After the child operator is exhausted, each worker thread may hold a partially-filled
`ChunkedNodeGroup` (less than `NODE_GROUP_SIZE` rows).  These must be merged before writing
because the storage layer only allows one writer to the "last node group":

```cpp
void NodeBatchInsert::appendIncompleteNodeGroup(ExecutionContext* ctx) {
    std::unique_lock lck{sharedState.mtx};   // ← exclusive lock
    if (localState->chunkedGroup->isEmpty()) return;

    // Merge into a shared accumulation group first
    if (sharedState.accumNodeGroup == nullptr) {
        sharedState.accumNodeGroup = std::move(localState->chunkedGroup);
    } else {
        sharedState.accumNodeGroup->append(*localState->chunkedGroup);
    }

    if (sharedState.accumNodeGroup->isFull()) {
        auto full = std::move(sharedState.accumNodeGroup);
        lck.unlock();
        writeAndResetNodeGroup(ctx, *full);   // write without holding lock
    }
}

// finalize() is called by the last worker to exit
void NodeBatchInsert::finalize(ExecutionContext* ctx) {
    if (sharedState.accumNodeGroup && !sharedState.accumNodeGroup->isEmpty()) {
        writeAndResetNodeGroup(ctx, *sharedState.accumNodeGroup);
    }
    sharedState.indexBuilder->finishedProducing();  // drain index queues
    sharedState.logWarnings(ctx);
}
```

The exclusive `mtx` covers **only** the accumulation merge; the final `writeAndResetNodeGroup`
call is intentionally done after releasing the lock to avoid blocking other workers still
flushing their tails.

---

## 3. Hash Index Protocol (`IndexBuilder`)

The hash index is built concurrently across all worker threads using a sub-index sharding
scheme designed to minimise lock contention.

### 3.1 Sharding

```cpp
// index_builder.h
static constexpr uint32_t NUM_HASH_INDEXES = 256;
```

The PK hash index is logically split into 256 sub-indexes.  A value's sub-index is
determined by `hash(value) % NUM_HASH_INDEXES`.  This ensures that concurrent threads
almost always operate on different sub-indexes.

### 3.2 Local Buffers

Each worker thread has an `IndexBuilderLocalBuffers` object:

```cpp
class IndexBuilderLocalBuffers {
    // One per sub-index:
    std::array<std::vector<IndexBuilderEntry>, NUM_HASH_INDEXES> buffers;

    void insert(offset_t offset, const Value& key);
    void flush(IndexBuilderGlobalQueues& globalQueues);
};
```

`insert()` hashes `key`, selects the sub-index buffer, and appends `(offset, key)`. When
a local buffer reaches `LOCAL_BUFFER_CAPACITY` entries it is transferred (moved) into the
corresponding global MPSC queue via `globalQueues.insert(subIdx, buffer)`.

### 3.3 Global MPSC Queues

```cpp
class IndexBuilderGlobalQueues {
    std::array<moodycamel::ConcurrentQueue<IndexBufferChunk>, NUM_HASH_INDEXES> queues;
    std::array<std::atomic<bool>, NUM_HASH_INDEXES> queueLocks;

    void insert(uint32_t subIdx, IndexBufferChunk chunk);

    // Returns true if we won the lock and consumed the queue
    bool maybeConsumeIndex(uint32_t subIdx);
};
```

`maybeConsumeIndex(subIdx)`:

1. Tries `pkIndex.tryLockTypedIndex(subIdx)` — a per-sub-index try-lock.
2. If the lock is taken by another consumer, returns immediately (`false`).
3. If the lock is acquired, adopts it as a `unique_lock` via
   `pkIndex.adoptLockOfTypedIndex(subIdx)` (move semantics; avoids a second lock/unlock).
4. Drains the MPSC queue with `appendWithIndexPosNoLock(entry)`.
5. On duplicate PK: `errorHandler.handleError(IndexBuilderError{key, offset})` and advances
   past the entry (`insertBufferOffset += 1`), so processing continues.

### 3.4 Producers and Completion

```cpp
class IndexBuilderSharedState {
    std::atomic<int> producers;     // count of active worker threads
    std::atomic<bool> done;         // true when all producers have quit

    void quitProducer() {
        if (producers.fetch_sub(1) == 1) {
            done.store(true);       // I was the last producer
            // wake up any spin-waiting consumers
        }
    }
    bool isDone() const { return done.load(); }
    void consume(IndexBuilderGlobalQueues& queues);
};
```

When a worker thread has finished inserting all its data:

```cpp
// NodeBatchInsert::finalize() per-worker
localState->indexBuilderLocalBuffers->flush(sharedState->globalQueues);
sharedState->indexBuilderSharedState->quitProducer();
```

Then in `IndexBuilder::finishedProducing()` (called on the last worker's finalize path):

```cpp
void IndexBuilder::finishedProducing() {
    localBuffers.flush(sharedState.globalQueues);   // flush remaining entries
    sharedState.quitProducing();                    // decrement producers

    // Spin-consume until all sub-indexes are drained
    while (!sharedState.isDone()) {
        sharedState.consume(sharedState.globalQueues);
    }
    // Final drain pass
    sharedState.consume(sharedState.globalQueues);
}
```

The spin-wait loop (`while (!isDone())`) is intentional: the calling thread is the last active
worker and has nothing else to do, so CPU-spinning is cheaper than a condition variable.

### 3.5 Error Handling

Duplicate PK violations are *soft errors* during COPY.  The error handler records:

```cpp
struct IndexBuilderError {
    std::string pkValue;
    offset_t    duplicateOffset;
    offset_t    originalOffset;
};
```

After the COPY completes, `sharedState.throwIfErrorsExist()` is called in `finalize()`.
If any duplicates were found, a single `CopyException` is thrown (not per-row) containing
the first N violations and a total count.

---

## 4. Relationship Copy Pipeline

### 4.1 Partitioning

The `Partitioner` operator receives rows from the scan side and distributes them into
per-partition `ChunkedRelNodeGroup`s keyed by the *source node offset*:

```cpp
// Partitioner
void executeInternal(ExecutionContext* ctx) {
    while (child->getNextTuple(ctx) == HAS_MORE) {
        evaluateExpressions();
        for each row:
            partitionID = srcNodeOffset / PARTITION_SIZE;
            partitions[partitionID].append(row);
    }
}
```

Partitioning ensures that all edges with the same source node end up in the same partition,
which is required for CSR ordering.

### 4.2 CSR Length Computation (`populateCSRLengths`)

After partitioning is complete, `CopyRelBatchInsert` counts the out-degree of each source
node:

```cpp
void CopyRelBatchInsert::populateCSRLengths() {
    for each partition:
        for each row in partition:
            srcOffset = row.srcNodeOffset;
            csrLengths[srcOffset]++;
}
```

`csrLengths[i]` will become the CSR row-length array entry for node `i`.

### 4.3 CSR Offset Computation (`setRowIdxFromCSROffsets`)

A prefix-sum converts lengths to starting offsets:

```cpp
void CopyRelBatchInsert::setRowIdxFromCSROffsets() {
    uint64_t cumsum = 0;
    for (offset_t i = 0; i < numNodes; i++) {
        csrOffsets[i] = cumsum;
        cumsum += csrLengths[i];
    }
    csrOffsets[numNodes] = cumsum;  // sentinel

    // Re-use the row-idx column (bound-node-offset) to track
    // the current insertion position per source node.
    for each partition:
        for each row:
            srcOffset = row.srcNodeOffset;
            row.rowIdx = csrOffsets[srcOffset]++;   // post-increment gives next slot
}
```

The key design choice: the **bound-node-offset column is reused** as a row-index storage
column during CSR building.  This avoids allocating an extra column per partition.  After
`setRowIdxFromCSROffsets` the `rowIdx` values in each row point to the exact position in
the final CSR array where that edge should be written.

### 4.4 Writing to Storage (`writeToTable`)

```cpp
void CopyRelBatchInsert::writeToTable() {
    for each partition (in order):
        for each ChunkedRelNodeGroup in partition:
            relTable->appendToLastRelGroup(Transaction::Get(*ctx), group);
}
```

Because `rowIdx` values are pre-computed, the storage layer can write directly into the
correct CSR slot without reordering.  No sorting pass is needed.

### 4.5 Bidirectional Tables

If the relationship table is not directed, `CopyRelBatchInsert` runs the same pipeline a
second time with source and destination swapped to populate the backward CSR
(`FWD` vs. `BWD` direction).

---

## 5. COPY Always Forces a Checkpoint

```cpp
// ClientContext::executeNoLock()
if (parsedStatement->getStatementType() == StatementType::COPY_FROM) {
    Transaction::Get(*this)->setForceCheckpoint();
}
```

The `forceCheckpoint` flag causes `TransactionManager::commit()` to trigger a full WAL
flush and checkpoint synchronously after the transaction commits.  This ensures:

1. All node-group pages written during `COPY` are persisted to the data file.
2. The WAL is cleared (truncated) before the next transaction begins.
3. Recovery after a crash does not need to replay the COPY.

This is unconditional — even if `autoCheckpoint = false`, a `COPY FROM` will checkpoint.

---

## 6. Concurrency Model Summary

| Phase | Locking |
|-------|---------|
| Scan (child operators) | Morsel-parallel, no explicit locks |
| `copyToNodeGroup` | Thread-local, no lock |
| `writeAndResetNodeGroup` | `table->appendToLastNodeGroup()` holds internal page lock |
| `appendIncompleteNodeGroup` | `sharedState.mtx` (exclusive, brief) |
| `finalize` | Called by last worker; single-threaded at this point |
| Hash index local buffer insert | Thread-local |
| Hash index global queue push | Lock-free MPSC (`moodycamel::ConcurrentQueue`) |
| Hash index sub-index consume | Per-sub-index try-lock; only one consumer wins |
| Checkpoint (post-commit) | `TransactionManager` global write lock |

---

## 7. Error Handling during COPY

Errors during COPY fall into two categories:

### Parse / cast errors

If a CSV/JSON field cannot be cast to the column type, the row is skipped and a warning is
recorded in `WarningContext`.  After the COPY completes, warnings are emitted via
`sharedState.logWarnings()`.

### PK duplicate errors

Detected by the `IndexBuilder` (option B) or `NoIndexPKValidator` (option D):

- `IndexBuilder`: errors are accumulated in `IndexBuilderError` list; thrown as a single
  `CopyException` in `finalize()`.
- `NoIndexPKValidator`: throws immediately when the first duplicate is detected.

In both cases the entire `COPY` transaction is rolled back because the exception propagates
up through `executeNoLock()` into `TransactionHelper::runFuncInTransaction()`, which calls
`TransactionManager::rollback()` on exception.

---

## 8. Key Invariants

1. **A `COPY FROM` always checkpoints.** There is no way to suppress the post-commit
   checkpoint for a `COPY FROM` statement.

2. **`appendIncompleteNodeGroup` requires the exclusive lock.** Only one thread may merge
   partial tail groups at a time; the full write is done after releasing the lock.

3. **Relation rows are never re-sorted.** CSR positions are pre-computed by prefix sum so
   the storage layer always receives rows in final order.

4. **The bound-node-offset column is mutated.** During CSR building the column is repurposed
   as a row-index storage; its original semantic is not recoverable after this point.

5. **`IndexBuilder.finishedProducing()` must be called exactly once.** It is called in
   `NodeBatchInsert::finalize()` which is guaranteed to run on the last thread to exit the
   sink operator.
