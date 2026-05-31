# Vector Index Extension (HNSW)

The `vector` extension adds a **Hierarchical Navigable Small World (HNSW)** index to LadybugDB, enabling approximate nearest-neighbour (ANN) search over `FLOAT[]` and `DOUBLE[]` columns. It is implemented in `extension/vector/`.

---

## Quick Start

```cypher
-- Load the extension
LOAD EXTENSION vector

-- 1. Create a node table with a fixed-width embedding column
CREATE NODE TABLE Book (
    ID     SERIAL,
    title  STRING,
    emb    FLOAT[384],
    PRIMARY KEY (ID)
);

-- 2. Populate it (embeddings are 384-dimensional FLOAT arrays)
CREATE (:Book {title: 'The Quantum World', emb: [...]});

-- 3. Build an HNSW index on the embedding column
CALL CREATE_VECTOR_INDEX('Book', 'title_idx', 'emb');

-- 4. Query the k nearest neighbours
CALL QUERY_VECTOR_INDEX('Book', 'title_idx', [0.1, 0.2, ...], 5)
RETURN node.title, distance
ORDER BY distance;

-- 5. Drop the index when no longer needed
CALL DROP_VECTOR_INDEX('Book', 'title_idx');
```

---

## Loading the Extension

```cypher
-- Dynamic load (development / standalone binary)
LOAD EXTENSION "${LBUG_ROOT_DIRECTORY}/extension/vector/build/libvector.lbug_extension"

-- Official release channel
FORCE INSTALL vector FROM 'http://extension-repo/';
LOAD vector;
```

The extension registers itself via:

```cpp
// extension/vector/src/main/vector_extension.cpp
void VectorExtension::load(main::ClientContext* context) {
    ExtensionUtils::addStandaloneTableFunc<CreateVectorIndexFunction>(db);
    ExtensionUtils::addInternalStandaloneTableFunc<InternalCreateVectorIndexFunction>(db);
    ExtensionUtils::addStandaloneTableFunc<DropVectorIndexFunction>(db);
    ExtensionUtils::addInternalStandaloneTableFunc<InternalDropVectorIndexFunction>(db);
    ExtensionUtils::addTableFunc<QueryVectorIndexFunction>(db);
    ExtensionUtils::registerIndexType(db, OnDiskHNSWIndex::getIndexType());
    initHNSWEntries(context, *db.getCatalog());
}
```

---

## Creating an Index — `CREATE_VECTOR_INDEX`

### Signature

```
CALL CREATE_VECTOR_INDEX(tableName, indexName, propertyName [, options...])
```

| Parameter      | Type   | Required | Description                                |
|----------------|--------|----------|--------------------------------------------|
| `tableName`    | STRING | yes      | Name of the node table                     |
| `indexName`    | STRING | yes      | Name to assign to the index                |
| `propertyName` | STRING | yes      | Name of the `FLOAT[]` or `DOUBLE[]` column |

The third argument must refer to a column of type `ARRAY(FLOAT, N)` or `ARRAY(DOUBLE, N)`. Any other type raises a `BinderException` from `HNSWIndexUtils::validateColumnType`.

### Optional Parameters

All optional parameters are passed as `key := value` pairs after the mandatory arguments.

| Parameter                          | Default    | Constraint              | Description                                                     |
|------------------------------------|------------|-------------------------|-----------------------------------------------------------------|
| `mu`                               | `30`       | 2 ≤ mu ≤ 2000          | Maximum degree (number of neighbours) per node in lower layer  |
| `ml`                               | `15`       | 1 ≤ ml ≤ 1000          | Maximum degree in upper (sparse) layer                         |
| `pu`                               | `5`        | 0 < pu ≤ 100           | Probability (%) of a new node being promoted to upper layer    |
| `metric`                           | `"cosine"` | see table below         | Distance / similarity metric                                   |
| `alpha`                            | `1.0`      | > 0                     | RNG heuristic shrink factor                                     |
| `efc`                              | `200`      | > 0                     | `ef_construction` — beam width during index build              |
| `efs`                              | `200`      | > 0                     | `ef_search` — beam width during ANN query                      |
| `cache_embeddings`                 | `true`     | boolean                 | Cache all vectors in memory (faster queries, more RAM)          |
| `skip_if_exists`                   | `false`    | boolean                 | Return silently instead of raising error if index already exists|
| `blind_search_upper_sel_threshold` | `0.005`    | 0.0–1.0                 | Selectivity threshold to switch to blind two-hop filtered search|
| `directed_search_upper_sel_threshold`| `0.05`  | 0.0–1.0                 | Selectivity threshold to switch to directed filtered search     |

#### Supported Metrics

| String     | Similarity Function          | Notes                                      |
|------------|------------------------------|--------------------------------------------|
| `"cosine"` | `simsimd_cos_f32/f64`        | Default; most widely used for embeddings   |
| `"dotproduct"` | `simsimd_dot_f32/f64`    | Inner product; use with normalised vectors |
| `"l2"`     | `simsimd_l2_f32/f64`         | Euclidean distance                         |
| `"l2sq"`   | `simsimd_l2sq_f32/f64`       | Squared Euclidean (avoids sqrt)            |

The metric function is dispatched at bind time based on the column element type (`FLOAT` → `f32`, `DOUBLE` → `f64`) using the **simsimd** library.

### Example with Options

```cypher
CALL CREATE_VECTOR_INDEX(
    'Book',
    'book_vec_idx',
    'title_embedding',
    mu    := 64,
    ml    := 32,
    pu    := 5,
    metric := 'cosine',
    efc   := 400,
    efs   := 200,
    cache_embeddings := true
);
```

---

## Querying — `QUERY_VECTOR_INDEX`

### Signature

```
CALL QUERY_VECTOR_INDEX(tableName, indexName, queryVector, k [, options...])
RETURN node.<property>, distance [ORDER BY distance]
```

| Parameter     | Type               | Required | Description                                |
|---------------|--------------------|----------|--------------------------------------------|
| `tableName`   | STRING             | yes      | Same table on which the index was built    |
| `indexName`   | STRING             | yes      | Name of the HNSW index                    |
| `queryVector` | FLOAT[] / DOUBLE[] | yes      | Query embedding — must match column type   |
| `k`           | INT64              | yes      | Number of approximate nearest neighbours  |

The function returns a virtual table with two columns: `node` (INTERNAL_ID of the result document) and `distance` (DOUBLE — lower is closer for L2/L2sq; higher is closer for cosine/dot, but the engine returns a value that can be sorted ascending).

### Optional Query Parameters

| Parameter        | Default | Description                                              |
|------------------|---------|----------------------------------------------------------|
| `efs`            | index-time `efs` (default 200) | Override beam width for this query |
| `skip_if_not_exists` | `false` | Return empty instead of error when index is missing |

### BM25-style Filtered Search

When the `QUERY_VECTOR_INDEX` call is combined with a `WHERE` clause in the same `MATCH`, the planner detects the predicate and passes a **semi-mask** into the HNSW search. The engine selects one of four search strategies automatically based on the mask selectivity:

| Strategy                 | Enum                        | When Used                                                             |
|--------------------------|-----------------------------|-----------------------------------------------------------------------|
| `UNFILTERED`             | `SearchType::UNFILTERED`    | No filter predicate                                                   |
| `BLIND_TWO_HOP`          | `SearchType::BLIND_TWO_HOP` | Selectivity ≤ `blind_search_upper_sel_threshold` (default 0.5%)       |
| `DIRECTED_TWO_HOP`       | `SearchType::DIRECTED_TWO_HOP`| Selectivity ≤ `directed_search_upper_sel_threshold` (default 5%)    |
| `ONE_HOP_FILTERED`       | `SearchType::ONE_HOP_FILTERED`| Selectivity above both thresholds                                   |

```cypher
-- Filtered query: only books published after 2010
CALL QUERY_VECTOR_INDEX('Book', 'book_vec_idx', $queryEmb, 5)
WITH node, distance
MATCH (node)
WHERE node.published_year > 2010
RETURN node.title, distance
ORDER BY distance;
```

### Effective `ef`

During search, `ef = max(k, efs)`. This means increasing `k` can automatically increase recall at the cost of more work.

### Non-Parallel Execution

`QUERY_VECTOR_INDEX` is registered with `canParallelFunc = [] { return false; }`. It executes in a single thread even when the surrounding query uses multiple workers.

---

## Dropping an Index — `DROP_VECTOR_INDEX`

```cypher
CALL DROP_VECTOR_INDEX('Book', 'book_vec_idx');
```

The `skip_if_not_exists` option (default `false`) can be passed to suppress errors when the index does not exist.

---

## Internal Architecture

### Two-Layer HNSW Graph

The HNSW index is stored as **two internal relationship tables**:

| Table Name Pattern                      | Layer   | Nodes Present           |
|-----------------------------------------|---------|-------------------------|
| `_{tableID}_{indexName}_UPPER`          | Upper   | ~pu% of all nodes       |
| `_{tableID}_{indexName}_LOWER`          | Lower   | All nodes               |

A new node is promoted to the upper layer if `rand() <= INSERT_TO_UPPER_LAYER_RAND_UPPER_BOUND * pu / 100`. The constant `INSERT_TO_UPPER_LAYER_RAND_UPPER_BOUND = 100`.

### Graph Representation — `InMemHNSWGraph`

```cpp
// extension/vector/src/include/index/hnsw_graph.h
class InMemHNSWGraph {
    CompressedNodeOffsetBuffer csr;          // CSR neighbour offset table
    std::vector<std::atomic<uint16_t>> csrLength; // per-node degree (atomic)
    uint64_t maxDegree;                      // mu or ml
    uint64_t degreeThresholdToShrink;        // ceil(degree * 1.25)
};
```

- **CSR layout**: `CompressedNodeOffsetBuffer` holds raw `offset_t` values in a flat `MemoryBuffer`. Offsets are compact unsigned integers.
- **Degree cap**: When a node's degree reaches `degreeThresholdToShrink = ceil(maxDegree * 1.25)`, `shrinkForNode` runs the HNSW RNG heuristic (controlled by `alpha`) to prune edges.

### Embedding Storage — `HNSWIndexEmbeddings`

Two implementations are selected at index build time:

| Class                | Condition               | Description                                              |
|----------------------|-------------------------|----------------------------------------------------------|
| `InMemEmbeddings`    | `cache_embeddings=true` | Wraps `CachedColumn`; all vectors kept in memory          |
| `OnDiskEmbeddings`   | `cache_embeddings=false`| Reads from the live `NodeTable` column on each access    |

### Persistence — `HNSWStorageInfo`

Serialised fields (in order):

| Field                  | Type      | Description                                       |
|------------------------|-----------|---------------------------------------------------|
| `upperRelTableID`      | table_id_t| ID of the upper layer relation table              |
| `lowerRelTableID`      | table_id_t| ID of the lower layer relation table              |
| `upperEntryPoint`      | offset_t  | Entry-point node in upper layer                   |
| `lowerEntryPoint`      | offset_t  | Entry-point node in lower layer                   |
| `numCheckpointedNodes` | offset_t  | Nodes persisted at last checkpoint                |

### Handling Un-Checkpointed Rows

Rows inserted after the last checkpoint are not yet in the HNSW graph. During search, the engine performs a **linear (brute-force) scan** from `numCheckpointedNodes` to `numTotalRows`. The threshold constant `INSERTION_BATCH_MERGE_THRESHOLD = 2000` controls when pending inserts are flushed.

### Incremental Inserts

The `HNSWRelBatchInsert` pipeline divides work via `HNSWLayerPartitionerSharedState` and `HNSWIndexPartitionerSharedState`. Rows are inserted into the lower layer first, then the upper layer for promoted nodes.

**Important**: Updating an indexed property is not supported. The engine throws:

> "Cannot set property `vec` in table `embeddings` because it is used in one or more indexes. Try delete and then insert."

---

## Catalog Entry

At creation time, `HNSWIndexCatalogEntry` is registered with the catalog. It carries:

```cpp
// extension/vector/src/include/catalog/hnsw_index_catalog_entry.h
struct HNSWIndexAuxInfo {
    HNSWConfig config;  // full copy of all config parameters
};
```

The `OnDiskHNSWIndex::getIndexType()` static method returns:

```cpp
IndexType{"HNSW", SECONDARY_NON_UNIQUE, EXTENSION, &OnDiskHNSWIndex::load}
```

---

## Configuration Reference

All configuration structs live in `extension/vector/src/include/index/hnsw_config.h`.

```cpp
struct Mu              { static constexpr uint64_t DEFAULT_VALUE = 30;    };
struct Ml              { static constexpr uint64_t DEFAULT_VALUE = 15;    };
struct Pu              { static constexpr double   DEFAULT_VALUE = 5.0;   };
struct Metric          { static constexpr auto     DEFAULT_VALUE = "cosine"; };
struct Alpha           { static constexpr double   DEFAULT_VALUE = 1.0;   };
struct Efc             { static constexpr uint64_t DEFAULT_VALUE = 200;   };
struct Efs             { static constexpr uint64_t DEFAULT_VALUE = 200;   };
struct CacheEmbeddings { static constexpr bool     DEFAULT_VALUE = true;  };
struct SkipIfExists    { static constexpr bool     DEFAULT_VALUE = false; };
struct SkipIfNotExists { static constexpr bool     DEFAULT_VALUE = false; };
struct BlindSearchUpSelThreshold    { static constexpr double DEFAULT_VALUE = 0.005; };
struct DirectedSearchUpSelThreshold { static constexpr double DEFAULT_VALUE = 0.05;  };
```

The maximum degree is validated by:

```cpp
// hnsw_config.cpp
if (mu > MAX_DEGREE) {
    throw BinderException("mu must be at most " + std::to_string(MAX_DEGREE));
}
// MAX_DEGREE = 2000  (for ml, MAX_DEGREE/2 = 1000)
```

---

## Combining with the LLM Extension

A common pattern is to generate embeddings via the `llm` extension and immediately index them:

```cypher
LOAD EXTENSION llm;
LOAD EXTENSION vector;

-- Store embeddings
MATCH (b:Book)
WITH b, CREATE_EMBEDDING(b.title, 'openai', 'text-embedding-3-small') AS emb
SET b.title_embedding = emb;

-- Build index
CALL CREATE_VECTOR_INDEX('Book', 'title_vec_index', 'title_embedding');

-- Query
CALL QUERY_VECTOR_INDEX(
    'Book',
    'title_vec_index',
    CREATE_EMBEDDING('quantum machine learning', 'openai', 'text-embedding-3-small'),
    2
)
RETURN node.title
ORDER BY distance;
```

---

## Error Reference

| Error                                                    | Cause                                                       |
|----------------------------------------------------------|-------------------------------------------------------------|
| `Binder exception: Table X does not exist.`              | Unknown table name in `CREATE_VECTOR_INDEX`                 |
| `Binder exception: Index Y already exists in table X.`  | Duplicate index name; use `skip_if_exists := true`          |
| `Binder exception: mu must be at most 2000`             | `mu` out of range                                           |
| `Binder exception: HNSW index only supports ARRAY types.`| Column is not `FLOAT[]` or `DOUBLE[]`                       |
| `Runtime exception: Cannot set property ...`            | Attempt to UPDATE an HNSW-indexed column (not supported)    |
| `Binder exception: Table X doesn't have an index Y.`    | Query on non-existent index; use `skip_if_not_exists := true`|

---

## Implementation File Map

| File                                                        | Purpose                                           |
|-------------------------------------------------------------|---------------------------------------------------|
| `extension/vector/src/include/index/hnsw_config.h`          | All config struct definitions with defaults       |
| `extension/vector/src/include/index/hnsw_index.h`           | `HNSWIndex`, `InMemHNSWIndex`, `OnDiskHNSWIndex`  |
| `extension/vector/src/include/index/hnsw_graph.h`           | `InMemHNSWGraph`, `CompressedNodeOffsetBuffer`    |
| `extension/vector/src/include/index/hnsw_index_functions.h` | Public function structs and bind data             |
| `extension/vector/src/index/hnsw_index.cpp`                 | Core algorithm: insert, searchNN, searchKNN       |
| `extension/vector/src/index/hnsw_index_utils.cpp`           | simsimd dispatch, `validateColumnType`            |
| `extension/vector/src/function/create_hnsw_index.cpp`       | `CREATE_VECTOR_INDEX` bind and execution          |
| `extension/vector/src/function/query_hnsw_index.cpp`        | `QUERY_VECTOR_INDEX` bind, plan, filtered search  |
| `extension/vector/src/main/vector_extension.cpp`            | Extension load and function registration          |

---

## HNSW Algorithm Deep Dive

### Insert Flow (`InMemHNSWIndex::insert`)

1. Draw a random number; if `rand <= 100 * pu`, add to upper layer.
2. Start search from the current upper entry point using `searchNN` (nearest-neighbour), navigating the upper layer greedily.
3. Insert the new node into the lower layer with `InMemHNSWLayer::insert`:
   a. Run `searchKNN` from the lower entry point to find `efc` candidates.
   b. Select the best `mu` neighbours (RNG heuristic via `alpha`).
   c. Add bidirectional edges; if any neighbour now exceeds `degreeThresholdToShrink`, run `shrinkForNode`.
4. If the node was promoted, repeat step 3 for the upper layer with `ml` as max degree.
5. Update entry points if the new node is the first in its layer.

### Search Flow (`OnDiskHNSWIndex::search`)

For checkpointed nodes, standard HNSW greedy descent is used. For un-checkpointed nodes, a brute-force linear scan is appended to the result set. Results are merged and the top-k are returned via `HNSWIndex::popTopK`.

### Shrink Heuristic (`shrinkForNode`)

When a node has too many neighbours, the HNSW **Relative Neighbourhood Graph (RNG)** heuristic is applied:

1. Collect all current neighbours.
2. Sort by distance to the node.
3. Greedily retain a neighbour `n` only if no already-retained neighbour `m` satisfies `dist(n, m) * alpha < dist(node, n)`.
4. The `alpha` parameter controls aggressiveness; `alpha = 1.0` (default) is the standard heuristic.

---

## Performance Tuning

### Build Time

| Parameter | Effect                                                                   |
|-----------|--------------------------------------------------------------------------|
| `efc`     | Higher `efc` → better graph quality → slower build. Default: 200.       |
| `mu`      | Higher `mu` → more edges → higher recall but more memory and slower build. Default: 30. |
| `ml`      | Controls upper layer density; rarely needs to change. Default: 15.       |
| `pu`      | Fraction of nodes in upper layer. Lower pu = smaller upper layer = faster search entry but shallower hierarchy. Default: 5. |
| `cache_embeddings` | `true` (default) keeps all vectors in RAM during build, significantly faster than re-reading from disk. |

### Query Time

| Parameter | Effect                                                                   |
|-----------|--------------------------------------------------------------------------|
| `efs`     | Higher `efs` → more candidates explored → higher recall → slower. Effective `ef = max(k, efs)`. |
| `metric`  | Choose based on how embeddings were trained. Most embedding models use cosine. |

### Memory Usage

When `cache_embeddings=true`, all embedding vectors are loaded into memory:
- For `FLOAT[384]` and 1 million nodes: ~384 × 4 × 1,000,000 ≈ 1.5 GB
- For `FLOAT[1536]` and 1 million nodes: ~1536 × 4 × 1,000,000 ≈ 6 GB

Use `cache_embeddings=false` for very large tables where RAM is constrained. Query speed will be reduced because vectors must be read from disk on each distance computation.

### Recall vs. Speed Trade-Off

The HNSW algorithm is approximate. Exact recall at 100% is not guaranteed. To improve recall:
1. Increase `efs` at query time.
2. Increase `efc` at build time (rebuild needed).
3. Increase `mu` to allow each node more neighbours (rebuild needed).

For a quick ad-hoc check after changes, use a brute-force cosine scan as a baseline:

```cypher
-- Brute-force reference (use only on small tables)
MATCH (b:Book)
RETURN b.title, array_cosine_similarity(b.title_embedding, $queryEmb) AS sim
ORDER BY sim DESC LIMIT 5;
```

---

## Constraints and Limitations

1. **Column type**: Only `FLOAT[]` (= `ARRAY(FLOAT, N)`) and `DOUBLE[]` are supported. Use `CAST(col AS FLOAT[N])` to convert if needed.
2. **Updates not supported**: Setting an indexed vector property raises a runtime error. Delete and re-insert the node.
3. **Auto-transaction only**: `CREATE_VECTOR_INDEX`, `DROP_VECTOR_INDEX`, and `QUERY_VECTOR_INDEX` must run outside of a manual transaction.
4. **Single-threaded query**: HNSW search is not parallelised (`canParallelFunc = false`). Multiple concurrent queries from different connections run on separate threads.
5. **Fixed dimension**: All vectors in the table must have the same dimension (enforced by the `ARRAY(T, N)` type).
6. **One index per column**: Multiple indexes on the same column are allowed (e.g., with different metrics), but each has independent storage.

---

## Worked Example: Books Semantic Search

```cypher
LOAD EXTENSION llm;
LOAD EXTENSION vector;

-- Schema
CREATE NODE TABLE Book (
    id              SERIAL PRIMARY KEY,
    title           STRING,
    abstract        STRING,
    published_year  INT64,
    title_embedding FLOAT[1536]
);

-- Data
CREATE
    (:Book {title: 'The Quantum World',          abstract: 'Quantum mechanics for everyone.',         published_year: 2004}),
    (:Book {title: 'Learning Machines',           abstract: 'Machine learning from scratch.',          published_year: 2019}),
    (:Book {title: 'Echoes of the Past',          abstract: 'A historical novel of ancient empires.',  published_year: 2010}),
    (:Book {title: 'Chronicles of the Universe',  abstract: 'Astrophysics and cosmology explained.',   published_year: 2022}),
    (:Book {title: 'The Dragon Call',             abstract: 'Epic fantasy with dragons and magic.',    published_year: 2015});

-- Generate embeddings
MATCH (b:Book)
WITH b, CREATE_EMBEDDING(b.title + ' ' + b.abstract, 'openai', 'text-embedding-3-small') AS emb
SET b.title_embedding = emb;

-- Build HNSW index
CALL CREATE_VECTOR_INDEX('Book', 'book_emb_idx', 'title_embedding',
    mu := 32, efc := 400, metric := 'cosine');

-- ANN query — find 3 most relevant books about physics
CALL QUERY_VECTOR_INDEX(
    'Book', 'book_emb_idx',
    CREATE_EMBEDDING('physics and the cosmos', 'openai', 'text-embedding-3-small'),
    3
)
RETURN node.title, node.published_year, distance
ORDER BY distance;

-- Filtered ANN — recent books only
CALL QUERY_VECTOR_INDEX(
    'Book', 'book_emb_idx',
    CREATE_EMBEDDING('machine intelligence', 'openai', 'text-embedding-3-small'),
    3
)
WITH node, distance
MATCH (node)
WHERE node.published_year >= 2015
RETURN node.title, distance
ORDER BY distance;
```

---

## Frequently Asked Questions

**Q: Can I have multiple HNSW indexes on the same table?**
Yes. Each index has a unique name and is stored in its own pair of internal rel tables.

**Q: Does the index update automatically when I insert new rows?**
Yes. New rows are handled via incremental insert. A brute-force scan covers un-checkpointed nodes during queries. After a checkpoint, they become part of the graph.

**Q: Can I use HNSW with `DOUBLE[]` columns?**
Yes. The metric dispatch uses `simsimd_*_f64` functions for `DOUBLE[]` columns.

**Q: What happens if I drop the node table?**
You must drop the HNSW index first. The internal rel tables (`_UPPER` and `_LOWER`) are cascade-dropped with the index. Attempting to drop the node table while an index exists raises a `BinderException`.

**Q: How do I inspect index metadata?**
```cypher
CALL SHOW_INDEXES() RETURN *;
```
This returns the index name, type (`HNSW`), indexed columns, and the DDL to recreate it.

**Q: Is there a way to rebuild an index without dropping it?**
Not directly. Drop the index and recreate it with `CREATE_VECTOR_INDEX`.

**Q: What is the `alpha` parameter?**
Alpha controls the RNG shrink heuristic. At `alpha = 1.0` (default), the standard HNSW heuristic keeps neighbours only if no already-selected neighbour is strictly closer to the new neighbour. Increasing `alpha` above 1.0 makes the heuristic more permissive, allowing more edges to survive, which can improve recall at the cost of higher degree.

---

## `SHOW_INDEXES` and Index Inspection

```cypher
CALL SHOW_INDEXES() RETURN *;
```

Example output for an HNSW index:

```
Book | book_vec_idx | HNSW | [title_embedding] | True |
CALL CREATE_VECTOR_INDEX('Book', 'book_vec_idx', 'title_embedding', mu := 30, ml := 15, ...);
```

The last column is the DDL statement needed to recreate the index with its original options.

---

## Integration with the FTS Extension

For text data you may want both keyword (BM25) and semantic (HNSW) search. Combine both extensions:

```cypher
LOAD EXTENSION fts;
LOAD EXTENSION llm;
LOAD EXTENSION vector;

CREATE NODE TABLE Article (
    id              SERIAL PRIMARY KEY,
    title           STRING,
    body_embedding  FLOAT[1536]
);

-- Build FTS on title
CALL CREATE_FTS_INDEX('Article', 'art_fts', ['title']);

-- Build HNSW on embedding column
CALL CREATE_VECTOR_INDEX('Article', 'art_vec', 'body_embedding');

-- Keyword search
CALL QUERY_FTS_INDEX('Article', 'art_fts', 'quantum entanglement') RETURN node.id, score;

-- Semantic search
CALL QUERY_VECTOR_INDEX('Article', 'art_vec',
    CREATE_EMBEDDING('quantum entanglement', 'openai', 'text-embedding-3-small'), 5)
RETURN node.id, distance;
```

---

## Index Storage Layout

At the filesystem level, HNSW index data is stored in the same `lbug` data file as the rest of the database. The two internal rel tables (`_UPPER` and `_LOWER`) are ordinary LadybugDB rel tables; their pages are managed by the buffer manager and included in checkpoints.

The `HNSWStorageInfo` blob (serialised config + entry points + checkpoint offset) is stored in the catalog's index entry (`HNSWIndexCatalogEntry`). On database re-open, `initHNSWEntries` in `vector_extension.cpp` iterates all catalog index entries of type `"HNSW"` and calls `unloadedIndex.load(context, storageManager)` to reconstruct the in-memory structures.

---

## Version Compatibility

The vector extension is registered with the catalog as an `EXTENSION`-defined index type (not `BUILTIN`). This means:
- The extension must be loaded before queries that reference HNSW indexes can run.
- If the extension is not loaded, the catalog entry exists but the index is not accessible.
- The on-disk format is versioned via `HNSWStorageInfo`'s serialise/deserialise methods.

---

## See Also

- [Full-Text Search Extension (BM25)](./fts) — keyword search with BM25 ranking
- [LLM Embeddings Extension](./llm) — generate embeddings from OpenAI, Ollama, Bedrock, and others
- [Extension Architecture](./architecture) — how LadybugDB extensions are structured and loaded
