# Incident Reports

Post-mortems written after significant bugs are resolved. Each report covers root cause, impact, resolution, and lessons learned.

---

## 2026-02-17: CI minimal test — CloseConnectionWithActiveTransaction checkpoint timeout

**Severity:** Low (CI flake; no production impact)  
**Component:** WAL / Checkpoint — `waitForCheckpoint()` under high I/O  
[→ Full report](https://github.com/aheev/ladybug/blob/main/docs/incidents/2026-02-17-minimal-test-checkpoint-timeout.md)

A CI test (`CloseConnectionWithActiveTransaction`) timed out waiting for checkpoint to complete. The WAL checkpoint path stalled under synthetic I/O load in the minimal test environment. Fixed by increasing the checkpoint wait timeout and improving the WAL flush retry loop to yield the CPU between retries rather than spin-waiting.

---

## 2026-02-17: FSM leak after COPY + ROLLBACK + reload

**Severity:** Medium (memory growth; no data corruption)  
**Component:** Storage — Free Space Manager (FSM) / WAL replay  
[→ Full report](https://github.com/aheev/ladybug/blob/main/docs/incidents/2026-02-17-fsm-leak-copy-rollback-recovery.md)

Rolling back a large `COPY` statement and then reloading the database caused the Free Space Manager to leak block entries. The `ROLLBACK` path correctly discarded dirty pages but did not release the corresponding FSM reservations; on reload the FSM was reconstructed from WAL without clearing those ghost entries. Fixed by flushing FSM reservations as part of the ROLLBACK undo path.

---

## 2026-02-16: CopyRelSegmentTest — "Try to partition multiple factorization group"

**Severity:** Medium (E2E test failure; no production impact)  
**Component:** Planner — `COPY FROM` for relationship tables  
[→ Full report](https://github.com/aheev/ladybug/blob/main/docs/incidents/2026-02-16-copy-rel-segment-planner-schema-groups.md)

`COPY <rel_table> FROM (subquery)` threw a runtime exception during planning when the subquery plan had more than one factorization group but only one group in scope. `planCopyRelFrom` used `getGroupsPosInScope().size() == 1` to decide whether to insert an `Accumulate` operator, whereas `LogicalPartitioner` requires `getNumGroups() == 1`. Fixed by aligning the condition to `getNumGroups() <= 1`, matching the stricter check already used in `planCopyNodeFrom`.

**Key lesson:** Keep schema group checks consistent across node and rel `COPY` planning paths. `getGroupsPosInScope()` and `getNumGroups()` are not equivalent; prefer `getNumGroups()` when downstream operators assert on the total group count.

---

## 2026-02-16: SIGSEGV when Connection is destroyed while query workers are still running

**Severity:** High (crash; observed in Node.js addon and during COPY)  
**Component:** Main — Connection / ClientContext lifecycle, Processor task scheduler  
[→ Full report](https://github.com/aheev/ladybug/blob/main/docs/incidents/2026-02-16-connection-close-sigsegv.md)

Closing a `Connection` (or `Database`) while a query was still executing could cause a SIGSEGV. The `Connection` destructor destroyed `ClientContext` immediately while `TaskScheduler` worker threads still held raw pointers to it. Touches to freed memory → crash.

**Resolution:** Added `std::atomic<uint32_t> activeQueryCount` + `waitForNoActiveQuery()` to `ClientContext`. `QueryProcessor::execute()` increments/decrements the count via an RAII guard. `Connection::~Connection()` now calls `waitForNoActiveQuery()` before destroying the context.

**Key lesson:** If worker threads hold raw pointers to an object, the owner must block destruction until all workers finish. A ref-count + condition variable is the canonical fix. Document and enforce "no query in flight on destructor entry" for all connection/context types.

---

## When to write an incident report

Write a report whenever you fix a bug that:
- Caused a crash, data loss, or silent corruption
- Required non-trivial diagnosis (> 30 min to find root cause)
- Revealed a systemic gap (wrong abstraction, missing invariant, copy-paste error across multiple sites)
- Is likely to recur if the lesson is not written down

Place the file in `docs/incidents/` with a date-prefixed name: `YYYY-MM-DD-short-description.md`.
