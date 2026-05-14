# WAL Internals

**Source files:** `src/storage/wal/wal.cpp`, `src/storage/wal/local_wal.cpp`, `src/storage/wal/wal_replayer.cpp`, `src/include/storage/wal/`

This page covers the two-tier WAL architecture. For the shadow file mechanism and the high-level durability design see [Shadow File & WAL](./shadow-wal).

## Two-Tier Architecture

LadybugDB uses **two separate WAL objects**:

| | `LocalWAL` | `WAL` |
|---|---|---|
| **Scope** | Per-transaction | Shared across all transactions |
| **Storage** | In-memory (`InMemFileWriter`) | On-disk (`lbug.wal`) |
| **Thread safety** | Mutex-protected | Append-only single-writer (write-TX serialized) |
| **Lifetime** | Created at TX start, destroyed at commit/rollback | Lives for the duration of the database |
| **Purpose** | Stage records for the current transaction | Durable record after commit |
| **Checksums** | Optional (`ChecksumWriter`) | Same flag as global `enableChecksums` config |

```
Write transaction flow:

  BEGIN TX
   │
   ├── LocalWAL (in-memory):
   │     logBeginTransaction()
   │     logCreateCatalogEntryRecord(…)
   │     logTableInsertion(…)
   │     logCommit()
   │
   │── COMMIT:
   │     LocalWAL::getBytes() → bytes
   │     WAL::logCommittedWAL(bytes)   ← flush to disk WAL
   │     LocalWAL::clear()
```

### Why Two Tiers?

`LocalWAL` is per-transaction and written in memory. This avoids disk I/O for transactions that roll back — the in-memory buffer is simply discarded. Only committed transactions ever touch the shared on-disk `WAL`.

## WAL Record Types

All record types are defined in `src/include/storage/wal/wal_record_type.h`:

| Record Type | Logged When |
|-------------|-------------|
| `BEGIN_TRANSACTION_RECORD` | Transaction starts |
| `COMMIT_RECORD` | Transaction commits |
| `CHECKPOINT_RECORD` | Checkpoint completes (written at end of frozen WAL) |
| `CREATE_CATALOG_ENTRY_RECORD` | CREATE TABLE / CREATE INDEX / CREATE SEQUENCE |
| `DROP_CATALOG_ENTRY_RECORD` | DROP TABLE / DROP INDEX |
| `ALTER_TABLE_ENTRY_RECORD` | ALTER TABLE (rename, add column, drop column, change type) |
| `TABLE_INSERTION_RECORD` | INSERT or COPY INTO (batch of rows) |
| `NODE_DELETION_RECORD` | DELETE on a node table |
| `NODE_UPDATE_RECORD` | SET on a node property |
| `REL_DELETION_RECORD` | DELETE on a relationship |
| `REL_DETACH_DELETE_RECORD` | DETACH DELETE — delete all edges of a node |
| `REL_UPDATE_RECORD` | SET on a relationship property |
| `COPY_TABLE_RECORD` | COPY FROM (bulk load) |
| `UPDATE_SEQUENCE_RECORD` | NEXTVAL / auto-increment sequence advance |
| `LOAD_EXTENSION_RECORD` | LOAD EXTENSION |

::: tip Data pages vs WAL records
Data modifications (node property values, CSR arrays) go through the **shadow file** — they are not written as WAL records. Only *logical* operations (catalog changes, DML metadata, extension loads) are WAL-recorded. See [Shadow File & WAL](./shadow-wal) for the full picture.
:::

## WAL File Format

```
lbug.wal (binary):
┌─────────────────────────────┐
│  WALHeader                  │
│    databaseID (UUID, 16B)   │  — must match DatabaseHeader
│    enableChecksums (uint8)  │
├─────────────────────────────┤
│  WALRecord 0                │  BEGIN_TRANSACTION_RECORD
├─────────────────────────────┤
│  WALRecord 1                │  TABLE_INSERTION_RECORD
├─────────────────────────────┤
│  ...                        │
├─────────────────────────────┤
│  WALRecord N                │  COMMIT_RECORD  ← end of TX 0
├─────────────────────────────┤
│  WALRecord N+1              │  BEGIN_TRANSACTION_RECORD (TX 1)
│  ...                        │
└─────────────────────────────┘
```

When **checksums are enabled** (`enableChecksums = true` in `SystemConfig`), each record is wrapped with a `ChecksumWriter`/`ChecksumReader` that appends a CRC after each record. On replay, a checksum mismatch throws:

```
"Checksum verification failed, the WAL file is corrupted."
```

## Two-File WAL: Active vs Frozen

During a checkpoint, LadybugDB uses **two WAL files**:

| File | Path | State |
|------|------|-------|
| Active WAL | `<dbPath>/lbug.wal` | Normal operations |
| Frozen (checkpoint) WAL | `<dbPath>/checkpoint.wal.lbug` | Renamed from active during checkpoint |

The checkpoint sequence:

```
1. Acquire write lock
2. Rename  lbug.wal  →  checkpoint.wal.lbug   (freeze)
3. Checkpoint storage phase (write shadow file from frozen WAL state)
4. Write CHECKPOINT_RECORD to  checkpoint.wal.lbug  (marks completion)
5. Commit shadow file → data pages durable
6. Remove checkpoint.wal.lbug  (no longer needed)
7. Release write lock
8. New write transactions use a fresh  lbug.wal
```

If the process crashes between steps 3 and 6, the frozen WAL (`checkpoint.wal.lbug`) exists without a `CHECKPOINT_RECORD`. Recovery detects this and re-replays the frozen WAL.

## WAL Replay on Startup

`WALReplayer::replay()` runs on every database open. It handles four cases:

### Case 1: No WAL Files

```
No lbug.wal, no checkpoint.wal.lbug
  → removeFileIfExists(shadow file)
  → checkpointer.readCheckpoint()   ← load last clean checkpoint
  → done
```

### Case 2: Frozen WAL only (crashed mid-checkpoint)

```
checkpoint.wal.lbug exists, no lbug.wal
  → replayFrozenWAL()
  → done
```

### Case 3: Active WAL only (normal operations, no checkpoint in progress)

```
lbug.wal exists, no checkpoint.wal.lbug
  → removeFileIfExists(shadow file)   ← discard stale shadow file
  → checkpointer.readCheckpoint()
  → replayActiveWAL()
```

### Case 4: Both files exist (crashed after rename but before CHECKPOINT_RECORD)

```
Both exist:
  → replayFrozenWAL()        ← replay frozen WAL first
  → replayActiveWAL()        ← then replay active WAL delta
```

## Dry Replay Algorithm

Before executing changes, `WALReplayer::dryReplay()` makes a **single forward pass** to find the last safe replay offset:

```cpp
dryReplay(fileInfo):
  offsetDeserialized = 0
  for each WALRecord in file:
    if record == COMMIT_RECORD:
      offsetDeserialized = current_offset   // safe to replay up to here
    if record == CHECKPOINT_RECORD:
      offsetDeserialized = current_offset
      break
    // deserialization error → stop, assume corrupted tail

  return offsetDeserialized
```

After the dry pass, the actual replay runs **only up to `offsetDeserialized`**. This safely skips a partially-written (uncommitted) transaction tail.

After replay, the WAL file is **truncated** to `offsetDeserialized`:

```cpp
truncateWALFile(fileInfo, offsetDeserialized);
```

This ensures any future writes don't try to re-replay a corrupt tail, and is idempotent (if truncation was already done by a previous recovery).

## Error Handling

`replay(throwOnWalReplayFailure, enableChecksums)`:

- `throwOnWalReplayFailure = true` (CI / explicit replay) — deserialization errors are rethrown
- `throwOnWalReplayFailure = false` (normal startup) — deserialization errors at the tail are silently swallowed; the dry-replay offset is the last safe commit

This lets the database recover from a crash that left a partial record at the end of the WAL.

## Compatibility Check

The WAL header stores the `databaseID` (a UUID stored in `DatabaseHeader`). On replay, the replayer verifies:

```cpp
if (walHeader.databaseID != databaseHeader.databaseID):
    throw RuntimeException("WAL file belongs to a different database")
```

This prevents accidentally replaying a WAL from a different database into the current one.

The replayer also checks `enableChecksums` consistency:

```
"The database you are trying to open was serialized with enableChecksums=true
but you are trying to open it with enableChecksums=false."
```

## Related Files

- `src/storage/wal/local_wal.cpp` — per-TX in-memory WAL accumulator
- `src/storage/wal/wal.cpp` — shared on-disk WAL, `logCommittedWAL()`, file rotation
- `src/storage/wal/wal_replayer.cpp` — startup replay, dry-replay, truncation
- `src/include/storage/wal/wal_record_type.h` — `WALRecordType` enum
- `src/include/storage/wal/record/` — one header per WAL record type
- `src/include/storage/wal/checksum_writer.h`, `checksum_reader.h` — CRC machinery
- `src/storage/checkpointer.cpp` — WAL rotation during checkpoint
