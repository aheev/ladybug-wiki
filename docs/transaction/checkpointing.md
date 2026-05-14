# Checkpointing

**Source files:** `src/storage/checkpointer.cpp`, `src/include/storage/checkpointer.h`

## What is a Checkpoint?

A checkpoint is the process of **flushing all in-memory committed state to disk** and then **truncating the WAL** so that recovery after a crash no longer needs to replay old records. After a checkpoint, the database is fully consistent on disk without the WAL.

## Trigger Conditions

A checkpoint is triggered when any of the following occurs:
1. The WAL file exceeds a configurable size threshold (default: 100 MB)
2. A client explicitly issues `CHECKPOINT`
3. The database is cleanly shut down (auto-checkpoint)

```cpp
// database.cpp
void Database::maybeCheckpoint() {
    if (wal->walFileSize() > walSizeThreshold) {
        checkpointer->checkpoint(*context);
    }
}
```

## Checkpoint Algorithm

```
Checkpointer::checkpoint(context):

  1. Acquire write lock (block new write transactions)
  │
  2. For each modified node table:
  │    └─ NodeTable::checkpoint():
  │         ├─ Flush all LocalNodeTable data → committed NodeGroups
  │         ├─ For each NodeGroup with dirty column chunks:
  │         │    ├─ Compress columns (BitPacking, RLE, Dictionary)
  │         │    └─ Write to shadow file at new page locations
  │         └─ Update NodeGroup metadata (page ranges, compression info)
  │
  3. For each modified relationship table:
  │    └─ RelTable::checkpoint():
  │         ├─ Flush LocalRelTable → committed CSR arrays
  │         └─ Write updated indptr[] and indices[] to shadow file
  │
  4. For each modified hash index:
  │    └─ HashIndex::checkpoint(pageAllocator):
  │         ├─ Merge LocalHashIndex inserts/deletes into committed slots
  │         └─ Write updated hash index pages to shadow file
  │
  5. Commit shadow file → all writes become durable in original data file
  │
  6. Update DatabaseHeader (new catalog page range, metadata page range)
  │
  7. Write CHECKPOINT_RECORD to WAL (marks LSN boundary)
  │
  8. Truncate WAL at checkpoint LSN
  │
  9. Release write lock
```

## Node Group Checkpointing

The most complex part is writing node groups. Each `ColumnChunk` must be:

1. **Analyzed** — scan all values to choose the best compression codec
2. **Compressed** — write to a `CompressedColumnChunk`
3. **Serialized** — page-aligned binary written to shadow file

```cpp
void Checkpointer::checkpointColumnChunk(ColumnChunk& chunk, PageAllocator& allocator) {
    // Step 1: choose codec
    auto codec = CompressionAnalyzer::analyze(chunk);
    // Step 2: compress
    auto compressed = codec->compress(chunk);
    // Step 3: allocate pages and write to shadow
    auto pageRange = allocator.allocate(compressed.numPages());
    compressed.writeTo(shadowFile, pageRange);
    // Step 4: record the page range in NodeGroupMetadata
    chunk.metadata.pageRange = pageRange;
    chunk.metadata.compressionType = codec->type();
}
```

## Hash Index Checkpointing

The hash index must merge local (in-transaction) changes into the committed slot array:

```cpp
void HashIndex::checkpoint(PageAllocator& allocator) {
    // Copy committed slot pages + apply local inserts/deletes
    for (auto& [key, offset] : localInserts) {
        insertIntoSlotArray(key, offset, /* forCheckpoint= */ true);
    }
    for (auto& key : localDeletes) {
        deleteFromSlotArray(key, /* forCheckpoint= */ true);
    }
    // Write all slot pages to shadow file
    for (auto pageIdx = 0; pageIdx < slotArrayPages.size(); pageIdx++) {
        writeSlotPage(shadowFile, allocator, pageIdx);
    }
}
```

## WAL Truncation

After the shadow commit makes all data durable, the WAL is truncated:

```cpp
void WAL::truncateAfterCheckpoint(lsn_t checkpointLSN) {
    // Seek to checkpointLSN in WAL file
    // Truncate file at that position
    // Next write transaction appends after the CHECKPOINT_RECORD
    truncateFile(walFd, checkpointLSN);
}
```

This means recovery only needs to replay records after the checkpoint LSN — all older records are already baked into the data file.

## Recovery After Checkpoint

```
Database::open() with existing checkpoint:
  1. Read DatabaseHeader → verify databaseID
  2. Open WAL → scan from after last CHECKPOINT_RECORD LSN
  3. Replay only the delta (WAL records after last checkpoint)
  4. Discard shadow file (no incomplete writes survived)
  5. Database ready
```

In the best case (clean shutdown + checkpoint), the WAL is empty and startup is near-instant.

## Interaction With Active Transactions

The write lock in step 1 ensures no write transaction is active during checkpoint. Read-only transactions continue running concurrently — they access the committed state and are unaffected by the checkpoint.

## Related Files

- `src/storage/checkpointer.cpp` — main checkpoint algorithm
- `src/include/storage/checkpointer.h` — Checkpointer class declaration
- `src/storage/wal/wal.cpp` — WAL truncation after checkpoint
- `src/storage/table/node_table.cpp` — `NodeTable::checkpoint()`
- `src/storage/index/hash_index.cpp` — `HashIndex::checkpoint()`
- `src/storage/compression/` — column compression codecs
