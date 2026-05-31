# File System Subsystem

This page documents LadybugDB's file-system abstraction, local-file implementation, virtual dispatch layer, compressed-file handling, gzip reader, and the serializer classes that sit directly on top of `FileInfo`.

## Scope and primary source files

- `src/include/common/file_system/file_system.h`
- `src/include/common/file_system/file_info.h`
- `src/include/common/file_system/local_file_system.h`
- `src/include/common/file_system/compressed_file_system.h`
- `src/include/common/file_system/gzip_file_system.h`
- `src/include/common/file_system/virtual_file_system.h`
- `src/common/file_system/file_system.cpp`
- `src/common/file_system/file_info.cpp`
- `src/common/file_system/local_file_system.cpp`
- `src/common/file_system/compressed_file_system.cpp`
- `src/common/file_system/gzip_file_system.cpp`
- `src/common/file_system/virtual_file_system.cpp`
- `src/include/common/serializer/serializer.h`
- `src/common/serializer/serializer.cpp`
- `src/include/common/serializer/deserializer.h`
- `src/common/serializer/deserializer.cpp`
- `src/include/common/serializer/buffered_file.h`
- `src/common/serializer/buffered_file.cpp`
- `src/main/database.cpp`
- `src/storage/file_handle.cpp`
- `src/storage/wal/wal.cpp`
- `extension/httpfs/src/httpfs_extension.cpp`
- `extension/httpfs/src/httpfs.cpp`
- `extension/httpfs/src/http_config.cpp`
- `extension/httpfs/src/s3fs.cpp`
- `extension/httpfs/src/s3fs_config.cpp`
- `extension/azure/src/main/azure_extension.cpp`
- `extension/azure/src/file_system/azure_file_system.cpp`

## Architecture overview

The subsystem is layered like this:

1. **`FileSystem`**
   - abstract filesystem capability interface
2. **`FileInfo`**
   - opened-handle wrapper that delegates back into the filesystem object
3. **`LocalFileSystem`**
   - native POSIX/Windows filesystem implementation
4. **`CompressedFileSystem`**
   - sequential decompression wrapper over another `FileInfo`
5. **`GZipFileSystem`**
   - gzip-specific implementation using miniz
6. **`VirtualFileSystem`**
   - dispatch layer that chooses local vs registered extension filesystems and optional compression wrappers

Higher layers like:

- `Database`
- `BufferManager`
- `FileHandle`
- `WAL`
- serializer readers/writers

all consume this abstraction rather than calling POSIX APIs directly.

## `FileSystem`

`FileSystem` is the abstract base interface.
It stores only one data member:

- `dbPath`

The database path matters because the local filesystem uses it when enforcing deletion safety.

### Core responsibilities

A concrete filesystem can provide:

- `openFile(...)`
- `glob(...)`
- file replacement and copy operations
- directory creation
- existence checks
- path expansion
- raw read/write/seek/truncate primitives
- fsync/sync behavior
- optional function-based file handling for table scans

### Default behavior

Many base-class methods intentionally call `UNREACHABLE_CODE`.
This is not a convenience class with partial functionality.
Implementations are expected to override the operations they claim to support.

### Path helpers

`FileSystem` also provides static helpers:

- `joinPath(base, part)` -> simple `base + "/" + part`
- `getFileExtension(path)`
- `isCompressedFile(path)`
- `getFileName(path)`

`getFileExtension(path)` has one subtle behavior:

- if the file is compressed, it returns the extension of the *stem* rather than `.gz`

Example:

- `file.csv.gz` -> extension becomes `.csv`

That is used by `VirtualFileSystem` when deciding whether compressed input is supported.

## File flags and open flags

`FileFlags` currently defines:

- `READ_ONLY`
- `WRITE`
- `CREATE_IF_NOT_EXISTS`
- `CREATE_AND_TRUNCATE_IF_EXISTS`
- `TEMPORARY`
- Windows-only `BINARY`

`FileOpenFlags` bundles:

- integer `flags`
- `FileLockType lockType`
- `FileCompressionType compressionType`

Supported compression enum values are:

- `AUTO_DETECT`
- `UNCOMPRESSED`
- `GZIP`
- `ZSTD`

Only gzip is actually wired up in the current VFS implementation.

## `FileInfo`

`FileInfo` is the opened-handle façade.
It stores:

- immutable `path`
- `FileSystem* fileSystem`

All operations simply delegate back to the filesystem:

- `getFileSize()`
- `readFromFile(...)`
- `readFile(...)`
- `writeFile(...)`
- `syncFile()`
- `seek(...)`
- `reset()`
- `truncate(...)`
- `canPerformSeek()`

This design keeps polymorphism at the filesystem layer rather than on every handle method.

## `LocalFileSystem`

`LocalFileSystem` is the concrete filesystem for ordinary local paths.

### `LocalFileInfo`

Platform-specific payload:

- POSIX: `fd`
- Windows: `handle`

Destructor behavior:

- closes the fd or handle if valid

### Open-flag validation

A static helper validates combinations before opening:

- at least read or write must be set
- create flags require write mode
- `CREATE_IF_NOT_EXISTS` and `CREATE_AND_TRUNCATE_IF_EXISTS` cannot be combined

### Opening files

`openFile(path, flags, context)` does the following:

1. expands `~` via `expandPath(...)`
2. translates logical flags to OS flags
3. opens the file
4. optionally applies a file lock
5. returns a `LocalFileInfo`

### Locking behavior

On POSIX:

- uses `fcntl(..., F_SETLK, ...)`
- read locks use `F_RDLCK`
- write locks use `F_WRLCK`

If locking fails due to `EAGAIN` or `EACCES`, LadybugDB tries `F_GETLK` to report the owning PID in the error message.
The thrown message also points users to the concurrency documentation URL.

On Windows:

- uses `LockFileEx`
- read locks are non-exclusive
- write locks add `LOCKFILE_EXCLUSIVE_LOCK`

### Glob behavior

`LocalFileSystem::glob(context, path)` supports several path forms.

#### Absolute path

If the path starts with `/` or a Windows drive prefix, it globs it directly.

#### Home-relative path

If the path starts with `~`, it expands via `HomeDirectorySetting` from the client context.

#### Relative path

The implementation first tries `glob::glob(path)` directly.
If that finds nothing, it consults the `file_search_path` setting from the client context and tries each search path prefix.

This means local relative-path resolution is split between:

- the process working directory
- configured search paths

### Rename/copy/overwrite

- `renameFile()` uses `std::filesystem::rename`
- `copyFile()` copies only if the source exists and does not overwrite the destination
- `overwriteFile()` copies only if both source and destination exist and uses overwrite mode

### Directory creation

`createDir(dir)`:

- errors if the directory already exists
- strips a trailing slash because of a documented `std::filesystem::create_directories` issue
- throws descriptive `IOException`s on failure

### Deletion safety whitelist

`removeFileIfExists(path, context)` is intentionally restrictive.
It will only delete a path if one of these is true:

- the path is an allowed database-sidecar path according to `isAllowedDeletionPath(...)`
- the path is inside the extension directory resolved from the client context

The allowed sidecar logic recognizes patterns like:

- `db.lbdb.wal`
- `db.lbdb.shadow`
- `db.lbdb.tmp`
- `db.lbdb.lock`
- `db.lbdb.checkpoint`
- graph/copy sidecars derived from the database name
- graph database files like `db.<graph>.lbdb`

This is a real safety boundary, not just a convenience check.

### Existence checks

- `fileOrPathExists()` uses `std::filesystem::exists`
- `fileExists()` is stricter and checks that the path is a regular file

### Local-vs-remote detection

`isLocalPath(path)` returns false for prefixes:

- `s3://`
- `gs://`
- `gcs://`
- `http://`
- `https://`
- `az://`
- `abfss://`
- `xet://`

Everything else is treated as local.

### Read path

`readFromFile(fileInfo, buffer, numBytes, position)` uses positional reads:

- POSIX: `pread`
- Windows: `ReadFile` with `OVERLAPPED`

This is important because it avoids mutating the handle's current offset during random access.

`readFile(fileInfo, buf, nbyte)` uses sequential reads:

- POSIX: `read`
- Windows: `ReadFile` without explicit overlap

### Write path

`writeFile(...)` uses positional writes:

- POSIX: `pwrite`
- Windows: `WriteFile` with `OVERLAPPED`

Large writes are split into chunks of at most `1 << 30` bytes.
That is a hardcoded 1 GiB per iteration.

### Sync behavior

`syncFile(...)` is platform aware:

- Windows: `FlushFileBuffers`
- macOS with support: attempts `F_FULLFSYNC` first
- otherwise prefers `fdatasync` if available, else `fsync`

The macOS path is especially deliberate.
The comment says `F_FULLFSYNC` is required there to guarantee durability past power failures.

### Seek, truncate, size

- `seek()` delegates to `lseek` or `SetFilePointerEx`
- `truncate()` delegates to `ftruncate` or `SetEndOfFile`
- `getFileSize()` uses `fstat` or `GetFileSizeEx`

## `CompressedFileSystem`

`CompressedFileSystem` is not a standalone filesystem.
It wraps another already-opened `FileInfo` and presents a sequential decompressed read stream.

### Important consequences

- random access is not supported
- writes are not supported
- seek is not supported
- `readFromFile(positioned)` throws immediately

`canPerformSeek()` returns `false`.

### `CompressedFileInfo`

This handle stores:

- reference to the compressed filesystem
- owned child `FileInfo`
- `StreamData`
- `currentPos`
- `stream_wrapper`

`StreamData` contains both compressed-input and decompressed-output buffers plus start/end cursors.

### Initialization flow

`CompressedFileInfo::initialize()`:

1. closes any previous stream
2. allocates input and output buffers sized by the concrete compression implementation
3. resets cursor pointers
4. resets `currentPos`
5. creates a new stream wrapper
6. calls `stream_wrapper->initialize(*this)`

### Read flow

`readData(buffer, numBytes)` loops until either:

- the requested number of decompressed bytes have been produced
- the compressed stream ends

It first consumes any already-decoded bytes from the output buffer.
Then it refreshes or refills the input buffer as needed.
Then it calls `stream_wrapper->read(streamData)` to decode more output.

If the wrapper signals `finished`, the stream is reset.

### File size and sync behavior

`getFileSize()` returns the size of the **compressed child file**, not the decompressed byte length.
`syncFile()` simply delegates to the child file.

## `GZipFileSystem`

`GZipFileSystem` is the only built-in compressed reader currently registered by `VirtualFileSystem`.
It uses miniz.

### Buffer sizing

Both input and output buffer sizes are fixed to:

- `1 << 15`
- 32 KiB

### Gzip validation

The implementation validates:

- magic bytes `0x1F 0x8B`
- compression method `DEFLATE`
- absence of unsupported flags such as ascii, multipart flag, comment, or encrypt flag

It also handles optional header sections:

- extra field
- original file name

### Multi-member gzip support

One of the more interesting implementation details is support for concatenated gzip members.
When miniz returns `MZ_STREAM_END`, the stream marks `refresh = true`.
On the next read cycle it:

- skips the 8-byte footer
- validates the next member header if present
- reinitializes the miniz inflate state
- continues decoding

So LadybugDB can read gzip files containing multiple concatenated members.

### Important limitation

This layer only supports **reading** compressed files.
No compressed write path exists here.

## `VirtualFileSystem`

`VirtualFileSystem` is the main filesystem object owned by `Database`.

### Stored members

- `subSystems`
- `defaultFS`
- `compressedFileSystem`

By default:

- `defaultFS` is a `LocalFileSystem`
- `compressedFileSystem[GZIP]` is a `GZipFileSystem`

### Filesystem selection

`findFileSystem(path)` scans registered subsystems in insertion order.
It returns the first filesystem whose `canHandleFile(path)` returns true.
If none match, it falls back to the local default filesystem.

This is the extension hook for remote storage systems.

### File opening flow

`openFile(path, flags, context)`:

1. resolves compression mode
2. finds the responsible filesystem
3. opens the underlying file
4. if uncompressed, returns the handle directly
5. otherwise wraps it in a compressed reader

### Compression restrictions

Current explicit restrictions in `openFile(...)`:

- writing to compressed files is rejected
- only files whose *logical extension* is `.csv` can be read through the built-in compression path

Because `getFileExtension()` strips `.gz`, the accepted pattern is effectively things like:

- `*.csv.gz`
- `*.csv.gzip`

The error message says:

- `Lbug currently only supports reading from compressed csv files.`

### Delegated operations

`VirtualFileSystem` delegates most operations to the responsible underlying filesystem:

- `glob`
- `overwriteFile`
- `createDir`
- `removeFileIfExists`
- `fileOrPathExists`
- `expandPath`
- `syncFile`
- `handleFileViaFunction`
- `getHandleFunction`

`renameFile()` is slightly different:

- it always uses `defaultFS`

### Cleanup

`cleanUP(context)` calls `cleanUP` on every registered subsystem and then on the default filesystem.
This is the shutdown hook for extension-provided filesystems.

## Path resolution helpers

`VirtualFileSystem::resolvePath(context, path)` implements LadybugDB's higher-level path lookup behavior.

It does the following:

1. if there is no context or no VFS, return the original path
2. try `glob(context, path)` directly
3. if that succeeds, return the first match
4. if the path is not relative, return it unchanged
5. otherwise inspect the client setting `fileSearchPath`
6. for each search path entry that contains `://`, glob the joined remote path
7. return the first remote match if any
8. otherwise return the original path

Two helper rules matter here:

- local relative paths are handled by local glob/search-path logic in `LocalFileSystem`
- remote relative paths are handled here by prefixing remote search roots

## Database integration

`Database::initMembers()` creates the VFS early:

- `vfs = std::make_unique<VirtualFileSystem>(databasePath)`

The database also exposes:

- `registerFileSystem(std::unique_ptr<FileSystem> fs)`

That forwards to `VirtualFileSystem::registerFileSystem(...)`.
So extensions can add new filesystem implementations without replacing the default local one.

## Extension-provided remote backends

The current extension tree uses that hook in a few distinct ways.

### `httpfs`

`HttpfsExtension::load(...)` registers:

- `HTTPFileSystem` for `http://` and `https://`
- `XetFileSystem` for `xet://`
- one `S3FileSystem` for `s3://`
- one `S3FileSystem` configured for GCS interoperability mode with `gcs://` and `gs://`

That matches the public docs, which describe `httpfs` as the extension that covers plain HTTP(S) plus S3/GCS-style object storage.
Inside the source tree, the S3/GCS split is data-driven through `S3FileSystemConfig::getAvailableConfigs()` rather than through separate core VFS classes.

### `azure`

The Azure support lives in a separate extension, not inside `httpfs`.
`AzureExtension::load(...)` registers `AzureFileSystem`, and `AzureFileSystem::canHandleFile(...)` accepts:

- `az://`
- `abfss://`

The public docs describe those as Azure Blob Storage and ADLS entry points, and recommend `abfss` for ADLS scans.
The current source takes a scan-function-oriented approach: `AzureFileSystem` returns `handleFileViaFunction() = true`, and `getHandleFunction(...)` returns `AzureScanFunction`.
So Azure is present in the VFS registry, but it is not yet a raw byte-addressable filesystem like `LocalFileSystem` or `HTTPFileSystem`; its `read/seek/getFileSize` primitives currently throw `RuntimeException("This feature is not currently supported")`.

## `HTTP_CACHE_FILE` local caching

`httpfs` also adds a filesystem-specific caching option:

- option name: `http_cache_file`
- environment variable: `HTTP_CACHE_FILE`
- default: `false`

`HTTPConfigEnvProvider::setOptionValue(...)` reads the environment variable, parses it to `bool`, and rejects enabling cache files for in-memory databases.
When the option is enabled, `HTTPFileSystem::openFile(...)` and `S3FileSystem::openFile(...)` initialize a cached-file manager before constructing the remote `FileInfo`.

The public docs describe the effect precisely: the first remote access populates a local cache file, later accesses in the same transaction can reuse it, and repeated scans of the same remote file become much cheaper.
That behavior also explains why `VirtualFileSystem::cleanUP(context)` matters for remote backends: cleanup is where registered subsystems get a chance to tear down transaction-scoped cached state.

## Storage integration: `FileHandle`

Persistent storage files are opened through the VFS in `FileHandle::constructPersistentFileHandle()`.

Behavior:

- read-only files request `READ_ONLY` plus optional read lock
- writable files request `WRITE | READ_ONLY` and may also request `CREATE_IF_NOT_EXISTS`
- lock type becomes read or write lock depending on file role

After opening, `FileHandle` reads file size from `FileInfo` and derives page counts from the page size.

This is where filesystem locking meets the page-based buffer manager.

## WAL integration

The write-ahead log also sits directly on top of the VFS.

### Initialization

`WAL` stores:

- `walPath`
- `checkpointWalPath`
- `inMemory`
- `readOnly`
- `VirtualFileSystem* vfs`
- checksum flag

### Important filesystem operations

- appending WAL records opens the WAL path through the VFS
- rotation renames `walPath` to `checkpointWalPath`
- clearing removes files through the VFS deletion whitelist
- file-size queries go through `FileInfo::getFileSize()`

### Append-only semantics

When `WAL::initWriter()` opens the WAL file, it sets the buffered writer's file offset to the current file size.
The source comment is explicit:

- WAL must be append-only
- old unreplayed records must not be overwritten

## Buffered file reader/writer

These classes are the immediate bridge from serializer code to `FileInfo`.

### `BufferedFileWriter`

Key points:

- internal buffer size equals `LBUG_PAGE_SIZE`
- small writes accumulate in memory
- writes larger than the buffer flush first and then bypass buffering
- destructor flushes automatically
- `clear()` truncates the file to zero and resets offsets
- `sync()` delegates to `FileInfo::syncFile()`
- `setFileOffset()` is used by WAL append logic after reopening an existing file

### `BufferedFileReader`

Key points:

- also uses `LBUG_PAGE_SIZE` buffering
- reads large blocks directly from the file if requested size exceeds the buffer
- `readNextPage()` throws if asked to read past end-of-file
- `getReadOffset()` reports logical position accounting for buffered bytes

## `Serializer` and `Deserializer`

These generic object serializers are thin wrappers over abstract `Writer` and `Reader` objects.
When file-backed, those are typically `BufferedFileWriter` and `BufferedFileReader`.

### `Serializer`

Important features:

- trivially-destructible values are written by raw byte copy
- `std::string` is serialized as length + bytes
- vectors, arrays, sets, maps, and pointer containers have helper templates
- optional debugging markers can be written when debug macros are enabled

### `Deserializer`

Important features:

- mirrors serializer layout
- string is deserialized as length + byte payload
- carries a `storageVersion`
- supports vectors, arrays, sets, maps, and pointer collections
- optional debug validation can assert expected markers

These helpers are used by the catalog, value vectors, values, index metadata, and WAL records.

## Important constraints and gotchas

### Only sequential reads are supported for compressed files

If a caller assumes random access on a compressed `FileInfo`, it will fail.
`CompressedFileSystem::readFromFile(...)` throws immediately.

### The VFS only decompresses CSV today

Having gzip support does not mean arbitrary compressed storage files work.
The current VFS explicitly restricts built-in decompression to compressed CSV input.

### Deletion is intentionally restrictive

Do not treat `removeFileIfExists()` as a general-purpose unlink API.
It is designed to protect users from accidental arbitrary-file deletion.

### `getFileSize()` on compressed handles is the compressed size

If you need decompressed length, this API will not provide it.
The compressed wrapper simply forwards the child file size.

### Remote path resolution is split across layers

- local search-path behavior lives in `LocalFileSystem::glob()`
- remote relative-path behavior lives in `VirtualFileSystem::resolvePath()`

Both matter when debugging file lookup failures.

## Summary

LadybugDB's filesystem subsystem is intentionally small but carefully layered:

- `FileSystem` defines capabilities
- `FileInfo` represents open handles
- `LocalFileSystem` provides safe, locked local I/O
- `VirtualFileSystem` chooses the responsible backend
- `CompressedFileSystem` and `GZipFileSystem` add sequential gzip decoding for CSV inputs
- serializers and WAL code sit directly on top of these abstractions

For most storage bugs, read `virtual_file_system.cpp`, `local_file_system.cpp`, and the relevant caller (`file_handle.cpp` or `wal.cpp`) together.
