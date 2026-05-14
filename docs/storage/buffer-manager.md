# Buffer Manager

**Source files:** `src/storage/buffer_manager/buffer_manager.cpp`, `src/include/storage/buffer_manager/buffer_manager.h`, `src/include/storage/buffer_manager/page_state.h`

## Role

The buffer manager is the **single point of access between in-memory computation and on-disk pages**. Every storage read or write goes through it. It maintains a fixed-size page pool in memory and decides which pages to evict when the pool is full.

## Page State Machine

Each page tracked by the buffer manager has an atomic state packed into a single `uint64_t`:

```
 63..56   55       54..0
┌───────┬──────┬──────────────────────────────────────────────────┐
│ state │dirty │                    version                        │
└───────┴──────┴──────────────────────────────────────────────────┘
```

```cpp
// page_state.h
class PageState {
    static constexpr uint64_t STATE_MASK   = 0xFF00000000000000;
    static constexpr uint64_t DIRTY_MASK   = 0x0080000000000000;
    static constexpr uint64_t VERSION_MASK = 0x00FFFFFFFFFFFFFF;

    // State values:
    static constexpr uint64_t UNLOCKED = 0; // in memory, available
    static constexpr uint64_t LOCKED   = 1; // being read/written
    static constexpr uint64_t MARKED   = 2; // eviction candidate
    static constexpr uint64_t EVICTED  = 3; // not in memory
};
```

State transitions:

```
EVICTED ──pin()──▶ LOCKED ──unpin()──▶ UNLOCKED
                                           │
                                     eviction scan
                                           │
                                        MARKED ──recently accessed──▶ UNLOCKED (second chance)
                                           │
                                     evict()──▶ EVICTED
```

The `version` field is a monotonic counter incremented on every state change. It is used as an **ABA check** — operations that read the version before locking and compare after ensure they haven't raced with an eviction/re-pin cycle.

## Eviction: 2-Hand Clock Algorithm

LadybugDB uses a **circular EvictionQueue** with a 2-hand clock variant:

```cpp
// buffer_manager.h (simplified)
class EvictionQueue {
    std::atomic<EvictionCandidate>[] data;  // circular buffer
    uint64_t insertCursor;                  // where new candidates go
    uint64_t evictionCursor;                // where eviction scan reads

    // Returns next batch of BATCH_SIZE=64 candidates to try
    std::span<EvictionCandidate, 64> next();
};
```

Eviction algorithm:
1. When a new page is pinned and the pool is full, call `evictionQueue.next()` to get a batch of 64 candidates
2. For each candidate:
   - If `MARKED` → evictable: `madvise(MADV_DONTNEED)` (Unix) or `VirtualFree` (Windows), set state to `EVICTED`
   - If `UNLOCKED` → "second chance": set to `MARKED` (will be evictable next round unless accessed)
   - If `LOCKED` → skip (currently in use)
3. If no evictable page found in batch, get next batch and repeat

::: warning WASM variant
`MADV_DONTNEED` is unavailable in WebAssembly. The WASM build (`BM_MALLOC`) uses `free()` + `malloc()` to release/reclaim page memory instead.
:::

## FileHandle — Bridge to OS

`FileHandle` is the abstraction over a single OS file managed by the buffer manager:

```cpp
class FileHandle {
    // Flag bits:
    static constexpr uint8_t isLargePagedMask        = 0b0000'0001;
    static constexpr uint8_t isNewInMemoryTmpFileMask = 0b0000'0010;
    static constexpr uint8_t createIfNotExistsMask    = 0b0000'0100;
    static constexpr uint8_t isReadOnlyMask           = 0b0000'1000;
    static constexpr uint8_t isLockRequiredMask       = 0b1000'0000;

    // Open modes (combinations of flag bits):
    static constexpr uint8_t O_PERSISTENT_FILE_READ_ONLY       = 0b0000'1000;
    static constexpr uint8_t O_PERSISTENT_FILE_CREATE_NOT_EXISTS = 0b0000'0100;
    static constexpr uint8_t O_IN_MEM_TEMP_FILE                = 0b0000'0011;
    static constexpr uint8_t O_PERSISTENT_FILE_IN_MEM          = 0b0000'0010;
    static constexpr uint8_t O_LOCKED_PERSISTENT_FILE          = 0b1000'0000;
};
```

One `FileHandle` per database file (data file, shadow file, WAL, overflow files). It holds:
- `FileInfo` — OS file descriptor, path, size
- `ConcurrentVector<PageState>` — one `PageState` per page in the file
- `VMRegion` — virtual memory region for memory-mapped page slots (Unix)

## Pin / Unpin Protocol

All storage reads follow this protocol:

```cpp
// Read a page:
uint8_t* data = bufferManager.pin(fileHandle, pageIdx, PageReadPolicy::READ_PAGE);
// ... use data ...
bufferManager.unpin(fileHandle, pageIdx);
```

`pin()`:
1. Check if page is `UNLOCKED` → CAS state to `LOCKED`, return existing memory pointer
2. If `EVICTED` → allocate a slot, read from disk, CAS to `LOCKED`
3. If `LOCKED` → spin (another thread is loading the same page)

`unpin()`:
1. CAS state from `LOCKED` to `UNLOCKED`
2. Add to `EvictionQueue` as eviction candidate

## MemoryManager

Separate from the page pool, `MemoryManager` allocates **raw memory buffers** for components that need contiguous memory but don't need page-level management:

- `UndoBuffer` chain — each `UndoMemoryBuffer` starts at `LBUG_PAGE_SIZE` bytes
- In-memory column chunks during bulk load
- Sort / hash spill buffers

```cpp
class MemoryManager {
    std::unique_ptr<MemoryBuffer> allocate(uint64_t size);
    // MemoryBuffer is RAII — released back to pool on destruction
};
```

## Database Header

The data file begins with a `DatabaseHeader` page (always at page 0):

```cpp
struct DatabaseHeader {
    PageRange  catalogPageRange;    // where catalog pages are
    PageRange  metadataPageRange;   // where stats / metadata pages are
    page_idx_t dataFileNumPages;    // total pages in file
    uuid       databaseID;          // unique DB identity (matches WAL)
};
```

Magic bytes `"LBUG"` at file start + `StorageVersionInfo::STORAGE_VERSION_40` verify the format on open.

## Related Files

- `src/storage/buffer_manager/buffer_manager.cpp` — pin/unpin, eviction loop
- `src/include/storage/buffer_manager/page_state.h` — atomic state machine
- `src/storage/buffer_manager/vm_region.cpp` — mmap virtual memory management
- `src/storage/file_handle.cpp` — file open flags, page read/write
- `src/storage/buffer_manager/memory_manager.cpp` — raw buffer allocation
- `src/include/storage/database_header.h` — DatabaseHeader layout
