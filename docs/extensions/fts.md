# Full-Text Search Extension (BM25)

The `fts` extension adds **full-text search** to LadybugDB using the Okapi **BM25** ranking algorithm. It can index one or more `STRING` properties on any node table and supports stemming (Snowball), configurable stop words, tokenisation (simple or Chinese Jieba), and wildcard queries. It is implemented in `extension/fts/`.

---

## Quick Start

```cypher
-- Load the extension
LOAD EXTENSION fts

-- 1. Create a node table with text properties
CREATE NODE TABLE Book (
    ID       SERIAL,
    title    STRING,
    abstract STRING,
    author   STRING,
    PRIMARY KEY (ID)
);

-- 2. Populate data
CREATE (:Book {title: 'The Quantum World', abstract: 'An exploration of quantum mechanics.', author: 'Alice Johnson'});
CREATE (:Book {title: 'Learning Machines',  abstract: 'An introduction to machine learning.', author: 'Emma Brown'});

-- 3. Build a full-text index over multiple columns
CALL CREATE_FTS_INDEX('Book', 'book_index', ['abstract', 'author', 'title'], stemmer := 'porter');

-- 4. Query (returns node + score, ranked by BM25)
CALL QUERY_FTS_INDEX('Book', 'book_index', 'a quantum machine') RETURN node.title;

-- 5. Drop the index
CALL DROP_FTS_INDEX('Book', 'book_index');
```

---

## Loading the Extension

```cypher
-- Dynamic load (development)
LOAD EXTENSION "${LBUG_ROOT_DIRECTORY}/extension/fts/build/libfts.lbug_extension"

-- Official release channel
FORCE INSTALL fts FROM 'http://extension-repo/';
LOAD fts;
```

The extension registers itself via `FtsExtension::load`:

```cpp
// extension/fts/src/main/fts_extension.cpp
void FtsExtension::load(main::ClientContext* context) {
    ExtensionUtils::addScalarFunc<StemFunction>(db);
    ExtensionUtils::addScalarFunc<TokenizeFunction>(db);
    ExtensionUtils::addTableFunc<QueryFTSFunction>(db);
    ExtensionUtils::addStandaloneTableFunc<CreateFTSFunction>(db);
    ExtensionUtils::addStandaloneTableFunc<DropFTSFunction>(db);
    ExtensionUtils::registerIndexType(db, FTSIndex::getIndexType());
    initFTSEntries(context, *db.getCatalog());
}
```

The `initFTSEntries` function loads persisted `FTSIndexAuxInfo` for any FTS indexes that are already in the catalog.

---

## Creating an Index — `CREATE_FTS_INDEX`

### Signature

```
CALL CREATE_FTS_INDEX(tableName, indexName, propertyList [, options...])
```

| Parameter      | Type          | Required | Description                                  |
|----------------|---------------|----------|----------------------------------------------|
| `tableName`    | STRING        | yes      | Name of the node table to index              |
| `indexName`    | STRING        | yes      | Name to assign to the FTS index              |
| `propertyList` | `LIST<STRING>`| yes      | One or more `STRING` property names to index |

All listed properties must be of type `STRING`; any other type raises a `BinderException`.

### Optional Parameters

| Parameter    | Default       | Description                                                     |
|--------------|---------------|-----------------------------------------------------------------|
| `stemmer`    | `"english"`   | Stemming algorithm (see Stemmer Reference below)                |
| `stopWords`  | `"default"`   | Stop-words source (see Stop Words Reference below)              |
| `tokenizer`  | `"simple"`    | Tokeniser: `"simple"` or `"jieba"`                              |
| `ignorePattern` | See below  | Regex pattern; matched characters are replaced with a space     |

#### Default Ignore Pattern

```
[0-9!@#$%^&*()_+={}\\[\\]:;<>,.?~\\/\\|'\"\`-]+
```

This pattern strips punctuation and digits from document text before indexing.

### Example with Options

```cypher
CALL CREATE_FTS_INDEX(
    'Book',
    'book_index',
    ['abstract', 'author', 'title'],
    stemmer   := 'porter',
    stopWords := 'default'
);
```

---

## Querying — `QUERY_FTS_INDEX`

### Signature

```
CALL QUERY_FTS_INDEX(tableName, indexName, queryString [, options...])
RETURN node.<property>, score
```

| Parameter     | Type   | Required | Description                                  |
|---------------|--------|----------|----------------------------------------------|
| `tableName`   | STRING | yes      | Table on which the index was built           |
| `indexName`   | STRING | yes      | Name of the FTS index                        |
| `queryString` | STRING | yes      | Free-text query (tokenised and stemmed)      |

Returns a virtual table with columns `node` (INTERNAL_ID) and `score` (DOUBLE). Results are **not** ordered by default; add `ORDER BY score DESC` to get ranked results.

### Optional Query Parameters

| Parameter     | Default          | Description                                                  |
|---------------|------------------|--------------------------------------------------------------|
| `k`           | `1.2`            | BM25 TF saturation constant                                  |
| `b`           | `0.75`           | BM25 document length normalisation constant                  |
| `conjunctive` | `false`          | If `true`, all query terms must appear in every result       |
| `top`         | `UINT64_MAX`     | Return at most this many results (uses a min-heap internally)|

### BM25 Scoring Formula

For each result document `d` and query term `t`:

```
score(d, q) = Σ_t  log10((N - df_t + 0.5) / (df_t + 0.5) + 1)
                  × (tf_t × (k + 1))
                  / (tf_t + k × (1 - b + b × (len_d / avgLen)))
```

Where:
- `N` — total number of documents
- `df_t` — document frequency of term `t`
- `tf_t` — term frequency of `t` in document `d`
- `len_d` — number of tokens in document `d`
- `avgLen` — average document length across all documents
- `k`, `b` — tuning parameters

### Conjunctive Mode

When `conjunctive := true`, a document is included only if the number of unique matching terms equals the number of unique terms in the query. Stop words in the query are excluded from this count.

```cypher
-- 'test-drive' is split into 'test' and 'drive' by the ignore pattern
-- conjunctive=true: both terms must appear
CALL QUERY_FTS_INDEX('Documents', 'doc_idx', 'test-drive', conjunctive := true)
RETURN node.title;
```

### Wildcard Queries

Queries may include `*` (any sequence) or `?` (single character) wildcards. Wildcard terms bypass stemming and are matched via RE2 full-match against the terms table.

```cypher
-- Match 'quant', 'quantum', 'quantity', ...
CALL QUERY_FTS_INDEX('Book', 'book_index', 'quant*') RETURN node.title;
```

---

## Dropping an Index — `DROP_FTS_INDEX`

```cypher
CALL DROP_FTS_INDEX('Book', 'book_index');
```

You must drop all FTS indexes on a table before dropping the table itself:

```
Binder exception: Cannot delete node table Documents because it is referenced by index documents_index.
```

---

## Internal Architecture

### Build Pipeline

`CREATE_FTS_INDEX` is implemented as a **rewrite function** (`createFTSIndexQuery`). It generates and executes a sequence of Cypher statements to build the index. The full pipeline is:

1. **Create a `TOKENIZE` macro** per (table, index) pair — wraps lowercasing, regex replacement, and tokenisation.
2. **Create/populate the stop-words table** (if needed — see Stop Words below).
3. **Create `appearsInfoTable`** (temporary, named `_{tableID}_{indexName}_APPEARS_INFO`) — one row per (term, docID) occurrence across all indexed properties.
4. **Populate `appearsInfoTable`** via `COPY ... FROM (MATCH ...)` for each indexed property. Stop words are excluded via `NOT EXISTS { MATCH (s:stopWords {sw: t1}) }`. Terms are stemmed inline with `STEM(t1, stemmer)`.
5. **Create `docsTable`** (`_{tableID}_{indexName}_DOCS`) — (docID INT64, len UINT64) — aggregate count of tokens per document.
6. **Create `termsTable`** (`_{tableID}_{indexName}_TERMS`) — (term STRING, df UINT64) — distinct terms and their document frequency.
7. **Create `appearsInTable`** (`_{tableID}_{indexName}_APPEARS_IN`) — rel table from `termsTable` → `docsTable` with property `tf UINT64`.
8. **Drop `appearsInfoTable`** (no longer needed).
9. **Register the index** in the catalog via `_CREATE_FTS_INDEX` (internal function).
10. Compute `numDocs` and `avgDocLen` with a `LenCompute` vertex pass over `docsTable`.

### Internal Tables

```
FTSInternalTableInfo
├── stopWordsTable   NodeTable   _{tableID}_{indexName}_STOP_WORDS  (STRING PK)
├── docTable         NodeTable   _{tableID}_{indexName}_DOCS        (docID INT64, len UINT64)
├── termsTable       NodeTable   _{tableID}_{indexName}_TERMS       (term STRING, df UINT64)
├── appearsInfoTable NodeTable   _{tableID}_{indexName}_APPEARS_INFO (term, docID — temp)
└── appearsInfoTable RelTable    _{tableID}_{indexName}_APPEARS_IN  (tf UINT64)
```

### Query Pipeline

`QUERY_FTS_INDEX` runs as a **GDS (Graph Data Science) algorithm**:

1. Parse and normalise the query string using the stored `ignorePatternQuery` (same as build but preserving `*` and `?`).
2. Tokenise and stem the query terms.
3. **`MatchTermsVertexCompute`**: scan the `termsTable` to find matching term nodes and collect their `df` values. Wildcard terms use RE2 `FullMatch`.
4. **`QFTSEdgeCompute`**: follow `appearsIn` edges from each matched term node to collect `(df, tf)` per document.
5. **`QFTSVertexCompute`**: compute the BM25 score for each document and emit `(nodeID, score)` to the output factorised table.
6. If `top` was specified, a min-heap (`QFTSTopKSharedState`) retains only the top-k results.

### Persistence — `FTSStorageInfo`

| Field                  | Type     | Description                              |
|------------------------|----------|------------------------------------------|
| `numDocs`              | idx_t    | Total document count at index build time |
| `avgDocLen`            | double   | Average token count across all docs      |
| `numCheckpointedNodes` | offset_t | Nodes present at last checkpoint         |

These values are serialised and restored when the database is re-opened.

---

## Stemmer Reference

The extension uses **Snowball libstemmer** (`sb_stemmer_*`). Pass `"none"` to disable stemming entirely.

Supported language codes:

| Code            | Language              |
|-----------------|-----------------------|
| `"arabic"`      | Arabic                |
| `"armenian"`    | Armenian              |
| `"basque"`      | Basque                |
| `"catalan"`     | Catalan               |
| `"danish"`      | Danish                |
| `"dutch"`       | Dutch                 |
| `"english"`     | English (Porter2)     |
| `"finnish"`     | Finnish               |
| `"french"`      | French                |
| `"german"`      | German                |
| `"greek"`       | Greek                 |
| `"hindi"`       | Hindi                 |
| `"hungarian"`   | Hungarian             |
| `"indonesian"`  | Indonesian            |
| `"irish"`       | Irish                 |
| `"italian"`     | Italian               |
| `"lithuanian"`  | Lithuanian            |
| `"nepali"`      | Nepali                |
| `"norwegian"`   | Norwegian             |
| `"porter"`      | English (original Porter) |
| `"portuguese"`  | Portuguese            |
| `"romanian"`    | Romanian              |
| `"russian"`     | Russian               |
| `"serbian"`     | Serbian               |
| `"spanish"`     | Spanish               |
| `"swedish"`     | Swedish               |
| `"tamil"`       | Tamil                 |
| `"turkish"`     | Turkish               |
| `"yiddish"`     | Yiddish               |
| `"none"`        | No stemming           |

**Bind-time optimisation**: if the stemmer string is a literal constant, a single `sb_stemmer*` instance is created once at bind time and shared across calls, avoiding per-row allocation.

Stemming in action:

```cypher
CALL CREATE_FTS_INDEX('Documents', 'doc_idx', ['text'], stemmer := 'english');

-- 'quacked', 'quacking', and 'quack' all stem to the same root
CALL QUERY_FTS_INDEX('Documents', 'doc_idx', 'quacked') RETURN node.title;
-- Returns docs containing 'quacking', 'quack', or 'quacked'
```

---

## Stop Words Reference

### Sources

| Value               | Behaviour                                                              |
|---------------------|------------------------------------------------------------------------|
| `"default"`         | 570 hardcoded English stop words (e.g., "the", "a", "and", ...)        |
| A node table name   | Must have a single `STRING PRIMARY KEY` column; rows are copied in     |
| A file path         | CSV file with one stop word per line                                   |

### How Stop Words Are Applied

- During **index build**: terms matching a stop word are excluded from `appearsInfoTable` via `NOT EXISTS { MATCH (s:stopWordsTable {sw: t1}) }`.
- During **query**: stop words in the query string are silently dropped. (In conjunctive mode, the required term count is computed after stop-word removal.)

### Default Stop Words (partial list)

The full list of 570 words is defined in `extension/fts/src/function/fts_config.cpp`. It includes common English function words:

```
a, about, above, after, again, against, all, am, an, and, any, are, aren't, as, at, be,
because, been, before, being, below, between, both, but, by, can't, cannot, could, couldn't,
did, didn't, do, does, doesn't, doing, don't, down, during, each, few, for, from, further,
get, got, had, hadn't, has, hasn't, have, haven't, having, he, her, here, him, his, how, i,
if, in, into, is, isn't, it, its, itself, let's, me, more, most, mustn't, my, myself, no,
not, of, off, on, once, only, or, other, ought, our, out, over, own, same, shan't, she,
should, shouldn't, so, some, such, than, that, the, their, them, then, there, these, they,
this, those, through, to, too, under, until, up, very, was, wasn't, we, were, weren't, what,
when, where, which, while, who, whom, why, will, with, won't, would, wouldn't, you, your, ...
```

Custom stop-words example:

```cypher
-- Using a custom node table
CREATE NODE TABLE MyStopWords (sw STRING, PRIMARY KEY(sw));
CREATE (:MyStopWords {sw: 'foo'}), (:MyStopWords {sw: 'bar'});

CALL CREATE_FTS_INDEX('Book', 'book_idx', ['title'], stopWords := 'MyStopWords');

-- Using a file
CALL CREATE_FTS_INDEX('Book', 'book_idx2', ['title'], stopWords := '/path/to/stopwords.csv');
```

---

## Tokeniser Reference

### Simple Tokeniser (default)

Splits text on space characters after applying the ignore pattern. Implemented in `extension/fts/src/function/tokenize.cpp` as `SimpleTokenizer`.

### Jieba Tokeniser (Chinese)

Uses **cppjieba** with `CutForSearch` mode for Chinese word segmentation. Requires dictionary files in the Jieba dict directory.

```cypher
CALL CREATE_FTS_INDEX('Articles', 'art_idx', ['body'], tokenizer := 'jieba');
```

**Dict file location** (default): `{LBUG_ROOT_DIRECTORY}/extension/fts/build/dict`

The directory must contain:

| File                  | Purpose                                |
|-----------------------|----------------------------------------|
| `jieba.dict.utf8`     | Main Chinese word dictionary           |
| `hmm_model.utf8`      | Hidden Markov Model for new words      |
| `user.dict.utf8`      | User dictionary (AI/ML terms included) |
| `idf.utf8`            | Inverse document frequency weights     |
| `stop_words.utf8`     | Jieba-native stop words                |

---

## Scalar Helper Functions

Two scalar functions are also exposed for direct use in queries:

### `STEM(text, stemmer)`

```cypher
RETURN STEM('running', 'english');  -- Returns 'run'
RETURN STEM('chats', 'porter');     -- Returns 'chat'
RETURN STEM('hello', 'none');       -- Returns 'hello' (no-op)
```

### `TOKENIZE(text, tokenizer, extraParam)`

```cypher
RETURN TOKENIZE('hello world foo', 'simple', '');
-- Returns ['hello', 'world', 'foo']
```

The tokenise macro created at index build time wraps these with the index-specific ignore pattern:

```cypher
-- Auto-generated macro for (tableID, indexName)
CREATE MACRO `_{tableID}_{indexName}_tokenize`(query) AS
    TOKENIZE(lower(regexp_replace(CAST(query AS STRING), '<ignorePattern>', ' ', 'g')),
             '<tokenizer>', '<jiebaDictDir>');
```

---

## Index Lifecycle and Incremental Updates

### Insert

New nodes inserted after index creation are indexed incrementally. The `FTSIndex::initInsertState` method creates a `FTSInsertState` backed by the internal table info. On insert, `getTerms` tokenises, normalises, and stems each indexed property; then updates the `appearsInfoTable`, `docsTable`, `termsTable`, and `appearsInTable` relationship.

### Update

**Updates to indexed properties are not directly supported.** A node's indexed text can only be changed by deleting and re-inserting the node.

### Delete

When a node is deleted, the corresponding term frequency entries and document length entries are cleaned up via the `FTSInsertState` rollback path.

### Checkpoint

`FTSStorageInfo::numCheckpointedNodes` is updated at each checkpoint. The `FTSIndex::checkpoint` method persists the three internal node/rel tables (`docTable`, `termsTable`, `appearsInTable`).

---

## Showing Indexes

```cypher
CALL SHOW_INDEXES() RETURN *;
```

Example output:

```
Documents | documents_index | FTS | [text] | True | CALL CREATE_FTS_INDEX('Documents', 'documents_index', ['text'], stemmer := 'english', stopWords := 'default');
```

The last column contains the DDL statement needed to recreate the index.

---

## Error Reference

| Error                                                                   | Cause                                                  |
|-------------------------------------------------------------------------|--------------------------------------------------------|
| `Binder exception: Table X does not exist.`                             | Unknown table in `CREATE_FTS_INDEX`                    |
| `Binder exception: Index Y already exists in table X.`                  | Duplicate index name                                   |
| `Binder exception: Property: Z does not exist in table X.`              | Unknown property in property list                      |
| `Binder exception: Full text search index can only be built on string properties.` | Non-STRING property in property list    |
| `Binder exception: Table X doesn't have an index with name Y.`         | Query on non-existent index                            |
| `Binder exception: Cannot delete node table X because it is referenced by index Y.` | Drop table before dropping index      |
| `Binder exception: Table X already exists. Please drop or rename ...`  | Internal table name collision (rare)                   |

---

## Configuration Reference

All configuration structs are defined in `extension/fts/src/include/function/fts_config.h`.

```cpp
struct Stemmer     { static constexpr auto     DEFAULT_VALUE = "english";      };
struct StopWords   { static constexpr auto     DEFAULT_VALUE = "default";      };
struct IgnorePattern { /* default: punctuation/digit regex */ };
struct Tokenizer   { static constexpr auto     DEFAULT_VALUE = "simple";       };
struct K           { static constexpr double   DEFAULT_VALUE = 1.2;            };
struct B           { static constexpr double   DEFAULT_VALUE = 0.75;           };
struct Conjunctive { static constexpr bool     DEFAULT_VALUE = false;          };
struct TopK        { static constexpr uint64_t DEFAULT_VALUE = UINT64_MAX;     };
```

BM25 parameter ranges:
- `k` must be positive (default 1.2)
- `b` must be in range [0.0, 1.0] (default 0.75)

---

## Implementation File Map

| File                                                                    | Purpose                                          |
|-------------------------------------------------------------------------|--------------------------------------------------|
| `extension/fts/src/include/function/fts_config.h`                       | All config structs and `StopWords` helper        |
| `extension/fts/src/function/fts_config.cpp`                             | 570 default stop words, config parsing           |
| `extension/fts/src/include/index/fts_index.h`                           | `FTSIndex`, `FTSStorageInfo` classes             |
| `extension/fts/src/include/index/fts_internal_table_info.h`             | Internal table structure definitions             |
| `extension/fts/src/index/fts_index.cpp`                                 | Insert/delete logic, serialise/deserialise       |
| `extension/fts/src/function/create_fts_index.cpp`                       | Build pipeline rewrite function                  |
| `extension/fts/src/function/query_fts_index.cpp`                        | BM25 scoring, GDS edge/vertex compute            |
| `extension/fts/src/function/stem.cpp`                                   | Snowball libstemmer integration                  |
| `extension/fts/src/function/tokenize.cpp`                               | SimpleTokenizer and JiebaTokenizer               |
| `extension/fts/src/utils/fts_utils.cpp`                                 | `normalizeQuery`, `stemTerms`, `tokenizeString`  |
| `extension/fts/src/main/fts_extension.cpp`                              | Extension load and function registration         |

---

## Combining with the Vector Extension

FTS and HNSW vector search can be combined in a single workflow:

```cypher
LOAD EXTENSION fts;
LOAD EXTENSION llm;
LOAD EXTENSION vector;

CREATE NODE TABLE Article (
    id              SERIAL PRIMARY KEY,
    title           STRING,
    body            STRING,
    body_embedding  FLOAT[1536]
);

-- Build full-text index
CALL CREATE_FTS_INDEX('Article', 'art_fts', ['title', 'body'], stemmer := 'english');

-- Build vector index
MATCH (a:Article)
WITH a, CREATE_EMBEDDING(a.body, 'openai', 'text-embedding-3-small') AS emb
SET a.body_embedding = emb;

CALL CREATE_VECTOR_INDEX('Article', 'art_vec', 'body_embedding');

-- Hybrid query: BM25 for keyword precision, ANN for semantic recall
CALL QUERY_FTS_INDEX('Article', 'art_fts', 'quantum mechanics') RETURN node.id, score
UNION
CALL QUERY_VECTOR_INDEX('Article', 'art_vec',
    CREATE_EMBEDDING('quantum mechanics', 'openai', 'text-embedding-3-small'), 10)
RETURN node.id, distance;
```

---

## Advanced: Custom Stop Words and Ignore Patterns

For domain-specific text (e.g., legal, medical, code), the defaults may not be ideal.

```cypher
-- Create a custom stop-words table
CREATE NODE TABLE LegalStopWords (sw STRING, PRIMARY KEY(sw));
CREATE (:LegalStopWords {sw: 'whereas'}), (:LegalStopWords {sw: 'hereinafter'}),
       (:LegalStopWords {sw: 'notwithstanding'}), (:LegalStopWords {sw: 'aforementioned'});

-- Build index with custom stop words and no stemming
CALL CREATE_FTS_INDEX(
    'Contract',
    'contract_fts',
    ['clause_text'],
    stemmer   := 'none',
    stopWords := 'LegalStopWords'
);
```

For code search, disable the default ignore pattern so that identifiers like `foo_bar` and `CamelCase` are preserved:

```cypher
-- Empty ignore pattern: no character substitution
CALL CREATE_FTS_INDEX(
    'SourceFile',
    'code_fts',
    ['content'],
    stemmer       := 'none',
    ignorePattern := '',
    stopWords     := 'none'
);
```

---

## Performance Considerations

### Build Performance

The FTS index build executes as a sequence of Cypher queries internally. Performance scales with:
- Number of indexed columns (more COPY operations)
- Document corpus size
- Stemmer (some languages are slower than others)

The intermediate `appearsInfoTable` is dropped after build to reclaim space.

### Query Performance

BM25 queries run as a GDS algorithm scanning the `termsTable` and following `appearsIn` edges:
- **Term lookup** (`MatchTermsVertexCompute`): O(|terms| × |rows_in_termsTable|)
- **Edge traversal** (`QFTSEdgeCompute`): O(Σ_{matched_terms} df_t)
- **Scoring** (`QFTSVertexCompute`): O(|matching_docs|)

For large corpora, use `top := N` to limit result set size:

```cypher
CALL QUERY_FTS_INDEX('Book', 'book_idx', 'quantum', top := 10) RETURN node.title, score ORDER BY score DESC;
```

With `top := N`, results are maintained in a min-heap of size N, so memory use is bounded regardless of corpus size.

### Conjunctive vs Disjunctive

`conjunctive := false` (default) returns all documents matching **any** query term. `conjunctive := true` requires **all** unique, non-stop-word terms to appear in each result. Conjunctive mode is useful to reduce noise on multi-word queries.

---

## Integration Tests Reference

From `extension/fts/test/test_files/basic.test`:

```cypher
-- Multi-property index with stemmer
CALL CREATE_FTS_INDEX('Book', 'book_index', ['abstract', 'author', 'title'], stemmer := 'porter');

-- Terms are stemmed: 'quantum', 'machine' match stemmed forms
CALL QUERY_FTS_INDEX('Book', 'book_index', 'a quantum machine') RETURN node.title;
-- Returns: The Quantum World, Learning Machines

-- Stop words ('a', 'the') are silently removed
CALL QUERY_FTS_INDEX('Book', 'book_index', 'a an the') RETURN node.title;
-- Returns: (0 rows)

-- Incremental insert: new rows indexed automatically
CREATE (:Book {abstract: 'A fantasy tale of dragons.', author: 'J. K. Rowling', title: 'Harry Potter'});
CALL QUERY_FTS_INDEX('Book', 'book_index', 'goblet') RETURN node.title;
-- Returns: Harry Potter and the Goblet of Fire

-- Index survives node deletion (deleted nodes not returned)
MATCH (b:Book) WHERE b.author = 'John Smith' DELETE b;
CALL QUERY_FTS_INDEX('Book', 'book_index', 'past magic world') RETURN node.title;
-- Only returns remaining books
```
