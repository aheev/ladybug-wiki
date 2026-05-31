# C API Reference

The C API exposes Ladybug through a stable ABI with a flat set of `extern "C"` functions. It is the lowest-level binding and forms the foundation for the Python `capi` backend and other language wrappers. Compile your application against `liblbug` and include `<lbug/lbug.h>` (or the vendored header).

```c
#include "lbug.h"   // or <lbug/lbug.h> when installed system-wide
```

Link flags:

```sh
# Dynamic
cc -o myapp myapp.c -llbug

# Static
cc -o myapp myapp.c /usr/local/lib/liblbug.a -lstdc++ -lm
```

---

## Return convention

Nearly every function returns `lbug_state`:

```c
typedef enum { LbugSuccess = 0, LbugError = 1 } lbug_state;
```

Output parameters are written through pointer arguments. Always check the return value before using output pointer values.

---

## Memory ownership

| Scenario | Who frees |
|----------|-----------|
| `char*` returned by `lbug_query_result_get_error_message`, `lbug_prepared_statement_get_error_message`, `lbug_flat_tuple_to_string`, `lbug_value_to_string`, `lbug_value_get_string`, `lbug_value_get_uuid`, `lbug_value_get_decimal_as_string`, `lbug_node_val_to_string`, `lbug_rel_val_to_string`, `lbug_query_result_to_string`, `lbug_int128_t_to_string` | **Caller** — call `lbug_destroy_string(ptr)` |
| `lbug_value*` from `lbug_value_create_*` and `lbug_value_clone` | **Caller** — call `lbug_value_destroy(val)` |
| `lbug_value*` obtained via `lbug_flat_tuple_get_value` / `lbug_value_get_list_element` / struct/map/node/rel accessors | **Owned by the parent object** — do NOT call `lbug_value_destroy`; `_is_owned_by_cpp = true` |
| `lbug_flat_tuple*` obtained via `lbug_query_result_get_next` | **Owned by the result** (`_is_owned_by_cpp = true`) — do NOT call `lbug_flat_tuple_destroy` |
| `lbug_logical_type` structs on the stack (from `lbug_data_type_create`, `lbug_data_type_clone`) | **Caller** — call `lbug_data_type_destroy` |
| `uint8_t*` blob from `lbug_value_get_blob` | Points into the value's internal storage — valid as long as the `lbug_value` is alive; do NOT free separately |

```c
// Correct string handling:
char* msg = lbug_query_result_get_error_message(&result);
if (msg) {
    fprintf(stderr, "Error: %s\n", msg);
    lbug_destroy_string(msg);
}
```

---

## Structs and types

### `lbug_system_config`

```c
typedef struct {
    uint64_t buffer_pool_size;       // 0 = engine default
    uint64_t max_num_threads;        // 0 = auto
    bool enable_compression;
    bool read_only;
    uint64_t max_db_size;
    bool auto_checkpoint;
    uint64_t checkpoint_threshold;
    bool throw_on_wal_replay_failure;
    bool enable_checksums;
    bool enable_multi_writes;
    bool enable_default_hash_index;
} lbug_system_config;
```

### Opaque handle structs

```c
typedef struct { void* _database;                         } lbug_database;
typedef struct { void* _connection;                       } lbug_connection;
typedef struct { void* _prepared_statement;
                 void* _bound_values;                     } lbug_prepared_statement;
typedef struct { void* _query_result; bool _is_owned_by_cpp; } lbug_query_result;
typedef struct { void* _flat_tuple;   bool _is_owned_by_cpp; } lbug_flat_tuple;
typedef struct { void* _data_type;                        } lbug_logical_type;
typedef struct { void* _value;        bool _is_owned_by_cpp; } lbug_value;
typedef struct { void* _query_summary;                    } lbug_query_summary;
```

### Temporal types

```c
typedef struct { int32_t days;   } lbug_date_t;          // days since epoch
typedef struct { int64_t value;  } lbug_timestamp_t;     // microseconds since epoch
typedef struct { int64_t value;  } lbug_timestamp_ns_t;  // nanoseconds since epoch
typedef struct { int64_t value;  } lbug_timestamp_ms_t;  // milliseconds since epoch
typedef struct { int64_t value;  } lbug_timestamp_sec_t; // seconds since epoch
typedef struct { int64_t value;  } lbug_timestamp_tz_t;  // microseconds since epoch (UTC)
typedef struct { int32_t months; int32_t days; int64_t micros; } lbug_interval_t;
```

### Identity

```c
typedef struct { uint64_t table_id; uint64_t offset; } lbug_internal_id_t;
typedef struct { uint64_t low; int64_t high;           } lbug_int128_t;
```

### `lbug_data_type_id` enum

| Value | Numeric | Cypher type |
|-------|---------|-------------|
| `LBUG_ANY` | 0 | ANY |
| `LBUG_NODE` | 1 | node |
| `LBUG_REL` | 2 | relationship |
| `LBUG_RECURSIVE_REL` | 3 | — |
| `LBUG_SERIAL` | 4 | SERIAL |
| `LBUG_BOOL` | 5 | BOOLEAN |
| `LBUG_INT64` | 6 | INT64 |
| `LBUG_INT32` | 7 | INT32 |
| `LBUG_INT16` | 8 | INT16 |
| `LBUG_INT8` | 9 | INT8 |
| `LBUG_UINT64` | 10 | UINT64 |
| `LBUG_UINT32` | 11 | UINT32 |
| `LBUG_UINT16` | 12 | UINT16 |
| `LBUG_UINT8` | 13 | UINT8 |
| `LBUG_INT128` | 14 | INT128 |
| `LBUG_DOUBLE` | 15 | DOUBLE |
| `LBUG_FLOAT` | 16 | FLOAT |
| `LBUG_DATE` | 17 | DATE |
| `LBUG_INTERVAL` | 18 | INTERVAL |
| `LBUG_FIXED_LIST` | 19 | — |
| `LBUG_TIMESTAMP` | 20 | TIMESTAMP |
| `LBUG_TIMESTAMP_TZ` | 21 | TIMESTAMP WITH TIME ZONE |
| `LBUG_TIMESTAMP_NS` | 22 | TIMESTAMP_NS |
| `LBUG_TIMESTAMP_MS` | 23 | TIMESTAMP_MS |
| `LBUG_TIMESTAMP_SEC` | 24 | TIMESTAMP_S |
| `LBUG_INTERNAL_ID` | 25 | INTERNAL_ID |
| `LBUG_STRING` | 26 | STRING |
| `LBUG_BLOB` | 27 | BLOB |
| `LBUG_LIST` | 28 | LIST |
| `LBUG_STRUCT` | 29 | STRUCT |
| `LBUG_MAP` | 30 | MAP |
| `LBUG_UNION` | 31 | UNION |
| `LBUG_DECIMAL` | 32 | DECIMAL |
| `LBUG_UUID` | 33 | UUID |
| `LBUG_JSON` | 34 | JSON |

---

## Database functions

```c
// Obtain defaults for system_config before customizing fields.
lbug_system_config lbug_default_system_config();

// Open / create a database.
// database_path: filesystem path, or "" for in-memory.
// out_database: caller-allocated lbug_database on the stack.
lbug_state lbug_database_init(const char* database_path,
                               lbug_system_config system_config,
                               lbug_database* out_database);

// Destroy the database. Must be called after all connections are destroyed.
void lbug_database_destroy(lbug_database* database);
```

---

## Connection functions

```c
lbug_state lbug_connection_init(lbug_database* database,
                                 lbug_connection* out_connection);

void lbug_connection_destroy(lbug_connection* connection);

lbug_state lbug_connection_set_max_num_thread_for_exec(lbug_connection* connection,
                                                         uint64_t num_threads);

lbug_state lbug_connection_get_max_num_thread_for_exec(lbug_connection* connection,
                                                         uint64_t* out_num_threads);

lbug_state lbug_connection_query(lbug_connection* connection,
                                  const char* query,
                                  lbug_query_result* out_query_result);

lbug_state lbug_connection_prepare(lbug_connection* connection,
                                    const char* query,
                                    lbug_prepared_statement* out_prepared_statement);

lbug_state lbug_connection_execute(lbug_connection* connection,
                                    lbug_prepared_statement* prepared_statement,
                                    lbug_query_result* out_query_result);

void lbug_connection_interrupt(lbug_connection* connection);

lbug_state lbug_connection_set_query_timeout(lbug_connection* connection,
                                              uint64_t timeout_in_ms);
```

### Arrow memory-backed tables

```c
// Create a node table backed by Arrow arrays (Arrow C Data Interface).
lbug_state lbug_connection_create_arrow_table(
    lbug_connection* connection,
    const char* table_name,
    struct ArrowSchema* schema,
    struct ArrowArray* arrays,
    uint64_t num_arrays,
    lbug_query_result* out_query_result);

// Create a relationship table backed by Arrow arrays.
lbug_state lbug_connection_create_arrow_rel_table(
    lbug_connection* connection,
    const char* table_name,
    struct ArrowSchema* schema,
    struct ArrowArray* arrays,
    uint64_t num_arrays,
    const char* src_table_name,
    const char* dst_table_name,
    lbug_query_result* out_query_result);

// Create a CSR-format relationship table backed by Arrow arrays.
lbug_state lbug_connection_create_arrow_rel_table_csr(
    lbug_connection* connection,
    const char* table_name,
    struct ArrowSchema* indices_schema,
    struct ArrowArray* indices_arrays,
    uint64_t num_indices_arrays,
    struct ArrowSchema* indptr_schema,
    struct ArrowArray* indptr_arrays,
    uint64_t num_indptr_arrays,
    const char* dst_col_name,
    const char* src_table_name,
    const char* dst_table_name,
    lbug_query_result* out_query_result);

lbug_state lbug_connection_drop_arrow_table(
    lbug_connection* connection,
    const char* table_name,
    lbug_query_result* out_query_result);
```

---

## Prepared statement functions

```c
void lbug_prepared_statement_destroy(lbug_prepared_statement* prepared_statement);

bool lbug_prepared_statement_is_success(lbug_prepared_statement* prepared_statement);

bool lbug_prepared_statement_is_read_only(lbug_prepared_statement* prepared_statement);

// Caller must free with lbug_destroy_string().
char* lbug_prepared_statement_get_error_message(
    lbug_prepared_statement* prepared_statement);
```

### Parameter binding

Each `bind_*` function writes the named parameter `$param_name` into the prepared statement's bound-value map. All bindings must be set before calling `lbug_connection_execute`.

```c
lbug_state lbug_prepared_statement_bind_bool(
    lbug_prepared_statement*, const char* param_name, bool value);

lbug_state lbug_prepared_statement_bind_int8(
    lbug_prepared_statement*, const char* param_name, int8_t value);
lbug_state lbug_prepared_statement_bind_int16(
    lbug_prepared_statement*, const char* param_name, int16_t value);
lbug_state lbug_prepared_statement_bind_int32(
    lbug_prepared_statement*, const char* param_name, int32_t value);
lbug_state lbug_prepared_statement_bind_int64(
    lbug_prepared_statement*, const char* param_name, int64_t value);

lbug_state lbug_prepared_statement_bind_uint8(
    lbug_prepared_statement*, const char* param_name, uint8_t value);
lbug_state lbug_prepared_statement_bind_uint16(
    lbug_prepared_statement*, const char* param_name, uint16_t value);
lbug_state lbug_prepared_statement_bind_uint32(
    lbug_prepared_statement*, const char* param_name, uint32_t value);
lbug_state lbug_prepared_statement_bind_uint64(
    lbug_prepared_statement*, const char* param_name, uint64_t value);

lbug_state lbug_prepared_statement_bind_float(
    lbug_prepared_statement*, const char* param_name, float value);
lbug_state lbug_prepared_statement_bind_double(
    lbug_prepared_statement*, const char* param_name, double value);

lbug_state lbug_prepared_statement_bind_date(
    lbug_prepared_statement*, const char* param_name, lbug_date_t value);

lbug_state lbug_prepared_statement_bind_timestamp(
    lbug_prepared_statement*, const char* param_name, lbug_timestamp_t value);
lbug_state lbug_prepared_statement_bind_timestamp_ns(
    lbug_prepared_statement*, const char* param_name, lbug_timestamp_ns_t value);
lbug_state lbug_prepared_statement_bind_timestamp_ms(
    lbug_prepared_statement*, const char* param_name, lbug_timestamp_ms_t value);
lbug_state lbug_prepared_statement_bind_timestamp_sec(
    lbug_prepared_statement*, const char* param_name, lbug_timestamp_sec_t value);
lbug_state lbug_prepared_statement_bind_timestamp_tz(
    lbug_prepared_statement*, const char* param_name, lbug_timestamp_tz_t value);

lbug_state lbug_prepared_statement_bind_interval(
    lbug_prepared_statement*, const char* param_name, lbug_interval_t value);

lbug_state lbug_prepared_statement_bind_string(
    lbug_prepared_statement*, const char* param_name, const char* value);

// Generic: bind any lbug_value* (copies the value; caller still owns original).
lbug_state lbug_prepared_statement_bind_value(
    lbug_prepared_statement*, const char* param_name, lbug_value* value);
```

> **Note**: There is no `bind_blob` function in the current API — use `lbug_prepared_statement_bind_value` with a `lbug_value` created from a hex literal, or use the `BLOB()` Cypher cast function.

---

## Query result functions

```c
void lbug_query_result_destroy(lbug_query_result* query_result);

bool     lbug_query_result_is_success(lbug_query_result* query_result);

// Caller frees with lbug_destroy_string().
char*    lbug_query_result_get_error_message(lbug_query_result* query_result);

uint64_t lbug_query_result_get_num_columns(lbug_query_result* query_result);

// Write column name at index into *out_column_name (heap-allocated; caller frees).
lbug_state lbug_query_result_get_column_name(lbug_query_result* query_result,
                                               uint64_t col_idx,
                                               char** out_column_name);

lbug_state lbug_query_result_get_column_data_type(lbug_query_result* query_result,
                                                    uint64_t col_idx,
                                                    lbug_logical_type* out_type);

uint64_t lbug_query_result_get_num_tuples(lbug_query_result* query_result);

lbug_state lbug_query_result_get_query_summary(lbug_query_result* query_result,
                                                lbug_query_summary* out_query_summary);

// Row iteration:
bool lbug_query_result_has_next(lbug_query_result* query_result);

lbug_state lbug_query_result_get_next(lbug_query_result* query_result,
                                       lbug_flat_tuple* out_flat_tuple);

// Multi-result chaining (e.g., stored procedures):
bool lbug_query_result_has_next_query_result(lbug_query_result* query_result);

lbug_state lbug_query_result_get_next_query_result(lbug_query_result* query_result,
                                                     lbug_query_result* out_query_result);

// Format all rows as a pipe-delimited table string. Caller frees with lbug_destroy_string().
char* lbug_query_result_to_string(lbug_query_result* query_result);

// Reset the row iterator to the beginning.
void lbug_query_result_reset_iterator(lbug_query_result* query_result);
```

### Arrow C Data Interface output

```c
// Populate an ArrowSchema with the schema of the result.
lbug_state lbug_query_result_get_arrow_schema(lbug_query_result* query_result,
                                               struct ArrowSchema* out_schema);

// Populate an ArrowArray with the next chunk_size rows.
// Returns LbugSuccess with an empty array when exhausted.
lbug_state lbug_query_result_get_next_arrow_chunk(lbug_query_result* query_result,
                                                    int64_t chunk_size,
                                                    struct ArrowArray* out_arrow_array);
```

---

## Flat tuple functions

```c
void lbug_flat_tuple_destroy(lbug_flat_tuple* flat_tuple);

// Write the value at column index into *out_value.
// The returned value is owned by the flat_tuple (_is_owned_by_cpp = true).
lbug_state lbug_flat_tuple_get_value(lbug_flat_tuple* flat_tuple,
                                      uint64_t index,
                                      lbug_value* out_value);

// Format as a pipe-delimited string. Caller frees with lbug_destroy_string().
char* lbug_flat_tuple_to_string(lbug_flat_tuple* flat_tuple);
```

> **Ownership note**: `lbug_flat_tuple` instances obtained from `lbug_query_result_get_next` have `_is_owned_by_cpp = true`. Do NOT call `lbug_flat_tuple_destroy` on them — they are freed when the parent `lbug_query_result` is destroyed.

---

## Logical type functions

```c
// Create a logical type. For parameterized types (LIST, ARRAY, STRUCT, MAP, UNION),
// pass child_type with additional metadata; for simple types, pass NULL.
void lbug_data_type_create(lbug_data_type_id id,
                            lbug_logical_type* child_type,
                            uint64_t fixed_num_elements_in_list,
                            lbug_logical_type* out_type);

void lbug_data_type_clone(lbug_logical_type* data_type,
                           lbug_logical_type* out_type);

// Must be called for every lbug_logical_type created on the stack.
void lbug_data_type_destroy(lbug_logical_type* data_type);

bool           lbug_data_type_equals(lbug_logical_type*, lbug_logical_type*);
lbug_data_type_id lbug_data_type_get_id(lbug_logical_type*);

lbug_state lbug_data_type_get_child_type(lbug_logical_type*, lbug_logical_type* out);
lbug_state lbug_data_type_get_num_elements_in_array(lbug_logical_type*, uint64_t* out);
```

---

## Value create functions

All `lbug_value_create_*` functions return a heap-allocated `lbug_value*`. The caller owns the result and must call `lbug_value_destroy` when done.

```c
lbug_value* lbug_value_create_null();
lbug_value* lbug_value_create_null_with_data_type(lbug_logical_type*);
lbug_value* lbug_value_create_default(lbug_logical_type*);

lbug_value* lbug_value_create_bool(bool);
lbug_value* lbug_value_create_int8(int8_t);
lbug_value* lbug_value_create_int16(int16_t);
lbug_value* lbug_value_create_int32(int32_t);
lbug_value* lbug_value_create_int64(int64_t);
lbug_value* lbug_value_create_uint8(uint8_t);
lbug_value* lbug_value_create_uint16(uint16_t);
lbug_value* lbug_value_create_uint32(uint32_t);
lbug_value* lbug_value_create_uint64(uint64_t);
lbug_value* lbug_value_create_int128(lbug_int128_t);
lbug_value* lbug_value_create_float(float);
lbug_value* lbug_value_create_double(double);
lbug_value* lbug_value_create_decimal(const char* val_str,
                                       uint32_t precision,
                                       uint32_t scale);
lbug_value* lbug_value_create_internal_id(lbug_internal_id_t);
lbug_value* lbug_value_create_date(lbug_date_t);
lbug_value* lbug_value_create_timestamp(lbug_timestamp_t);
lbug_value* lbug_value_create_timestamp_ns(lbug_timestamp_ns_t);
lbug_value* lbug_value_create_timestamp_ms(lbug_timestamp_ms_t);
lbug_value* lbug_value_create_timestamp_sec(lbug_timestamp_sec_t);
lbug_value* lbug_value_create_timestamp_tz(lbug_timestamp_tz_t);
lbug_value* lbug_value_create_interval(lbug_interval_t);
lbug_value* lbug_value_create_string(const char*);
lbug_value* lbug_value_create_json(const char*);
lbug_value* lbug_value_create_uuid(const char*);     // UUID string "xxxxxxxx-xxxx-..."

// List value: num_elements elements, each a lbug_value*.
lbug_state lbug_value_create_list(uint64_t num_elements,
                                   lbug_value** elements,
                                   lbug_value** out_value);

// Struct value: field_names and field_values arrays are copied.
lbug_state lbug_value_create_struct(uint64_t num_fields,
                                     const char** field_names,
                                     lbug_value** field_values,
                                     lbug_value** out_value);

// Map value: num_fields key-value pairs.
lbug_state lbug_value_create_map(uint64_t num_fields,
                                  lbug_value** keys,
                                  lbug_value** values,
                                  lbug_value** out_value);

// Deep-copy an existing value (caller owns result).
lbug_value* lbug_value_clone(lbug_value* value);

// Copy src into dst (dst must already be initialized).
void lbug_value_copy(lbug_value* dst, lbug_value* src);

void lbug_value_destroy(lbug_value* value);
```

---

## Value query functions

```c
bool lbug_value_is_null(lbug_value*);
void lbug_value_set_null(lbug_value*, bool is_null);
void lbug_value_get_data_type(lbug_value*, lbug_logical_type* out_type);

lbug_state lbug_value_get_bool(lbug_value*, bool* out);
lbug_state lbug_value_get_int8(lbug_value*, int8_t* out);
lbug_state lbug_value_get_int16(lbug_value*, int16_t* out);
lbug_state lbug_value_get_int32(lbug_value*, int32_t* out);
lbug_state lbug_value_get_int64(lbug_value*, int64_t* out);
lbug_state lbug_value_get_uint8(lbug_value*, uint8_t* out);
lbug_state lbug_value_get_uint16(lbug_value*, uint16_t* out);
lbug_state lbug_value_get_uint32(lbug_value*, uint32_t* out);
lbug_state lbug_value_get_uint64(lbug_value*, uint64_t* out);
lbug_state lbug_value_get_int128(lbug_value*, lbug_int128_t* out);
lbug_state lbug_value_get_float(lbug_value*, float* out);
lbug_state lbug_value_get_double(lbug_value*, double* out);
lbug_state lbug_value_get_internal_id(lbug_value*, lbug_internal_id_t* out);
lbug_state lbug_value_get_date(lbug_value*, lbug_date_t* out);
lbug_state lbug_value_get_timestamp(lbug_value*, lbug_timestamp_t* out);
lbug_state lbug_value_get_timestamp_ns(lbug_value*, lbug_timestamp_ns_t* out);
lbug_state lbug_value_get_timestamp_ms(lbug_value*, lbug_timestamp_ms_t* out);
lbug_state lbug_value_get_timestamp_sec(lbug_value*, lbug_timestamp_sec_t* out);
lbug_state lbug_value_get_timestamp_tz(lbug_value*, lbug_timestamp_tz_t* out);
lbug_state lbug_value_get_interval(lbug_value*, lbug_interval_t* out);

// Caller frees with lbug_destroy_string():
lbug_state lbug_value_get_decimal_as_string(lbug_value*, char** out);
lbug_state lbug_value_get_string(lbug_value*, char** out);
lbug_state lbug_value_get_uuid(lbug_value*, char** out);

// out_result points into the value's internal storage; do NOT free.
// out_length is the byte length of the blob.
lbug_state lbug_value_get_blob(lbug_value*, uint8_t** out_result, uint64_t* out_length);

// Format as a string. Caller frees with lbug_destroy_string().
char* lbug_value_to_string(lbug_value*);
```

### INT128 helpers

```c
lbug_state lbug_int128_t_from_string(const char* str, lbug_int128_t* out);
// Caller frees with lbug_destroy_string():
lbug_state lbug_int128_t_to_string(lbug_int128_t val, char** out);
```

### Nested value accessors

```c
// LIST / ARRAY
lbug_state lbug_value_get_list_size(lbug_value*, uint64_t* out);
// out_value is owned by parent; do NOT destroy separately.
lbug_state lbug_value_get_list_element(lbug_value*, uint64_t index, lbug_value* out_value);

// STRUCT
lbug_state lbug_value_get_struct_num_fields(lbug_value*, uint64_t* out);
lbug_state lbug_value_get_struct_field_name(lbug_value*, uint64_t index, char** out_name);
lbug_state lbug_value_get_struct_field_index(lbug_value*, const char* name, uint64_t* out);
lbug_state lbug_value_get_struct_field_value(lbug_value*, uint64_t index, lbug_value* out_value);

// MAP
lbug_state lbug_value_get_map_size(lbug_value*, uint64_t* out);
lbug_state lbug_value_get_map_key(lbug_value*, uint64_t index, lbug_value* out_key);
lbug_state lbug_value_get_map_value(lbug_value*, uint64_t index, lbug_value* out_value);

// RECURSIVE_REL
lbug_state lbug_value_get_recursive_rel_node_list(lbug_value*, lbug_value* out_list);
lbug_state lbug_value_get_recursive_rel_rel_list(lbug_value*, lbug_value* out_list);
```

---

## Node value functions

```c
lbug_state lbug_node_val_get_id_val(lbug_value* node_val, lbug_value* out_value);
lbug_state lbug_node_val_get_label_val(lbug_value* node_val, lbug_value* out_value);
lbug_state lbug_node_val_get_property_size(lbug_value* node_val, uint64_t* out_value);
lbug_state lbug_node_val_get_property_name_at(lbug_value* node_val, uint64_t index,
                                               char** out_name);
lbug_state lbug_node_val_get_property_value_at(lbug_value* node_val, uint64_t index,
                                                lbug_value* out_value);
// Caller frees with lbug_destroy_string():
lbug_state lbug_node_val_to_string(lbug_value* node_val, char** out_result);
```

---

## Relationship value functions

```c
lbug_state lbug_rel_val_get_id_val(lbug_value* rel_val, lbug_value* out_value);
lbug_state lbug_rel_val_get_src_id_val(lbug_value* rel_val, lbug_value* out_value);
lbug_state lbug_rel_val_get_dst_id_val(lbug_value* rel_val, lbug_value* out_value);
lbug_state lbug_rel_val_get_label_val(lbug_value* rel_val, lbug_value* out_value);
lbug_state lbug_rel_val_get_property_size(lbug_value* rel_val, uint64_t* out_value);
lbug_state lbug_rel_val_get_property_name_at(lbug_value* rel_val, uint64_t index,
                                              char** out_name);
lbug_state lbug_rel_val_get_property_value_at(lbug_value* rel_val, uint64_t index,
                                               lbug_value* out_value);
// Caller frees with lbug_destroy_string():
lbug_state lbug_rel_val_to_string(lbug_value* rel_val, char** out_result);
```

---

## String destruction

```c
// All heap-allocated char* returned by lbug_* functions must be freed here.
void lbug_destroy_string(char* str);
```

---

## Complete Example

```c
#include <stdio.h>
#include <stdlib.h>
#include "lbug.h"

static void check(lbug_state s, const char* ctx) {
    if (s != LbugSuccess) {
        fprintf(stderr, "Error in %s\n", ctx);
        exit(1);
    }
}

int main(void) {
    /* Database */
    lbug_system_config cfg = lbug_default_system_config();
    lbug_database db;
    check(lbug_database_init("./mydb", cfg, &db), "database_init");

    /* Connection */
    lbug_connection conn;
    check(lbug_connection_init(&db, &conn), "connection_init");

    /* Schema */
    lbug_query_result result;
    check(lbug_connection_query(&conn,
        "CREATE NODE TABLE Person(name STRING, age INT64, PRIMARY KEY(name));",
        &result), "create table");
    if (!lbug_query_result_is_success(&result)) {
        char* msg = lbug_query_result_get_error_message(&result);
        fprintf(stderr, "%s\n", msg);
        lbug_destroy_string(msg);
    }
    lbug_query_result_destroy(&result);

    /* Prepared statement */
    lbug_prepared_statement ps;
    check(lbug_connection_prepare(&conn,
        "CREATE (:Person {name: $name, age: $age});", &ps), "prepare");

    if (!lbug_prepared_statement_is_success(&ps)) {
        char* msg = lbug_prepared_statement_get_error_message(&ps);
        fprintf(stderr, "Prepare failed: %s\n", msg);
        lbug_destroy_string(msg);
        goto cleanup;
    }

    lbug_prepared_statement_bind_string(&ps, "name", "Alice");
    lbug_prepared_statement_bind_int64(&ps, "age", 25);
    check(lbug_connection_execute(&conn, &ps, &result), "execute Alice");
    lbug_query_result_destroy(&result);

    lbug_prepared_statement_bind_string(&ps, "name", "Bob");
    lbug_prepared_statement_bind_int64(&ps, "age", 30);
    check(lbug_connection_execute(&conn, &ps, &result), "execute Bob");
    lbug_query_result_destroy(&result);
    lbug_prepared_statement_destroy(&ps);

    /* Query and iterate */
    check(lbug_connection_query(&conn,
        "MATCH (p:Person) RETURN p.name, p.age", &result), "query");

    uint64_t ncols = lbug_query_result_get_num_columns(&result);
    printf("Columns: %llu\n", (unsigned long long)ncols);

    while (lbug_query_result_has_next(&result)) {
        lbug_flat_tuple row;
        check(lbug_query_result_get_next(&result, &row), "get_next");

        lbug_value name_val, age_val;
        lbug_flat_tuple_get_value(&row, 0, &name_val);
        lbug_flat_tuple_get_value(&row, 1, &age_val);

        char* name_str;
        lbug_value_get_string(&name_val, &name_str);
        int64_t age;
        lbug_value_get_int64(&age_val, &age);

        printf("%s: %lld\n", name_str, (long long)age);
        lbug_destroy_string(name_str);
        /* Do NOT call lbug_flat_tuple_destroy — owned by result */
        /* Do NOT call lbug_value_destroy — owned by flat_tuple  */
    }
    lbug_query_result_destroy(&result);

cleanup:
    lbug_connection_destroy(&conn);
    lbug_database_destroy(&db);
    return 0;
}
```

---

## Error handling pattern

```c
lbug_query_result result;
lbug_state s = lbug_connection_query(&conn, query, &result);
if (s != LbugSuccess) {
    // lbug_state == LbugError means the C++ layer threw an unexpected exception.
    // The result's error message may still be populated.
}
if (!lbug_query_result_is_success(&result)) {
    char* msg = lbug_query_result_get_error_message(&result);
    fprintf(stderr, "Query error: %s\n", msg);
    lbug_destroy_string(msg);
}
lbug_query_result_destroy(&result);
```

Two error levels exist:
1. `lbug_state == LbugError` — the function itself threw a C++ exception (rare).
2. `lbug_query_result_is_success == false` — the Cypher query failed (syntax error, constraint violation, etc.); the error message carries details.

Always check both and always free the error message string.
