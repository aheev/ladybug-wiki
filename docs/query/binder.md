# Binder & Type System

**Source files:** `src/binder/binder.cpp`, `src/include/binder/`, `src/common/types/`

## Binder Responsibilities

The binder transforms the parsed AST into a **bound statement** where every identifier is resolved to a specific catalog entry and every expression has a fully-resolved type. Binding fails with a user-visible error if:
- A label (`Person`) doesn't exist in the catalog
- A property (`p.foo`) doesn't exist on the resolved table
- Types are incompatible (`p.age + 'hello'`)
- A variable is used before it is introduced (out-of-scope)

## Symbol Table

```cpp
// expression_binder.h
class BinderScope {
    // Maps variable name → resolved expression
    unordered_map<string, shared_ptr<Expression>> variableScope;

    // Outer scope chain (for subquery nesting)
    BinderScope* parentScope;

    shared_ptr<Expression> resolve(const string& name) const;
    void add(const string& name, shared_ptr<Expression> expr);
};
```

Variables are introduced at `MATCH` and carried through to `WHERE`, `RETURN`, etc. Subqueries introduce a new nested `BinderScope`.

## Pattern Binding

```
Input pattern: (p:Person)-[:KNOWS]->(friend:Person)
```

```cpp
// expression_binder.cpp
BoundPattern Binder::bindPattern(const ParsedPattern& pattern) {
    // Resolve 'Person' label → lookup catalog → NodeTableID=0
    auto personTable = catalog->getNodeTable("Person");
    // Create NodeExpression for 'p' with all Person properties available
    auto pExpr   = make_shared<NodeExpression>("p", personTable->tableID, personTable->properties);
    scope->add("p", pExpr);

    // Resolve 'KNOWS' rel type → RelTableID=2
    auto knowsTable = catalog->getRelTable("KNOWS");
    auto eExpr  = make_shared<RelExpression>("__e0__", knowsTable->tableID, FORWARD);

    // 'friend' uses same Person label
    auto friendExpr = make_shared<NodeExpression>("friend", personTable->tableID, personTable->properties);
    scope->add("friend", friendExpr);

    return BoundPattern{pExpr, eExpr, friendExpr};
}
```

## Type System

```cpp
// logical_type.h
class LogicalType {
    LogicalTypeID typeID;  // INT64, STRING, BOOL, LIST, NODE, REL, ...
    unique_ptr<ExtraTypeInfo> extraTypeInfo;  // for LIST: element type; for STRUCT: field types
};
```

### Primitive Types

| TypeID | C++ | Notes |
|--------|-----|-------|
| `INT8`/`INT16`/`INT32`/`INT64` | `int8_t`..`int64_t` | Fixed-width integers |
| `UINT8`/`UINT16`/`UINT32`/`UINT64` | `uint8_t`..`uint64_t` | Unsigned variants |
| `FLOAT`/`DOUBLE` | `float`/`double` | IEEE 754 |
| `BOOL` | `uint8_t` (0/1) | Stored as byte in ValueVector |
| `STRING` | `string_t` | Inline if ≤12 bytes, else overflow pointer |
| `DATE` | `int32_t` | Days since Unix epoch |
| `TIMESTAMP` | `int64_t` | Microseconds since Unix epoch |
| `INTERVAL` | `interval_t` | months + days + microseconds |

### Complex Types

| TypeID | ExtraTypeInfo | Example |
|--------|---------------|---------|
| `LIST` | element type | `INT64[]` |
| `MAP` | key type, value type | `MAP(STRING, INT64)` |
| `STRUCT` | field names + types | `STRUCT(x: INT64, y: FLOAT)` |
| `UNION` | tag + member types | `UNION(a: INT64, b: STRING)` |
| `NODE` | tableID, property types | returned from `MATCH (p:Person)` |
| `REL` | tableID, src/dst tableIDs | returned from `MATCH ()-[e]->()` |

### Type Casting Rules

The binder inserts implicit cast operators when types are compatible:

```cpp
// implicit: INT32 → INT64, FLOAT → DOUBLE
// explicit required: STRING → INT64 (must use toInt64(str))
// incompatible: STRING + INT64 → error at bind time
```

## Property Expression Resolution

```
p.age  →  PropertyExpression{
              expr: NodeExpression{p, NodeTableID=0},
              propertyName: "age",
              propertyID: ColumnID=1,
              dataType: INT64
           }
```

The binder looks up `age` in the `Person` table schema from the catalog:

```cpp
shared_ptr<Expression> ExpressionBinder::bindPropertyExpression(
    const ParsedExpression& expr,
    const string& propertyName
) {
    auto nodeExpr = scope->resolve(expr.varName);
    auto tableSchema = catalog->getNodeTableSchema(nodeExpr->tableID);
    auto prop = tableSchema->getProperty(propertyName);  // throws if not found
    return make_shared<PropertyExpression>(nodeExpr, prop->propertyID, prop->dataType);
}
```

## Function Resolution

```
count(*) → AggregateFunctionExpression{
               func: AggregateFunction::COUNT_STAR,
               isDistinct: false,
               dataType: INT64
           }
```

Functions are resolved via `BuiltInFunctionsUtils::matchFunction()`, which supports overload resolution:

```cpp
// count(expr) → INT64 (regardless of input type)
// count(DISTINCT expr) → INT64 (deduplicating)
// sum(INT64) → INT64
// sum(DOUBLE) → DOUBLE
// toString(ANY) → STRING
```

## WHERE Clause Binding

The WHERE expression is recursively bound and must resolve to `BOOL`:

```cpp
auto boundWhere = exprBinder->bindExpression(*whereClause.expression);
// Type check: must be BOOL or implicitly castable to BOOL
if (boundWhere->dataType != LogicalType::BOOL) {
    throw BinderException("WHERE expression must be boolean");
}
```

## Related Files

- `src/binder/binder.cpp` — main binder entry point
- `src/binder/expression_binder.cpp` — expression binding and type resolution
- `src/include/binder/expression/` — bound expression node types
- `src/common/types/logical_type.cpp` — LogicalType hierarchy
- `src/catalog/catalog.cpp` — table schema lookups
