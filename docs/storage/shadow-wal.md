# Shadow File & WAL

**Source files:** `src/storage/shadow_file.cpp`, `src/storage/wal/wal.cpp`, `src/include/storage/shadow_file.h`, `src/include/storage/shadow_utils.h`

## Two-Layer Durability Design

LadybugDB uses a **hybrid durability approach** — not a pure WAL system:

| What | How | Why |
|------|-----|-----|
| **Data page writes** | Shadow file | Atomic page swap — no redo log needed |
| **Logical operations** (catalog changes, extension loads) | WAL | Small structured records, must be replayed on recovery |

This split avoids the complexity of a full redo log while still achieving crash safety.

## Shadow File Mechanism

### Concept

When a transaction modifies a page, it **never overwrites the original page directly**. Instead:

1. The modified page is written to a *shadow file* at a shadow page slot
2. The shadow file records a mapping: `originalPageIdx → shadowPageIdx`
3. On **commit**: the shadow pages are atomically copied/remapped to the original file positions
4. On **rollback**: the shadow file is simply discarded

```
Before commit:
  data.lbug:    [page 0: Alice age=30] [page 1: ...] [page 2: ...]
  shadow.lbug:  [shadow 0: Alice age=31]  ← modified page buffered here

After commit (atomic swap):
  data.lbug:    [page 0: Alice age=31] [page 1: ...] [page 2: ...]
  shadow.lbug:  (cleared)
```

### ShadowFile Implementation

```cpp
// shadow_file.h (simplified)
class ShadowFile {
    FileHandle shadowFileHandle;
    // Maps original (fileIdx, pageIdx) → shadow page slot
    unordered_map<PageID, page_idx_t> pageMapping;

    // Called when a page is first dirtied in a write transaction
    page_idx_t getOrCreateShadowPage(FileHandle& originalFile, page_idx_t originalPageIdx);

    // Called at commit: copies all shadow pages back to original files
    void commitChanges();

    // Called at rollback: discards all shadow pages
    void rollback();
};
```

### Atomicity Guarantee

`commitChanges()` writes all shadow pages before updating the original file. The `DatabaseHeader` contains a `databaseID` UUID that the WAL also records — if a crash occurs between shadow write and original update, the WAL `COMMIT_RECORD` has not yet been written, so recovery treats the transaction as incomplete and discards the shadow file.

## WAL Record Types

The WAL records **logical** operations, not page diffs:

```cpp
// src/include/storage/wal/wal_record_type.h
enum class WALRecordType : uint8_t {
    BEGIN_TRANSACTION_RECORD   = 0,
    COMMIT_RECORD              = 1,
    DROP_CATALOG_ENTRY_RECORD  = 2,
    COPY_TABLE_RECORD          = 3,
    LOAD_EXTENSION_RECORD      = 4,
    TABLE_INSERTION_RECORD     = 5,
    NODE_UPDATE_RECORD         = 6,
    REL_UPDATE_RECORD          = 7,
    REL_DELETION_RECORD        = 8,
    REL_DETACH_DELETE_RECORD   = 9,
};
```

Each record is prefixed with its type byte and is self-describing enough to be replayed:

```
WAL file (binary):
  [0x00] BEGIN_TRANSACTION  txID=42
  [0x05] TABLE_INSERTION    tableID=0, nodeOffset=500000
  [0x06] NODE_UPDATE        tableID=0, nodeOffset=0, columnID=1, oldValue=30, newValue=31
  [0x01] COMMIT_RECORD      txID=42
```

## Write Transaction Flow

```
BEGIN TX (txID=42)
│
├─ WAL: append BEGIN_TRANSACTION_RECORD
│
├─ INSERT / UPDATE / DELETE operations:
│    ├─ Data pages → written to ShadowFile (not original file)
│    ├─ UndoBuffer ← records old values for rollback
│    └─ WAL ← records logical operation record
│
└─ COMMIT:
     ├─ WAL: append COMMIT_RECORD, fsync WAL
     ├─ ShadowFile::commitChanges()
     │    └─ copy shadow pages → original data file, fsync
     ├─ LocalStorage flush → persisted to NodeGroups
     └─ TransactionManager: mark TX committed
```

## Recovery on Startup

```
Database::open():
  1. Read DatabaseHeader to get databaseID
  2. Open WAL file, verify databaseID matches
  3. Scan WAL records:
     ├─ If COMMIT_RECORD seen for txID:
     │    └─ replay all records for that txID
     │         (re-apply catalog changes, extension loads, etc.)
     └─ If no COMMIT_RECORD for txID:
          └─ discard — transaction was incomplete at crash
  4. Discard shadow file (shadow pages without a COMMIT are invalid)
  5. Database is consistent at last committed state
```

::: tip Why no redo log for data pages?
The shadow file already guarantees data pages are atomically committed — if the shadow→original swap completes (evidenced by the WAL COMMIT_RECORD), the data is durable. A redo log would be redundant.
:::

## Checkpointer

`Checkpointer` periodically flushes in-memory state to disk, reducing WAL replay time on recovery:

- Flushes `LocalStorage` node groups to columnar disk format
- Clears the WAL (truncates after checkpoint LSN)
- Updates `DatabaseHeader` with new catalog page range
- Triggered when WAL size exceeds a threshold or explicitly via `CHECKPOINT` statement

```cpp
// checkpointer.h
class Checkpointer {
    void checkpoint(ClientContext& context);
    void checkpointNodeTable(NodeTable& table);
    void checkpointRelTable(RelTable& table);
    void checkpointHashIndex(HashIndex& index, PageAllocator& pageAllocator);
};
```

## Related Files

- `src/storage/shadow_file.cpp` — shadow page mapping, commitChanges(), rollback()
- `src/storage/shadow_utils.cpp` — utilities for shadow page read/write
- `src/storage/wal/wal.cpp` — WAL append, fsync, record scanning
- `src/include/storage/wal/record/` — one header per WAL record type
- `src/storage/checkpointer.cpp` — checkpoint logic
- `src/include/storage/database_header.h` — DatabaseHeader, databaseID
