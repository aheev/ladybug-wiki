# Overflow & String Storage

**Source files:** `src/storage/overflow_file.cpp`, `src/include/storage/overflow_file.h`

## The Problem

Column chunks store fixed-width values efficiently — a column of `INT64` is just a packed array of 8-byte values. Variable-length data (strings, lists, blobs) cannot fit in a fixed-width slot.

LadybugDB uses an **overflow file** as a side-car to each column chunk that contains variable-length data.

## string_t — The In-Memory String Type

```cpp
// common/types/string_t.h
struct string_t {
    // Short strings (<= 12 bytes) stored inline in the struct
    // Long strings store a pointer + length into the overflow file
    union {
        struct { uint32_t len; char prefix[4]; char* ptr; } pointer;
        struct { uint32_t len; char data[12]; }             inlined;
    };

    static constexpr uint32_t SHORT_STR_MAX = 12;
    bool isInlined() const { return len <= SHORT_STR_MAX; }
};
```

Short strings (≤ 12 bytes) never touch the overflow file — they are fully inlined in the column chunk's value buffer. Long strings store only a pointer.

## Overflow File Layout

The overflow file (`ColumnChunk.overflow`) is a separate file handle managed by `OverflowFileHandle`. It is append-only during writes and addressed by byte offset.

```
overflow file bytes:
  offset 0:    [len=5]["Alice"]
  offset 9:    [len=11]["Christopher"]
  offset 24:   [len=18]["Bartholomew James"]
  ...
```

A `string_t` in the main column chunk holds:
```
{ len=11, ptr=0x...9 }   ← points to offset 9 in overflow file
```

At scan time, the `ptr` is resolved through the `OverflowFileHandle` to produce a `string_view`.

## Lists and Nested Types

The same mechanism applies to `LIST` columns. A list value in the main column chunk stores:
```cpp
struct list_entry_t {
    offset_t offset;  // byte offset into overflow file
    uint64_t size;    // number of list elements
};
```

The overflow file contains the serialized list elements at that offset.

## Read Path

```
ScanNode reads column chunk page
  └─ For STRING column:
       ├─ Short strings: copy from valueBuffer inline data
       └─ Long strings:
            ├─ Read string_t from valueBuffer (8 bytes)
            └─ OverflowFileHandle::read(ptr.ptr, ptr.len)
                 └─ BufferManager::pin(overflowPage)
                      └─ returns pointer into pinned page
```

The overflow file is **buffer-managed** — its pages go through the same page pool as regular data pages, subject to eviction.

## Write Path

```
INSERT (:Person {name: 'Bartholomew James'})
  └─ name is a long string (18 bytes > SHORT_STR_MAX=12)
       ├─ OverflowFileHandle::append(bytes, len) → returns offset
       └─ Store string_t{len=18, ptr=offset} in main column chunk
```

During checkpoint, overflow pages are flushed via the shadow file mechanism like all other modified pages.

## Compression Interaction

Overflow file data is **not compressed** — variable-length data resists the fixed-width compression schemes used for main column data. The main column's `string_t` pointers are themselves compressed (e.g., delta-encoded offsets via bitpacking) since they are monotonically increasing during bulk load.
