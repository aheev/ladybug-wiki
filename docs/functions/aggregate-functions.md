# Aggregate Functions

**Source files:**
- `src/include/function/aggregate_function.h` — `AggregateState`, `AggregateFunction` structs
- `src/function/aggregate/` — all aggregate implementations
- `src/function/function_collection.cpp` — canonical registration list

---

## Overview

Aggregate functions consume a set of rows and produce a single summary value per group. In
Cypher they appear in `RETURN` or `WITH` clauses after a `GROUP BY` or when all result columns
are aggregates.

LadybugDB's aggregate infrastructure is defined in
`src/include/function/aggregate_function.h`. There are **eight** built-in aggregate functions:
`COUNT(*)`, `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `COLLECT`, and `PERCENTILE_DISC`.

---

## Core Types

### `AggregateState`

```cpp
struct AggregateState {
    virtual uint32_t getStateSize() const = 0;
    virtual void     writeToVector(ValueVector* outputVector, uint64_t pos) const = 0;
    virtual ~AggregateState() = default;
};
```

`getStateSize()` returns the number of bytes needed to hold one instance of the state. The
aggregation operator pre-allocates a flat buffer of size `numGroups × getStateSize()` and casts
raw pointers to `AggregateState*` for each group.

`writeToVector` materialises the accumulated state for one group into an output `ValueVector`
at position `pos`.

### `AggregateStateWithNull`

```cpp
struct AggregateStateWithNull : public AggregateState {
    bool isNull = true;   // group has not seen any non-NULL input yet
};
```

All aggregate states except `CountStarState` extend `AggregateStateWithNull`. The `isNull`
flag ensures that `SUM`, `AVG`, `MIN`, `MAX`, and `COLLECT` return NULL for groups that
contained only NULLs (or no rows at all), consistent with SQL NULL semantics.

---

## The Five-Function Protocol

Every `AggregateFunction` carries five function pointers:

```cpp
struct AggregateFunction : public ScalarOrAggregateFunction {
    // 1. Called once per group to zero-initialise the state
    agg_initialize_t  initializeFunc;

    // 2. Vectorized accumulate: processes a full DataChunk of input rows
    agg_update_all_t  updateAllFunc;

    // 3. Positional accumulate: processes selected row positions only
    agg_update_pos_t  updatePosFunc;

    // 4. Merges a partial state (src) into an accumulator state (dst)
    //    Used for parallel aggregation and DISTINCT aggregation
    agg_combine_t     combineFunc;

    // 5. Writes the final result for one group to an output vector
    agg_finalize_t    finalizeFunc;

    // Optional: rewrites expression arguments at bind time (for node/rel types)
    agg_param_rewrite_t paramRewriteFunc;

    bool needToHandleNulls = false; // if true, NULLs are passed to updateAllFunc
    bool isDistinct        = false; // if true, duplicates are eliminated before update
};
```

### Type aliases

```cpp
using agg_initialize_t   = std::function<void(uint8_t* state)>;
using agg_update_all_t   = std::function<void(uint8_t* state, ValueVector* input,
                               uint64_t multiplicity, uint64_t numRows)>;
using agg_update_pos_t   = std::function<void(uint8_t* state, ValueVector* input,
                               uint64_t multiplicity, uint64_t pos)>;
using agg_combine_t      = std::function<void(uint8_t* dst, uint8_t* src,
                               InMemOverflowBuffer* overflowBuffer)>;
using agg_finalize_t     = std::function<void(uint8_t* state, ValueVector* result,
                               uint64_t pos, InMemOverflowBuffer* overflowBuffer)>;
using agg_param_rewrite_t= std::function<expression_vector(
                               const expression_vector& params,
                               const Catalog& catalog,
                               transaction::Transaction* transaction)>;
```

### Execution flow

```
Query start
│
├── For each group G:
│   └── initializeFunc(statePtr[G])
│
├── For each input DataChunk:
│   ├── Determine group IDs for each row
│   └── updateAllFunc(statePtr[G], inputVector, multiplicity, numRows)
│       or updatePosFunc per row when positions are scattered
│
├── (Parallel): after each thread finishes its partition
│   └── combineFunc(dstState, srcState, overflowBuffer)
│
└── For each group G in output:
    └── finalizeFunc(statePtr[G], outputVector, pos, overflowBuffer)
```

### `needToHandleNulls`

When `needToHandleNulls = false` (the default), the aggregation operator pre-filters NULL
inputs: `updateAllFunc` is never called with a NULL value at any row position.

When `needToHandleNulls = true`, NULL values **are** passed through. Only `CountFunction`
and `CountStarFunction` set this flag, because they must count NULL rows
(`COUNT(*)` counts all rows; `COUNT(x)` counts non-NULL values which is handled specially).

### `isDistinct`

When `isDistinct = true`, the aggregation operator inserts a deduplication step before
calling `updateAllFunc`. An auxiliary hash table tracks which values have already been seen
for each group; duplicate rows are discarded. This is used for `COUNT(DISTINCT x)`,
`SUM(DISTINCT x)`, etc.

### `paramRewriteFunc`

Called at bind time to rewrite the aggregate's argument expressions. Used to handle node and
relationship types: `COUNT(n)` is rewritten to `COUNT(n._id)`, and
`COLLECT(r)` is rewritten to `COLLECT(r._id)`. This allows the aggregate to work on
primitive types rather than complex node/rel types.

```cpp
// Example rewrite rule (simplified from CountFunction)
auto paramRewriteFunc = [](const expression_vector& params, const Catalog&, Transaction*) {
    // If the first param is a node/rel, extract its internal ID
    if (params[0]->expressionType == NODE || params[0]->expressionType == REL) {
        return expression_vector{extractID(params[0])};
    }
    return params;
};
```

---

## COUNT(*)

**Source:** `src/function/aggregate/count_star.cpp`
**Registration:** `CountStarFunction`

```
COUNT(*) → INT64
```

The simplest aggregate. Counts all rows in a group including NULLs.

### State

```cpp
struct CountStarState : public AggregateState {
    int64_t count = 0;
    uint32_t getStateSize() const override { return sizeof(CountStarState); }
    void writeToVector(ValueVector* out, uint64_t pos) const override {
        out->setValue(pos, count);
    }
};
```

Notice: **does not** extend `AggregateStateWithNull` — result is always 0 or more, never NULL.

### Key details

- `needToHandleNulls = true` — it must see all rows.
- `updateAllFunc` adds `numRows` to `count`.
- `combineFunc` adds src's count into dst's count.
- Multiplicity support: `updateAllFunc` uses `count += multiplicity * numRows`, enabling
  hash-join multiplicity compression.

---

## COUNT

**Source:** `src/function/aggregate/count.cpp`
**Registration:** `CountFunction`

```
COUNT(ANY) → INT64
```

Counts non-NULL input values. The aggregate engine still passes all rows (including NULLs)
because `needToHandleNulls = true`, but `updateAllFunc` explicitly checks and skips NULLs.

### State

Reuses `CountStarState` (count field only, never NULL output).

### Key details

- `paramRewriteFunc` rewrites node/rel arguments to their `._id` property.
- `COUNT(DISTINCT x)` is supported via `isDistinct = true` on a separate registration.
- The two registrations are returned as overloads from `CountFunction::getFunctionSet()`.

### Distinct variant behaviour

When `isDistinct = true`, the operator:
1. Collects all input values for a group into a hash set.
2. Calls `updateAllFunc` once per unique value (with `multiplicity = 1`).

---

## SUM

**Source:** `src/function/aggregate/sum.h` (template)
**Registration:** `SumFunction`

```
SUM(numeric T) → T
```

Templated over the numeric type. Overloads are registered for:
INT8, INT16, INT32, INT64, INT128, UINT8, UINT16, UINT32, UINT64, UINT128, FLOAT, DOUBLE

### State

```cpp
template<typename T>
struct SumState : public AggregateStateWithNull {
    T sum;
    // ...
};
```

`isNull` starts `true`; first non-NULL input sets `isNull = false` and `sum`.
Subsequent values add to `sum`.

### Key details

- `updateAllFunc` adds each non-NULL value to `sum`.
- `combineFunc` adds `src.sum` to `dst.sum` if `src.isNull == false`.
- `finalizeFunc` writes NULL if `isNull == true`, otherwise writes `sum`.
- `SUM(DISTINCT x)` deduplicates before summing.

---

## AVG

**Source:** `src/function/aggregate/avg.h` (template)
**Registration:** `AvgFunction`

```
AVG(numeric T) → DOUBLE
```

AVG always returns DOUBLE regardless of input type. Templated on the summand type T.
Overloads for the same types as SUM.

### State

```cpp
template<typename T>
struct AvgState : public AggregateStateWithNull {
    double sum   = 0.0;
    uint64_t cnt = 0;
};
```

### Key details

- `updateAllFunc` accumulates `sum += (double)value` and `cnt++` per non-NULL input.
- `combineFunc` adds `src.sum` and `src.cnt` into dst.
- `finalizeFunc`: result = `sum / cnt`; writes NULL if `cnt == 0` (i.e., `isNull`).

---

## MIN / MAX

**Source:** `src/function/aggregate/min_max.cpp`
**Registration:** `MinFunction`, `MaxFunction`

```
MIN(T) → T   where T is any comparable type
MAX(T) → T
```

Supports all orderable types: numeric, STRING, DATE, TIMESTAMP, INTERVAL, BOOL, BLOB, UUID.

### State

```cpp
template<typename T>
struct MinMaxState : public AggregateStateWithNull {
    T val;
};
```

Uses template specialisation for each type; STRING specialisation stores the string value
in the group's per-row memory (not the overflow buffer — strings are compared in-place).

### Key details

- `updateAllFunc` performs a type-appropriate `val = min(val, input)` / `val = max(val, input)`.
- `combineFunc` merges the two extrema.
- `finalizeFunc` writes NULL if `isNull`, otherwise writes `val`.
- Overloads cover `ANY` — the function catalog returns the overload with the exact input type
  at bind time.

---

## COLLECT

**Source:** `src/function/aggregate/collect.cpp`
**Registration:** `CollectFunction`

```
COLLECT(T) → LIST(T)
```

Accumulates all non-NULL input values into a list. The result type is always
`LIST(inputElementType)`.

### State

```cpp
struct CollectState : public AggregateStateWithNull {
    list_entry_t listEntry;   // (offset, size) into the overflow buffer
    // The actual data lives in the InMemOverflowBuffer
};
```

The collected values are stored as an **intrusive singly-linked list** over
`InMemOverflowBuffer`. Each appended element is allocated directly into the overflow buffer,
and the list entry grows by one.

### Key details

- `updateAllFunc` appends one element per non-NULL input row. For list/struct/nested types,
  the entire nested value is deep-copied into the overflow buffer.
- `combineFunc` transfers ownership of the src list into dst by splicing the two linked
  lists: the tail pointer of dst's list is updated to point to the head of src's list.
  No data is copied — only the list linkage is updated. This makes `combine` O(1).
- `finalizeFunc`:
  1. Sorts the linked list into a contiguous vector (one allocation in the overflow buffer).
  2. Writes the `list_entry_t` reference into the output `ValueVector`.
  3. The output vector's child vector points into the same overflow buffer region.
- `paramRewriteFunc` rewrites node/rel inputs to their `._id` property.
- `bindFunc` sets `returnTypeID` to `LIST(inputType)` dynamically.

### Overflow buffer lifecycle

`InMemOverflowBuffer` is owned by the aggregation operator and shared across all partial
states for a query. It is arena-allocated and grows by doubling. The buffer is kept alive
until the output `DataChunk` is consumed and cleared.

---

## PERCENTILE_DISC

**Source:** `src/function/aggregate/percentile_disc.cpp`
**Registration:** `PercentileDiscFunction`

```
PERCENTILE_DISC(percentile DOUBLE) WITHIN GROUP (ORDER BY value T) → T
```

In Cypher syntax:
```cypher
RETURN percentiledisc(n.score, 0.5)  // median
```

The percentile argument must be a **literal double** at bind time (0.0 to 1.0 inclusive).
This is enforced by `bindFunc`, which extracts the literal value and stores it in
`PercentileDiscBindData::percentile`.

### State

```cpp
struct PercentileDiscState : public AggregateStateWithNull {
    // Accumulated values stored as a linked list over InMemOverflowBuffer
    uint64_t numValues = 0;
    uint8_t* listHead  = nullptr;  // singly-linked list of value nodes
};
```

### Key details

- `updateAllFunc` appends each non-NULL value into the overflow buffer as a linked-list node.
  The node stores both the value and a pointer to the next node.
- `combineFunc` splices src's linked list onto dst's list (O(1), same as COLLECT).
- `finalizeFunc`:
  1. Traverses the linked list into a temporary `std::vector<T>`.
  2. Calls `std::sort` on the vector.
  3. Picks the element at index `ceil(percentile * numValues) - 1` (clamped to
     `[0, numValues - 1]`).
  4. Writes the selected value to the output vector; writes NULL if no values were accumulated.
- Supports numeric types: INT8–INT128, UINT8–UINT128, FLOAT, DOUBLE.
- There is no `PERCENTILE_CONT` (continuous interpolation) function currently registered.

### Example

```cypher
MATCH (n:Product)
RETURN percentiledisc(n.price, 0.9)  // 90th percentile price
```

The second argument (`0.9`) is evaluated at bind time. Passing a column reference instead of
a literal will produce a bind-time error.

---

## Registering a Custom Aggregate Function

The full `AggregateFunction` constructor signature:

```cpp
AggregateFunction(
    std::string                name,
    std::vector<LogicalTypeID> parameterTypeIDs,
    LogicalTypeID              returnTypeID,
    std::unique_ptr<AggregateState> (*stateFactory)(),
    agg_initialize_t           initializeFunc,
    agg_update_all_t           updateAllFunc,
    agg_update_pos_t           updatePosFunc,
    agg_combine_t              combineFunc,
    agg_finalize_t             finalizeFunc,
    bool                       needToHandleNulls = false,
    agg_param_rewrite_t        paramRewriteFunc  = nullptr,
    func_bind_t                bindFunc          = nullptr
);
```

Minimal example — a `PRODUCT` aggregate:

```cpp
struct ProductState : public AggregateStateWithNull {
    double product = 1.0;
    uint32_t getStateSize() const override { return sizeof(ProductState); }
    void writeToVector(ValueVector* out, uint64_t pos) const override {
        if (isNull) out->setNull(pos, true);
        else out->setValue(pos, product);
    }
};

AggregateFunction productFunc(
    "PRODUCT",
    {LogicalTypeID::DOUBLE},
    LogicalTypeID::DOUBLE,
    /*init*/ [](uint8_t* s) { new(s) ProductState(); },
    /*updateAll*/ [](uint8_t* s, ValueVector* input, uint64_t mult, uint64_t n) {
        auto& state = *reinterpret_cast<ProductState*>(s);
        for (uint64_t i = 0; i < n; i++) {
            if (!input->isNull(i)) {
                state.isNull = false;
                state.product *= input->getValue<double>(i);
            }
        }
    },
    /*updatePos*/ [](uint8_t* s, ValueVector* input, uint64_t mult, uint64_t pos) {
        auto& state = *reinterpret_cast<ProductState*>(s);
        if (!input->isNull(pos)) {
            state.isNull = false;
            state.product *= input->getValue<double>(pos);
        }
    },
    /*combine*/ [](uint8_t* dst, uint8_t* src, InMemOverflowBuffer*) {
        auto& d = *reinterpret_cast<ProductState*>(dst);
        auto& s = *reinterpret_cast<ProductState*>(src);
        if (!s.isNull) {
            d.isNull = false;
            d.product *= s.product;
        }
    },
    /*finalize*/ [](uint8_t* s, ValueVector* out, uint64_t pos, InMemOverflowBuffer*) {
        reinterpret_cast<ProductState*>(s)->writeToVector(out, pos);
    }
);
```

---

## DISTINCT Aggregation

DISTINCT aggregation (`COUNT(DISTINCT x)`) is implemented at the operator level, not inside
the `AggregateFunction` itself. The `HashAggregateOp` detects `isDistinct = true` and inserts
a per-group hash set before calling `updateAllFunc`. For functions where `isDistinct` makes
sense, the function catalog registers two overloads:

```cpp
// Non-distinct
AggregateFunction nonDistinct("COUNT", {ANY}, INT64, ..., isDistinct = false);
// Distinct
AggregateFunction distinct("COUNT", {ANY}, INT64, ..., isDistinct = true);
```

The binder inspects the Cypher expression (`DISTINCT` keyword) to select the correct overload.

---

## Parallel Aggregation

The aggregation operator uses a two-phase approach for parallel query execution:

**Phase 1 — Parallel partial aggregation**
- Each worker thread processes its own partition of the input.
- `initializeFunc` and `updateAllFunc`/`updatePosFunc` are called per thread.
- Each thread produces a partial `AggregateHashTable`.

**Phase 2 — Combine**
- A single merge thread iterates over the partial hash tables.
- For matching group keys, `combineFunc` merges the partial state into the global state.
- For non-matching keys, the partial state is moved as-is.

`combineFunc` for most aggregates is O(1) or O(state size). `COLLECT` and `PERCENTILE_DISC`
are both O(1) due to the linked-list splice trick.

---

## Type Coverage Summary

| Function | Supported input types |
|----------|-----------------------|
| `COUNT(*)` | (none — counts rows) |
| `COUNT` | ANY |
| `SUM` | INT8–INT128, UINT8–UINT128, FLOAT, DOUBLE |
| `AVG` | INT8–INT128, UINT8–UINT128, FLOAT, DOUBLE |
| `MIN` | All comparable types (numeric, STRING, DATE, TIMESTAMP, INTERVAL, BOOL, BLOB, UUID) |
| `MAX` | Same as MIN |
| `COLLECT` | ANY (result is LIST of input type) |
| `PERCENTILE_DISC` | INT8–INT128, UINT8–UINT128, FLOAT, DOUBLE |

---

## NULL Semantics Summary

| Function | NULL input rows | Empty group |
|----------|----------------|-------------|
| `COUNT(*)` | Counted | Returns 0 |
| `COUNT(x)` | Skipped | Returns 0 |
| `SUM` | Skipped | Returns NULL |
| `AVG` | Skipped | Returns NULL |
| `MIN` | Skipped | Returns NULL |
| `MAX` | Skipped | Returns NULL |
| `COLLECT` | Skipped | Returns `[]` (empty list) |
| `PERCENTILE_DISC` | Skipped | Returns NULL |

These semantics follow the SQL standard for aggregate NULL handling.
