# Semi-Mask & SIP Optimization

**Source files:** `src/processor/operator/semi_masker.cpp`, `src/include/processor/operator/semi_masker.h`, `docs/semi_mask_in_scan.md`

## The Problem: Graph Join I/O

Consider this query:

```cypher
MATCH (a:Person)-[:KNOWS]->(b:Person)
WHERE a.country = 'US'
RETURN b.name
```

Without optimization, the executor:
1. Scans all Person nodes for `b`
2. For each `b`, joins via KNOWS edges to find all `a`
3. Filters where `a.country = 'US'`

If only 1% of people are in the US, step 1 reads 100% of Person pages and 100% of KNOWS edge pages — most of it wasted I/O.

## Semi-Mask Concept

A **semi-mask** is a bitmap over node offsets. Before scanning the full `b` node table, the optimizer:

1. Scans `a` with `WHERE a.country = 'US'` → produces a set of `a` node IDs
2. Follows KNOWS edges from those `a`s → produces a set of `b` node IDs
3. Builds a semi-mask from those `b` IDs
4. When scanning `b` node table: **skip entire node groups that contain no set bits**

This is **Semi-Mask Intersection Pushdown (SIP)**.

## Roaring Bitmap Implementation

The semi-mask is a Roaring bitmap — a hybrid compressed bitset:

```cpp
// semi_masker.h
class Roaring32BitmapSemiMask : public SemiMask {
    // Used for graphs where node IDs fit in 32 bits (< 2^32 nodes)
    roaring_bitmap_t* bitmap;

    bool isNodeVisible(offset_t nodeOffset) const {
        return roaring_bitmap_contains(bitmap, (uint32_t)nodeOffset);
    }
};

class Roaring64BitmapSemiMask : public SemiMask {
    // Used for larger graphs (>= 2^32 nodes)
    roaring64_bitmap_t* bitmap;
};
```

Roaring bitmaps store sparse sets as sorted arrays (for small cardinality) or compressed bitsets (for dense regions), switching automatically. This gives near-optimal storage and fast `contains()` checks.

## Node Group Skipping

The key optimization is skipping entire node groups if the semi-mask has no bits set in that group's range:

```cpp
bool ScanNodeTableSharedState::skipNodeGroup(
    node_group_idx_t groupIdx,
    const SemiMask& semiMask
) {
    offset_t groupStart = groupIdx * NODE_GROUP_SIZE;    // e.g., 131072 * groupIdx
    offset_t groupEnd   = groupStart + NODE_GROUP_SIZE;  // e.g., 131072 * (groupIdx+1)
    return !semiMask.hasAnyBitInRange(groupStart, groupEnd);
}
```

`hasAnyBitInRange()` on a Roaring bitmap is O(log(num_containers)) — fast enough to evaluate before issuing any I/O.

For a 1% selectivity join on 1M nodes (8 node groups):
- Without SIP: read all 8 node groups (64 pages)
- With SIP: skip 7-8 node groups → read ≈0-1 node group (0-8 pages)

## SIP Directions

```cpp
enum class SIPDirection {
    BUILD_TO_PROBE,  // default: semi-mask flows from build side to probe side
    PROBE_TO_BUILD,  // reverse: semi-mask flows from probe side to build side
};
```

**BUILD_TO_PROBE** (default): After the hash join build side is done, build a semi-mask from the build side keys and push it to the probe side scan.

**PROBE_TO_BUILD**: Used when the probe side is more selective. The probe side scan builds a semi-mask and pushes it backward to filter the build side scan.

The choice is made by `AccHashJoinOptimizer` based on estimated cardinalities.

## AccHashJoinOptimizer

```cpp
// acc_hash_join_optimizer.cpp
class AccHashJoinOptimizer {
    // Decides SIP direction for each hash join in the plan
    SIPDirection chooseSIPDirection(
        const HashJoinPlan& join,
        const CardinalityEstimator& estimator
    );
};
```

Heuristic: if `estimatedBuildSize < estimatedProbeSize × threshold`, use BUILD_TO_PROBE; otherwise PROBE_TO_BUILD.

## SemiMasker Operator

The `SemiMasker` is a pipelined operator inserted between the source scan and the join:

```cpp
class SemiMasker : public PhysicalOperator {
    SemiMask* mask;  // points to the relevant Roaring bitmap

    bool getNextTuple(ExecutionContext& context) override {
        // Pull next DataChunk from child
        bool hasMore = children[0]->getNextTuple(context);
        // For each valid row: add node ID to semi-mask
        auto& vec = resultSet->getValueVector(nodeIDVectorPos);
        for (auto i = 0; i < vec.state->selVector->selectedSize; i++) {
            auto pos = vec.state->selVector->selectedPositions[i];
            mask->add(vec.getValue<offset_t>(pos));
        }
        return hasMore;
    }
};
```

## Only Applies to COMMITTED Source

Semi-masks are only applied when scanning `TableScanSource::COMMITTED` data. The local storage scan (uncommitted writes) is always fully scanned — semi-masks are never pushed to local-only paths, since the local storage is typically tiny and the overhead of applying a mask there outweighs the benefit.

## Worked Numerical Example

```
Graph: 1,000,000 Person nodes (8 node groups), 5,000,000 KNOWS edges
Query: MATCH (a)-[:KNOWS]->(b) WHERE a.country='US' RETURN b.name
Selectivity of a.country='US': 1% = 10,000 a-nodes
Average out-degree of KNOWS: 5

Without SIP:
  Scan b: 8 node groups × 16 pages = 128 page reads
  Scan KNOWS: 5,000,000 edges = ~40 pages (CSR indices file)
  Total: ~168 page reads

With SIP (BUILD_TO_PROBE):
  Scan a (filtered): 8 node groups × 16 pages = 128 reads  ← full scan to apply WHERE
  Build semi-mask: 10,000 a-nodes × avg 5 edges = 50,000 b-node IDs
  Semi-mask covers ~50,000/1,000,000 = 5% of node ID space
  Node group check: each group has 131,072 slots
  Expected b-node groups with hits: 50,000/131,072 × 8 ≈ 3 groups
  Scan b: ~3 node groups × 16 pages = 48 reads (vs 128 without SIP)
  Total: 128 + 48 ≈ 176 reads  ← slightly more (semi-mask build cost)

BUT: for deeper multi-hop (a)→(b)→(c), SIP on c can skip >90% of c pages:
  10,000 a × 5 edges × 5 edges = 250,000 c-nodes out of 1M → skip 75%+ of node groups
```

## Related Files

- `src/processor/operator/semi_masker.cpp` — SemiMasker operator
- `src/include/processor/operator/semi_masker.h` — SemiMask base class, Roaring variants
- `src/optimizer/acc_hash_join_optimizer.cpp` — SIP direction chooser
- `docs/semi_mask_in_scan.md` — original design document (in repo)
- `src/include/processor/operator/scan/` — scan states that check the semi-mask
