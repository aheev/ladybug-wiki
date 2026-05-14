# Cypher Query Internals

This page walks through how several representative Cypher queries execute inside LadybugDB, from parsing to final output. For the pipeline and morsel-parallel execution model, see [Pipelines](./pipeline) and [Morsel-Driven Parallelism](../execution/morsel).

## Query Lifecycle

Every Cypher statement goes through five stages:

```
Query string
   │
   ▼ Parser         (ANTLR4 → AST)
Statement AST
   │
   ▼ Binder         (name resolution → typed expression tree)
Bound statement
   │
   ▼ Planner        (logical plan: RelationalAlgebra)
Logical plan
   │
   ▼ Optimizer      (filter pushdown, join order, etc.)
Optimized logical plan
   │
   ▼ Physical mapper (logical → PhysicalOperator tree + Pipeline grouping)
PhysicalPlan (pipelines)
   │
   ▼ Executor       (morsel-parallel evaluation)
QueryResult
```

See [Parser](./parser), [Binder](./binder), [Planner](./planner), [Optimizer](./optimizer) for details on each stage.

---

## Walkthrough 1: Full Node Scan With Projection

```cypher
MATCH (p:person) RETURN p.fName, p.age
```

### Logical Plan

```
Projection[p.fName, p.age]
  └── ScanNodeTable[person]
```

### Physical Plan

Single pipeline (no pipeline-breaking operators):

```
ScanNodeTable  →  Projection  →  ResultCollector
```

### Execution

1. **Morsel assignment** — `ScanNodeTableSharedState` holds an atomic `currentCommittedGroupIdx`. Each worker thread calls `getNextMorsel()`:
   ```cpp
   nodeGroupIdx = currentCommittedGroupIdx.fetch_add(1);
   ```
   A morsel = one node group (up to 131,072 rows). Threads claim node groups independently.

2. **Column read** — For each morsel, the scan reads only the projected columns (`fName`, `age`). The compressed blocks are decompressed in place into `ValueVector` slots.

3. **MVCC filter** — The scan checks each row's visibility against the current transaction's snapshot timestamp. Uncommitted rows from `LocalNodeTable` are appended after committed rows.

4. **Projection** — The `Projection` operator evaluates `p.fName` and `p.age` expressions and writes them into the output DataChunk.

5. **Collect** — `ResultCollector` accumulates DataChunks from all workers into the final `QueryResult`.

---

## Walkthrough 2: Primary-Key Lookup

```cypher
MATCH (p:person) WHERE p.id = 42 RETURN p.fName
```

The binder detects that `id` is the primary key and rewrites to a **point lookup**:

### Logical Plan

```
Projection[p.fName]
  └── PrimaryKeyScan[person, id = 42]
```

### Physical Plan

```
PrimaryKeyScanNodeTable  →  Projection  →  ResultCollector
```

### Execution

1. The scan uses `HashIndex::lookup(key=42)` to get `nodeOffset` directly (O(1) hash table probe).
2. The resolved `nodeOffset` is placed in the `nodeIDVector`.
3. A single-row fetch reads the `fName` column at that offset — no morsel iteration.
4. No MVCC row loop: the hash index lookup returns the offset only if the entry is visible.

The planner prioritizes this path over a full scan whenever a predicate targets the primary key.

---

## Walkthrough 3: One-Hop Relationship Traversal

```cypher
MATCH (a:person)-[e:knows]->(b:person) RETURN a.fName, b.fName
```

### Logical Plan

```
Projection[a.fName, b.fName]
  └── ScanRelTable[knows, fwd]
        └── ScanNodeTable[person as a]
```

### Physical Plan (two pipelines)

```
Pipeline 1 (build side):
  ScanNodeTable[person as a]  →  SemiMasker[b's nodeIDs]  →  (block)

Pipeline 2 (probe side):
  ScanNodeTable[person as b]  →  ScanRelTable[knows, fwd]  →  Projection  →  ResultCollector
```

### Execution

1. **Pipeline 1: ScanNodeTable[person as a]**
   - Scans node groups of `person` in parallel.
   - For each `a` node, evaluates the `knows` adjacency list length as a validity check.
   - `SemiMasker` writes a bit into a shared `SemiMask` for every `a.nodeID` that has at least one outgoing `knows` edge. This prunes `b` nodes that can never be reached.

2. **Pipeline 2: ScanNodeTable[person as b]**
   - Morsel-parallel scan of `person` node groups.
   - For each `b` node, checks the `SemiMask`: if `b.nodeID` is not set, skip.
   - **ScanRelTable[knows, fwd]**: for each remaining `b`, looks up `indptr[b.nodeID]` and scans `indices[indptr[b.nodeID] .. indptr[b.nodeID+1])` to enumerate all `a` neighbors.
   - Each `(a, b)` pair is output as a DataChunk row.
   - Projection fetches `a.fName` and `b.fName` via random-access column reads.

See [Semi-Mask](../execution/semi-mask) and [Table Scan Internals](../execution/scan) for the full scan and semi-mask details.

---

## Walkthrough 4: Filtered Scan With Index Probe

```cypher
MATCH (a:person)-[e:knows]->(b:person)
WHERE b.age > 35
RETURN a.fName, b.fName, b.age
```

### Optimization

The optimizer applies **filter pushdown**: the `b.age > 35` predicate is pushed into `ScanNodeTable[b]`. This means `b` rows with `age ≤ 35` never enter the pipeline.

### Physical Plan

```
ScanNodeTable[person as b, filter: age > 35]
  → ScanRelTable[knows, reverse]
  → ScanNodeTable[person as a, fetch: fName]
  → Projection
  → ResultCollector
```

### Execution

The pushed-down filter is evaluated by `ColumnChunk::Filterer`. Inside the decompressed column block, the filterer computes a `SelectionVector` of valid row positions before writing values to the `ValueVector`. Rows failing the predicate are never materialized.

---

## Walkthrough 5: Aggregation

```cypher
MATCH (p:person) RETURN p.age, COUNT(*) AS cnt ORDER BY p.age
```

### Logical Plan

```
OrderBy[p.age ASC]
  └── Aggregate[groupBy: p.age, COUNT(*)]
        └── ScanNodeTable[person]
```

### Physical Plan (pipeline break at Aggregate)

```
Pipeline 1 (parallel):
  ScanNodeTable[person]  →  Aggregate (local hash table per thread)  →  (block)

Pipeline 2 (finalize):
  MergeAggregate  →  OrderBy  →  ResultCollector
```

### Execution

1. Each worker thread runs its own local `HashAggregateTable` keyed on `p.age`.
2. After pipeline 1, `MergeAggregate` merges all local tables into a single result (thread-safe merge at barrier).
3. `OrderBy` sorts by `p.age` using a radix sort.
4. `ResultCollector` emits the final `(age, count)` pairs.

---

## Walkthrough 6: CREATE (Insert)

```cypher
CREATE (:person {id: 100, name: "Dave", age: 40})
```

### Physical Plan

```
Insert[person]  →  ResultCollector
```

### Execution

1. **LocalNodeTable** — the row is inserted into the per-transaction `LocalNodeTable` (in-memory). The primary key `id=100` is looked up in `LocalHashIndex` to detect conflicts.

2. **WAL logging** — `LocalWAL::logTableInsertion(tableID, numRows=1, vectors)` appends a `TABLE_INSERTION_RECORD` to the in-memory `LocalWAL`.

3. **COMMIT** — `TransactionContext::commit()`:
   - Flushes `LocalWAL` bytes to the shared on-disk `WAL` via `WAL::logCommittedWAL()`.
   - Flushes `LocalNodeTable` inserts → appends to the committed `NodeTable` storage.
   - Appends primary key entry to the committed `HashIndex`.

4. **Auto-checkpoint** — if WAL size exceeds the threshold (default 100 MB), `Checkpointer::checkpoint()` runs asynchronously after commit.

---

## Walkthrough 7: DELETE With Detach

```cypher
MATCH (p:person {id: 100}) DETACH DELETE p
```

### Physical Plan

```
PrimaryKeyScan[person, id=100]  →  DetachDelete[person]  →  ResultCollector
```

### Execution

1. PrimaryKeyScan resolves `p.nodeOffset` via hash index.
2. `DetachDelete`:
   - For each relationship table connected to `person`, calls `RelTable::detachDelete(nodeOffset, direction)`.
   - Internally this iterates the adjacency list and calls `logRelDetachDelete` on each connected edge.
   - Marks the node as deleted in the `LocalNodeTable` undo buffer.
   - Logs `NODE_DELETION_RECORD` + `REL_DETACH_DELETE_RECORD` to `LocalWAL`.
3. On commit, MVCC visibility of the deleted node/edges is hidden from future transactions (see [MVCC](../transaction/mvcc)).

---

## Operator Reference

| Operator | File | Role |
|----------|------|------|
| `ScanNodeTable` | `scan/scan_node_table.cpp` | Morsel-parallel node scan |
| `PrimaryKeyScanNodeTable` | `scan/primary_key_scan_node_table.cpp` | O(1) hash index lookup |
| `ScanRelTable` | `scan/scan_rel_table.cpp` | CSR adjacency list traversal |
| `ScanMultiRelTables` | `scan/scan_multi_rel_tables.cpp` | Multi-label relationship scan |
| `Filter` | `filter.cpp` | Evaluates predicate and applies SelVector |
| `HashJoinBuild` | `hash_join/hash_join_build.cpp` | Build phase: populate `JoinHashTable` |
| `HashJoinProbe` | `hash_join/hash_join_probe.cpp` | Probe phase: lookup keys |
| `Aggregate` | `aggregate/` | Hash aggregation with local tables per thread |
| `OrderBy` / `TopK` | `order_by/` | Radix sort and top-K sort |
| `Limit` / `Skip` | `limit.cpp`, `skip.cpp` | Row-count limiting |
| `Projection` | `projection.cpp` | Expression evaluation and column reordering |
| `SemiMasker` | `semi_masker.cpp` | Set bits in shared SemiMask for probe pruning |
| `RecursiveExtend` | `recursive_extend.cpp` | Variable-length path expansion |
| `Insert` | `persistent/insert.cpp` | Row insertion into LocalNodeTable/LocalRelTable |
| `Delete` | `persistent/delete.cpp` | Mark rows deleted in undo buffer |
| `Update` | `persistent/update.cpp` | Write new column values to undo buffer |

## Related Pages

- [Vectorized Execution](../execution/vectorized) — DataChunk and ValueVector
- [Pipeline Execution](../execution/pipeline) — pipeline structure, sinks and sources
- [Morsel-Driven Parallelism](../execution/morsel) — thread pool and morsel assignment
- [Table Scan Internals](../execution/scan) — deep scan walkthrough
- [Semi-Mask](../execution/semi-mask) — semi-mask optimization detail
- [Planner](./planner) — logical plan construction
- [Optimizer](./optimizer) — rule-based optimization passes
