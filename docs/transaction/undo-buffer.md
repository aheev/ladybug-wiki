# UndoBuffer Chain

**Source files:** `src/include/storage/undo_buffer.h`, `src/storage/undo_buffer.cpp`

## Purpose

The undo buffer records **before-images** of all mutations made by a write transaction. On rollback, the buffer is iterated in reverse to undo each change in LIFO order.

## Memory Layout

```
UndoBuffer (owns a chain of UndoMemoryBuffers):

  ┌─────────────────────────────────────────────┐
  │  UndoMemoryBuffer #0 (LBUG_PAGE_SIZE bytes) │
  │  [header][data0][header][data1][header][...] │
  └──────────────────┬──────────────────────────┘
                     │ next
  ┌──────────────────▼──────────────────────────┐
  │  UndoMemoryBuffer #1 (LBUG_PAGE_SIZE × 2)   │
  │  [header][data0][header][data1][...         │
  └─────────────────────────────────────────────┘
```

Each `UndoMemoryBuffer` starts at `LBUG_PAGE_SIZE` (4096 bytes) and the chain grows: buffer N has capacity `LBUG_PAGE_SIZE << N` bytes. This doubling strategy limits the number of allocations for large transactions.

## Record Format

Each record in the buffer is prefixed by a `UndoRecordHeader`:

```cpp
struct UndoRecordHeader {
    UndoRecordType recordType;  // 1 byte
    uint32_t       dataSize;    // bytes of payload following header
};
```

Payload layout by record type:

```cpp
enum class UndoRecordType : uint8_t {
    CATALOG_ENTRY = 0,     // dropped/created catalog entry
    SEQUENCE_ENTRY = 1,    // sequence counter old value
    // ... reserved 2-5 ...
    UPDATE_INFO = 6,       // column update: old value per row
    INSERT_INFO = 7,       // inserted row: mark as deleted on rollback
    DELETE_INFO = 8,       // deleted row: mark as visible again on rollback
};
```

### UPDATE_INFO payload

```
[nodeOffset: offset_t][columnID: column_id_t][oldValueBytes: uint8_t[dataSize - sizeof(header)]]
```

Rollback: write `oldValueBytes` back to column at `nodeOffset`.

### INSERT_INFO payload

```
[tableID: table_id_t][nodeOffset: offset_t]
```

Rollback: mark node at `nodeOffset` as deleted (set delete bit in validity mask).

### DELETE_INFO payload

```
[tableID: table_id_t][nodeOffset: offset_t]
```

Rollback: clear delete bit at `nodeOffset` (undelete).

### CATALOG_ENTRY payload

```
[catalogEntryType: CatalogEntryType][serializedCatalogEntry: bytes]
```

Rollback: re-insert or re-drop the catalog entry in reverse.

## Appending a Record

```cpp
// undo_buffer.h (simplified)
uint8_t* UndoBuffer::createUndoRecord(uint32_t size) {
    // Find (or allocate) a memory buffer with enough room
    auto& buf = currentBuffer();
    if (buf.remaining() < sizeof(UndoRecordHeader) + size) {
        addNewBuffer();  // allocate next larger buffer
    }
    auto* ptr = buf.currentPos;
    buf.currentPos += sizeof(UndoRecordHeader) + size;
    return ptr + sizeof(UndoRecordHeader);  // caller writes payload here
}
```

Called from `NodeTable::updateColumn()`, `NodeTable::deleteNode()`, `RelTable::deleteRel()`, etc.

## Reverse Iteration (Rollback)

```cpp
// undo_buffer.cpp
void UndoBuffer::reverseIterate(std::function<void(UndoRecord&)> callback) {
    // Collect all buffers in the chain
    vector<UndoMemoryBuffer*> buffers = collectBufferChain();

    // Iterate each buffer backwards (last record first)
    for (auto it = buffers.rbegin(); it != buffers.rend(); ++it) {
        UndoMemoryBuffer* buf = *it;
        // Build reverse index of record offsets within the buffer
        auto offsets = buildOffsetIndex(buf);
        for (auto rit = offsets.rbegin(); rit != offsets.rend(); ++rit) {
            UndoRecord record = readRecord(buf, *rit);
            callback(record);
        }
    }
}
```

Because records are appended in operation order (first-to-last), reversing gives exactly LIFO rollback semantics.

## Commit Path

On commit, the undo buffer is **discarded without iteration**:

```cpp
void UndoBuffer::commit() {
    // Free all memory buffers — nothing to replay
    buffers.clear();
}
```

The committed changes are already in the shadow file / node groups. No further action is needed from the undo buffer.

## GC Interaction

The undo buffer also participates in version GC: once a transaction commits and its `commitID` falls below the watermark (no active reader can see older versions), the `UPDATE_INFO` records for that transaction can be dropped — no reader will ever need to roll back to those old values.

## Related Files

- `src/include/storage/undo_buffer.h` — record types, header struct
- `src/storage/undo_buffer.cpp` — append, reverse iterate
- `src/storage/local_storage/local_node_table.cpp` — calls createUndoRecord()
- `src/include/transaction/transaction.h` — Transaction owns UndoBuffer
