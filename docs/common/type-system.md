# Type System

This page is an engineering reference for LadybugDB's type layer.
It is grounded in the current C++ implementation, but it now cross-checks the public SQL/type docs where they publish aliases or user-facing size claims.
When the public docs and the inspected runtime layout differ, this page calls out both layers explicitly instead of flattening them into one table.

## Scope and primary source files

- `src/include/common/types/types.h`
- `src/common/types/types.cpp`
- `src/include/common/types/value/value.h`
- `src/common/types/value/value.cpp`
- `src/include/common/types/value/nested.h`
- `src/common/types/value/nested.cpp`
- `src/include/common/types/value/node.h`
- `src/common/types/value/node.cpp`
- `src/include/common/types/value/rel.h`
- `src/common/types/value/rel.cpp`
- `src/include/common/types/value/recursive_rel.h`
- `src/common/types/value/recursive_rel.cpp`
- `src/include/common/type_utils.h`
- `src/include/common/types/string_t.h`
- `src/common/types/string_t.cpp`
- `src/include/common/types/list_t.h`
- `src/common/types/list_t.cpp`
- `src/include/common/types/blob.h`
- `src/common/types/blob.cpp`
- `src/include/common/types/date_t.h`
- `src/common/types/date_t.cpp`
- `src/include/common/types/timestamp_t.h`
- `src/common/types/timestamp_t.cpp`
- `src/include/common/types/interval_t.h`
- `src/common/types/interval_t.cpp`
- `src/include/common/types/uuid.h`
- `src/common/types/uuid.cpp`
- `src/include/function/cast/vector_cast_functions.h`
- `src/function/vector_cast_functions.cpp`
- `src/function/built_in_function_utils.cpp`
- `src/catalog/catalog.cpp`
- `src/extension/extension_entries.cpp`
- `src/include/extension/extension.h`
- `extension/json/src/main/json_extension.cpp`
- `extension/fts/src/function/stem.cpp`
- `extension/vector/src/function/create_hnsw_index.cpp`
- `extension/json/src/functions/scalar_functions/json_contains.cpp`

## Mental model

LadybugDB separates type handling into three layers:

1. **Logical type IDs**
   - What the binder, planner, catalog, and user-visible schema talk about.
   - Examples: `INT32`, `NODE`, `MAP`, `UNION`, `JSON`.

2. **Physical type IDs**
   - What a `ValueVector` or storage-oriented routine actually stores in its fixed-width slot.
   - Examples: `INT32`, `INT64`, `LIST`, `STRUCT`, `STRING`.

3. **Extra type info**
   - Parameters that refine a logical type.
   - Examples:
     - decimal precision/scale
     - list child type
     - array child type and fixed length
     - struct field names and field types
     - UDT name

That split is visible everywhere:

- `LogicalType` owns a `LogicalTypeID`.
- `LogicalType` also caches a `PhysicalTypeID`.
- Complex types attach an `ExtraTypeInfo` subclass.
- Runtime vectors switch mostly on physical type.
- Binder utilities and string parsers switch mostly on logical type.

## Core aliases and scalar runtime structs

The front of `types.h` defines a large amount of runtime vocabulary used throughout the engine.
The most important type-level aliases are:

- `sel_t`: selection-vector index.
- `idx_t`: general vector-sized index.
- `oid_t`: catalog OID.
- `table_id_t`: table identifier.
- `property_id_t`: property identifier.
- `transaction_t`: MVCC timestamp / transaction id.
- `offset_t`: row or node offset in many storage paths.

Important runtime structs used by the type system:

- `internalID_t`
  - Pair of `{offset, tableID}`.
  - Used for `INTERNAL_ID`, node ids, and relationship ids.
- `list_entry_t`
  - Pair of `{offset, size}` into a child data vector.
- `struct_entry_t`
  - Single `pos` field.
  - Struct vectors store children out-of-line and use the parent position as the indirection key.
- `map_entry_t`
  - Wraps a `list_entry_t`.
- `union_entry_t`
  - Wraps a `struct_entry_t`.

## Logical type IDs

Current `LogicalTypeID` values are:

| ID | Value | Notes |
| --- | --- | --- |
| `ANY` | `0` | unresolved or generic placeholder |
| `NODE` | `10` | graph node value |
| `REL` | `11` | graph relationship value |
| `RECURSIVE_REL` | `12` | path-like recursive relationship value |
| `SERIAL` | `13` | sequence-backed `INT64`-like logical type |
| `BOOL` | `22` | boolean |
| `INT64` | `23` | signed 64-bit integer |
| `INT32` | `24` | signed 32-bit integer |
| `INT16` | `25` | signed 16-bit integer |
| `INT8` | `26` | signed 8-bit integer |
| `UINT64` | `27` | unsigned 64-bit integer |
| `UINT32` | `28` | unsigned 32-bit integer |
| `UINT16` | `29` | unsigned 16-bit integer |
| `UINT8` | `30` | unsigned 8-bit integer |
| `INT128` | `31` | signed 128-bit integer |
| `DOUBLE` | `32` | double precision float |
| `FLOAT` | `33` | single precision float |
| `DATE` | `34` | days-based date |
| `TIMESTAMP` | `35` | microseconds since epoch |
| `TIMESTAMP_SEC` | `36` | seconds precision timestamp |
| `TIMESTAMP_MS` | `37` | milliseconds precision timestamp |
| `TIMESTAMP_NS` | `38` | nanoseconds precision timestamp |
| `TIMESTAMP_TZ` | `39` | timezone-aware logical flavor, stored as `INT64` |
| `INTERVAL` | `40` | `{months, days, micros}` |
| `DECIMAL` | `41` | precision/scale in extra type info |
| `INTERNAL_ID` | `42` | `{offset, tableID}` |
| `UINT128` | `43` | unsigned 128-bit integer |
| `STRING` | `50` | UTF-8 string |
| `BLOB` | `51` | binary payload, stored with string machinery |
| `LIST` | `52` | variable-length homogeneous nested type |
| `ARRAY` | `53` | fixed-length homogeneous nested type |
| `STRUCT` | `54` | named field product type |
| `MAP` | `55` | map is represented as a list of key/value structs |
| `UNION` | `56` | tagged union |
| `POINTER` | `58` | raw pointer-like internal type |
| `UUID` | `59` | logical UUID |
| `JSON` | `60` | logical JSON, runtime string-like |

## Public SQL names, aliases, and documented sizes

The public docs at `docs.ladybugdb.com/cypher/data-types/` describe the SQL surface a bit differently from the engine internals exposed in `types.h`.
The most important reconciliations are below.

| SQL surface / public name | Public docs | Source-backed engine note |
| --- | --- | --- |
| `INT32` / `INT` | 4 bytes | `INT` is parsed as `LogicalTypeID::INT32`; physical type is `INT32`. |
| `INT64` | 8 bytes | physical type is `INT64`. |
| `SERIAL` | public docs present it as the `INT64` alias and also document its auto-increment semantics | current source keeps a distinct `LogicalTypeID::SERIAL = 13`, but maps it to physical `INT64`. |
| `FLOAT` / `REAL` / `FLOAT4` | 4 bytes | parser accepts `REAL` and `FLOAT4` as `FLOAT`. |
| `DOUBLE` / `FLOAT8` | 8 bytes | parser accepts `FLOAT8` as `DOUBLE`. |
| `DECIMAL` / `NUMERIC` | variable | source maps precision `1-4 -> INT16`, `5-9 -> INT32`, `10-18 -> INT64`, `19-38 -> INT128`. |
| `BOOLEAN` / `BOOL` | 1 byte | parser normalizes `BOOLEAN` to `BOOL`. |
| `UUID` | 16 bytes | logical `UUID` uses physical `INT128`. |
| `STRING` | variable | physical storage uses `string_t` plus overflow storage. |
| `BLOB` / `BYTEA` | variable | logical `BLOB` maps to physical `STRING`. |
| `DATE` | 4 bytes | logical `DATE` maps to physical `INT32`. |
| `TIMESTAMP` | public docs currently say 4 bytes | current code maps `TIMESTAMP`, `TIMESTAMP_SEC`, `TIMESTAMP_MS`, `TIMESTAMP_NS`, and `TIMESTAMP_TZ` to physical `INT64`; `timestamp_t` stores one `int64_t value`. |
| `INTERVAL` / `DURATION` | public docs currently say 4 bytes | current code uses physical `INTERVAL`; `interval_t` stores `{int32 months, int32 days, int64 micros}`. |
| `LIST` | variable-length list | current core logical id is `LIST`; physical type is also list-shaped. |
| `ARRAY` | fixed-length list | current core logical id is `ARRAY`; physical type is `ARRAY`. |
| `STRUCT` | fixed-size nested value | current row layout is field-dependent, because physical `STRUCT` stores child layouts plus null bytes. |
| `MAP` | variable | source lowers `MAP` to a list whose child type is a key/value `STRUCT`. |
| `UNION` | variable; docs say the active alternative is tracked by key `"tag"` | source implements `UNION` as physical `STRUCT` with a synthetic `tag` field inserted at field index `0`. |
| `NODE` | fixed graph value | source represents it as physical `STRUCT` containing `_ID`, `_LABEL`, and property fields. |
| `REL` | fixed graph value | source represents it as physical `STRUCT` containing `_SRC`, `_DST`, `_ID`, `_LABEL`, and property fields. |
| `RECURSIVE_REL` | docs describe it as `STRUCT{LIST[NODE], LIST[REL]}` | source keeps a distinct logical id, but still maps it to physical `STRUCT`. |
| `PATH` | public docs describe path-shaped values at the Cypher level | the inspected current tree has `ExpressionType::PATH`, but no `LogicalTypeID::PATH`; recursive path outputs are modeled with `RECURSIVE_REL` plus helper list expressions. |
| `INTERNAL_ID` | not given its own public size row on the current docs page | source uses physical `INTERNAL_ID` backed by `internalID_t {offset, tableID}`. |
| `JSON` | public docs present a native JSON logical type | source keeps both `LogicalTypeID::JSON` and `PhysicalTypeID::JSON`, while still reusing much of the string runtime machinery. |
| `RDF_VARIANT` | mentioned in some higher-level materials, but not on the inspected core type page | no `LogicalTypeID::RDF_VARIANT` or `PhysicalTypeID::RDF_VARIANT` exists in the inspected current source tree. |
| `FIXED_LIST` / `VAR_LIST` | public-facing naming may describe fixed vs variable list families | the current core enum and parser use `ARRAY` and `LIST`; the inspected parser does not advertise `FIXED_LIST` / `VAR_LIST` as built-in keywords. |

For `TIMESTAMP` and `INTERVAL`, the safest reading is: the public docs are describing the SQL-surface type family, while the current runtime/storage code clearly uses wider in-memory representations.
This page keeps both facts visible because they answer different engineering questions.

## Physical type IDs

Current `PhysicalTypeID` values are:

| ID | Value | Runtime meaning |
| --- | --- | --- |
| `ANY` | `0` | unresolved / placeholder |
| `BOOL` | `1` | `bool` |
| `INT64` | `2` | 8-byte signed scalar |
| `INT32` | `3` | 4-byte signed scalar |
| `INT16` | `4` | 2-byte signed scalar |
| `INT8` | `5` | 1-byte signed scalar |
| `UINT64` | `6` | 8-byte unsigned scalar |
| `UINT32` | `7` | 4-byte unsigned scalar |
| `UINT16` | `8` | 2-byte unsigned scalar |
| `UINT8` | `9` | 1-byte unsigned scalar |
| `INT128` | `10` | 16-byte signed scalar |
| `DOUBLE` | `11` | 8-byte float |
| `FLOAT` | `12` | 4-byte float |
| `INTERVAL` | `13` | `interval_t` |
| `INTERNAL_ID` | `14` | `internalID_t` |
| `ALP_EXCEPTION_FLOAT` | `15` | compression-specific internal physical flavor |
| `ALP_EXCEPTION_DOUBLE` | `16` | compression-specific internal physical flavor |
| `UINT128` | `17` | 16-byte unsigned scalar |
| `STRING` | `20` | `string_t` + overflow buffer |
| `JSON` | `21` | physically string-like but distinguished |
| `LIST` | `22` | `list_entry_t` + child vector |
| `ARRAY` | `23` | `list_entry_t` + fixed-length semantics |
| `STRUCT` | `24` | `struct_entry_t` + child vectors |
| `POINTER` | `25` | pointer payload |

## Logical-to-physical mapping

`LogicalType::getPhysicalType()` defines the authoritative mapping.

### Direct scalar mappings

- `BOOL -> BOOL`
- `INT64 -> INT64`
- `INT32 -> INT32`
- `INT16 -> INT16`
- `INT8 -> INT8`
- `UINT64 -> UINT64`
- `UINT32 -> UINT32`
- `UINT16 -> UINT16`
- `UINT8 -> UINT8`
- `INT128 -> INT128`
- `UINT128 -> UINT128`
- `DOUBLE -> DOUBLE`
- `FLOAT -> FLOAT`
- `INTERVAL -> INTERVAL`
- `INTERNAL_ID -> INTERNAL_ID`
- `POINTER -> POINTER`

### Logical aliases that share a scalar physical layout

- `TIMESTAMP`, `TIMESTAMP_SEC`, `TIMESTAMP_MS`, `TIMESTAMP_NS`, `TIMESTAMP_TZ`, and `SERIAL`
  all use physical `INT64`.
- `DATE` uses physical `INT32`.
- `UUID` uses physical `INT128`.
- `BLOB` uses physical `STRING`.
- `JSON` uses physical `JSON`, but many runtime paths intentionally share string code.

### Nested mappings

- `LIST` and `MAP` use physical `LIST`.
- `ARRAY` uses physical `ARRAY`.
- `NODE`, `REL`, `RECURSIVE_REL`, `UNION`, and `STRUCT` all use physical `STRUCT`.

### Decimal mapping by precision

`DECIMAL` is special because its physical type depends on `DecimalTypeInfo`:

- precision `<= 4` -> physical `INT16`
- precision `<= 9` -> physical `INT32`
- precision `<= 18` -> physical `INT64`
- precision `<= 38` -> physical `INT128`
- precision `> 38` -> binder error

This means two `DECIMAL` logical types can share the same logical id but have different physical widths.

## Extension-facing type registration in the current tree

The current extension submodule does **not** add new `LogicalTypeID` or `PhysicalTypeID` enum values.
There are also no extension-side calls to `Catalog::createType(...)` in the inspected tree.

What extensions do today is narrower:

- core `Catalog::registerBuiltInTypes()` inserts `JSON` as the one built-in named type entry
- `JsonExtension::load(...)` explicitly notes that the JSON type is now built into core and therefore does not re-register it
- `ExtensionManager::lookupExtensionsByTypeName(...)` currently advertises only `JSON` as an extension-associated type name for better error messages

So the type-system contract is currently:

- core owns the actual logical-type ids and physical layouts
- the named-type catalog contains JSON plus user-defined types
- extension code mostly consumes existing logical types through function signatures and bind logic rather than minting new top-level type ids

## `LogicalType`

`LogicalType` stores:

- `typeID`
- `physicalType`
- `extraTypeInfo`
- `category`

`category` distinguishes:

- `TypeCategory::INTERNAL`
- `TypeCategory::UDT`

### Important constructor helpers

The class exposes factory helpers for all built-ins:

- `BOOL()`
- `INT64()`
- `UINT64()`
- `DOUBLE()`
- `DATE()`
- `TIMESTAMP()` and its variants
- `INTERVAL()`
- `DECIMAL(precision, scale)`
- `STRING()`
- `BLOB()`
- `UUID()`
- `JSON()`
- `POINTER()`
- `STRUCT(...)`
- `NODE(...)`
- `REL(...)`
- `RECURSIVE_REL(...)`
- `UNION(...)`
- `LIST(child)`
- `MAP(key, value)`
- `ARRAY(child, numElements)`

### `ANY` is not a normal execution-time type

`ANY` is allowed in logical reasoning and type combination.
It is *not* allowed for runtime vector allocation.
`ValueVector` explicitly throws if constructed with logical type `ANY`.
The implementation comment says the binder is expected to resolve it before execution.

## Extra type info classes

### `UDTTypeInfo`

Stores only the UDT name.
`LogicalType::toString()` returns that name directly for non-internal types.

### `DecimalTypeInfo`

Stores:

- `precision`
- `scale`

`DECIMAL` defaults to `DECIMAL(18, 3)` when parsed without parameters.

### `ListTypeInfo`

Stores one child `LogicalType`.
Used by both `LIST` and, as a base class, `ARRAY`.

### `ArrayTypeInfo`

Extends `ListTypeInfo` with `numElements`.
The parser rejects arrays with `numElements <= 0`.

### `StructTypeInfo`

Stores:

- ordered `fields`
- `fieldNameToIdxMap`

This is used by:

- `STRUCT`
- `NODE`
- `REL`
- `RECURSIVE_REL`
- `UNION`

`UNION` is modeled as a struct-shaped type with a synthetic tag field named `"tag"` at index `0`.
The current helper constants make that tag field type `UINT16`, and every user-visible union field is therefore offset by one internal struct slot.

## Built-in type string grammar

`LogicalType::convertFromString()` accepts several forms.

### Scalar aliases

The parser recognizes aliases such as:

- `INT` -> `INT32`
- `BOOLEAN` -> `BOOL`
- `BYTEA` -> `BLOB`
- `FLOAT8` -> `DOUBLE`
- `FLOAT4` and `REAL` -> `FLOAT`
- `TIMESTAMP_S` -> `TIMESTAMP_SEC`
- `DURATION` -> `INTERVAL`
- `NUMERIC` -> `DECIMAL`

The inspected current parser does **not** advertise separate built-in keywords for:

- `PATH`
- `RDF_VARIANT`
- `FIXED_LIST`
- `VAR_LIST`

So when you see those names in higher-level docs, map them back to the current source concepts (`ExpressionType::PATH`, `ARRAY`, `LIST`, or extension/client-layer terminology) instead of expecting matching `LogicalTypeID` enum members.

### List syntax

- `INT64[]`
- `STRUCT(a INT64, b STRING)[]`

Implemented as `LIST(childType)` internally.

### Array syntax

- `INT64[4]`
- `STRING[16]`

Implemented as `ARRAY(childType, numElements)`.

### Struct syntax

- `STRUCT(id INT64, name STRING)`

The parser:

- finds the outer parentheses
- splits fields on commas while tracking nested bracket depth
- rejects duplicate field names
- rejects more than `UINT16_MAX` fields

### Map syntax

- `MAP(STRING, INT64)`

Implemented as a logical map with key type and value type.
Internally many runtime operations lower this to list-of-struct behavior.

### Union syntax

- `UNION(int_val INT64, str_val STRING)`

Union field names must still be unique.
The runtime injects a synthetic tag field.
When `toString()` is called on a union type, the synthetic tag field is omitted from the display.

### Decimal syntax

- `DECIMAL(18, 3)`
- `NUMERIC(10, 2)`
- `DECIMAL` -> defaults to `(18, 3)`

## `LogicalType::toString()` behavior

Important exact formatting rules:

- `LIST(child)` prints as `child[]`
- `ARRAY(child, n)` prints as `child[n]`
- `STRUCT(...)` prints as `STRUCT(name TYPE, ...)`
- `UNION(...)` prints as `UNION(name TYPE, ...)` without showing the internal tag field
- `MAP(k, v)` prints as `MAP(k, v)`
- `DECIMAL` prints with precision and scale
- non-internal UDTs print the UDT name directly

## Type utility predicates

`LogicalTypeUtils` exposes several frequently used predicates:

- `isDate`
- `isTimestamp`
- `isUnsigned`
- `isIntegral`
- `isNumerical`
- `isFloatingPoint`
- `isNested`

Current nested types are:

- `STRUCT`
- `LIST`
- `ARRAY`
- `UNION`
- `MAP`
- `NODE`
- `REL`
- `RECURSIVE_REL`

## Row-layout sizes

`LogicalTypeUtils::getRowLayoutSize()` drives the row-oriented storage layout used by row materialization and factorized tables.
These are **engine-internal row-layout sizes**, not the public SQL-doc size column from `docs.ladybugdb.com`.

Rules:

- `STRING` and `JSON` -> `sizeof(string_t)`
- `LIST` and `ARRAY` -> `sizeof(list_t)`
- `STRUCT` -> sum of field row sizes + struct null bytes
- otherwise -> `PhysicalTypeUtils::getFixedTypeSize(...)`

This is the bridge between logical schema and row materialization.
It is also why nested types have dedicated `copyToRowData()` and `copyFromRowData()` paths in `ValueVector`.

## Type combination and maximal type selection

LadybugDB has two related but different routines:

### `tryGetMaxLogicalType`

This is the strict combination routine.
It can fail.
It is used when the engine needs a common type that respects known cast rules.

Important behavior:

- `ANY` behaves as the weakest placeholder.
- decimal+decimal merges precision/scale.
- decimal+numeric may stay decimal if precision allows; otherwise it degrades to `DOUBLE`.
- signed/unsigned integer joins have special handling.
- timestamp flavors are ordered by an internal timestamp order helper.
- nested types recurse on children.
- union combination is explicitly not supported and throws.

### `combineTypes`

This is the permissive routine.
It always succeeds.

Important behavior:

- if either side is `STRING`, the result is `STRING`
- structs are merged by field-name union
- lists and maps recurse on child/key/value types
- if strict combination fails, it falls back to `STRING`

That is intentionally more permissive than `tryGetMaxLogicalType`.
The source comment explicitly calls this out.

## `Value`

`Value` is the owning scalar/nested value container used outside raw vectors.

It stores:

- `LogicalType dataType`
- `bool isNull_`
- scalar union `val`
- `std::string strVal`
- `children`
- `childrenSize`

### Why both `strVal` and `children` exist

- scalar fixed-width payloads live in `val`
- string/blob/json textual payloads live in `strVal`
- nested values live in `children`

The implementation note says `childrenSize` must be treated as authoritative instead of `children.size()`.
That is because some nested paths keep spare capacity in the vector without resizing the logical child count.

### Constructors

`Value` has explicit constructors for:

- all integer widths
- `double`
- `float`
- `date_t`
- all timestamp flavors
- `interval_t`
- `internalID_t`
- `uint128_t`
- `uuid`
- `const char*`
- `std::string`
- `uint8_t*`
- arbitrary `LogicalType` + `std::string`
- arbitrary nested `LogicalType` + children vector

### Null and default factories

`createNullValue()`:

- returns NULL of logical `ANY`

`createNullValue(type)`:

- returns a NULL value tagged with `type`

`createDefaultValue(type)`:

- allocates a non-null default payload for the requested logical type
- for nested types this usually means allocating child shells as well

### Serialization format

`Value::serialize()` writes:

1. logical type
2. null flag
3. `childrenSize`
4. payload according to physical type

Payload rules:

- fixed-width scalar physical types serialize the scalar union member
- `STRING` and `JSON` serialize `strVal`
- `ARRAY`, `LIST`, and `STRUCT` serialize each child recursively
- `ANY` only serializes if it is NULL

`Value::deserialize()` mirrors that exact shape.

### Stringification

`Value::toString()` dispatches by logical/physical type and uses specialized formatting for nested graph values.

Key exact formats from the implementation:

- list -> `[v1,v2,...]`
- map -> `{k1=v1, k2=v2}`
- struct -> `{field: value, ...}`
- node -> `{field: value, ...}` but omits null children and returns empty string if the internal id child is null
- rel -> `(src)-{field: value, ...}->(dst)` and returns empty string if the id child is null
- decimal -> inserts the decimal point based on the logical scale, not on textual storage

## Nested value helper classes

### `NestedVal`

A minimal helper with:

- `getChildrenSize(const Value*)`
- `getChildVal(const Value*, idx)`

`ValueVector` uses this helper when copying nested `Value` objects into vectors.

### `NodeVal`

A `NODE` value is represented as a struct-like value.
`NodeVal` documents the public offsets:

- child `0` and `1` are reserved for id and label
- properties start at offset `2`

Available helper methods:

- `getProperties`
- `getNumProperties`
- `getPropertyName`
- `getPropertyVal`
- `getNodeIDVal`
- `getLabelVal`
- `toString`

### `RelVal`

A `REL` value is also represented as a struct-like value.
`RelVal` reserves four leading positions:

- id
- label
- src
- dst

Properties start after offset `4`.

### `RecursiveRelVal`

A recursive relationship value exposes two nested values:

- nodes list
- rels list

It is a structured path container, not a flat scalar.

## Scalar helper types

### `string_t`

`string_t` is the runtime inline/overflow string representation used by vectors and row layout.
The vector layer decides whether a string is short or long via `string_t::isShortString(...)`.

### `blob_t` / `BLOB`

`BLOB` is logical binary data.
It shares physical string storage and many string-oriented serialization paths.
The user-visible textual rendering comes from `Blob::toString(...)`.

### `date_t`

`DATE` is physically `INT32`.
It is implemented as a day count and has helpers for parsing, conversion, extraction, truncation, and formatting.

### `timestamp_t` and variants

The base timestamp stores microseconds since `1970-01-01`.
Important implementation details:

- `Timestamp::tryConvertTimestamp()` accepts a date-only form and treats it as midnight.
- both space and `T` separators are accepted.
- trailing `Z` is accepted.
- UTC offsets of the form `+HH`, `+HHMM`, or `+HH:MM` are parsed.
- offset handling subtracts the parsed offset from the stored microsecond value.
- `TIMESTAMP_NS` uses nanosecond epoch conversion helpers but the general timestamp representation is still routed through the timestamp helpers.

### `interval_t`

An interval stores three independent components:

- `months`
- `days`
- `micros`

This is important:
LadybugDB does **not** normalize intervals into a single scalar.
Month-sized and day-sized semantics are preserved separately.

Important parser behavior:

- recognizes unit strings such as year/month/day/hour/minute/second/millisecond/microsecond
- supports compact aliases like `y`, `mon`, `d`, `h`, `m`, `s`, `ms`, `us`
- can parse time-like tails via the time parser
- raises overflow exceptions when scaled components exceed the target integer range

### `uuid`

`UUID` stores an `int128_t` internally.
The implementation deliberately flips the top bit of the high 64 bits when parsing and flips it back when formatting.
The source comment explains why:

- it makes `ORDER BY uuid` behave like ordering by the textual UUID form

`UUID::generateRandomUUID()` also sets the RFC-style variant and version bits explicitly.

## Casting model

LadybugDB distinguishes two concepts:

- **explicit casts**
  - user-visible function calls such as `DATE(...)`, `STRING(...)`, `UUID(...)`, `CAST(...)`
- **implicit casts**
  - binder-inserted casts used to match function signatures or reconcile expression types

### Built-in cast cost table

The binder consults `BuiltInFunctionsUtils::getCastCost(input, target)`.
Important top-level rules are:

- identical types cost `0`
- casting to or from `ANY` costs `1`
- casting to `STRING` or `JSON` routes through the string-cost helper
- many numeric widening conversions have defined costs
- undefined edges return `UNDEFINED_CAST_COST`

Examples encoded in `built_in_function_utils.cpp`:

- `INT8 -> INT16/INT32/INT64/INT128/FLOAT/DOUBLE/DECIMAL`
- `INT16 -> INT32/INT64/INT128/FLOAT/DOUBLE/DECIMAL`
- `INT32 -> SERIAL/INT64/INT128/FLOAT/DOUBLE/DECIMAL`
- `INT64 -> SERIAL/INT128/FLOAT/DOUBLE/DECIMAL`
- unsigned numeric types widen to larger unsigned or signed-enough targets where defined
- `JSON` can be treated as `STRING`/`JSON` at zero cost and otherwise uses string-based casting

### `CastFunction::hasImplicitCast`

The high-level implicit-cast check does more than just consult cast cost.
It also has dedicated recursion for nested types.

Current nested behavior:

- array-to-list implicit cast is allowed with recursive child checks
- list-to-array implicit cast is allowed only when shape and child casting rules are compatible
- struct-to-struct requires matching fields and recursive compatibility
- map-to-map checks both key and value child casts
- union has special handling, including struct-to-union compatibility if fields line up
- if both types are numerical, the function still returns `true` even if the simple cast-cost lookup did not fully capture the case

### Nested cast binding

`vector_cast_functions.cpp` binds executable cast kernels.
Notable implementation details:

- `STRING` to scalar/nested types uses specialized string parsers.
- `DECIMAL` binding depends on the target physical type.
- casts to `UNION` choose the lowest-cost compatible field tag.
- casts from `NODE` and `REL` to `STRING` use dedicated graph-aware formatters.

## Design quirks worth remembering

### `MAP` is logically special but physically list-like

The type system exposes `MAP(key, value)` as a first-class logical type.
At runtime it still leans on list and struct infrastructure.
That is why map row layout and map casting are mostly expressed through list/struct routines.

### `NODE`, `REL`, and `RECURSIVE_REL` are physically structs

This is why:

- they serialize like nested values
- they use struct child vectors in execution
- their user-visible formatting is implemented in `Value::nodeToString()` and `Value::relToString()` rather than by a dedicated physical representation

### `JSON` is its own logical and physical type, but it shares most string machinery

You see this repeatedly in vector code:

- `STRING` and `JSON` are accepted together in assertions
- both use `StringAuxiliaryBuffer`
- both use `StringVector::addString(...)`

The separation is semantic, not a different memory layout.

### How extensions interact with the type system without adding new type ids

The extension hook for types is mostly indirect and currently runs through ordinary function registration.
`extension::addFunc<T>(...)` ultimately inserts a `FunctionCatalogEntry` whose `function_set` contains regular engine `Function` objects with normal `LogicalTypeID` signatures.

Examples from the extension tree:

- FTS `StemFunction::getFunctionSet()` registers a scalar function with `STRING, STRING -> STRING`
- JSON `JsonContainsFunction::getFunctionSet()` registers `STRING, STRING -> BOOL`
- vector `CreateVectorIndexFunction::getFunctionSet()` registers a `TableFunction` whose SQL-facing arguments are strings, while bind-time logic later inspects the indexed property type and HNSW config

That means extension behavior can be strongly type-aware without extending the enum tables in `types.h`.
The binder and function layer are the main extensibility surface today, not the low-level logical-type id list.

## Practical debugging checklist

When a type bug appears, check the following in order:

1. `LogicalTypeID`
2. `PhysicalTypeID`
3. `ExtraTypeInfo`
4. `LogicalType::toString()` output
5. `LogicalTypeUtils::getRowLayoutSize()`
6. `CastFunction::hasImplicitCast(...)`
7. `BuiltInFunctionsUtils::getCastCost(...)`
8. `Value::serialize()/deserialize()` if the bug crosses process or storage boundaries
9. `ValueVector::copyFromValue()` if the bug only appears during execution

## Summary

The LadybugDB type system is intentionally split between logical semantics and physical storage.
That split is what lets the engine:

- treat graph values as structured logical types
- treat decimals as one logical type with several physical widths
- reuse string/list/struct machinery for JSON, maps, unions, nodes, and relationships
- compute binder cast costs independently from vector execution kernels
- let extensions add type-aware functions without changing the core logical-type-id or physical-type-id enums

If you need one file to anchor your reading, start with `types.h`.
If you need the real behavior, follow it immediately with `types.cpp`, `value.cpp`, and `vector_cast_functions.cpp`.
