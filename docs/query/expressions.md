# Expression Evaluator

**Source files:** `src/expression_evaluator/`, `src/include/expression_evaluator/`, `src/processor/map/expression_mapper.cpp`

## What This Document Covers

This document is the complete reference for the LadybugDB expression evaluation subsystem. It covers the `ExpressionEvaluator` class hierarchy, the `ExpressionMapper` translation layer that converts bound logical expressions into runtime evaluators, per-evaluator behavior, NULL handling, and the `evaluate()` / `select()` API. For how the physical planner uses `ExpressionMapper`, see [Physical Planner](./physical-planner.md).

---

## Overview

The expression evaluator is the runtime component that executes expressions over vectorized data. Given a `DataChunk` (a batch of up to 2048 rows), an expression evaluator writes its result into an output `ValueVector`.

**Key design invariants:**
1. Evaluators form a tree mirroring the expression tree — each leaf is a literal or reference, each internal node is a function, case, or lambda.
2. `evaluate()` writes to `resultVector` for all active rows in the current chunk.
3. `select()` writes matching row indices into a `SelectionVector` (short-circuit evaluation for filters).
4. Evaluators are **not** reentrant — they hold mutable state (current result vector, lambda param bindings) and are per-thread.

---

## Base Class: `ExpressionEvaluator`

```cpp
// src/include/expression_evaluator/expression_evaluator.h
namespace kuzu::evaluator {

class ExpressionEvaluator {
public:
    // Type tag for fast downcasting without dynamic_cast
    EvaluatorType evaluatorType;

    // The result of evaluate() is always written here
    std::shared_ptr<common::ValueVector> resultVector;

    // Core API
    virtual void init(const processor::ResultSet& resultSet,
                      main::ClientContext* context) = 0;
    virtual void evaluate() = 0;
    virtual bool select(common::SelectionVector& selVector) = 0;

    // Children (sub-expressions)
    std::vector<std::unique_ptr<ExpressionEvaluator>> children;

    // Schema expression (for debugging / EXPLAIN output)
    std::shared_ptr<binder::Expression> expression;

    // Is this a constant expression? (literal or all-constant inputs)
    bool isResultFlat() const;

protected:
    // Called by init(): recursively initializes children, then calls initInternal
    void initChildren(const processor::ResultSet& resultSet, main::ClientContext* context);
    virtual void initInternal(const processor::ResultSet& resultSet,
                              main::ClientContext* context) {}
};

} // namespace kuzu::evaluator
```

### `EvaluatorType` Enum

```cpp
enum class EvaluatorType : uint8_t {
    CASE_ELSE   = 0,  // CaseExpressionEvaluator
    FUNCTION    = 1,  // FunctionExpressionEvaluator
    LAMBDA_PARAM = 2, // LambdaParamEvaluator
    LIST_LAMBDA  = 3, // ListLambdaEvaluator
    LITERAL     = 4,  // LiteralExpressionEvaluator
    PATH        = 5,  // PathExpressionEvaluator
    NODE_REL    = 6,  // PatternExpressionEvaluator (node or rel)
    // 7 is intentionally absent in current code
    REFERENCE   = 8,  // ReferenceExpressionEvaluator
};
```

Note: value `7` does not appear in the current codebase — this is an artifact of historical refactoring.

---

## `ReferenceExpressionEvaluator` (type 8)

**Source:** `src/include/expression_evaluator/reference_evaluator.h`

```cpp
class ReferenceExpressionEvaluator final : public ExpressionEvaluator {
    processor::DataPos dataPos;  // where to find the value in the ResultSet
public:
    void initInternal(const processor::ResultSet& resultSet, ...) override {
        // Bind resultVector to the existing ValueVector in the ResultSet at dataPos
        resultVector = resultSet.getValueVector(dataPos);
    }
    void evaluate() override {}  // No-op: resultVector IS the upstream vector
    bool select(SelectionVector& sel) override {
        // For boolean vectors: copy active true indices into sel
    }
};
```

`ReferenceExpressionEvaluator` is the most common evaluator — it handles any expression that was computed by an upstream operator. Rather than copying values, it makes `resultVector` an alias of the upstream `ValueVector` via `DataPos` lookup. `evaluate()` is a no-op.

**Created by `ExpressionMapper` when:** `schema->isExpressionInScope(*expression)` returns true — i.e., the expression is already available in the current input schema.

---

## `LiteralExpressionEvaluator` (type 4)

**Source:** `src/include/expression_evaluator/literal_evaluator.h`

```cpp
class LiteralExpressionEvaluator final : public ExpressionEvaluator {
    common::Value literal;
public:
    void initInternal(const processor::ResultSet& resultSet, ...) override {
        // Creates a flat (capacity=1) ValueVector and writes the literal value once
        resultVector = std::make_shared<ValueVector>(literal.getDataType(), ...);
        resultVector->setFlat(true);
        copyToResultVector(literal);
    }
    void evaluate() override {}  // No-op: the value never changes
    bool select(SelectionVector& sel) override;
};
```

**Flat vector optimization:** Because a literal has exactly one value, the result vector is always flat (1-element). Operations on a flat vector can skip the loop over 2048 elements and just apply the scalar. The function executor infrastructure (`UnaryFunctionExecutor`, `BinaryFunctionExecutor`) detects flat inputs and handles them specially.

**Also used for:** `PARAMETER` expressions — the parameter's bound `Value` is treated as a literal.

---

## `FunctionExpressionEvaluator` (type 1)

**Source:** `src/include/expression_evaluator/function_evaluator.h`, `src/expression_evaluator/function_evaluator.cpp`

```cpp
class FunctionExpressionEvaluator final : public ExpressionEvaluator {
    function::ScalarFunction function;  // the compiled scalar function
public:
    void evaluate() override {
        // First evaluate all children:
        for (auto& child : children) child->evaluate();
        // Then execute the scalar function over all active rows:
        function.execFunc(getInputVectors(), *resultVector, ...);
    }
    bool select(SelectionVector& sel) override {
        // For comparison/boolean functions:
        for (auto& child : children) child->evaluate();
        if (function.selectFunc) {
            return function.selectFunc(getInputVectors(), sel);
        }
        // Fallback: evaluate then filter by true values
        evaluate();
        return selectFromResultVector(sel);
    }
};
```

`ScalarFunction` holds:
- `execFunc`: the vectorized execution function `(inputs, output, numValues) → void`
- `selectFunc` (optional): optimized boolean-producing function that writes to a `SelectionVector` directly, avoiding materializing intermediate booleans
- `compileFunc` (optional): called during `init()` to do type-specific JIT or specialization

**Children evaluation is always top-down.** For a binary comparison like `a.age > 30`, both `a.age` (ReferenceEvaluator) and `30` (LiteralEvaluator) are evaluated first, then the `>` function runs.

**Short-circuit via `selectFunc`:** Comparison functions (`=`, `<`, `>`, `<>`, `<=`, `>=`) provide a `selectFunc` that writes matching row indices into the `SelectionVector` without writing a boolean vector, saving one pass through memory.

---

## `CaseExpressionEvaluator` (type 0)

**Source:** `src/include/expression_evaluator/case_evaluator.h`, `src/expression_evaluator/case_evaluator.cpp`

```cpp
struct CaseAlternativeEvaluator {
    std::unique_ptr<ExpressionEvaluator> whenEvaluator;
    std::unique_ptr<ExpressionEvaluator> thenEvaluator;
};

class CaseExpressionEvaluator final : public ExpressionEvaluator {
    std::vector<CaseAlternativeEvaluator> alternativeEvaluators;
    std::unique_ptr<ExpressionEvaluator> elseEvaluator;

    // Internal fill vectors for per-case handling
    std::shared_ptr<ValueVector> trueSelectedVector;    // rows where WHEN was true
    std::shared_ptr<ValueVector> falseSelectedVector;   // rows where WHEN was false

    void evaluate() override;
};
```

**Lazy evaluation per WHEN clause:** The evaluator processes one WHEN clause at a time. For each clause:
1. Run `whenEvaluator.select(trueSelected)` → rows where the WHEN condition is true.
2. For those rows only, run `thenEvaluator.evaluate()` and write to `resultVector`.
3. Repeat with `falseSelected` as the current active set for the next WHEN clause.
4. After all WHEN clauses, evaluate `elseEvaluator` for remaining unhandled rows.

This ensures THEN clauses are never evaluated for rows where their WHEN condition was false — important when THEN contains side effects or expensive computations.

---

## `PatternExpressionEvaluator` (`NODE_REL`, type 6)

**Source:** `src/include/expression_evaluator/pattern_evaluator.h`, `src/expression_evaluator/pattern_evaluator.cpp`

```cpp
class PatternExpressionEvaluator final : public ExpressionEvaluator {
    // Evaluators for each property column of the node/rel
    std::vector<std::unique_ptr<ExpressionEvaluator>> propertyEvaluators;
    // Whether each property is available or must be null-filled
    std::vector<bool> propertyIsAvailable;

    void evaluate() override {
        // For each property:
        for (size_t i = 0; i < propertyEvaluators.size(); i++) {
            if (propertyIsAvailable[i]) {
                propertyEvaluators[i]->evaluate();
                // copy to struct field
            } else {
                // fill with NULL
            }
        }
    }
};
```

Used for `NODE` and `REL` pattern expressions — i.e., when a query explicitly returns a node or relationship object (e.g., `RETURN a`). The evaluator assembles the node/rel struct from its constituent property evaluators.

For undirected relationships (which appear in two directions), a separate `UndirectedRelExpressionEvaluator` handles the direction-swap logic.

---

## `PathExpressionEvaluator` (type 5)

**Source:** `src/include/expression_evaluator/path_evaluator.h`, `src/expression_evaluator/path_evaluator.cpp`

```cpp
class PathExpressionEvaluator final : public ExpressionEvaluator {
    // Node evaluators (alternating node, rel, node, rel, ... node)
    std::vector<std::unique_ptr<ExpressionEvaluator>> nodeEvaluators;
    std::vector<std::unique_ptr<ExpressionEvaluator>> relEvaluators;
    // Intermediate lists for path construction
    std::shared_ptr<ValueVector> nodeIDsVector;
    std::shared_ptr<ValueVector> relIDsVector;

    void evaluate() override;
};
```

`PathExpressionEvaluator` evaluates a `PATH` expression — the result of a path pattern like `p = (a)-[r]->(b)`. It assembles the path by:
1. Evaluating node evaluators → populating `nodeIDsVector`.
2. Evaluating rel evaluators → populating `relIDsVector`.
3. Constructing a LIST struct output (alternating node IDs and rel IDs).

For variable-length paths (`-[*1..5]->`), the path is constructed from the factorized table results produced by `RecursiveExtend`.

---

## `LambdaParamEvaluator` (type 2) and `ListLambdaEvaluator` (type 3)

**Source:** `src/include/expression_evaluator/lambda_evaluator.h`, `src/expression_evaluator/lambda_evaluator.cpp`

### `LambdaParamEvaluator`

```cpp
class LambdaParamEvaluator final : public ExpressionEvaluator {
    // resultVector is set externally by the parent ListLambdaEvaluator
    // before evaluate() is called on the lambda body
    void evaluate() override {} // resultVector is already set by parent
};
```

`LambdaParamEvaluator` is a leaf that represents a lambda parameter (e.g., `x` in `list_transform(lst, x -> x + 1)`). The parent `ListLambdaEvaluator` sets the `resultVector` to point at the current element's vector before evaluating the lambda body.

### `ListLambdaEvaluator`

```cpp
class ListLambdaEvaluator final : public ExpressionEvaluator {
    std::unique_ptr<ExpressionEvaluator> lambdaRootEvaluator; // the lambda body
    // For each row in the input list:
    void evaluate() override {
        listEvaluator->evaluate();   // evaluate the list argument first
        auto& listVector = listEvaluator->resultVector;
        for (uint64_t i = 0; i < listVector->state->getNumSelectedValues(); i++) {
            uint64_t rowIdx = listVector->state->selVector->selectedPositions[i];
            auto [offset, size] = listVector->getListInfo(rowIdx);
            for (auto elemIdx = offset; elemIdx < offset + size; elemIdx++) {
                // bind lambdaParam.resultVector to the current element
                for (auto& paramEval : lambdaParamEvaluators) {
                    paramEval->resultVector = /* current element vector slice */;
                }
                lambdaRootEvaluator->evaluate();
                // write result into output list at rowIdx
            }
        }
    }
};
```

This per-element loop over the list is the "inner evaluation" loop of list lambda functions. It is always sequential within a row's list (no vectorized parallelism at the lambda level).

---

## `ExpressionMapper`: Logical → Runtime Translation

`ExpressionMapper` (`src/processor/map/expression_mapper.cpp`) is the bridge between bound logical expressions (`binder::Expression`) and runtime evaluators (`evaluator::ExpressionEvaluator`).

### Dispatch Priority

```
getEvaluator(expression):
  1. schema == nullptr           → getConstantEvaluator (only literals/parameters)
  2. isExpressionInScope         → ReferenceExpressionEvaluator (DataPos lookup)
  3. LITERAL                     → LiteralExpressionEvaluator
  4. isNodePattern(expr)         → PatternExpressionEvaluator (node struct assembly)
  5. isRelPattern(expr)          → PatternExpressionEvaluator or UndirectedRel
  6. PATH                        → PathExpressionEvaluator
  7. PARAMETER                   → LiteralExpressionEvaluator (with param value)
  8. CASE_ELSE                   → CaseExpressionEvaluator
  9. canEvaluateAsFunction(type) → FunctionExpressionEvaluator (all scalar functions,
                                    comparisons, boolean operators, arithmetic, string, etc.)
 10. parentEvaluator != nullptr  → LambdaParamEvaluator
 11.                            → NotImplementedException
```

**Rule 2 (reference check) precedes all others.** If an expression is already in the input schema, it is always accessed as a reference — even if it is a function expression that was computed by an upstream operator. This prevents redundant recomputation.

**Rule 9 (`canEvaluateAsFunction`)** covers:
- `COMPARISON_*` (EQ, NEQ, LT, LTE, GT, GTE)
- `BOOLEAN_*` (AND, OR, NOT, XOR)
- `FUNCTION` (any scalar function)
- `AGGREGATE_FUNCTION` (in contexts where aggregate is evaluated)
- `EXISTS` subquery (in certain plan contexts)
- `IN_LIST` / `NOT_IN_LIST`

### Lambda Sub-Expression Handling

When mapping a function whose second child is a `LAMBDA` expression:
```cpp
if (isFuncWithLambda(expression)) {
    auto listArgEvaluator = getEvaluator(expression->getChild(0));
    auto result = std::make_unique<ListLambdaEvaluator>(expression, {listArgEvaluator});
    // Recursive mapper with parentEvaluator set — so lambda params resolve to LambdaParamEvaluator
    auto lambdaMapper = ExpressionMapper(schema, result.get());
    auto& lambda = expression->getChild(1)->constCast<LambdaExpression>();
    result->setLambdaRootEvaluator(lambdaMapper.getEvaluator(lambda.getFunctionExpr()));
    return result;
}
```

The `parentEvaluator` pointer in the recursive `ExpressionMapper` enables Rule 10 — lambda parameter expressions hit the `LambdaParamEvaluator` path rather than throwing `NotImplementedException`.

---

## NULL Handling

LadybugDB follows SQL three-valued logic (TRUE / FALSE / NULL) for all expression evaluations.

### In `ValueVector`

```cpp
class ValueVector {
    NullMask nullMask;        // one bit per position; 1 = null
    void setNull(uint64_t pos, bool isNull);
    bool isNull(uint64_t pos) const;
};
```

### In `FunctionExpressionEvaluator`

Scalar function executors check null masks and propagate nulls:
- If **any** input is null, the output is null (default for most functions).
- Exceptions: `COALESCE` (first non-null), `IS NULL` / `IS NOT NULL` (return FALSE/TRUE for null inputs), `CASE` (short-circuit to ELSE on null WHEN).

The `UnaryFunctionExecutor` and `BinaryFunctionExecutor` templates handle null propagation generically:
```cpp
template<typename OP>
void BinaryFunctionExecutor::execute(ValueVector& left, ValueVector& right, ValueVector& result) {
    for (uint64_t i = 0; i < numValues; i++) {
        auto pos = selVector[i];
        if (left.isNull(pos) || right.isNull(pos)) {
            result.setNull(pos, true);
        } else {
            result.setNull(pos, false);
            OP::operation(left.getValue<L>(pos), right.getValue<R>(pos), result.getValue<RESULT>(pos));
        }
    }
}
```

### In `select()`

When `select()` is used for filtering, null rows are excluded:
```cpp
bool FunctionExpressionEvaluator::select(SelectionVector& sel) {
    evaluate();
    uint64_t numSelected = 0;
    for (uint64_t i = 0; i < sel.getSelSize(); i++) {
        auto pos = sel.getSelectedPositions()[i];
        if (!resultVector->isNull(pos) && resultVector->getValue<bool>(pos)) {
            sel.getSelectedPositions()[numSelected++] = pos;
        }
    }
    sel.setSelSize(numSelected);
    return numSelected > 0;
}
```

NULL rows are never "selected" — they are treated as false in a WHERE clause, consistent with SQL semantics.

---

## Flat vs. Unflat Vectors and Evaluator Behavior

### Flat vectors

A `ValueVector` is **flat** when it holds exactly one value (position 0) shared across the entire chunk. This occurs when:
- The vector holds a literal.
- The group this vector belongs to was FLATTENed by the `FactorizationRewriter`.

Flat vectors enable short-circuit optimization in `BinaryFunctionExecutor`:
```cpp
if (left.isFlat() && right.isFlat()) {
    // Scalar path: compute once
} else if (left.isFlat()) {
    // Broadcast left scalar across right vector
} else if (right.isFlat()) {
    // Broadcast right scalar across left vector
} else {
    // Full vector path
}
```

### Unflat vectors

An **unflat** vector has up to `DEFAULT_VECTOR_CAPACITY` (2048) active values, indexed by `state->selVector`. Most reference evaluators bound to scan output vectors are unflat.

When a function evaluator receives mixed flat/unflat inputs, the output is unflat (vector-sized), copying the flat input's value for each row.

---

## `evaluate()` vs. `select()` API

| Method | Purpose | Output | Cost |
|--------|---------|--------|------|
| `evaluate()` | Compute expression for all active rows | Writes to `resultVector` | Full vector pass |
| `select(SelectionVector&)` | Find rows where expression is true | Filters `selVector` in-place | Potentially cheaper (selectFunc) |

`select()` is used in:
- `Filter` operator: calls `predicate->select(sel)` to filter the DataChunk in-place.
- `HashJoin` probe: calls join condition evaluator's `select()` to find matching rows.
- `Merge` operator: calls existence mark evaluator's `select()`.

If a `FunctionExpressionEvaluator` has a `selectFunc`, it directly writes matching indices without materializing a boolean vector. If not, it falls back to calling `evaluate()` then scanning the result boolean vector.

---

## Initialization: `init()` and `initInternal()`

Before the first call to `evaluate()` or `select()`, the evaluator tree must be initialized against a concrete `ResultSet`:

```cpp
void ExpressionEvaluator::init(const ResultSet& resultSet, ClientContext* context) {
    initChildren(resultSet, context);  // recurse to all children first
    initInternal(resultSet, context);  // then bind this evaluator's own state
}
```

`initInternal()` by default is a no-op. Subclasses override it to:
- **`ReferenceEvaluator`**: bind `resultVector` to `resultSet.getValueVector(dataPos)`
- **`LiteralEvaluator`**: allocate a flat vector and write the literal value
- **`FunctionEvaluator`**: call `compileFunc` if present (type specialization / JIT)
- **`CaseEvaluator`**: allocate `trueSelectedVector` and `falseSelectedVector` scratch buffers
- **`PatternEvaluator`**: allocate the struct-type output vector; wire property sub-vectors

---

## Source File Reference

| File | Description |
|------|-------------|
| `src/include/expression_evaluator/expression_evaluator.h` | Base class; `EvaluatorType` enum; `evaluate()`, `select()`, `init()` API |
| `src/include/expression_evaluator/reference_evaluator.h` | `ReferenceExpressionEvaluator` — DataPos alias |
| `src/include/expression_evaluator/literal_evaluator.h` | `LiteralExpressionEvaluator` — flat constant vector |
| `src/include/expression_evaluator/function_evaluator.h` | `FunctionExpressionEvaluator` — scalar function dispatch |
| `src/include/expression_evaluator/case_evaluator.h` | `CaseExpressionEvaluator` — lazy WHEN/THEN evaluation |
| `src/include/expression_evaluator/pattern_evaluator.h` | `PatternExpressionEvaluator` — node/rel struct assembly |
| `src/include/expression_evaluator/path_evaluator.h` | `PathExpressionEvaluator` — path list assembly |
| `src/include/expression_evaluator/lambda_evaluator.h` | `LambdaParamEvaluator`, `ListLambdaEvaluator` |
| `src/expression_evaluator/function_evaluator.cpp` | Null propagation; flat/unflat dispatch logic |
| `src/expression_evaluator/case_evaluator.cpp` | Per-WHEN selected-rows tracking |
| `src/expression_evaluator/pattern_evaluator.cpp` | Struct vector field wiring |
| `src/expression_evaluator/path_evaluator.cpp` | Path node/rel interleaving |
| `src/expression_evaluator/lambda_evaluator.cpp` | Per-element lambda iteration |
| `src/processor/map/expression_mapper.cpp` | `ExpressionMapper::getEvaluator()` dispatch |

---

## Worked Examples

### Example 1: `WHERE a.age > 30 AND a.name = 'Alice'`

The bound expression tree:
```
AND
├── FUNCTION(>)
│   ├── PROPERTY(a.age)    [type: INT64]
│   └── LITERAL(30)        [type: INT64]
└── FUNCTION(=)
    ├── PROPERTY(a.name)   [type: STRING]
    └── LITERAL('Alice')   [type: STRING]
```

After `ExpressionMapper` (assuming `a.age` is at `DataPos(0,1)` and `a.name` is at `DataPos(0,2)`):
```
FunctionEvaluator(AND)
├── FunctionEvaluator(GT, selectFunc=GT_select)
│   ├── ReferenceEvaluator(DataPos(0,1))   ← a.age
│   └── LiteralEvaluator(30)
└── FunctionEvaluator(EQ, selectFunc=EQ_select)
    ├── ReferenceEvaluator(DataPos(0,2))   ← a.name
    └── LiteralEvaluator('Alice')
```

When the `Filter` operator calls `select(selVector)`:
1. `AND.select(sel)` evaluates all children first (in order), then filters.
2. Actually: `AND` uses short-circuit evaluation — evaluates left child first, then only for rows where left is true, evaluates right child.
3. After both, only rows where both conditions hold are written to `sel`.

### Example 2: `RETURN CASE WHEN a.score > 90 THEN 'A' WHEN a.score > 80 THEN 'B' ELSE 'C' END`

```
CaseEvaluator
├── alternative[0]:
│   ├── when: FunctionEvaluator(GT, [ReferenceEval(a.score), LiteralEval(90)])
│   └── then: LiteralEvaluator('A')
├── alternative[1]:
│   ├── when: FunctionEvaluator(GT, [ReferenceEval(a.score), LiteralEval(80)])
│   └── then: LiteralEvaluator('B')
└── else: LiteralEvaluator('C')
```

Evaluation for a batch of 5 rows where a.score = [95, 85, 75, 92, 88]:
1. WHEN[0] select → trueSelected = {0, 3} (scores 95, 92)
2. THEN[0] evaluate for {0, 3} → result[0]='A', result[3]='A'
3. Remaining = {1, 2, 4}
4. WHEN[1] select over {1,2,4} → trueSelected = {1, 4} (scores 85, 88)
5. THEN[1] evaluate for {1, 4} → result[1]='B', result[4]='B'
6. Remaining = {2}
7. ELSE evaluate for {2} → result[2]='C'
8. Final result = ['A', 'B', 'C', 'A', 'B'] ✓

### Example 3: Lambda `list_transform(scores, x -> x * 2)`

```
ListLambdaEvaluator
├── listArg: ReferenceEvaluator(DataPos(0,3))   ← scores column
└── lambdaRoot: FunctionEvaluator(MULTIPLY)
    ├── LambdaParamEvaluator('x')               ← bound per-element
    └── LiteralEvaluator(2)
```

For each row `i`:
1. Get `scores[i]` list from the reference evaluator.
2. For each element `elem` in `scores[i]`:
   a. Set `LambdaParamEvaluator('x').resultVector` = elem's slice.
   b. Call `lambdaRoot.evaluate()` → computes `elem * 2`.
   c. Write result into output list at position `elem`'s index.
3. Output: `list_transform(scores, x -> x * 2)` for all rows.

---

## Debugging and Diagnostics

**To see what evaluators are created for a query:**
- Enable `DEBUG` level logging for the `evaluator` module.
- `EXPLAIN` the query and examine the physical operator plan — each physical operator's `printPhysicalPlanToJson()` includes its expression evaluator tree.

**To trace NULL propagation issues:**
- The `NullMask` class tracks which positions are null. Check `resultVector->isNull(pos)` after `evaluate()`.
- `IS NULL` / `IS NOT NULL` functions always inspect the null mask before computing their result.
- For CASE expressions: a NULL WHEN condition is treated as FALSE (the WHEN does not fire), consistent with SQL semantics.

**Common issues:**
- "Expression not in scope" error: An expression in an `evaluate()` call is not present in the operator's input `Schema`. This is a planner bug — the `ProjectionPushDownOptimizer` or `SchemaPopulator` failed to include the expression.
- "NotImplementedException" in `getEvaluator`: An expression type not covered by the dispatch. Check if it is a new expression type that needs a new evaluator class.
- Wrong results with flat vectors: Verify that `isFlat()` is set correctly after `FLATTEN` operators. A flat vector that should be unflat (or vice versa) causes incorrect vectorized execution.

---

## Relationship to Optimizer

The expression evaluator subsystem is **read-only** with respect to the optimizer — it only executes what the optimizer has decided. The optimizer, however, affects which evaluators are created:

- **FilterPushDownOptimizer** moves `FILTER` operators to earlier pipeline stages → `FunctionExpressionEvaluator` instances for filter predicates are created in earlier operators.
- **ProjectionPushDownOptimizer** prunes unused columns → `ReferenceExpressionEvaluator` nodes are not created for pruned columns (the DataPos is never computed).
- **FactorizationRewriter** inserts `FLATTEN` operators → affects which `ValueVector`s are flat, changing the execution path in `BinaryFunctionExecutor`.
- **TopKOptimizer** rewrites `LIMIT + ORDER_BY` → affects whether `OrderBy` evaluators include a limit count.
- **AggKeyDependencyOptimizer** splits GROUP BY keys → affects which evaluators are created as aggregate key vs. payload evaluators in `mapAggregate`.

For the full optimizer pipeline, see [Optimizer](./optimizer.md).
