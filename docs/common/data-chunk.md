# Data Chunk and Vector Layer

This page documents LadybugDB's execution-time tuple container layer.
It covers `DataChunk`, `DataChunkState`, selection vectors, null masks, `ValueVector`, and auxiliary buffers.

## Scope and primary source files

- `src/include/common/constants.h`
- `src/include/common/null_mask.h`
- `src/include/common/null_buffer.h`
- `src/include/common/data_chunk/data_chunk.h`
- `src/include/common/data_chunk/data_chunk_state.h`
- `src/include/common/data_chunk/sel_vector.h`
- `src/include/common/data_chunk/data_chunk_collection.h`
- `src/include/common/vector/value_vector.h`
- `src/include/common/vector/auxiliary_buffer.h`
- `src/common/data_chunk/data_chunk.cpp`
- `src/common/data_chunk/data_chunk_state.cpp`
- `src/common/data_chunk/sel_vector.cpp`
- `src/common/data_chunk/data_chunk_collection.cpp`
- `src/common/vector/auxiliary_buffer.cpp`
- `src/common/vector/value_vector.cpp`
- `cmake/templates/system_config.h.in`
- `CMakeLists.txt`

## The basic model

A `DataChunk` is LadybugDB's row-batch container for execution pipelines.
It holds:

- a vector of `ValueVector`s
- a shared `DataChunkState`

All value vectors in a chunk are expected to have the same logical row count.
That row count is tracked indirectly through the selection vector inside the shared state.

## Vector capacity

`DEFAULT_VECTOR_CAPACITY` is generated from `system_config.h`.
The template defines it as:

- `1 << VECTOR_CAPACITY_LOG_2`

The top-level `CMakeLists.txt` defaults `LBUG_VECTOR_CAPACITY_LOG2` to `11`.
So the default effective vector capacity is:

- `2048`

This number drives:

- default `SelectionVector` size
- `DataChunkState()` default capacity
- `ValueVector` storage allocation
- `DataChunkCollection` chunk splitting

## `DataChunk`

`DataChunk` is a thin coordinator object.
Its public members are intentionally simple:

- `std::vector<std::shared_ptr<ValueVector>> valueVectors`
- `std::shared_ptr<DataChunkState> state`

### Construction

Supported construction modes:

- `DataChunk()`
  - zero vectors
- `DataChunk(numValueVectors)`
  - allocates a fresh `DataChunkState`
- `DataChunk(numValueVectors, sharedState)`
  - shares state with other chunks or vectors

### Important methods

`insert(pos, valueVector)`:

- stores the shared pointer
- immediately calls `valueVector->setState(state)`
- guarantees that the vector participates in the chunk's shared selection/filtering state

`resetAuxiliaryBuffer()`:

- iterates over all vectors
- delegates to `ValueVector::resetAuxiliaryBuffer()`
- clears overflow/list/struct child metadata without reallocating the vector object itself

## `DataChunkState`

`DataChunkState` owns:

- a shared `SelectionVector`
- a factorization-state flag `FStateType`

### `FStateType`

Current values:

- `FLAT`
- `UNFLAT`

The comment says `currIdx` used to be part of the flattening story, but the current header only stores the factorization flag and selection vector.
A TODO explicitly says this state should probably be merged with `SelectionVector` in the future.

### Construction behavior

`DataChunkState()`:

- allocates a `SelectionVector(DEFAULT_VECTOR_CAPACITY)`
- defaults to `UNFLAT`

`DataChunkState(capacity)`:

- allocates a `SelectionVector(capacity)`
- defaults to `UNFLAT`

### Single-value state

`getSingleValueDataChunkState()` is a special helper for vectors that conceptually hold one scalar.
It does three things:

- allocates capacity `1`
- sets selected size to `1`
- sets the factorization state to `FLAT`

That helper is the clearest representation of LadybugDB's scalar-vector convention.

## Selection vectors

The selection layer is split into:

- `SelectionView`
- `SelectionVector`

### `SelectionView`

`SelectionView` is a lightweight immutable view over selected positions.
It supports two internal states:

- `STATIC`
- `DYNAMIC`

#### Static mode

In static mode:

- `selectedPositions` points into a shared incremental array
- a contiguous logical range is represented without copying
- `isUnfiltered()` is true only if the state is `STATIC` and the first selected position is `0`

#### Dynamic mode

In dynamic mode:

- `selectedPositions` points into mutable storage
- arbitrary filtered position lists are represented explicitly

#### Iteration helpers

`SelectionView` provides:

- `forEach`
- `forEachBreakWhenFalse`
- `operator[]`
- `getSelectedPositions()`

Both iteration helpers exploit the static-vs-dynamic distinction.
In static mode they iterate ranges directly.
In dynamic mode they walk the buffer.

### `SelectionVector`

`SelectionVector` extends `SelectionView` by owning mutable storage.

It stores:

- `selectedPositionsBuffer`
- `capacity`

#### Incremental default buffer

`sel_vector.cpp` defines a compile-time array named `INCREMENTAL_SELECTED_POS` containing:

- `0, 1, 2, ..., DEFAULT_VECTOR_CAPACITY - 1`

This is what static unfiltered vectors point at.
No per-vector initialization loop is needed for the common unfiltered case.

#### Important operations

`setToUnfiltered()`:

- points to the static incremental array
- keeps the vector in `STATIC` mode

`setToUnfiltered(size)`:

- same as above, but with a shorter active prefix

`setRange(startPos, size)`:

- writes an explicit contiguous range into the mutable buffer
- switches to `DYNAMIC`

`setToFiltered()`:

- points to mutable storage
- keeps current selected size

`makeDynamic()`:

- copies current selected positions into mutable storage
- useful when mutating a previously static view

`slice(startIndex, selectedSize)`:

- returns a `SelectionView` subspan
- does not copy data

`fromValueVectors(...)`:

- convenience helper that extracts raw `SelectionVector*` pointers from a vector list

## Null handling

LadybugDB uses two related null representations.

### `NullMask`

`NullMask` is the vector-level bit-packed null representation.

Key constants:

- `NUM_BITS_PER_NULL_ENTRY = 64`
- `NUM_BYTES_PER_NULL_ENTRY = 8`
- `NO_NULL_ENTRY = 0`
- `ALL_NULL_ENTRY = ~0`

Important state:

- `std::span<uint64_t> data`
- optional owned `buffer`
- `mayContainNulls`

The `mayContainNulls` flag is important.
If it is false, `hasNoNullsGuarantee()` returns true and callers can skip per-row null checks.
That is an optimization guarantee, not just a cached count.

Important APIs:

- `setAllNonNull()`
- `setAllNull()`
- `setNull(pos, isNull)`
- `isNull(pos)`
- `countNulls()`
- `copyNullMask(...)`
- `copyFromNullBits(...)`
- `setNullRange(...)`
- `resize(capacity)`
- `operator|=()`
- `getMinMax(...)`

### `NullBuffer`

`NullBuffer` is separate from `NullMask`.
It is used for row-layout serialization of nested values.

It operates on bytes rather than 64-bit entries and provides:

- `isNull(nullBytes, valueIdx)`
- `setNull(nullBytes, valueIdx)`
- `setNoNull(nullBytes, valueIdx)`
- `getNumBytesForNullValues(numValues)`
- `initNullBytes(nullBytes, numValues)`

A useful rule of thumb:

- `NullMask` is for vectors
- `NullBuffer` is for row-layout nested payloads

## `ValueVector`

`ValueVector` is the central execution-time column container.
It stores values of one logical type for up to one vector capacity worth of rows.

### Core fields

- `LogicalType dataType`
- `std::shared_ptr<DataChunkState> state`
- `std::unique_ptr<uint8_t[]> valueBuffer`
- `NullMask nullMask`
- `uint32_t numBytesPerValue`
- `std::unique_ptr<AuxiliaryBuffer> auxiliaryBuffer`

### Capacity rules

The header comment calls out two capacities:

- `1` for sequence/single-value vectors
- `DEFAULT_VECTOR_CAPACITY` for normal vectors

In practice the normal constructor allocates `DEFAULT_VECTOR_CAPACITY` storage.
Single-value behavior is usually expressed through state and selection size rather than a different class.

### Construction

`ValueVector(dataType, memoryManager, state)` does the following:

1. rejects logical `ANY`
2. computes `numBytesPerValue`
3. allocates `valueBuffer`
4. creates an auxiliary buffer if the physical type needs one
5. attaches shared state if one was provided

### Fixed-width slot sizes

`getDataTypeSize(type)` returns:

- `sizeof(string_t)` for `STRING` and `JSON`
- `sizeof(struct_entry_t)` for `STRUCT`-physical values
- `sizeof(list_entry_t)` for `LIST` and `ARRAY`
- otherwise the fixed physical size

That is why nested vectors store indirection structs in the main buffer and push the real content into auxiliary buffers.

### State propagation

When `setState()` is called on a struct vector, the state is recursively forwarded to every child field vector.
This keeps selections and flattening synchronized across the whole struct tree.

## Auxiliary buffers

`AuxiliaryBuffer` is the polymorphic base for overflow storage.
There are three important subclasses.

### `StringAuxiliaryBuffer`

Holds an `InMemOverflowBuffer`.
Used for:

- `STRING`
- `JSON`

Provides:

- `allocateOverflow(size)`
- `resetOverflowBuffer()`

### `StructAuxiliaryBuffer`

Owns child field vectors for struct-like physical values.
It allocates one child `ValueVector` per field type.
Used for:

- `STRUCT`
- `NODE`
- `REL`
- `RECURSIVE_REL`
- `UNION`

### `ListAuxiliaryBuffer`

Stores:

- `capacity`
- `size`
- `dataVector`

Used for:

- `LIST`
- `ARRAY`
- `MAP` indirectly via list-based layout

`addList(listSize)` returns a `list_entry_t {offset, size}` and expands capacity geometrically when needed.
If the child vector is struct-typed, resizing recursively resizes the struct field vectors too.

### Factory behavior

`AuxiliaryBufferFactory::getAuxiliaryBuffer(...)` chooses:

- string buffer for `STRING` and `JSON`
- struct buffer for physical `STRUCT`
- list buffer for physical `LIST` and `ARRAY`
- `nullptr` otherwise

## String vectors

`StringVector` is a static helper over `ValueVector`.
The implementation deliberately accepts both physical `STRING` and physical `JSON` in its assertions.

### Short vs long strings

`addString(...)` checks `string_t::isShortString(length)`.

- short strings are stored inline in the `string_t`
- long strings allocate overflow space from `StringAuxiliaryBuffer`

This is used consistently in:

- `setValue<string_t>`
- `setValue<std::string>`
- `setValue<std::string_view>`
- `copyFromValue()`
- row-layout copy routines

### Reserving output space

`reserveString(...)` allocates space without immediately copying contents.
That is useful for functions that want to write directly into the destination string buffer.

### Row layout for strings

`StringVector::copyToRowData()` writes a `string_t` into row storage.
If the string is long, it allocates row-overflow space from the provided `InMemOverflowBuffer` and writes the long-string pointer metadata there.

## List and array vectors

`ListVector` is used for both physical `LIST` and physical `ARRAY`.
The logical distinction is preserved in the type metadata, not in separate vector classes.

### Main-buffer layout

Each row stores one `list_entry_t` in the main vector buffer:

- `offset`
- `size`

The actual elements live in the shared child `dataVector` owned by `ListAuxiliaryBuffer`.

### Core helper methods

- `setDataVector(...)`
- `getDataVector(...)`
- `getSharedDataVector(...)`
- `getDataVectorSize(...)`
- `getListValues(...)`
- `getListValuesWithOffset(...)`
- `addList(listSize)`
- `resizeDataVector(...)`
- `appendDataVector(...)`
- `sliceDataVector(...)`

### Copying from a `Value`

When `ValueVector::copyFromValue()` sees physical `LIST` or `ARRAY` it:

1. reads child count from `NestedVal`
2. allocates a new list slot via `ListVector::addList()`
3. recursively copies each child into the child data vector

### Row layout for lists and arrays

The row layout is implemented through `list_t` and a dedicated overflow payload.
The exact overflow structure is:

1. null bytes first
2. row-layout child payloads immediately after

`ListVector::copyFromRowData()`:

- reads a `list_t`
- interprets `overflowPtr`
- reads null bytes with `NullBuffer`
- recursively materializes each child row payload into the child vector

`ListVector::copyToRowData()`:

- writes `list_t.size`
- allocates a single overflow block
- writes child null bytes first
- writes row-layout child values after the null bytes

This detail matters a lot when debugging factorized-table materialization.

### Arrays are list-like with extra validation

Arrays reuse the same physical machinery, but array casts and parsers enforce a fixed element count.
The cast layer validates that list sizes match the target array length.

## Struct vectors

Struct-like logical types all use physical `STRUCT`.
The parent vector buffer stores `struct_entry_t` values, whose `pos` field identifies the shared row position across the child vectors.

### Initialization

`ValueVector::initializeValueBuffer()` fills struct-entry positions using `std::iota`.
So for a fresh struct vector:

- slot `0` stores position `0`
- slot `1` stores position `1`
- and so on

### Child storage

Actual field values are stored in `StructAuxiliaryBuffer::childrenVectors`.
Every field has its own `ValueVector`.

### Core helper methods

- `getFieldVectors(...)`
- `getFieldVector(...)`
- `getFieldVectorRaw(vector, fieldName)`
- `referenceVector(...)`
- `copyFromRowData(...)`
- `copyToRowData(...)`
- `copyFromVectorData(...)`

### Row layout for structs

The source comment in `StructVector::copyToRowData()` states the storage structure directly:

- `[NULLBYTES, FIELD1, FIELD2, ...]`

Implementation details:

- null bytes are initialized with `NullBuffer::initNullBytes(...)`
- each field increments the row pointer by `LogicalTypeUtils::getRowLayoutSize(fieldType)`
- null fields set the corresponding null bit and do not write payload bytes
- non-null fields recursively write their own row representation

## Union vectors

A union is represented using struct infrastructure.
The helper conventions are:

- field `0` is the synthetic tag vector
- payload fields begin at internal field index `1`

Important helpers:

- `getTagVector(...)`
- `getValVector(...)`
- `getSharedValVector(...)`
- `referenceVector(...)`

The type layer, not the vector layer, decides which union field is semantically active.

## Copy paths

There are three very important families of copy logic.

### Row-data copies

- `copyFromRowData(...)`
- `copyToRowData(...)`

Used when interacting with factorized tables and row-oriented nested payloads.

### Vector-data copies

- `copyFromVectorData(dstData, srcVector, srcData)`
- `copyFromVectorData(dstPos, srcVector, srcPos)`

Used when appending chunks, materializing selections, or re-slicing nested child vectors.

### Value-object copies

- `copyFromValue(pos, Value)`
- `getAsValue(pos)`

Used by serialization, test code, interfaces, and other non-hot-path conversions.

## Null elimination

`ValueVector::discardNull(vector)` is a useful execution helper.

Behavior:

- if `hasNoNullsGuarantee()` is true, it returns true immediately
- otherwise it rewrites the selection vector in place to keep only non-null positions
- if the selection was previously static/unfiltered, it first moves into the dynamic buffer
- it returns whether any positions remain after null removal

This is one of the key places where selection vectors become dynamic during execution.

## Serialization

`ValueVector::serialize()` writes:

1. debugging tag `data_type`
2. logical type
3. debugging tag `num_values`
4. selected-size count
5. per-selected-position null flags
6. debugging tag `values`
7. each selected value serialized as a `Value`

`ValueVector::deSerialize()` reverses that process and then rehydrates values through `copyFromValue()`.

This is intentionally value-oriented rather than dumping raw buffers.
That makes the format more general but also more expensive than a binary memcpy format.

## `DataChunkCollection`

`DataChunkCollection` is a growable array of chunks used to accumulate result batches.

It stores:

- a `MemoryManager*`
- a copy of the chunk `types`
- `std::vector<DataChunk> chunks`

### Append behavior

`append(chunk)`:

- determines how many tuples are selected in the source chunk
- allocates a new destination chunk whenever the current one reaches `DEFAULT_VECTOR_CAPACITY`
- copies row-by-row and vector-by-vector with `copyFromVectorData(...)`
- increments the destination selection size as rows are appended

The implementation copies selected rows, not raw buffer prefixes.
So filters already applied in the source chunk are respected.

### Allocation behavior

`allocateChunk(sourceChunk)`:

- lazily initializes the stored type list
- allocates a fresh `DataChunk(types.size(), std::make_shared<DataChunkState>())`
- inserts one `ValueVector` per type

## Important invariants and debugging notes

### Invariant: vector state is shared inside a chunk

Do not treat a chunk's vectors as independent filtered columns.
They are expected to share one `DataChunkState`.

### Invariant: struct children follow parent state

If a struct vector looks misaligned under filtering, check whether `setState()` was applied after vector creation.

### Invariant: list entries are only metadata

A `list_entry_t` does not own data.
Its `offset` and `size` only make sense relative to the current child data vector.

### Invariant: auxiliary buffers hold the real nested/overflow payloads

If a vector looks empty after a reset, inspect `resetAuxiliaryBuffer()` behavior before blaming `valueBuffer` contents.

### Invariant: JSON follows string execution paths in many places

If a bug reproduces only for JSON, always compare the code path with string handling.
Often they share the exact helper.

## Summary

The data-chunk layer is compact but subtle:

- `DataChunk` groups vectors
- `DataChunkState` shares selection and factorization state
- `SelectionVector` determines which rows are live
- `NullMask` optimizes null checks
- `ValueVector` stores fixed-width slots plus optional auxiliary structures
- strings use overflow buffers
- lists and arrays use entry metadata plus a child vector
- structs use positional indirection plus child vectors

If you are debugging execution bugs, `value_vector.cpp` is the most important file in this subsystem.
