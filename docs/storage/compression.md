# Column Compression

**Source files:** `src/storage/compression/compression.cpp`, `src/storage/compression/compression.h`, `src/storage/compression/bitpacking_utils.cpp`, `src/storage/compression/float_compression.cpp`, `src/include/storage/predicate/column_predicate.h`, `src/include/common/enums/zone_map_check_result.h`

## Overview

Every `ColumnChunk` in LadybugDB is independently compressed. Compression is chosen **once per chunk at checkpoint time** by the `CompressionAnalyzer`, and the chosen codec plus its parameters are stored in `CompressionMetadata`. At read time the metadata tells the decompressor exactly how to decode each value — no per-value format bytes are stored in the data pages themselves.

### Codec Summary

| Codec | `CompressionType` value | Applies to | What it stores |
|---|---|---|---|
| **UNCOMPRESSED** | `0` | Any type (fallback) | Raw bytes, no transformation |
| **INTEGER_BITPACKING** | `1` | All integer types | Min-shifted values packed into minimum bit width |
| **BOOLEAN_BITPACKING** | `2` | `BOOL` | 1 bit per boolean, 8 booleans per byte |
| **CONSTANT** | `3` | Any type | A single value; decompression fills the whole range with it |
| **ALP** | `4` | `FLOAT`, `DOUBLE` | Adaptive Lossless floating Point — floats encoded as integers, then bitpacked |

```cpp
// src/storage/compression/compression.h
enum class CompressionType : uint8_t {
    UNCOMPRESSED       = 0,
    INTEGER_BITPACKING = 1,
    BOOLEAN_BITPACKING = 2,
    CONSTANT           = 3,
    ALP                = 4,
};
```

---

## CompressionMetadata

`CompressionMetadata` is the self-describing header stored alongside every column chunk. It contains everything the decompressor needs.

```cpp
// src/storage/compression/compression.h
struct CompressionMetadata {
    StorageValue min;   // minimum value seen in this chunk (zone map)
    StorageValue max;   // maximum value seen in this chunk (zone map)
    CompressionType compression;

    // Present only for ALP float compression:
    std::optional<std::unique_ptr<ExtraMetadata>> extraMetadata;

    // Child metadata: ALP uses one child for its INTEGER_BITPACKING layer
    std::vector<CompressionMetadata> children;
};
```

`StorageValue` is a union covering all physical storage types:

```cpp
union StorageValue {
    int64_t   signedInt;
    uint64_t  unsignedInt;
    float     floatVal;
    __int128  signedInt128;
};
```

The `min`/`max` fields serve double duty: they are **zone map** statistics used for predicate pushdown (see [Zone Maps](#zone-maps-predicate-pushdown)) and they provide the shift offset for integer bitpacking.

### Serialization

`CompressionMetadata` is serialized into the column chunk metadata block during checkpoint and deserialized on first read. Because ALP embeds a child `CompressionMetadata` (for its INTEGER_BITPACKING layer) via the `children` vector, the structure is serialized recursively.

---

## Compression Selection (Checkpoint)

Before writing column data to disk, `CompressionAnalyzer::analyze(chunk)` inspects all values in the in-memory chunk and selects the best codec:

```
CompressionAnalyzer::analyze(chunk)
│
├─ scan all non-null values → compute min, max
│
├─ if min == max
│    └─ → CONSTANT  (zero data bytes required)
│
├─ else if type == BOOL
│    └─ → BOOLEAN_BITPACKING
│
├─ else if type is integer (INT8 … INT128, UINT8 … UINT64)
│    └─ → INTEGER_BITPACKING
│         bit_width = ceil(log2(max - min + 1))
│
└─ else if type == FLOAT or DOUBLE
     ├─ try ALP encoding on a sample
     │    if exception_rate is acceptable → ALP
     └─ else → UNCOMPRESSED
```

::: tip CONSTANT is the biggest win per byte
If an entire column chunk is a single repeated value — a deleted column filled with NULLs, a boolean flag that is always `false`, a default integer that was never updated — the CONSTANT codec stores **zero** data bytes. Decompression is a memset.
:::

The resulting `CompressionMetadata` is embedded in the serialized `ColumnChunk` header and is available before any data page is read.

---

## Zone Maps & Predicate Pushdown

Every `ColumnChunk` surfaces its `CompressionMetadata::min` and `CompressionMetadata::max` as a **zone map**: a lightweight per-chunk statistic that lets the scan operator skip entire compressed blocks without decompressing them.

```
Scan operator receives predicate:  WHERE age > 35
                                         ↓
            ColumnPredicateSet::checkZoneMap(stats)
                                         ↓
              stats.max <= 35  →  ZoneMapCheckResult::SKIP_SCAN
              stats.max  > 35  →  ZoneMapCheckResult::ALWAYS_SCAN
```

```cpp
// src/include/common/enums/zone_map_check_result.h
enum class ZoneMapCheckResult : uint8_t {
    ALWAYS_SCAN,  // predicate may match — must scan
    SKIP_SCAN,    // predicate can never match — skip entire chunk
};
```

The zone map check is performed **before** any buffer page is pinned or any decompression is attempted. For a large table with many node groups, this can eliminate the majority of I/O.

### How min/max are computed

`getMinMaxStorageValue()` is called during `CompressionAnalyzer::analyze()`. It iterates over every non-null value in the chunk and tracks the running minimum and maximum. Null positions are excluded via the chunk's null bitmask.

::: warning Zone maps after updates/deletes
After in-place updates or row deletions, the stored min/max become **upper/lower bounds** rather than exact values. No actual stored value will exceed the recorded max or fall below the recorded min, so `SKIP_SCAN` decisions remain safe. However, `ALWAYS_SCAN` may trigger on a chunk whose live values no longer satisfy the bounds — false positives are tolerable; false negatives (skipping a chunk that contains matching rows) are not.
:::

---

## Codec Deep Dive

### UNCOMPRESSED

The simplest codec: values are written as raw bytes in their native physical representation. Used as a fallback when no compression codec produces acceptable results (most commonly for high-entropy floating-point data that ALP cannot encode efficiently).

- **Write:** `memcpy` values directly into the data page.
- **Read:** `memcpy` values directly out of the data page.
- No parameters stored in `CompressionMetadata` beyond `min`/`max`.

---

### INTEGER_BITPACKING

Used for all integer physical types: `INT8`, `INT16`, `INT32`, `INT64`, `INT128`, `UINT8`, `UINT16`, `UINT32`, `UINT64`.

#### Encoding

1. Compute `min` across all values in the chunk.
2. Subtract `min` from every value to shift the range to `[0, max - min]`. This handles signed integers — even if individual values are negative, the shifted range is always non-negative.
3. Compute `bit_width = ceil(log2(max - min + 1))`. This is the minimum number of bits needed to represent any shifted value.
4. Pack `bit_width` bits per value sequentially into the data page using the **FastPFOR** library.

```
Example: values = [-3, 0, 4, 1, -1]
  min = -3,  max = 4
  shifted   = [0, 3, 7, 4, 2]
  max_shifted = 7 = 0b111  → bit_width = 3

  packed bits (3 per value, LSB first):
  000 | 011 | 111 | 100 | 010  → stored in 2 bytes
```

#### Decoding

`BitpackingDecompressor::decompress(data, bitWidth, offset, numValues, output)`:

1. Unpack `numValues` values starting at `offset` from the bit stream.
2. Add `min` back to each value to restore the original signed representation.

For `INT128`, the standard FastPFOR path cannot be used directly. `src/storage/compression/bitpacking_utils.cpp` provides `bitpacking_int128.cpp` with a custom 128-bit bitpacking implementation that follows the same shift-then-pack logic.

::: info Why subtract the minimum?
Without the shift, negative integers require a sign bit, which wastes a bit. After shifting, all values are non-negative and FastPFOR's unsigned packing is applicable. The cost is one extra `int64_t`/`int128_t` stored in `CompressionMetadata::min`.
:::

---

### BOOLEAN_BITPACKING

A dedicated 1-bit-per-value codec for `BOOL` columns.

- **Write:** pack each boolean into one bit; 8 booleans fill one byte.
- **Read:** extract bit at position `offset % 8` from byte `offset / 8`.
- `CompressionMetadata::min` = `false` (0), `max` = `true` (1) unless the chunk is constant.

This is separate from INTEGER_BITPACKING because booleans are logically 1-bit values and the bitpacking should always use `bit_width = 1` without going through the min-shift analysis.

---

### CONSTANT

When `CompressionAnalyzer` finds that `min == max` — every non-null value in the chunk is identical — the CONSTANT codec is selected.

- **Write:** store the single value once in `CompressionMetadata::min` (or `max`; they are equal). Write **zero data bytes** to the data page.
- **Read:** for any range `[offset, offset + numValues)`, fill the output vector with the stored value without reading any data page at all.

```cpp
// Decompression (conceptual)
for (uint64_t i = 0; i < numValues; i++) {
    output[i] = metadata.min;  // same value for every position
}
```

CONSTANT is especially effective for:
- Columns that were added with a default value and never updated
- Soft-deleted row markers (all `true`)
- Foreign-key columns in a star schema fact table that reference a single dimension value

---

### ALP (Adaptive Lossless floating Point)

ALP is the most complex codec, targeting `FLOAT` and `DOUBLE` columns. It is based on the ALP research algorithm (implemented via the `alp/` library header `state.hpp`).

#### Core idea

Most real-world floating-point columns store values that are mentally decimal (prices, measurements, coordinates). ALP exploits this: it multiplies each float by a power of 10 (`fac`) and rounds to an integer, then divides by another power of 10 (`exp`) to recover the original value exactly. The resulting integers are small and uniform, which makes them excellent candidates for INTEGER_BITPACKING.

```
value = 3.14159
fac   = 1e5  (scale up)
enc   = round(3.14159 * 1e5) = 314159   ← integer
dec   = 314159 / 1e5 = 3.14159          ← exact recovery
```

#### ALPMetadata

The `ExtraMetadata` stored in `CompressionMetadata::extraMetadata` for ALP chunks:

```cpp
// src/storage/compression/compression.h
struct ALPMetadata : ExtraMetadata {
    uint8_t  exp;               // exponent of the scaling factor (10^exp)
    uint8_t  fac;               // factor applied before rounding
    uint64_t exceptionCount;    // number of values that could not be ALP-encoded
    uint64_t exceptionCapacity; // allocated space for exception values
};
```

`exp` and `fac` are chosen by the ALP algorithm by sampling the column to find the pair that minimises the number of exceptions (values that round-trip imperfectly).

#### Exceptions

Not every float can be encoded losslessly with a single `(exp, fac)` pair. Values that cannot be encoded without rounding error are called **exceptions**. They are stored verbatim in a side array alongside the encoded integer array.

```
float values:  [1.5,  0.1,  NaN,  3.14159,  1e38 ]
                 ↓     ↓     ↗      ↓         ↗
encoded ints:  [15,   1,   exc,   314159,   exc  ]
exceptions:                NaN              1e38
```

If the exception rate exceeds the threshold during `CompressionAnalyzer::analyze()`, ALP is rejected and UNCOMPRESSED is used instead.

#### Two-layer compression

ALP's output (the integer array) is itself compressed with INTEGER_BITPACKING. This is represented by the `children` vector in `CompressionMetadata`:

```
CompressionMetadata (ALP)
├─ min, max          (float zone map)
├─ extraMetadata     (ALPMetadata: exp, fac, exceptionCount, exceptionCapacity)
└─ children[0]       (CompressionMetadata for INTEGER_BITPACKING of encoded integers)
     ├─ min, max     (integer zone map for the encoded representation)
     └─ compression = INTEGER_BITPACKING
```

#### Encoding (write path)

1. ALP algorithm samples the chunk to pick the best `(exp, fac)` pair.
2. Each float is encoded as `round(value * fac) / exp`; values that fail round-trip go to the exception array.
3. The integer array is compressed with INTEGER_BITPACKING (see above), with its own `CompressionMetadata` stored in `children[0]`.
4. Exception positions and exception values are appended after the bitpacked integer data.

#### Decoding (read path)

`ColumnChunkData::readToVector(offset, numValues, vector)` for ALP:

1. Use `children[0]` to bitpack-decompress the integer sub-array.
2. Apply the ALP reverse transform: `float = integer * (10^exp) / fac`.
3. For each position flagged as an exception, overwrite the decoded value with the verbatim exception value.

---

## Reading Compressed Data

All codec reads go through `ColumnChunkData::readToVector(offset, numValues, vector)`. The method dispatches on `CompressionMetadata::compression`:

```
readToVector(offset, numValues, output)
│
├─ CONSTANT           → fill output[0..numValues] with metadata.min
│
├─ BOOLEAN_BITPACKING → extract bits [offset, offset+numValues) from data page
│
├─ INTEGER_BITPACKING → BitpackingDecompressor::decompress(
│                            data, bitWidth, offset, numValues, output)
│                        then add metadata.min to each value
│
├─ ALP               → decompress integer sub-array via children[0] metadata
│                       apply ALP reverse transform
│                       patch exception positions
│
└─ UNCOMPRESSED      → memcpy numValues * sizeof(T) bytes from data page
```

::: tip Skipping is free for CONSTANT
Because CONSTANT stores no data bytes, reading any range — even the full `NODE_GROUP_SIZE` of 131,072 values — costs only a memset. Zone maps on CONSTANT chunks always report either `ALWAYS_SCAN` (if the constant satisfies the predicate) or `SKIP_SCAN` (if it does not), so the scan operator never touches any buffer page.
:::

---

## Related Files

- `src/storage/compression/compression.cpp` — `CompressionAnalyzer::analyze()`, codec dispatch, `getMinMaxStorageValue()`
- `src/storage/compression/compression.h` — `CompressionType` enum, `CompressionMetadata`, `ALPMetadata`, `StorageValue`
- `src/storage/compression/bitpacking_utils.cpp` — FastPFOR wrapper, `BitpackingDecompressor::decompress()`, 128-bit bitpacking
- `src/storage/compression/float_compression.cpp` — ALP encoding/decoding, exception handling, `(exp, fac)` selection
- `src/include/storage/predicate/column_predicate.h` — `ColumnPredicateSet::checkZoneMap()`, `ColumnConstantPredicate`
- `src/include/common/enums/zone_map_check_result.h` — `ZoneMapCheckResult` enum (`ALWAYS_SCAN`, `SKIP_SCAN`)
