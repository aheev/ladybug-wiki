# Expression Evaluator

**Source files:** `src/expression_evaluator/`, `src/include/expression_evaluator/`, `src/function/`

## Role

The expression evaluator is the runtime component that executes **bound expressions** on `DataChunk`s. Given a DataChunk with N rows, it evaluates an expression and writes the result into an output `ValueVector`.

## Evaluator Types

```cpp
// expression_evaluator.h
class ExpressionEvaluator {
    virtual void evaluate() = 0;
    // output vector is pre-allocated; evaluate() fills it for the current DataChunk
    ValueVector* resultVector;
};
```

Concrete evaluators (one per expression type):

| Evaluator | Expression Type |
|-----------|----------------|
| `LiteralExpressionEvaluator` | constants (`42`, `'hello'`) |
| `ReferenceExpressionEvaluator` | column references (`p.age`) |
| `FunctionExpressionEvaluator` | scalar functions (`toLower(p.name)`) |
| `CaseExpressionEvaluator` | `CASE WHEN ... THEN ... END` |
| `ListComprehensionEvaluator` | `[x IN list | x + 1]` |
| `PatternPredicateEvaluator` | `EXISTS { MATCH ... }` |

## Scalar Function Execution

Scalar functions are called in vectorized batches:

```cpp
// function_expression_evaluator.cpp
void FunctionExpressionEvaluator::evaluate() {
    // 1. Evaluate child expressions (function arguments)
    for (auto& child : children) {
        child->evaluate();
    }
    // 2. Execute the scalar function on the output vectors
    function->execFunc(
        resultVector,         // output
        childResultVectors,   // inputs
        resultVector->state->selVector->selectedSize  // row count
    );
}
```

Each scalar function (`ScalarFunction`) stores a function pointer:

```cpp
struct ScalarFunction {
    using execFunc = function<void(ValueVector*, vector<ValueVector*>&, uint32_t)>;
    execFunc exec;  // vectorized implementation
    bool isVarLength;  // true for functions like coalesce(a, b, c, ...)
};
```

## Worked Example: Vectorized Add

```cpp
// Function: intAdd(a: INT64, b: INT64) → INT64
void intAddExec(ValueVector* result, vector<ValueVector*>& inputs, uint32_t count) {
    auto* a = (int64_t*)inputs[0]->valueBuffer.get();
    auto* b = (int64_t*)inputs[1]->valueBuffer.get();
    auto* r = (int64_t*)result->valueBuffer.get();

    auto& sel = *result->state->selVector;
    if (sel.isUnfiltered()) {
        // Fast path: SIMD-friendly sequential loop
        for (uint32_t i = 0; i < count; i++) {
            r[i] = a[i] + b[i];
        }
    } else {
        // Filtered path: only selected positions
        for (uint32_t i = 0; i < count; i++) {
            auto pos = sel.selectedPositions[i];
            r[pos] = a[pos] + b[pos];
        }
    }
    // NULL propagation: result[i] is NULL if a[i] or b[i] is NULL
    result->nullMask.orWith(inputs[0]->nullMask);
    result->nullMask.orWith(inputs[1]->nullMask);
}
```

## Filter Expression Evaluation

WHERE predicates are evaluated by the `FilterOperator` using the expression evaluator, then used to update the `SelectionVector`:

```cpp
// filter.cpp
void Filter::execute(ExecutionContext& context) {
    // 1. Evaluate predicate → fill boolVector with true/false per row
    predEvaluator->evaluate();

    // 2. Update selVector: keep only rows where predicate = true
    auto& sel = *dataChunk->state->selVector;
    uint32_t newCount = 0;
    for (uint32_t i = 0; i < sel.selectedSize; i++) {
        auto pos = sel.selectedPositions[i];
        if (!boolVector->isNull(pos) && boolVector->getValue<bool>(pos)) {
            sel.selectedPositions[newCount++] = pos;
        }
    }
    sel.selectedSize = newCount;
}
```

After the filter, downstream operators see only the surviving rows via the updated `selVector`.

## Aggregate Expression Evaluation

Aggregate functions (`count`, `sum`, `avg`, `min`, `max`) are evaluated in two phases:

### Phase 1: Update (per DataChunk)

```cpp
// aggregate_hash_table.cpp
void AggregateHashTable::update(DataChunk& dataChunk) {
    // For each row in the DataChunk:
    for (uint32_t i = 0; i < sel.selectedSize; i++) {
        auto pos = sel.selectedPositions[i];
        // Hash the group-by keys to find the aggregate slot
        auto bucket = hashGroupByKeys(dataChunk, pos);
        // Update the aggregate for this bucket:
        //   count(*): bucket.count++
        //   sum(x):   bucket.sum += x[pos]
        //   min(x):   bucket.min = min(bucket.min, x[pos])
        updateAggregate(bucket, dataChunk, pos);
    }
}
```

### Phase 2: Finalize (single thread, after all threads combine)

```cpp
void AggregateHashTable::finalize() {
    // For avg: finalize() computes sum/count per bucket
    for (auto& bucket : buckets) {
        if (aggregateFunction.type == AVG) {
            bucket.result = bucket.sum / bucket.count;
        }
    }
}
```

## Expression Tree

The evaluator is built recursively from the bound expression tree:

```
count(friend.name) with GROUP BY p.age

Evaluator tree:
  AggregateExpressionEvaluator [count(friend.name)]
    └─ ReferenceExpressionEvaluator [friend.name → ValueVector ref]

GROUP BY key evaluator:
  ReferenceExpressionEvaluator [p.age → ValueVector ref]
```

## Related Files

- `src/expression_evaluator/expression_evaluator.cpp` — base class, factory
- `src/expression_evaluator/function_expression_evaluator.cpp` — scalar fn eval
- `src/function/` — all scalar and aggregate function implementations
- `src/include/function/scalar_function.h` — ScalarFunction struct with execFunc
- `src/processor/operator/filter.cpp` — filter with SelectionVector update
- `src/processor/operator/aggregate/` — aggregate hash table, combine/finalize
