# HTTPFS Extension

**Source tree:** `extension/httpfs/src/`  
**Extension name constant:** `HttpfsExtension::EXTENSION_NAME`  
**Namespace:** `lbug::httpfs_extension`

---

## Overview

The `httpfs` extension provides three virtual file-system drivers that let LadybugDB read (and in the S3 case, also write) files that live outside the local filesystem:

| Driver class | Prefix(es) | Description |
|---|---|---|
| `HTTPFileSystem` | `http://`, `https://` | Plain HTTP range-request reader |
| `S3FileSystem` | `s3://` | AWS S3 compatible storage |
| `S3FileSystem` (GCS) | `gcs://`, `gs://` | Google Cloud Storage via S3 interop |
| `XetFileSystem` | `xet://` | Hugging Face XET / Hub resolver |

All three inherit from the same `common::FileSystem` abstract interface and are registered into the database's `VirtualFileSystem` during `HttpfsExtension::load`.

---

## Architecture

### Registration Path

```
HttpfsExtension::load(ClientContext*)
  ├─ registerFileSystem(db)
  │    ├─ db->registerFileSystem(HTTPFileSystem)
  │    ├─ db->registerFileSystem(XetFileSystem)
  │    └─ for each S3FileSystemConfig:
  │         db->registerFileSystem(S3FileSystem(config))
  ├─ registerExtensionOptions(db)      // S3/GCS auth options + uploader options
  └─ for each S3FileSystemConfig:
       fsConfig.setEnvValue(context)   // read matching env vars → extension options
```

`HTTPConfigEnvProvider::setOptionValue(context)` runs last, reading `HTTP_CACHE_FILE` from the environment.

### Dynamic-load entry point

```cpp
extern "C" void   init(lbug::main::ClientContext* context);
extern "C" const char* name();
```

Both symbols are exported with default visibility on Linux/macOS and `__declspec(dllexport)` on Windows.

---

## HTTPFileSystem

**Header:** `src/include/httpfs.h`

### Class hierarchy

```
common::FileSystem
  └─ HTTPFileSystem           (plain HTTP)
       ├─ S3FileSystem        (AWS SigV4 auth, multipart upload)
       └─ XetFileSystem       (Hugging Face Hub resolver)
```

### `HTTPFileInfo` fields

| Field | Type | Purpose |
|---|---|---|
| `httpClient` | `unique_ptr<httplib::Client>` | Persistent keep-alive connection |
| `length` | `uint64_t` | Remote file size (from HEAD response) |
| `readBuffer` | `uint8_t[]` | Local read-ahead buffer |
| `READ_BUFFER_LEN` | `constexpr uint64_t` | **1 000 000 bytes** (1 MB) |
| `bufferStartPos` / `bufferEndPos` | `uint64_t` | Current window inside the remote file |
| `cachedFileInfo` | `unique_ptr<FileInfo>` | Non-null when `http_cache_file = true` |
| `httpConfig` | `HTTPConfig` | Per-request config (cache flag) |

### Key virtual methods

| Method | Behaviour |
|---|---|
| `openFile` | Creates `HTTPFileInfo`, calls `initMetadata` (HEAD request) |
| `readFromFile` | Serves data from `readBuffer`; issues a Range GET if the requested offset falls outside the current window |
| `seek` | Adjusts `fileOffset`; does **not** issue a network request |
| `glob` | Returns `{path}` — HTTP FS is not listable |
| `canHandleFile` | Returns true for `http://` and `https://` prefixes |
| `syncFile` | No-op (read-only) |
| `cleanUP` | Delegates to `CachedFileManager::cleanUP` |

### Retry logic

```cpp
static std::unique_ptr<HTTPResponse> runRequestWithRetry(
    const std::function<httplib::Result()>& request,
    const std::string& url,
    std::string method,
    const std::function<void()>& retry = {});
```

| Parameter | Default |
|---|---|
| `DEFAULT_TIMEOUT` | 30 000 ms |
| `DEFAULT_RETRIES` | 3 |
| `DEFAULT_RETRY_WAIT_MS` | 100 ms |
| `DEFAULT_RETRY_BACKOFF` | 4× (exponential) |
| `DEFAULT_KEEP_ALIVE` | `true` |

These constants live in `HTTPParams` and are currently hard-coded (`TODO` in source to make them configurable).

---

## File Caching

**Header:** `src/include/cached_file_manager.h`

When the database option `http_cache_file = true`, `HTTPFileSystem::openFile` calls `CachedFileManager::getCachedFileInfo` to download the entire remote file to a local directory before handing a regular `FileInfo` to the rest of the engine.

### Cache layout

```
<extension_local_dir>/httpfs/.cached_files/<transaction_id>/<filename>
```

- Cache is **transaction-scoped**: a separate directory per transaction ID.
- Cache is cleaned up when `cleanUP(context)` is called (typically at transaction end).
- Each segment download uses a 50 MB buffer (`MAX_SEGMENT_SIZE = 50 000 000`).

### Configuration option

| Option name | Type | Default | Env var |
|---|---|---|---|
| `http_cache_file` | `BOOL` | `false` | `HTTP_CACHE_FILE` |

```cypher
CALL db.setExtensionOption('http_cache_file', true);
```

---

## S3FileSystem

**Header:** `src/include/s3fs.h`

`S3FileSystem` extends `HTTPFileSystem` with AWS Signature Version 4 authentication and multi-part upload support.

### Authentication parameters

`S3AuthParams` carries six fields. They are populated from extension options (settable via `CALL db.setExtensionOption(…)` or the matching environment variable):

| Option name | Env var | Default | Confidential |
|---|---|---|---|
| `S3_ACCESS_KEY_ID` | `S3_ACCESS_KEY_ID` | `""` | ✓ |
| `S3_SECRET_ACCESS_KEY` | `S3_SECRET_ACCESS_KEY` | `""` | ✓ |
| `S3_SESSION_TOKEN` | `S3_SESSION_TOKEN` | `""` | ✓ |
| `S3_ENDPOINT` | `S3_ENDPOINT` | `"s3.amazonaws.com"` | ✗ |
| `S3_URL_STYLE` | `S3_URL_STYLE` | `"vhost"` | ✗ |
| `S3_REGION` | `S3_REGION` | `"us-east-1"` | ✗ |

Configuration reads from `ClientContext::getCurrentSetting(…)` which respects `CALL db.setExtensionOption(name, value)` or prior `setEnvValue` injection.

### GCS (S3 interoperability mode)

GCS prefixes `gcs://` and `gs://` use the same `S3FileSystem` class but with a different `S3FileSystemConfig`:

| Option name | Default | Configurable |
|---|---|---|
| `GCS_ACCESS_KEY_ID` | `""` | ✓ |
| `GCS_SECRET_ACCESS_KEY` | `""` | ✓ |
| `GCS_SESSION_TOKEN` | `""` | ✓ |
| `GCS_ENDPOINT` | `"storage.googleapis.com"` | ✗ (fixed) |
| `GCS_URL_STYLE` | `"path"` | ✗ (fixed) |
| `GCS_REGION` | `"us-east-1"` | ✗ (fixed) |

Endpoint and URL style for GCS are pinned and cannot be overridden.

### URL parsing

```cpp
ParsedS3URL S3FileSystem::parseS3URL(std::string url, S3AuthParams& params) const;
```

Returns a `ParsedS3URL` with fields `httpProto`, `prefix`, `host`, `bucket`, `path`, `queryParam`, and `trimmedS3URL`. The `getHTTPURL(httpQueryString)` helper reassembles a plain HTTPS URL for the underlying `HTTPFileSystem` calls.

### Header signing

```cpp
HeaderMap createS3Header(std::string url, std::string query, std::string host,
    std::string service, std::string method, const S3AuthParams& authParams,
    std::string payloadHash = "", std::string contentType = "") const;
```

Implements AWS Signature Version 4. The payload hash for empty bodies is the well-known SHA-256 of the empty string:

```
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

### Glob / listing

`S3FileSystem::glob` calls `AWSListObjectV2::request` which issues `GET /?list-type=2&...` requests with continuation tokens. Results are parsed using the XML tag constants:

```cpp
static constexpr char OPEN_KEY_TAG[]         = "<Key>";
static constexpr char OPEN_PREFIX_TAG[]      = "<Prefix>";
static constexpr char OPEN_CONTINUATION_TAG[]= "<NextContinuationToken>";
```

### Multi-part upload

AWS requires part sizes of **5 MiB – 5 GiB** (`AWS_MINIMUM_PART_SIZE = 5 242 880`).

| Extension option | Type | Default | Purpose |
|---|---|---|---|
| `s3_uploader_max_num_parts_per_file` | `INT64` | `800 000 000 000` | Maximum number of parts per file |
| `s3_uploader_max_filesize` | `INT64` | `10 000` | Maximum file size in MB |
| `s3_uploader_threads_limit` | `INT64` | `50` | Maximum concurrent upload threads |

Upload flow:
1. `S3FileSystem::writeFile` → fills `S3WriteBuffer` entries.
2. Each buffer is flushed with `flushBuffer` which spawns a thread calling `uploadBuffer`.
3. `finalizeMultipartUpload` sends the XML manifest with all part ETags.
4. Each part's ETag is stored in `S3FileInfo::partEtags` for integrity verification.

---

## XetFileSystem (Hugging Face Hub)

**Header:** `src/include/xetfs.h`  
**Prefix:** `xet://`

`XetFileSystem` is read-only (`openFile` throws `IOException` for write flags). It resolves `xet://` paths to Hugging Face `https://huggingface.co/…/resolve/…` URLs by calling `toHuggingFaceURL`.

### URL translation rules

| Input prefix | Mapped to HF URL pattern |
|---|---|
| `xet://huggingface.co/…` | Strips `huggingface.co/` prefix, prepends base URL |
| `xet://hf.co/…` | Strips `hf.co/` prefix |
| `xet://models/<owner>/<repo>/<rev>/<file>` | `huggingface.co/<owner>/<repo>/resolve/<rev>/<file>` |
| `xet://datasets/<owner>/<repo>/…` | `huggingface.co/datasets/<owner>/<repo>/resolve/…` |
| `xet://spaces/<owner>/<repo>/…` | `huggingface.co/spaces/<owner>/<repo>/resolve/…` |
| `xet://<owner>/<repo>/<rev>/<file>` | `huggingface.co/<owner>/<repo>/resolve/<rev>/<file>` |
| `xet://<owner>/<repo>/resolve/<rev>/<file>` | Same (explicit `resolve` supported) |

### Redirect handling

Hugging Face returns `x-linked-size` headers on redirect responses. `XetFileSystem::headRequest` synthesises a synthetic 200 HEAD response containing the `x-linked-size` value as `Content-Length`. Clients following `Location` redirects get the correct file size without an additional round-trip.

`getRangeRequest` follows `Location` redirects recursively before consuming the body.

### Glob

Returns `{path}` unchanged — the path is passed through as-is, routing all reads to `XetFileSystem` after bind-time expansion.

---

## Integration with the Query Engine

The `httpfs` extension does **not** register any table functions or catalog entries. It only registers file-system drivers. Upper layers (e.g. `COPY FROM 's3://…'`, `LOAD FROM 'https://…'`) use the VirtualFileSystem dispatch table which picks the correct driver via `canHandleFile(path)`.

Because `HTTPFileSystem::glob` is essentially a no-op (returns the path unchanged), wildcard file listing over HTTP is not supported. S3 glob is fully supported via the `AWSListObjectV2` listing API.

---

## Known Edge Cases and Caveats

1. **Cache isolation:** The `CachedFileManager` is `mutex`-protected but the cache directory itself is keyed on transaction ID. Concurrent transactions opening the same remote file will download it independently — no de-duplication across transactions.

2. **S3 read buffer size:** The internal `READ_BUFFER_LEN = 1 000 000` bytes means small random-access patterns (e.g. Parquet footer reads) may over-fetch. There is currently no configurable read-ahead size.

3. **GCS endpoint/style are fixed:** `GCS_ENDPOINT` and `GCS_URL_STYLE` are marked `isConfigurable = false`. Calls to `db.setExtensionOption('GCS_ENDPOINT', …)` are silently ignored — they are not registered options.

4. **Retry parameters are hard-coded:** `HTTPParams::DEFAULT_RETRIES = 3`, `DEFAULT_RETRY_WAIT_MS = 100`, `DEFAULT_RETRY_BACKOFF = 4`. A `TODO` comment in the source (`httpfs.h:29`) notes these should become configurable.

5. **Multipart upload ETag race:** Part ETags are stored in `S3FileInfo::partEtags` under `partEtagsLock`. If an upload thread throws, the exception is captured in `uploadException` and re-thrown by `rethrowIOError()`. The upload is not automatically retried at the part level.

6. **XetFileSystem write:** Writing to `xet://` paths is unconditionally rejected with `IOException{"Writing to xet:// URLs is not supported."}`.

7. **SigV4 crypto:** The SHA-256 implementation lives in `crypto.cpp` and is a bespoke standalone implementation (no OpenSSL dependency).
