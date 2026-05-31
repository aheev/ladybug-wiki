# JSON Extension

**Source tree:** `extension/json/src/`  
**Extension name constant:** `JsonExtension::EXTENSION_NAME` (`"json"`)  
**Namespace:** `lbug::json_extension`

---

## Overview

The `JSON` extension adds comprehensive JSON handling to LadybugDB:

- A `JSON` logical type (backed in core, not registered by the extension itself)
- A `JSON_SCAN` table function for reading JSON files
- A `COPY_JSON` export function
- Scalar functions for creation, extraction, transformation, and introspection
- Cast functions for converting between JSON and native Ladybug types

The extension uses [yyjson](https://github.com/ibireme/yyjson) as its JSON parsing library with a custom allocator that maps allocations to Ladybug's `InMemOverflowBuffer` / `MemoryManager`.

---

## Registered Functions

### Creation functions

| Function | Aliases | Description |
|---|---|---|
| `to_json(any)` | `json_quote`, `array_to_json`, `row_to_json` | Convert any Ladybug value to its JSON text representation |
| `cast_to_json(string)` | — | Parse a STRING and cast it to the JSON type |
| `json_array(val, …)` | — | Build a JSON array from zero or more arguments |
| `json_object(key, val, …)` | — | Build a JSON object from alternating key/value arguments |
| `json_merge_patch(json1, json2)` | — | Merge two JSON objects using JSON Merge Patch (RFC 7396) |

### Extraction functions

| Function | Description |
|---|---|
| `json_extract(json, path)` | Extract a value from a JSON document using a JSONPath expression |

### Scalar / introspection functions

| Function | Description |
|---|---|
| `json_array_length(json)` | Return the number of elements in a JSON array |
| `json_contains(json, needle)` | Return whether `needle` appears anywhere in `json` |
| `json_keys(json)` | Return the top-level keys of a JSON object as `LIST(STRING)` |
| `json_structure(json)` | Return a JSON schema-like structure description of the value |
| `json_type(json)` | Return the JSON type as a string (`"object"`, `"array"`, `"string"`, etc.) |
| `json_valid(json)` | Return `true` if the input is valid JSON |
| `json(json)` | Minify / normalise a JSON string (removes whitespace) |

### Export function

| Function | Description |
|---|---|
| `COPY_JSON` | Export query results to a JSON file (registered as an export function) |

### Table function

| Function | Description |
|---|---|
| `JSON_SCAN(path, …)` | Read a local JSON file and return its records as rows |

---

## `JSON_SCAN` — Reading JSON Files

### Syntax

```cypher
LOAD FROM 'data.json' RETURN *;

-- With explicit options
LOAD FROM 'data.json' (FORMAT = 'array', MAXIMUM_DEPTH = 5) RETURN *;

-- Via the table function directly
CALL JSON_SCAN('data.json') RETURN *;
```

### Options

| Option | Type | Default | Allowed values | Description |
|---|---|---|---|---|
| `FORMAT` | STRING | `'AUTO'` | `'AUTO'`, `'ARRAY'`, `'UNSTRUCTURED'` | How JSON records are delimited in the file |
| `MAXIMUM_DEPTH` | INT64 | 10 | any integer | Maximum nesting depth for schema auto-detection |
| `SAMPLE_SIZE` | INT64 | 2048 | any integer | Number of values sampled for schema auto-detection |
| `AUTO_DETECT` | BOOL | `true` | `true`, `false` | Whether to auto-detect schema from file content |
| `IGNORE_ERRORS` | BOOL | `false` | `true`, `false` | Skip malformed records instead of throwing |

### Format modes

| `FORMAT` value | JSON layout |
|---|---|
| `AUTO` | Automatically detect layout from file content |
| `ARRAY` | File is one top-level JSON array: `[{…}, {…}, …]` |
| `UNSTRUCTURED` | One JSON value after another; newlines may occur anywhere |
| `NEWLINE_DELIMITED` | NDJSON / JSON Lines: one value per line (detected automatically by `AUTO`) |

### Buffer and size constants

| Constant | Value | Description |
|---|---|---|
| `MAXIMUM_OBJECT_SIZE` | 16 777 216 (16 MB) | Maximum size of a single JSON object |
| `SCAN_BUFFER_CAPACITY` | 33 554 432 (32 MB) | Read buffer capacity (2 × `MAXIMUM_OBJECT_SIZE`) |
| `DEFAULT_JSON_DETECT_DEPTH` | 10 | Default schema detection depth |
| `DEFAULT_JSON_DETECT_BREADTH` | 2048 | Default schema detection sample size |

### Schema auto-detection

When `AUTO_DETECT = true`, the scan probes the first `SAMPLE_SIZE` values up to `MAXIMUM_DEPTH` levels of nesting. Object fields become columns. Nested objects and arrays map to `STRUCT` and `LIST` columns respectively.

When `AUTO_DETECT = false`, the function returns all records as a single `JSON`-typed column named `json`.

### Error handling and warnings

Parse errors are tracked per-record. Each error captures:
- `filePath` — the source file name
- `lineNumber` — estimated line number within the file
- `skippedLineOrRecord` — the raw JSON text that failed to parse (reconstructed from `startByteOffset`/`endByteOffset`)
- `message` — the yyjson error message

With `IGNORE_ERRORS = true`, parse failures are recorded as warnings (accessible via `CALL show_warnings()`) and the record is skipped. Without it, the first error throws immediately.

### Internals

**`BufferedJsonReader`:** Manages file I/O through Ladybug's `VirtualFileSystem` (so `JSON_SCAN` works with remote files via the `httpfs` extension). Internally maintains a `bufferMap` of `JsonScanBufferHandle` entries — each a named `MemoryBuffer` plus an atomic reader count.

**`JSONScanLocalState`:** Each worker thread holds one local state with:
- `docs[]` — a fixed array of `yyjson_doc*` pointers (up to `DEFAULT_VECTOR_CAPACITY` documents per chunk)
- A `JSONAllocator` backed by the thread's `MemoryManager`
- A `reconstructBuffer` for cross-buffer record reconstruction (records that span two read windows)

**Parsing flags:**

```cpp
READ_FLAG       = YYJSON_READ_ALLOW_INF_AND_NAN | YYJSON_READ_ALLOW_TRAILING_COMMAS
READ_STOP_FLAG  = READ_FLAG | YYJSON_READ_STOP_WHEN_DONE
READ_INSITU_FLAG= READ_STOP_FLAG | YYJSON_READ_INSITU
WRITE_FLAG      = YYJSON_WRITE_ALLOW_INF_AND_NAN
```

The scanner accepts `Infinity`, `-Infinity`, `NaN`, and trailing commas in JSON input.

---

## `COPY_JSON` — Exporting to JSON

```cypher
COPY (MATCH (n:Person) RETURN n.name, n.age) TO 'people.json';
```

`COPY_JSON` is registered as an **export** function via `ExtensionUtils::addExportFunc<JsonExportFunction>(db)`. The function name in the engine is `COPY_JSON`.

---

## JSON Scalar Functions — Detailed Reference

### `to_json` / `json_quote` / `array_to_json` / `row_to_json`

Converts any Ladybug value to its JSON string representation. All four names point to the same implementation.

```cypher
RETURN to_json([1, 2, 3]);              -- '[1,2,3]'
RETURN json_quote('hello');             -- '"hello"'
RETURN array_to_json([true, false]);    -- '[true,false]'
RETURN row_to_json({name: 'Alice'});    -- '{"name":"Alice"}'
```

### `cast_to_json`

Parses a string as JSON and returns the typed `JSON` value. Throws if the input is not valid JSON.

```cypher
RETURN cast_to_json('{"a": 1}');   -- JSON typed value
```

### `json_array`

```cypher
RETURN json_array(1, 'two', true);   -- '[1,"two",true]'
RETURN json_array();                 -- '[]'
```

### `json_object`

```cypher
RETURN json_object('name', 'Alice', 'age', 30);   -- '{"name":"Alice","age":30}'
```

Key-value pairs must be alternating arguments. An odd number of arguments throws at bind time.

### `json_merge_patch`

Implements [RFC 7396 JSON Merge Patch](https://datatracker.ietf.org/doc/html/rfc7396).

```cypher
RETURN json_merge_patch('{"a":1,"b":2}', '{"b":null,"c":3}');
-- '{"a":1,"c":3}'   (b removed, c added)
```

### `json_extract`

```cypher
RETURN json_extract('{"user":{"name":"Alice"}}', '$.user.name');   -- '"Alice"'
RETURN json_extract('{"ids":[10,20,30]}', '$.ids[1]');              -- '20'
```

Returns `NULL` when the path does not exist in the document.

### `json_array_length`

```cypher
RETURN json_array_length('[1,2,3]');   -- 3
RETURN json_array_length('{}');        -- NULL (not an array)
```

### `json_contains`

```cypher
RETURN json_contains('{"a":1}', '1');        -- true  (value exists)
RETURN json_contains('[1,2,3]', '4');        -- false
```

### `json_keys`

```cypher
RETURN json_keys('{"a":1,"b":2}');   -- ['a','b']
RETURN json_keys('[1,2]');            -- NULL (not an object)
```

### `json_structure`

```cypher
RETURN json_structure('[{"name":"Alice","age":30},{"name":"Bob","age":25}]');
-- '{"name":"VARCHAR","age":"BIGINT"}'  (inferred schema)
```

Returns a JSON-encoded schema derived from the sample. Useful for checking what `AUTO_DETECT` would infer.

### `json_type`

```cypher
RETURN json_type('{"a":1}');    -- 'OBJECT'
RETURN json_type('[1,2]');      -- 'ARRAY'
RETURN json_type('"hello"');    -- 'STRING'
RETURN json_type('42');         -- 'INTEGER'
RETURN json_type('3.14');       -- 'DOUBLE'
RETURN json_type('true');       -- 'BOOLEAN'
RETURN json_type('null');       -- 'NULL'
```

### `json_valid`

```cypher
RETURN json_valid('{"a":1}');   -- true
RETURN json_valid('{bad json}');-- false
```

Returns `false` for any parse error. Does not throw.

### `json` (minify)

```cypher
RETURN json('{ "name" :  "Alice" , "age" :  30 }');
-- '{"name":"Alice","age":30}'
```

Parses and re-serialises the JSON, stripping all unnecessary whitespace. The function name is `"json"` (lowercase).

---

## Custom yyjson Allocator

The extension uses yyjson's pluggable allocator API to route all JSON parsing allocations through Ladybug's `MemoryManager`:

```cpp
class JSONAllocator {
    common::InMemOverflowBuffer overflowBuffer;
    yyjson_alc yyjsonAlc;   // { .malloc=allocate, .realloc=reallocate, .free=free }
};
```

- `allocate`: delegates to `overflowBuffer.allocateSpace(size)`.
- `reallocate`: allocates new memory and `memcpy`s the old block (since `InMemOverflowBuffer` does not support in-place realloc).
- `free`: no-op (overflow buffer uses arena-style deallocation).

This avoids `malloc` / `free` overhead during parsing and integrates JSON memory usage with the query-engine memory accounting.

---

## Integration Notes

1. **Remote files:** `JSON_SCAN` opens files through `VirtualFileSystem`, so it works with `s3://`, `https://`, `gcs://`, and `xet://` paths when the `httpfs` extension is also loaded.

2. **Parallel scan:** `JSONScanSharedState` coordinates access to the `BufferedJsonReader` under a `std::mutex`. Multiple worker threads can each hold a `JSONScanLocalState` and call `readNext()` concurrently; the reader lock serialises buffer assignments while individual buffer parsing is thread-local.

3. **Cross-buffer records:** If a JSON object spans the boundary between two read buffers, `reconstructFirstObject()` copies the tail of the first buffer and the head of the second into the `reconstructBuffer` so it can be parsed as a contiguous byte range.

4. **Large objects:** Objects larger than `MAXIMUM_OBJECT_SIZE = 16 MB` cause a parse error. There is no streaming parser for very large individual JSON values.

5. **NDJSON detection:** With `FORMAT = 'AUTO'`, the scanner sniffs the first non-whitespace character. A `[` character causes it to switch to `ARRAY` mode; otherwise it defaults to `NEWLINE_DELIMITED` / `UNSTRUCTURED` heuristics.
