# Vectorized Execution Model

**Source files:** `src/include/processor/operator/`, `src/processor/`, `src/include/common/data_chunk/`

## Core Data Types

The execution engine operates on **batches of rows** rather than one row at a time. The key abstractions are:

### DataChunk

```cpp
// data_chunk.h
class DataChunk {
    vector<shared_ptr<ValueVector>> valueVectors;
    SelectionVector selectionVector;
    uint32_t numValueVectors;
    // logical count of active rows in this chunk
    uint64_t state->selVector->selectedSize;
};
```

A `DataChunk` is a horizontal slice of up to `DEFAULT_VECTOR_CAPACITY = 2048` rows. Each `ValueVector` holds one column's values for those rows.

### ValueVector

```cpp
// value_vector.h
class ValueVector {
    unique_ptr<uint8_t[]> valueBuffer;  // values[capacity * typeSize]
    NullMask nullMask;                  // one bit per row
    uint32_t capacity;                  // DEFAULT_VECTOR_CAPACITY
    LogicalType dataType;
    DataChunkState* state;              // shared state with parent chunk
};
```

`valueBuffer` is a flat array of fixed-width values (for variable-length types, it holds `string_t` or `list_entry_t` pointers — see [Overflow Storage](/storage/overflow)). Null bits are stored separately in `NullMask` to allow branchless SIMD operations on the value buffer.

### SelectionVector

```cpp
// sel_vector.h
class SelectionVector {
    sel_t selectedPositions[DEFAULT_VECTOR_CAPACITY];
    uint32_t selectedSize;
    // "unfiltered" shortcut: if selectedSize == capacity,
    // selectedPositions is a simple [0, 1, 2, ..., 2047] sequence
    bool isUnfiltered() const;
};
```

The `SelectionVector` is an indirection layer that allows operators to "remove" rows from a batch without physically compacting memory. When `isUnfiltered()` is true, operators can use the fast path (iterate all 2048 positions directly without indirection).

## Filter Push-Down at Vector Level

When a `WHERE` clause evaluates to false for some rows:

```
DataChunk state before filter (2048 rows):
  selVector: [0, 1, 2, 3, ..., 2047]  (unfiltered)
  valueBuffer: [a0, a1, a2, ..., a2047]

Predicate: age > 30  →  only rows 1, 3, 5 pass

DataChunk state after filter:
  selVector: [1, 3, 5]
  selectedSize: 3
  valueBuffer: (unchanged — a0, a1, a2... still there but logically hidden)
```

No memory movement occurs — the `selVector` simply records which indices are still valid. Subsequent operators iterate only those indices.

## NullMask

```cpp
class NullMask {
    // Bit-packed: bit i = 1 means row i is NULL
    uint64_t data[ceil(capacity / 64)];

    bool isNull(uint32_t pos) const;
    void setNull(uint32_t pos);
    void setAllNonNull();  // zeroes entire mask (fast path for no-null scans)
};
```

Operators that can produce NULLs set the mask. Operators that cannot produce NULLs (e.g., integer addition on non-null inputs) can call `setAllNonNull()` and skip null checks.

## Worked Example

Consider `MATCH (p:Person) WHERE p.age > 30 RETURN p.name`:

```
ScanOperator:
  Reads 2048 rows from Person node group
  DataChunk: { name: ValueVector[2048], age: ValueVector[2048] }
  selVector: [0..2047], selectedSize=2048 (unfiltered)

FilterOperator (age > 30):
  evaluates predicate for all 2048 rows
  updates selVector to keep only rows where age > 30
  e.g., selectedSize → 673, selVector=[1, 4, 7, ...]

ProjectionOperator (p.name):
  iterates only selectedSize=673 positions
  writes name values to output DataChunk
  (age column is dropped — not projected)

ResultCollector:
  receives output DataChunk with 673 rows
```

## Operator Interface

Every execution operator implements:

```cpp
class PhysicalOperator {
    virtual void initLocalState(ResultSet& resultSet, ExecutionContext& context) = 0;
    virtual bool getNextTuple(ExecutionContext& context) = 0;
    // Pull model: caller calls getNextTuple() to get each DataChunk
};
```

`getNextTuple()` fills the operator's output DataChunk and returns `true` while rows remain, `false` when exhausted.

## Pipeline-Breaking vs Pipeline-Fusing

Some operators can process a full DataChunk and pass it downstream immediately (**pipelined**). Others must **accumulate all input** before producing any output (**blocking**):

| Pipelined (fused in one pipeline) | Blocking (pipeline break) |
|----------------------------------|---------------------------|
| Scan, Filter, Projection | HashJoin build side |
| HashJoin probe side | Sort |
| Extend (1-hop expand) | Aggregate |
| Semi-mask filter | OrderBy |

See the [Pipeline & Operator Model](/execution/pipeline) page for details.

## Related Files

- `src/include/common/data_chunk/data_chunk.h` — DataChunk layout
- `src/include/common/vector/value_vector.h` — ValueVector, NullMask
- `src/include/common/sel_vector.h` — SelectionVector
- `src/processor/operator/` — all physical operators
- `src/include/processor/operator/physical_operator.h` — base class
