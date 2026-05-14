# Column Statistics & Zone Map Skipping

**Source files:** `src/storage/stats/table_stats.cpp`, `src/storage/stats/hyperloglog.cpp`, `src/include/storage/predicate/column_predicate.h`, `src/include/common/enums/zone_map_check_result.h`, `src/optimizer/filter_push_down_optimizer.cpp`, `src/planner/cardinality_estimator.cpp`

## Overview

LadybugDB maintains two complementary layers of column statistics:

| Layer | Granularity | Purpose | Updated |
|---|---|---|---|
| **TableStats / ColumnStats** | Whole table | Query planning — cardinality estimation, join selectivity | At INSERT time (HyperLogLog) |
| **Zone Maps** | Per `ColumnChunk` (≤ 2 048 rows) | Scan execution — skip compressed blocks that cannot satisfy a predicate | At checkpoint time (min/max recomputed over live data) |

The two layers serve different masters. `TableStats` is read by the **planner** before execution begins, shaping join order and cost estimates. Zone maps are interrogated by the **scan operator** at runtime, eliminating I/O before a single row is decompressed.

---

## TableStats and ColumnStats

### Structure

```cpp
// src/storage/stats/table_stats.cpp (simplified)
struct ColumnStats {
    HyperLogLog ndv;   // estimated number of distinct values
};

struct TableStats {
    cardinality_t cardinality;           // total row count
    std::vector<ColumnStats> columns;    // one entry per column
};
```

`TableStats` is owned by `NodeTable` and updated transactionally. Every time a node is inserted, the HyperLogLog registers for each property column are updated with the new value's hash. Deletions are **not** reflected — the cardinality counter and NDV estimates are monotonically non-decreasing until the next checkpoint.

### Serialization

`TableStats` is written to the checkpoint file alongside the rest of the table metadata:

```
TableStats::serialize(Serializer)
  │
  ├─ write cardinality (uint64_t)
  └─ for each ColumnStats:
       └─ HyperLogLog::serialize(Serializer)
            └─ write 4096 × uint8_t registers
```

`TableStats::deserialize(Deserializer)` mirrors this layout exactly. After a restart the planner has the same estimates it had before shutdown.

---

## HyperLogLog — NDV Estimation

### Algorithm

LadybugDB uses the classic **HyperLogLog** algorithm with:

- `b = 12` precision bits → `m = 2^12 = 4 096` registers
- 64-bit **MurmurHash** to hash each inserted value

```
HyperLogLog::add(value):
  h = MurmurHash64(value)
  register_index = high b bits of h          // picks one of 4096 registers
  leading_zeros  = count_leading_zeros(low 64-b bits of h) + 1
  registers[register_index] = max(registers[register_index], leading_zeros)
```

Each register records the maximum number of leading zeros seen in the lower bits for all values hashed to that register. The more distinct values there are, the higher the maximum will tend to be.

### Cardinality Estimate

`HyperLogLog::count()` applies the three-range correction defined by the original HyperLogLog paper:

```
HyperLogLog::estimateCardinality(uint32_t* c):
  raw = alpha_m * m^2 / sum(2^(-registers[i]))

  if raw <= 5/2 * m:          // small-range correction
      zeros = count(registers[i] == 0)
      if zeros > 0:
          return m * log(m / zeros)   // linear counting

  if raw <= 1/30 * 2^64:      // normal range
      return raw

  // large-range correction (avoids hash collision saturation)
  return -2^64 * log(1 - raw / 2^64)
```

::: tip Merge for union NDV
`HyperLogLog::merge(const HyperLogLog& other)` takes the **per-register maximum** of both instances. This gives the HyperLogLog for the union of two value sets without re-scanning either set — useful when combining stats across partitions.

```cpp
void HyperLogLog::merge(const HyperLogLog& other) {
    for (uint32_t i = 0; i < NUM_REGISTERS; i++)
        registers[i] = std::max(registers[i], other.registers[i]);
}
```
:::

### Register count trade-off

| Precision (`b`) | Registers | Memory | Typical error |
|---|---|---|---|
| 10 | 1 024 | 1 KB | ~3.2% |
| **12** | **4 096** | **4 KB** | **~1.6%** |
| 14 | 16 384 | 16 KB | ~0.8% |

At `b = 12` each `TableStats` adds ~4 KB per column — a deliberate trade-off between estimate accuracy and checkpoint size.

---

## How the Planner Reads Stats

`CardinalityEstimator` is initialized once per query, before physical plan generation:

```
CardinalityEstimator::init(NodeExpression& nodeExpr)
  │
  └─ NodeTable::getStats(transaction)  → TableStats
       │
       ├─ nodeIDName2dom[nodeExpr.name] = stats.cardinality
       └─ nodeTableStats[tableID]      = stats.columns   // ColumnStats[]
```

The planner caches both the **table cardinality** (used as the domain for a node ID variable) and the full `ColumnStats` vector (which contains HyperLogLog for each column).

### Scan cost estimates

```cpp
// CardinalityEstimator::estimateScanNode(op)
if (op.indexScan())
    return 1;                   // PRIMARY_KEY_SCAN always returns at most 1 row
else
    return nodeIDName2dom[op.nodeIDName];  // full table scan → table cardinality
```

### Join selectivity estimate

```cpp
// CardinalityEstimator::estimateHashJoin(probeCard, buildCard, joinKey)
domain = max(ndv(probeKey), ndv(buildKey));   // max domain = least selective
return (probeCard * buildCard) / domain;
```

Dividing by the maximum domain assumes uniform distribution of join key values. This is the standard formula used by most cardinality-estimating planners.

::: warning NDV estimates are lower bounds after deletions
Because HyperLogLog only grows, columns where many distinct values have since been deleted will have inflated NDV estimates. The planner may underestimate join selectivity in heavily deleted tables until the next checkpoint recounts the live rows.
:::

---

## Zone Maps

### What is stored per ColumnChunk

Every `ColumnChunk` carries a `CompressionMetadata` header with `min` and `max` fields encoded as `StorageValue`:

```cpp
union StorageValue {
    int64_t   signedInt;
    uint64_t  unsignedInt;
    float     floatVal;
    __int128  signedInt128;
};

struct CompressionMetadata {
    StorageValue min;
    StorageValue max;
    CompressionType compression;
    // ...
};
```

These two values constitute the **zone map** for the chunk. They are computed by `CompressionAnalyzer::analyze()` at checkpoint time by scanning all non-null values in the chunk.

`MergedColumnChunkStats` is a lightweight view over this metadata that the predicate evaluation code operates on.

### ZoneMapCheckResult

```cpp
// src/include/common/enums/zone_map_check_result.h
enum class ZoneMapCheckResult : uint8_t {
    ALWAYS_SCAN = 0,  // predicate may match; chunk must be scanned
    SKIP_SCAN   = 1,  // predicate cannot match; skip chunk entirely
};
```

The result is **conservative**: `SKIP_SCAN` is only returned when it is mathematically certain that no value in the chunk can satisfy the predicate. `ALWAYS_SCAN` is a "don't know" — some rows in the chunk might not match, but we cannot prove all of them miss.

---

## ColumnPredicate Hierarchy

Predicates that can be pushed down to the scan level are represented as `ColumnPredicate` subclasses:

```
ColumnPredicate  (abstract)
│
├─ ColumnConstantPredicate   — column OP constant_literal
│    e.g. age > 35, name = 'Alice', score BETWEEN 1.0 AND 5.0
│
└─ ColumnNullPredicate       — IS NULL  /  IS NOT NULL
     checks null count in MergedColumnChunkStats
```

Each predicate implements:

```cpp
virtual ZoneMapCheckResult checkZoneMap(const MergedColumnChunkStats& stats) = 0;
```

### ColumnConstantPredicate::checkZoneMap logic

| Predicate | Skip condition (return `SKIP_SCAN`) |
|---|---|
| `col > k` | `chunk.max <= k` — all values ≤ k, none satisfy `> k` |
| `col >= k` | `chunk.max < k` |
| `col < k` | `chunk.min >= k` — all values ≥ k, none satisfy `< k` |
| `col <= k` | `chunk.min > k` |
| `col = k` | `k < chunk.min OR k > chunk.max` — k is outside the range entirely |
| `col BETWEEN lo AND hi` | `chunk.max < lo OR chunk.min > hi` — ranges don't overlap |

```cpp
// Conceptual implementation for col > k
ZoneMapCheckResult ColumnConstantPredicate::checkZoneMap(stats) {
    if (op == GREATER_THAN && stats.max <= constant)
        return SKIP_SCAN;
    return ALWAYS_SCAN;
}
```

### ColumnNullPredicate::checkZoneMap logic

- `IS NULL` → `SKIP_SCAN` if chunk null count == 0 (no nulls in chunk)
- `IS NOT NULL` → `SKIP_SCAN` if chunk null count == chunk row count (all nulls)

### ColumnPredicateSet (AND semantics)

Multiple predicates on the same column are combined into a `ColumnPredicateSet`. The set uses AND semantics: **any** predicate returning `SKIP_SCAN` is enough to skip the whole chunk.

```cpp
ZoneMapCheckResult ColumnPredicateSet::checkZoneMap(const MergedColumnChunkStats& stats) {
    for (auto& pred : predicates) {
        if (pred->checkZoneMap(stats) == SKIP_SCAN)
            return SKIP_SCAN;  // short-circuit on first match
    }
    return ALWAYS_SCAN;
}
```

This means a range predicate like `age BETWEEN 10 AND 50` can be encoded as two `ColumnConstantPredicate` instances (`age >= 10` AND `age <= 50`) and both must pass for the chunk to be scanned.

---

## How Predicates Are Built: FilterPushDownOptimizer

Not all predicates can be converted to zone map checks. The `FilterPushDownOptimizer` does the conversion:

```
FilterPushDownOptimizer::visitScanNodeTableReplace(op)
  │
  ├─ for each property expression in the predicate set:
  │    │
  │    ├─ tryConvertToConstColumnPredicate(column, predicate)
  │    │    └─ if predicate is (column OP literal):
  │    │         create ColumnConstantPredicate → add to ColumnPredicateSet
  │    │
  │    └─ tryConvertToIsNull(column, predicate)
  │         └─ if predicate is IS NULL / IS NOT NULL:
  │              create ColumnNullPredicate → add to ColumnPredicateSet
  │
  └─ predicates that don't fit either form:
       → remain as LogicalFilter above the scan node
```

::: tip What can and cannot be pushed down
**Can be pushed down:** `col > literal`, `col = literal`, `col IS NULL`, `col BETWEEN lit AND lit`, any comparison of a property column against a constant value known at plan time.

**Cannot be pushed down:** comparisons between two columns (`a.age > b.age`), predicates involving functions (`lower(name) = 'alice'`), subquery-dependent predicates. These remain as row-level filters applied after decompression.
:::

---

## Step-by-Step Scan Execution

The following shows exactly where zone map checks fit in the scan pipeline for `SELECT * FROM Person WHERE age > 35`:

```
ScanNodeTable operator
│
├─ [Planning] FilterPushDownOptimizer builds:
│    ColumnPredicateSet { ColumnConstantPredicate(age > 35) }
│    → attached to ScanNodeTable operator
│
└─ [Execution] for each NodeGroup in the table:
     │
     └─ for each ColumnChunk in the NodeGroup:
          │
          ├─ stats = chunk.getCompressionMetadata()    // O(1), already in memory
          │                                             // no page pin required
          │
          ├─ result = predicateSet.checkZoneMap(stats)
          │    └─ ColumnConstantPredicate::checkZoneMap:
          │         if stats.max <= 35 → SKIP_SCAN
          │         else               → ALWAYS_SCAN
          │
          ├─ if SKIP_SCAN:
          │    └─ skip entire chunk (up to 2 048 rows)
          │         ✓ no buffer page pinned
          │         ✓ no decompression
          │         ✓ no row-level predicate evaluation
          │
          └─ if ALWAYS_SCAN:
               ├─ pin buffer page(s) for this chunk
               ├─ decompress chunk → output vector (up to 2 048 values)
               └─ for each row in vector:
                    if age > 35:        // row-level in-vector filter
                        emit row
```

::: tip Metadata is free
`CompressionMetadata` is embedded in the column chunk header, which is loaded when the node group is first accessed. The zone map check reads two `StorageValue` fields that are already in the metadata cache — no additional I/O whatsoever.
:::

For a table with 100 node groups where 90 have `max_age ≤ 35`, the scan touches only 10 node groups' data pages. The other 90 are skipped entirely.

---

## ALP Float Columns and Zone Maps

Columns compressed with ALP (floating-point encoding) have a two-level `CompressionMetadata` structure:

```
CompressionMetadata (ALP, outer)
├─ min, max          ← decoded float values  ← zone map uses these
├─ extraMetadata     (ALPMetadata: exp, fac, exception count)
└─ children[0]       (CompressionMetadata for INTEGER_BITPACKING of encoded ints)
     └─ min, max     ← encoded integer range (not used for zone map predicates)
```

Zone map predicates on ALP columns operate on the **outer** `min`/`max`, which hold the decoded float range. The inner integer range is an implementation detail of the compression layer and is invisible to the predicate layer.

The two special physical type IDs for ALP exceptions —

```cpp
PhysicalTypeID::ALP_EXCEPTION_FLOAT  = 15
PhysicalTypeID::ALP_EXCEPTION_DOUBLE = 16
```

— refer to the side array of verbatim float values that could not be encoded losslessly. These exception values are bounded by the same outer `min`/`max` (because `min`/`max` are computed over all original float values, including exceptions), so the zone map remains correct.

---

## Staleness: Zone Maps After UPDATE and DELETE

Zone maps are computed at **checkpoint time**. Between checkpoints, in-place updates and row deletions can make the stored `min`/`max` stale:

| Operation | Effect on zone map |
|---|---|
| `INSERT` into a chunk | New values may extend min/max beyond the stored range — but new rows go to new chunks, not existing ones |
| `UPDATE col = newVal` | `newVal` might be outside `[min, max]`; if so, min/max are NOT updated in-place |
| `DELETE` | Deleted row's value was the unique min or max; the stored bound is now tighter than reality |

::: warning Staleness is safe but never false-negative
After updates or deletes the zone map is a **conservative upper/lower bound**:

- **`SKIP_SCAN` is still sound.** For the skip to fire, the predicate constant must be outside `[min, max]`. Because no live value can exceed `max` or fall below `min` (updates that would extend the range only happen to new rows in fresh chunks), a SKIP decision will never incorrectly exclude a matching row.
- **`ALWAYS_SCAN` may be pessimistic.** After deleting the only row with `age = 80` in a chunk, the zone map still shows `max = 80`. A predicate `age > 75` will scan the chunk even though no matching row remains. This is a **false positive** (wasted work) but not a **false negative** (missing results).

After a full checkpoint, `CompressionAnalyzer::analyze()` recomputes `min`/`max` exactly over the current live data, eliminating the pessimism.
:::

---

## Related Files

- `src/storage/stats/table_stats.cpp` — `TableStats`, `ColumnStats`, serialize/deserialize
- `src/storage/stats/hyperloglog.cpp` — `HyperLogLog::add()`, `count()`, `merge()`, `estimateCardinality()`
- `src/planner/cardinality_estimator.cpp` — `CardinalityEstimator::init()`, `estimateScanNode()`, `estimateHashJoin()`
- `src/storage/table/node_table.cpp` — `NodeTable::getStats(transaction)`
- `src/storage/compression/compression.h` — `CompressionMetadata`, `StorageValue` union, `ALPMetadata`
- `src/storage/compression/compression.cpp` — `CompressionAnalyzer::analyze()`, min/max computation
- `src/include/storage/predicate/column_predicate.h` — `ColumnPredicate`, `ColumnConstantPredicate`, `ColumnNullPredicate`, `ColumnPredicateSet`
- `src/include/common/enums/zone_map_check_result.h` — `ZoneMapCheckResult` enum
- `src/optimizer/filter_push_down_optimizer.cpp` — `visitScanNodeTableReplace()`, `tryConvertToConstColumnPredicate()`, `tryConvertToIsNull()`
