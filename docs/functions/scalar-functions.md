# Scalar Functions

**Source files:**
- `src/function/` (all subdirectories except `aggregate/` and `gds/`)
- `src/include/function/` (all subdirectory headers)
- `src/function/function_collection.cpp` — canonical registration order
- `src/include/function/scalar_function.h` — `ScalarFunction` struct

---

## Overview

Scalar functions in LadybugDB take zero or more `ValueVector` arguments and produce a single
`ValueVector` result. Every function call in a Cypher expression is resolved to a `ScalarFunction`
(or its `RewriteFunction` variant) at bind time.

The function infrastructure is defined in `src/include/function/scalar_function.h` and
`src/include/function/function.h`.

### `ScalarFunction` struct

```cpp
struct ScalarFunction : public ScalarOrAggregateFunction {
    scalar_func_exec_t    execFunc;     // main execution path
    scalar_func_select_t  selectFunc;   // optional boolean fast-path (filter pushdown)
    scalar_func_compile_exec_t compileFunc; // compile-time evaluation (e.g. struct extraction)

    bool isListLambda = false;  // true for LIST_TRANSFORM / LIST_FILTER / LIST_REDUCE
    bool isVarLength  = false;  // true for variadic functions (CONCAT, COALESCE, ...)
};
```

`scalar_func_exec_t` signature:
```cpp
void(const std::vector<std::shared_ptr<ValueVector>>&  params,
     const std::vector<SelectionVector*>&              paramSelVectors,
     ValueVector&                                      result,
     SelectionVector*                                  resultSelVector,
     void*                                             dataPtr)
```

`scalar_func_select_t` is used when the function is in a filter position (WHERE clause). It
writes directly into the selection vector instead of materialising a boolean vector, avoiding
an extra pass:
```cpp
bool(const std::vector<std::shared_ptr<ValueVector>>& params,
     SelectionVector& selVector,
     void* dataPtr)
```

`compileFunc` is called at plan-compile time when all inputs are constant, enabling constant
folding for nested-type accessors like `STRUCT_EXTRACT`.

### Bind Data

`FunctionBindData` carries information resolved at bind time and passed to `execFunc` through
`dataPtr`:

```cpp
struct FunctionBindData {
    std::vector<common::LogicalType> paramTypes;
    common::LogicalType resultType;
    main::ClientContext* clientContext;
    int64_t count;           // used by some functions for bookkeeping
};
```

Custom bind data (e.g. for string casts) inherits from `FunctionBindData` and is produced by
the `bindFunc` stored in `ScalarOrAggregateFunction::bindFunc`.

---

## Execution Machinery

Functions are not called one row at a time. The executor iterates over batches of rows described
by a `SelectionVector`. Four executor templates handle the common arities:

| Template | Use case |
|----------|---------|
| `UnaryFunctionExecutor` | Single-argument functions |
| `BinaryFunctionExecutor` | Two-argument functions |
| `TernaryFunctionExecutor` | Three-argument functions |
| `ConstFunctionExecutor` | Zero-argument (nullary) constant-output functions |
| `PointerFunctionExecutor` | Nullary functions that need `dataPtr` (e.g. NEXTVAL) |

Each executor wraps the core operation in a *wrapper type* that determines null handling and
memory allocation policy:

| Wrapper | Null rule | Extra context |
|---------|-----------|---------------|
| `UnaryFunctionWrapper` | NULL in → NULL out (skip) | — |
| `UnaryStringFunctionWrapper` | NULL in → NULL out | Passes `resultVector` for in-place string allocation |
| `UnaryCastStringFunctionWrapper` | NULL in → NULL out | Passes `CastFunctionBindData::option` for cast options |
| `UnaryNestedTypeFunctionWrapper` | NULL in → NULL out | Passes both input and result vectors (nested types need child-vector access) |
| `SetSeedFunctionWrapper` | Always writes NULL to result | Side-effect only (sets RNG seed via `dataPtr`) |
| `BinaryFunctionWrapper` | NULL in → NULL out | — |
| `BinaryStringFunctionWrapper` | NULL in → NULL out | Passes result vector for string allocation |
| `BinaryListStructFunctionWrapper` | NULL in → NULL out | Passes all three vectors (lists / structs modify child vectors) |
| `BinaryMapCreationFunctionWrapper` | NULL in → NULL out | Passes all vectors + `dataPtr` |

### Helper static methods on `ScalarFunction`

`ScalarFunction` exposes a family of static methods that bind a `FUNC` struct's `operation()`
to the correct executor at the call site:

```cpp
// Common patterns
ScalarFunction::UnaryExecFunction<OP_TYPE, RES_TYPE, FUNC>(...)
ScalarFunction::UnaryStringExecFunction<OP_TYPE, RES_TYPE, FUNC>(...)
ScalarFunction::BinaryExecFunction<L, R, RES, FUNC>(...)
ScalarFunction::BinaryStringExecFunction<L, R, RES, FUNC>(...)
ScalarFunction::TernaryExecFunction<A, B, C, RES, FUNC>(...)
ScalarFunction::NullaryExecFunction<RES, FUNC>(...)
ScalarFunction::NullaryAuxilaryExecFunction<RES, FUNC>(...)  // uses dataPtr
```

---

## Registration

All built-in scalar functions are declared in `FunctionCollection::getFunctions()` in
`src/function/function_collection.cpp` using compile-time macros:

```cpp
#define SCALAR_FUNCTION(_PARAM)        // canonical name
#define SCALAR_FUNCTION_ALIAS(_PARAM)  // alias pointing to another function's getFunctionSet
#define REWRITE_FUNCTION(_PARAM)       // rewrites the expression tree before execution
#define REWRITE_FUNCTION_ALIAS(_PARAM)
```

`REWRITE_FUNCTION` entries are `CatalogEntryType::REWRITE_FUNCTION_ENTRY`. The rewrite happens
in the binder, substituting the function call with a different expression (e.g. `LENGTH(p)` on
a path is rewritten to a path-length computation at plan time).

---

## Arithmetic Functions

**Source:** `src/function/arithmetic/`, `src/include/function/arithmetic/`

Arithmetic functions cover numeric operations. All support the standard numeric types
(INT8 through INT128, UINT8 through UINT128, FLOAT, DOUBLE).

### Basic operators

| Name | Symbol | Notes |
|------|--------|-------|
| `AddFunction` | `+` | Also handles date+interval, string concatenation via overloads |
| `SubtractFunction` | `-` | Supports date-date → INTERVAL |
| `MultiplyFunction` | `*` | |
| `DivideFunction` | `/` | Integer division truncates toward zero |
| `ModuloFunction` | `%` | |
| `PowerFunction` | `^` | Alias: `POW` |
| `NegateFunction` | `NEGATE` | Unary minus |

### Math functions

| Name | Description |
|------|-------------|
| `AbsFunction` | Absolute value |
| `AcosFunction` | Arc-cosine (radians) |
| `AsinFunction` | Arc-sine (radians) |
| `AtanFunction` | Arc-tangent (radians) |
| `Atan2Function` | `atan2(y, x)` |
| `CbrtFunction` | Cube root |
| `CeilFunction` / `CeilingFunction` | Ceiling (alias: `CEILING`) |
| `CosFunction` | Cosine |
| `CotFunction` | Cotangent |
| `DegreesFunction` | Radians → degrees |
| `EvenFunction` | Round to nearest even integer |
| `FactorialFunction` | `n!` (INT64 → INT128) |
| `FloorFunction` | Floor |
| `GammaFunction` | Gamma function |
| `LgammaFunction` | Log-gamma |
| `LnFunction` | Natural log |
| `LogFunction` / `Log10Function` | Base-10 log (aliases: `LOG`, `LOG10`) |
| `Log2Function` | Base-2 log |
| `PiFunction` | Returns π |
| `RadiansFunction` | Degrees → radians |
| `RoundFunction` | Round to N decimal places: `ROUND(x, n)` |
| `SignFunction` | `-1 / 0 / +1` |
| `SinFunction` | Sine |
| `SqrtFunction` | Square root |
| `TanFunction` | Tangent |

### Bitwise functions

| Name | Description |
|------|-------------|
| `BitwiseXorFunction` | `BITWISE_XOR(a, b)` |
| `BitwiseAndFunction` | `BITWISE_AND(a, b)` |
| `BitwiseOrFunction` | `BITWISE_OR(a, b)` |
| `BitShiftLeftFunction` | `BITSHIFT_LEFT(a, n)` |
| `BitShiftRightFunction` | `BITSHIFT_RIGHT(a, n)` |

### Random functions

| Name | Description |
|------|-------------|
| `RandFunction` | `RANDOM()` — uniform float in [0,1); nullary with `ConstFunctionExecutor` |
| `SetSeedFunction` | `SETSEED(x)` — sets RNG seed; side-effect via `SetSeedFunctionWrapper`; always returns NULL |

---

## String Functions

**Source:** `src/function/string/`, `src/include/function/string/`

All string functions accept `STRING` and return `STRING` or `BOOL`. Functions that allocate new
strings use `UnaryStringFunctionWrapper` / `BinaryStringFunctionWrapper` which pass the result
`ValueVector` for in-place string allocation into the overflow buffer.

### Case & padding

| Name | Aliases | Signature | Description |
|------|---------|-----------|-------------|
| `LOWER` | `TOLOWER`, `LCASE` | `STRING → STRING` | Lowercase |
| `UPPER` | `TOUPPER`, `UCASE` | `STRING → STRING` | Uppercase |
| `INITCAP` | — | `STRING → STRING` | Capitalise first letter of each word |
| `LPAD` | — | `(STRING, INT64, STRING) → STRING` | Left-pad to width |
| `RPAD` | — | `(STRING, INT64, STRING) → STRING` | Right-pad to width |
| `LTRIM` | — | `STRING → STRING` | Strip leading whitespace |
| `RTRIM` | — | `STRING → STRING` | Strip trailing whitespace |
| `TRIM` | — | `STRING → STRING` | Strip both ends |

### Search & substring

| Name | Aliases | Signature | Description |
|------|---------|-----------|-------------|
| `CONTAINS` | — | `(STRING, STRING) → BOOL` | True if haystack contains needle |
| `STARTS_WITH` | `PREFIX` | `(STRING, STRING) → BOOL` | True if haystack has given prefix |
| `ENDS_WITH` | `SUFFIX` | `(STRING, STRING) → BOOL` | True if haystack has given suffix |
| `LEFT` | — | `(STRING, INT64) → STRING` | Leftmost N characters |
| `RIGHT` | — | `(STRING, INT64) → STRING` | Rightmost N characters |
| `SUBSTR` | `SUBSTRING` | `(STRING, INT64[, INT64]) → STRING` | Substring starting at pos |
| `ARRAY_EXTRACT` | — | `(STRING, INT64) → STRING` | Extract N-th character (1-based) |

### Transformation

| Name | Aliases | Signature | Description |
|------|---------|-----------|-------------|
| `REVERSE` | — | `STRING → STRING` | Reverse the string |
| `REPEAT` | — | `(STRING, INT64) → STRING` | Repeat N times |
| `REPLACE` | — | `(STRING, STRING, STRING) → STRING` | Replace all occurrences |
| `CONCAT` | — | `(STRING, ...) → STRING` | Variadic concatenation; `isVarLength = true` |
| `CONCAT_WS` | — | `(STRING, STRING, ...) → STRING` | Concatenate with separator |

### Split & join

| Name | Aliases | Signature | Description |
|------|---------|-----------|-------------|
| `STRING_SPLIT` | `STR_SPLIT`, `STRING_TO_ARRAY` | `(STRING, STRING) → LIST(STRING)` | Split by delimiter |
| `SPLIT_PART` | — | `(STRING, STRING, INT64) → STRING` | Return N-th part after split |

### Regex

Regex functions use RE2 via `base_regexp_function.h`. The pattern is compiled at bind time when
it is a constant literal, otherwise it is compiled per-row.

| Name | Signature | Description |
|------|-----------|-------------|
| `REGEXP_FULL_MATCH` | `(STRING, STRING) → BOOL` | Full-string match |
| `REGEXP_MATCHES` | `(STRING, STRING) → BOOL` | Partial match anywhere in string |
| `REGEXP_REPLACE` | `(STRING, STRING, STRING[, STRING]) → STRING` | Replace first (or all with `'g'` flag) |
| `REGEXP_EXTRACT` | `(STRING, STRING[, INT64]) → STRING` | Extract first match or N-th capture group |
| `REGEXP_EXTRACT_ALL` | `(STRING, STRING[, INT64]) → LIST(STRING)` | All matches / group captures |
| `REGEXP_SPLIT_TO_ARRAY` | `(STRING, STRING) → LIST(STRING)` | Split by regex pattern |

The global-replace flag is the string constant `"g"` checked at runtime.

### Similarity

| Name | Signature | Description |
|------|-----------|-------------|
| `LEVENSHTEIN` | `(STRING, STRING) → INT64` | Edit distance |

---

## List Functions

**Source:** `src/function/list/`, `src/include/function/list/`

List functions operate on `LIST(<T>)` types. The element type is resolved at bind time through
`bindFunc`, which inspects `arguments[0]->dataType` to instantiate correctly typed overloads.

### Construction & range

| Name | Aliases | Signature | Description |
|------|---------|-----------|-------------|
| `LIST_CREATION` | — | `(T, ...) → LIST(T)` | Literal list `[a, b, c]` |
| `RANGE` | — | `(INT64[, INT64[, INT64]]) → LIST(INT64)` | Generates `[start..end)` with optional step |
| `SIZE` | `CARDINALITY` | `LIST(T) → INT64` | Number of elements |

### Access & search

| Name | Aliases | Signature | Description |
|------|---------|-----------|-------------|
| `LIST_EXTRACT` | `LIST_ELEMENT` | `(LIST(T), INT64) → T` | 1-based element access |
| `LIST_POSITION` | `LIST_INDEXOF` | `(LIST(T), T) → INT64` | 1-based position or NULL |
| `LIST_CONTAINS` | `LIST_HAS` | `(LIST(T), T) → BOOL` | Membership test |
| `LIST_HAS_ALL` | — | `(LIST(T), LIST(T)) → BOOL` | All elements of second list in first |
| `LIST_ANY_VALUE` | — | `LIST(T) → T` | Returns first non-NULL element |

### Transformation

| Name | Aliases | Signature | Description |
|------|---------|-----------|-------------|
| `LIST_CONCAT` | `LIST_CAT` | `(LIST(T), LIST(T)) → LIST(T)` | Concatenate two lists; `bindFunc` validates element type compatibility |
| `LIST_APPEND` | — | `(LIST(T), T) → LIST(T)` | Append element to end |
| `LIST_PREPEND` | — | `(T, LIST(T)) → LIST(T)` | Prepend element to front |
| `LIST_SLICE` | — | `(LIST(T), INT64, INT64) → LIST(T)` | Sublist `[from, to)` |
| `LIST_REVERSE` | — | `LIST(T) → LIST(T)` | Reverse order |
| `LIST_DISTINCT` | — | `LIST(T) → LIST(T)` | Remove duplicates (preserves order) |
| `LIST_UNIQUE` | — | `LIST(T) → INT64` | Count distinct elements |
| `LIST_SORT` | — | `LIST(T) → LIST(T)` | Ascending sort |
| `LIST_REVERSE_SORT` | — | `LIST(T) → LIST(T)` | Descending sort |
| `LIST_TO_STRING` | — | `(LIST(T), STRING) → STRING` | Join with separator |

### Aggregation over list elements

| Name | Signature | Description |
|------|-----------|-------------|
| `LIST_SUM` | `LIST(numeric) → numeric` | Sum of all non-NULL elements |
| `LIST_PRODUCT` | `LIST(numeric) → numeric` | Product of all non-NULL elements |

### Higher-order functions (lambda)

These functions set `isListLambda = true` on the `ScalarFunction`. The binder treats the second
argument as a lambda expression and inlines the lambda body at the call site.

| Name | Signature | Description |
|------|-----------|-------------|
| `LIST_TRANSFORM` | `(LIST(T), x → U) → LIST(U)` | Map each element |
| `LIST_FILTER` | `(LIST(T), x → BOOL) → LIST(T)` | Keep elements where predicate is true |
| `LIST_REDUCE` | `(LIST(T), (acc T, x T) → T) → T` | Left fold |

### Quantifiers

| Name | Signature | Description |
|------|-----------|-------------|
| `ANY` | `(LIST(T), x → BOOL) → BOOL` | True if any element satisfies predicate |
| `ALL` | `(LIST(T), x → BOOL) → BOOL` | True if all elements satisfy predicate |
| `None` | `(LIST(T), x → BOOL) → BOOL` | True if no element satisfies predicate |
| `Single` | `(LIST(T), x → BOOL) → BOOL` | True if exactly one element satisfies predicate |

Quantifiers use a shared `execQuantifierFunc` template with a `quantifier_handler` function
object capturing the counting logic.

---

## Array Functions

**Source:** `src/function/array/`, `src/include/function/array/`

Fixed-length `ARRAY(T, N)` functions. Many mirror their `LIST_*` counterparts.

### Construction

| Name | Signature | Description |
|------|-----------|-------------|
| `ARRAY_VALUE` | `(T, ...) → ARRAY(T, N)` | Literal fixed-length array |

### Manipulation

| Name | Aliases | Signature |
|------|---------|-----------|
| `ARRAY_CONCAT` | `ARRAY_CAT` | `(ARRAY(T,N1), ARRAY(T,N2)) → ARRAY(T,N1+N2)` |
| `ARRAY_APPEND` | `ARRAY_PUSH_BACK` | `(ARRAY(T,N), T) → ARRAY(T,N+1)` |
| `ARRAY_PREPEND` | `ARRAY_PUSH_FRONT` | `(T, ARRAY(T,N)) → ARRAY(T,N+1)` |
| `ARRAY_POSITION` | `ARRAY_INDEXOF` | `(ARRAY(T,N), T) → INT64` |
| `ARRAY_CONTAINS` | `ARRAY_HAS` | `(ARRAY(T,N), T) → BOOL` |
| `ARRAY_SLICE` | — | `(ARRAY(T,N), INT64, INT64) → ARRAY(T,M)` |

### Vector-math (numeric arrays only)

| Name | Signature | Description |
|------|-----------|-------------|
| `ARRAY_CROSS_PRODUCT` | `(ARRAY(T,3), ARRAY(T,3)) → ARRAY(T,3)` | 3D cross product |
| `ARRAY_COSINE_SIMILARITY` | `(ARRAY(T,N), ARRAY(T,N)) → DOUBLE` | Cosine similarity |
| `ARRAY_DISTANCE` | `(ARRAY(T,N), ARRAY(T,N)) → DOUBLE` | L2 (Euclidean) distance |
| `ARRAY_SQUARED_DISTANCE` | `(ARRAY(T,N), ARRAY(T,N)) → DOUBLE` | Squared L2 distance |
| `ARRAY_INNER_PRODUCT` | `(ARRAY(T,N), ARRAY(T,N)) → DOUBLE` | Inner (dot) product |
| `ARRAY_DOT_PRODUCT` | `(ARRAY(T,N), ARRAY(T,N)) → DOUBLE` | Alias for inner product |

---

## Map Functions

**Source:** `src/function/map/`, `src/include/function/map/`

| Name | Aliases | Signature | Description |
|------|---------|-----------|-------------|
| `MAP` | — | `(LIST(K), LIST(V)) → MAP(K,V)` | Construct map from parallel key/value lists |
| `MAP_EXTRACT` | `ELEMENT_AT` | `(MAP(K,V), K) → LIST(V)` | Returns a one-element list or empty list |
| `MAP_KEYS` | — | `MAP(K,V) → LIST(K)` | All keys |
| `MAP_VALUES` | — | `MAP(K,V) → LIST(V)` | All values |

`MAP_EXTRACT` returns `LIST(V)` (not just `V`) to preserve the semantics that a key may be
absent without returning NULL — it returns an empty list in that case.

---

## Struct Functions

**Source:** `src/function/struct/`, `src/include/function/struct/`

| Name | Signature | Notes |
|------|-----------|-------|
| `STRUCT_PACK` | `(name := value, ...) → STRUCT` | Constructs a struct literal; uses `compileFunc` for constant folding |
| `STRUCT_EXTRACT` | `(STRUCT, STRING) → T` | Extract field by name; uses `compileFunc` to resolve field index |
| `KEYS` | `STRUCT → LIST(STRING)` | Returns field names; implemented as `REWRITE_FUNCTION` |

`StructExtractBindData` carries the `childIdx` resolved at bind time so `compileFunc` can
reference the child vector directly without a name lookup at runtime.

---

## Union Functions

**Source:** `src/include/function/union/`

| Name | Signature | Description |
|------|-----------|-------------|
| `UNION_VALUE` | `(tag := value) → UNION` | Construct a tagged union value |
| `UNION_TAG` | `UNION → STRING` | Return the active tag |
| `UNION_EXTRACT` | `(UNION, STRING) → T` | Extract the value for a given tag; NULL if tag is not active |

---

## Date & Time Functions

**Source:** `src/function/date/`, `src/include/function/date/`  
**Timestamp:** `src/include/function/timestamp/`  
**Interval:** `src/include/function/interval/`

### Date functions

| Name | Aliases | Signature | Description |
|------|---------|-----------|-------------|
| `DATE_PART` | `DATEPART` | `(STRING, DATE\|TIMESTAMP\|INTERVAL) → INT64` | Extract date component by name (`'year'`, `'month'`, etc.) |
| `DATE_TRUNC` | `DATETRUNC` | `(STRING, DATE\|TIMESTAMP) → same` | Truncate to component granularity |
| `DAYNAME` | — | `DATE → STRING` | English day name |
| `MONTHNAME` | — | `DATE → STRING` | English month name |
| `LAST_DAY` | — | `DATE → DATE` | Last day of the month |
| `MAKE_DATE` | — | `(INT64, INT64, INT64) → DATE` | Construct from year, month, day |
| `GREATEST` | — | `(T, T) → T` | Greater of two comparables |
| `LEAST` | — | `(T, T) → T` | Lesser of two comparables |
| `CURRENT_DATE` | — | `() → DATE` | Today's date (UTC) |

### Timestamp functions

| Name | Signature | Description |
|------|-----------|-------------|
| `CENTURY` | `TIMESTAMP → INT64` | Century number |
| `EPOCH_MS` | `INT64 → TIMESTAMP` | Convert milliseconds-since-epoch to TIMESTAMP |
| `TO_TIMESTAMP` | `INT64 → TIMESTAMP` | Convert seconds-since-epoch to TIMESTAMP |
| `TO_EPOCH_MS` | `TIMESTAMP → INT64` | Convert TIMESTAMP to milliseconds-since-epoch |
| `CURRENT_TIMESTAMP` | `() → TIMESTAMP` | Current wall-clock time (UTC) |

### Interval construction

All take `INT64` and return `INTERVAL`:

| Name | Description |
|------|-------------|
| `TO_YEARS` | N years |
| `TO_MONTHS` | N months |
| `TO_DAYS` | N days |
| `TO_HOURS` | N hours |
| `TO_MINUTES` | N minutes |
| `TO_SECONDS` | N seconds |
| `TO_MILLISECONDS` | N milliseconds |
| `TO_MICROSECONDS` | N microseconds |

These are registered via `IntervalFunction::getUnaryIntervalFunction<Op>`, a template helper
that creates a `ScalarFunction` with `UnaryExecFunction<int64_t, interval_t, Op>`.

---

## Cast Functions

**Source:** `src/function/cast/`, `src/include/function/cast/`

Cast functions convert between types. Each has a `CastFunctionBindData` holding a
`CastingFunction::Option` that controls error handling (strict vs. try-cast).

| Name | Aliases | Target type |
|------|---------|-------------|
| `CastToDateFunction` | `DATE` | DATE |
| `CastToTimestampFunction` | — | TIMESTAMP |
| `CastToIntervalFunction` | `INTERVAL`, `DURATION` | INTERVAL |
| `CastToStringFunction` | `STRING` | STRING |
| `CastToBlobFunction` | `BLOB` | BLOB |
| `CastToUUIDFunction` | `UUID` | UUID |
| `CastToDoubleFunction` | — | DOUBLE |
| `CastToFloatFunction` | — | FLOAT |
| `CastToInt64Function` | — | INT64 |
| `CastToInt32Function` | — | INT32 |
| `CastToInt16Function` | — | INT16 |
| `CastToInt8Function` | — | INT8 |
| `CastToUInt64Function` | — | UINT64 |
| `CastToUInt32Function` | — | UINT32 |
| `CastToUInt16Function` | — | UINT16 |
| `CastToUInt8Function` | — | UINT8 |
| `CastToInt128Function` | — | INT128 |
| `CastToUInt128Function` | — | UINT128 |
| `CastToBoolFunction` | — | BOOL |
| `CastToSerialFunction` | — | SERIAL |
| `CastAnyFunction` | — | ANY (dynamic) |

The `CastAnyFunction` is resolved at bind time: the target type comes from the expression context.

Array casting (`cast_array.cpp`) handles element-wise conversion for `LIST` and `ARRAY` types,
recursively calling the element type's cast function.

---

## Comparison Functions

**Source:** `src/function/comparison_functions.cpp`, `src/include/function/comparison/`

All comparisons support `ANY` input types (resolved at bind time to comparable types).

| Name | Operator |
|------|---------|
| `EqualsFunction` | `=` |
| `NotEqualsFunction` | `<>` |
| `GreaterThanFunction` | `>` |
| `GreaterThanEqualsFunction` | `>=` |
| `LessThanFunction` | `<` |
| `LessThanEqualsFunction` | `<=` |

Comparisons expose both an `execFunc` (produces BOOL vector) and a `selectFunc` (fast-path for
filter evaluation). The `selectFunc` path writes the passing positions directly into the
`SelectionVector`, saving the allocation of a boolean result vector.

---

## Hash Functions

**Source:** `src/include/function/hash/`

| Name | Signature | Description |
|------|-----------|-------------|
| `MD5` | `STRING → STRING` | MD5 hex digest |
| `SHA256` | `STRING → STRING` | SHA-256 hex digest |
| `HASH` | `ANY → INT64` | Internal MurmurHash-based hash for any type |

`VectorHashFunction` exposes `computeHash` and `combineHash` used by the hash join and
aggregation operators internally.

---

## Blob Functions

**Source:** `src/include/function/blob/`

| Name | Signature | Description |
|------|-----------|-------------|
| `OCTET_LENGTH` | `BLOB → INT64` | Byte length of blob |
| `ENCODE` | `STRING → BLOB` | UTF-8 string to blob |
| `DECODE` | `BLOB → STRING` | Blob bytes to UTF-8 string |

---

## UUID Functions

**Source:** `src/include/function/uuid/`

| Name | Signature | Description |
|------|-----------|-------------|
| `GEN_RANDOM_UUID` | `() → UUID` | Generate a random UUID v4 |

---

## Sequence Functions

**Source:** `src/function/sequence/`, `src/include/function/sequence/`

| Name | Signature | Description |
|------|-----------|-------------|
| `CURRVAL` | `STRING → INT64` | Current value of named sequence |
| `NEXTVAL` | `STRING → INT64` | Advance and return next value of named sequence |

`NEXTVAL` uses `PointerFunctionExecutor` — the sequence state is passed through `dataPtr`
because it needs write access to the transaction-local sequence counter.

---

## Node / Relationship Pattern Functions

**Source:** `src/include/function/schema/`, `src/function/pattern/`

These are declared as `REWRITE_FUNCTION` entries — the binder substitutes them with the
appropriate internal expression at plan-compile time.

| Name | Aliases | Rewritten to |
|------|---------|-------------|
| `ID` | — | Internal node/rel ID expression |
| `ROWID` | — | Row-offset expression |
| `OFFSET` | — | Physical storage offset |
| `LABEL` | `LABELS` | Label string expression |
| `START_NODE` | — | Source node of a relationship |
| `END_NODE` | — | Destination node of a relationship |
| `COST` | — | Edge cost property (for weighted path queries) |

`InternalIDCreationFunction` creates an `INTERNAL_ID` value from `(tableID, offset)` pair — used
in testing and internal tooling.

---

## Path Functions

**Source:** `src/function/path/`, `src/include/function/path/`

| Name | Aliases | Signature | Description |
|------|---------|-----------|-------------|
| `NODES` | — | `PATH → LIST(NODE)` | All nodes in a path |
| `RELS` | `RELATIONSHIPS` | `PATH → LIST(REL)` | All relationships in a path |
| `PROPERTIES` | — | `(PATH\|NODE\|REL, STRING) → ANY` | Property access by name |
| `LENGTH` | — | `PATH → INT64` | Number of hops (`REWRITE_FUNCTION`) |
| `IS_TRAIL` | — | `PATH → BOOL` | True if all edges are distinct |
| `IS_ACYCLIC` | — | `PATH → BOOL` | True if no node is repeated |

`PropertiesBindData` carries a `childIdx` resolved at bind time for constant-string property
names.

---

## Utility Functions

**Source:** `src/include/function/utility/`

| Name | Signature | Description |
|------|-----------|-------------|
| `COALESCE` | `(T, T, ...) → T` | Returns first non-NULL argument; `isVarLength = true` |
| `IFNULL` | `(T, T) → T` | Returns second argument if first is NULL |
| `NULLIF` | `(T, T) → T` | Returns NULL if both arguments are equal (`REWRITE_FUNCTION`) |
| `CONSTANT_OR_NULL` | `(T, BOOL) → T` | Returns first arg if second is true, else NULL |
| `COUNT_IF` | `BOOL → INT64` | Counts rows where input is true |
| `ERROR` | `STRING → ANY` | Throws a runtime error with the given message |
| `TYPEOF` | `ANY → STRING` | Returns the logical type name as a string |

---

## Null Handling

The default execution wrappers (`UnaryFunctionWrapper`, `BinaryFunctionWrapper`, etc.) implement
**null propagation**: if any input value at a given position is NULL, the output at that
position is set to NULL without calling the underlying `FUNC::operation`. Exceptions:

- `IS_NULL` / `IS_NOT_NULL` (boolean null functions) do not propagate — they explicitly examine
  the null flag.
- `COALESCE` and `IFNULL` consume NULL rather than propagating it.
- `COUNT_STAR` and `COUNT(*) ignoring nulls` via `needToHandleNulls`.
- `CONSTANT_OR_NULL` has custom null logic.

The per-position null check is done by `ValueVector::isNull(pos)` inside the executor's
inner loop.

---

## Type Inference at Bind Time

`ScalarOrAggregateFunction::bindFunc` is optional. When absent, the return type is taken from
`ScalarFunction::returnTypeID` and no further type inference is needed. When present, `bindFunc`
receives the resolved argument expressions and the current `ClientContext`, and may:

1. Inspect `arguments[i]->dataType` to determine the exact return type (e.g. `LIST_SORT` returns
   the same list type as input).
2. Mutate `definition->parameterTypeIDs` to specialise overloads (e.g. `COLLECT` sets
   `parameterTypeIDs[0]` to the actual input element type).
3. Return a `FunctionBindData` subclass carrying per-call state (e.g. `StructExtractBindData`
   with the resolved field index).

---

## Function Resolution Order

1. Exact match on name + parameter types.
2. Widening match: numeric types are widened (INT8 → INT64 → DOUBLE) until a match is found.
3. If `returnTypeID == ANY`, the bind function is called for the first matching overload to
   determine the actual return type.
4. If no match is found, `ExtensionManager::lookupExtensionsByFunctionName` is consulted for
   a hint.
