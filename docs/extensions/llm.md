# LLM Embeddings Extension

The `llm` extension provides a `CREATE_EMBEDDING` scalar function that generates text embeddings from external AI providers. It enables semantic search workflows by producing embedding vectors that can be stored in `FLOAT[]` columns and queried with the `vector` extension. It is implemented in `extension/llm/`.

---

## Quick Start

```cypher
-- Load the extension
LOAD EXTENSION llm

-- Generate a single embedding
RETURN CREATE_EMBEDDING('Hello world', 'openai', 'text-embedding-3-small');

-- Store embeddings in a table
MATCH (b:Book)
WITH b, CREATE_EMBEDDING(b.title, 'openai', 'text-embedding-3-small') AS emb
SET b.title_embedding = emb;

-- Combine with the vector extension for ANN search
LOAD EXTENSION vector;

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

## Loading the Extension

```cypher
-- Dynamic load (development)
LOAD EXTENSION "${LBUG_ROOT_DIRECTORY}/extension/llm/build/libllm.lbug_extension"

-- Official release channel
FORCE INSTALL llm FROM 'http://extension-repo/';
LOAD llm;
```

The extension exports the standard C symbols `init(ClientContext*)` and `name()`, and registers a single scalar function on load:

```cpp
// extension/llm/src/main/llm_extension.cpp
void LlmExtension::load(main::ClientContext* context) {
    ExtensionUtils::addScalarFunc<CreateEmbedding>(db);
}
```

---

## `CREATE_EMBEDDING` Function

### Return Type

`LIST<FLOAT>` — a dynamically-sized list of 32-bit floats. The dimension depends on the model and the optional `dimensions` parameter.

> **Note**: the return type is `LIST<FLOAT>`, not `FLOAT[N]`. If you need to store the result in a fixed-width `FLOAT[N]` column (for HNSW indexing), use `CAST`:
> ```cypher
> MATCH (b:Book)
> WITH b, CAST(CREATE_EMBEDDING(b.title, 'openai', 'text-embedding-3-small') AS FLOAT[1536]) AS emb
> SET b.title_embedding = emb;
> ```

### Function Overloads

The function has four overloads depending on whether optional `dimensions` and `region`/`endpoint` parameters are provided. The actual overload selected depends on the provider.

```
CREATE_EMBEDDING(text, provider, model)
CREATE_EMBEDDING(text, provider, model, dimensions)
CREATE_EMBEDDING(text, provider, model, region_or_endpoint)
CREATE_EMBEDDING(text, provider, model, dimensions, region_or_endpoint)
```

| Parameter             | Type   | Description                                                        |
|-----------------------|--------|--------------------------------------------------------------------|
| `text`                | STRING | The input text to embed                                            |
| `provider`            | STRING | Provider name (see Provider Reference below)                       |
| `model`               | STRING | Model name understood by the provider                              |
| `dimensions`          | INT64  | (optional) Output dimension size; not supported by all providers   |
| `region_or_endpoint`  | STRING | (optional) Region string or endpoint URL; required by some providers|

---

## Provider Reference

### Supported Providers

| Provider Name (accepted strings)   | Description                   |
|------------------------------------|-------------------------------|
| `"openai"` / `"open-ai"`           | OpenAI Embeddings API         |
| `"ollama"`                         | Ollama (local LLM server)     |
| `"bedrock"` / `"amazon-bedrock"`   | Amazon Bedrock                |
| `"google-gemini"`                  | Google Gemini                 |
| `"google-vertex"` / `"vertex"`     | Google Vertex AI              |
| `"voyageai"` / `"voyage-ai"`       | Voyage AI                     |

Both the hyphenated and non-hyphenated forms are accepted (backward compatibility). Provider selection is done at bind time via a static `unordered_map<string, factory_func>` in `EmbeddingProviderFactory`.

---

## Provider Details

### OpenAI

| Item             | Value                                     |
|------------------|-------------------------------------------|
| **Endpoint**     | `https://api.openai.com`                  |
| **Path**         | `/v1/embeddings`                          |
| **Auth**         | `Authorization: Bearer $OPENAI_API_KEY`   |
| **Dimensions**   | Supported (sent as `"dimensions"` in JSON)|
| **Region/Endpoint** | Not supported                          |

**Environment variable**: `OPENAI_API_KEY`

**Request payload**:
```json
{
  "model": "<model>",
  "input": "<text>",
  "dimensions": <N>   // only if dimensions argument was provided
}
```

**Response path**: `data[0].embedding`

**Example**:
```cypher
RETURN CREATE_EMBEDDING('Hello world', 'openai', 'text-embedding-3-small');

-- With custom dimensions
RETURN CREATE_EMBEDDING('Hello world', 'openai', 'text-embedding-3-small', 512);
```

**Backward-compatible alias**: `'open-ai'` is also accepted.

---

### Ollama

| Item             | Value                                           |
|------------------|-------------------------------------------------|
| **Endpoint**     | `http://localhost:11434` (default) or `$OLLAMA_URL` |
| **Path**         | `/api/embeddings`                               |
| **Auth**         | None                                            |
| **Dimensions**   | Not supported                                   |
| **Region/Endpoint** | Optional — pass a custom URL as 4th argument |

**Environment variable**: `OLLAMA_URL` (optional). If unset, falls back to `http://localhost:11434`. Can also be overridden by passing the URL as the 4th string argument.

**Request payload**:
```json
{
  "model": "<model>",
  "prompt": "<text>"
}
```

> **Note**: Ollama uses the key `"prompt"` (not `"input"`), and the response key is `"embedding"` (singular, not `"embeddings"`).

**Response path**: `embedding` (top-level array)

**Example**:
```cypher
-- Using the default localhost endpoint
RETURN CREATE_EMBEDDING('Hello world', 'ollama', 'nomic-embed-text');

-- Using a custom endpoint
RETURN CREATE_EMBEDDING('Hello world', 'ollama', 'nomic-embed-text', 'http://my-server:11434');
```

---

### Amazon Bedrock

| Item             | Value                                                    |
|------------------|----------------------------------------------------------|
| **Endpoint**     | `https://bedrock-runtime.<region>.amazonaws.com`         |
| **Path**         | `/model/<model>/invoke`                                  |
| **Auth**         | AWS SigV4 (HMAC-SHA256 signature)                        |
| **Dimensions**   | Not supported                                            |
| **Region**       | **Required** — must be provided as 4th string argument   |

**Environment variables**:
- `AWS_ACCESS_KEY` — AWS access key ID
- `AWS_SECRET_ACCESS_KEY` — AWS secret access key

The extension computes a full **AWS Signature Version 4** signature using SHA-256 and HMAC-256 from the httpfs extension's `crypto.h` utilities. The region is used to construct both the endpoint URL and the `Credential` scope in the `Authorization` header.

**Example**:
```cypher
-- Region is required as the 4th argument
RETURN CREATE_EMBEDDING(
    'Hello world',
    'bedrock',
    'amazon.titan-embed-text-v1',
    'us-east-1'
);
```

> Bedrock does **not** accept a `dimensions` argument. If dimensions are passed with Bedrock, the binder raises an exception with the correct function signatures.

**Backward-compatible alias**: `'amazon-bedrock'` is also accepted.

---

### Google Gemini

| Item             | Value                                                        |
|------------------|--------------------------------------------------------------|
| **Endpoint**     | `https://generativelanguage.googleapis.com`                  |
| **Path**         | `/v1beta/models/<model>:embedContent`                        |
| **Auth**         | `x-goog-api-key: $GEMINI_API_KEY`                            |
| **Dimensions**   | Supported (sent as `"outputDimensionality"` in JSON)         |
| **Region/Endpoint** | Not supported                                             |

**Environment variable**: `GEMINI_API_KEY`

**Request payload**:
```json
{
  "model": "<model>",
  "content": {
    "parts": [{ "text": "<text>" }]
  },
  "outputDimensionality": <N>   // only if dimensions argument was provided
}
```

**Response path**: `embedding.values`

**Example**:
```cypher
RETURN CREATE_EMBEDDING('Hello world', 'google-gemini', 'text-embedding-004');

-- With 256-dimensional output
RETURN CREATE_EMBEDDING('Hello world', 'google-gemini', 'text-embedding-004', 256);
```

---

### Google Vertex AI

| Item             | Value                                                                          |
|------------------|--------------------------------------------------------------------------------|
| **Endpoint**     | `https://aiplatform.googleapis.com`                                            |
| **Path**         | `/v1/projects/$GOOGLE_CLOUD_PROJECT_ID/locations/<region>/publishers/google/models/<model>:predict` |
| **Auth**         | `Authorization: Bearer $GOOGLE_VERTEX_ACCESS_KEY`                              |
| **Dimensions**   | Supported (sent as `parameters.outputDimensionality`)                          |
| **Region**       | **Required** — must be provided as a string argument                           |

**Environment variables**:
- `GOOGLE_CLOUD_PROJECT_ID` — GCP project ID (read at call time)
- `GOOGLE_VERTEX_ACCESS_KEY` — OAuth2 bearer token

**Request payload**:
```json
{
  "instances": [{
    "content": "<text>",
    "task_type": "RETRIEVAL_DOCUMENT"
  }],
  "parameters": {
    "outputDimensionality": <N>   // only if dimensions argument was provided
  }
}
```

**Response path**: `predictions[0].embeddings.values`

**Example**:
```cypher
-- Region is required
RETURN CREATE_EMBEDDING(
    'Hello world',
    'google-vertex',
    'textembedding-gecko@003',
    'us-central1'
);

-- With dimensions and region
RETURN CREATE_EMBEDDING(
    'Hello world',
    'google-vertex',
    'textembedding-gecko@003',
    768,
    'us-central1'
);
```

**Alias**: `'vertex'` is also accepted.

---

### Voyage AI

| Item             | Value                                     |
|------------------|-------------------------------------------|
| **Endpoint**     | `https://api.voyageai.com`                |
| **Path**         | `/v1/embeddings`                          |
| **Auth**         | `Authorization: Bearer $VOYAGE_API_KEY`   |
| **Dimensions**   | Supported (sent as `"output_dimension"`)  |
| **Region/Endpoint** | Not supported                          |

**Environment variable**: `VOYAGE_API_KEY`

**Request payload**:
```json
{
  "model": "<model>",
  "input": "<text>",
  "output_dimension": <N>   // only if dimensions argument were provided
}
```

**Response path**: `data[0].embedding`

**Example**:
```cypher
RETURN CREATE_EMBEDDING('Hello world', 'voyageai', 'voyage-3');

-- With custom dimensions
RETURN CREATE_EMBEDDING('Hello world', 'voyageai', 'voyage-3', 512);
```

**Backward-compatible alias**: `'voyage-ai'` is also accepted.

---

## Provider × Feature Matrix

| Provider          | `dimensions` | `region`/`endpoint` | Auth Env Var(s)                          |
|-------------------|:------------:|:-------------------:|------------------------------------------|
| `openai`          | ✓            | ✗                   | `OPENAI_API_KEY`                         |
| `ollama`          | ✗            | ✓ (optional URL)    | none                                     |
| `bedrock`         | ✗            | ✓ (required region) | `AWS_ACCESS_KEY`, `AWS_SECRET_ACCESS_KEY`|
| `google-gemini`   | ✓            | ✗                   | `GEMINI_API_KEY`                         |
| `google-vertex`   | ✓            | ✓ (required region) | `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_VERTEX_ACCESS_KEY` |
| `voyageai`        | ✓            | ✗                   | `VOYAGE_API_KEY`                         |

---

## HTTP Client Details

All providers use **cpp-httplib** for synchronous HTTP requests with the following timeouts:

| Timeout Type    | Value |
|-----------------|-------|
| Connect timeout | 30 s  |
| Read timeout    | 30 s  |
| Write timeout   | 30 s  |

Every call makes a single synchronous `POST` request per invocation. There is no request batching; each row in a `MATCH ... SET` query triggers a separate HTTP call.

---

## Error Handling

| Error Type             | When Raised                                                                        |
|------------------------|------------------------------------------------------------------------------------|
| `ConnectionException`  | HTTP connection failed (network error, server unreachable)                         |
| `ConnectionException`  | HTTP response status ≠ 200 (includes the response body in the message)             |
| `RuntimeException`     | Missing required environment variable (e.g., `OPENAI_API_KEY` not set)             |
| `BinderException`      | Wrong number/type of arguments for the selected provider (correct signatures shown)|

### Wrong Overload Example

```cypher
-- Bedrock requires a region; omitting it gives:
RETURN CREATE_EMBEDDING('text', 'bedrock', 'model');
-- BinderException: ...
--   CREATE_EMBEDDING(STRING, STRING, STRING, STRING)
--   CREATE_EMBEDDING(STRING, STRING, STRING, INT64, STRING)
```

The error message shows the valid overloads for the selected provider.

---

## Semantic Similarity Workflow

A typical semantic similarity search workflow combining `llm` and `vector` extensions:

```cypher
-- Step 1: Load both extensions
LOAD EXTENSION llm;
LOAD EXTENSION vector;

-- Step 2: Create schema with an embedding column
CREATE NODE TABLE Book (
    id              SERIAL PRIMARY KEY,
    title           STRING,
    title_embedding FLOAT[1536],
    published_year  INT64
);

-- Step 3: Insert data
CREATE
    (:Book {title: 'The Quantum World',          published_year: 2004}),
    (:Book {title: 'Chronicles of the Universe', published_year: 2022}),
    (:Book {title: 'Learning Machines',          published_year: 2019}),
    (:Book {title: 'Echoes of the Past',         published_year: 2010}),
    (:Book {title: 'The Dragon Call',            published_year: 2015});

-- Step 4: Generate and store embeddings
MATCH (b:Book)
WITH b, CREATE_EMBEDDING(b.title, 'openai', 'text-embedding-3-small') AS emb
SET b.title_embedding = emb;

-- Step 5: Build HNSW vector index
CALL CREATE_VECTOR_INDEX('Book', 'title_vec_index', 'title_embedding');

-- Step 6: Query with a natural-language search
CALL QUERY_VECTOR_INDEX(
    'Book',
    'title_vec_index',
    CREATE_EMBEDDING('quantum machine learning', 'openai', 'text-embedding-3-small'),
    2
)
RETURN node.title
ORDER BY distance;
-- Result: Learning Machines, The Quantum World
```

---

## Cosine Similarity Without an Index

For small datasets, use `array_cosine_similarity` directly:

```cypher
MATCH (e:embedding)
RETURN array_cosine_similarity(
    e.embedding,
    CREATE_EMBEDDING(e.text, 'openai', 'text-embedding-3-small')
) >= 0.9 AS similarity;
```

---

## Provider Architecture

### Abstract Interface

All providers implement the `EmbeddingProvider` abstract class:

```cpp
// extension/llm/src/include/providers/provider.h
class EmbeddingProvider {
public:
    virtual std::string getClient() const = 0;
    virtual std::string getPath(const std::string& model) const = 0;
    virtual httplib::Headers getHeaders(const std::string& model,
                                        const JsonMutDoc& payload) const = 0;
    virtual JsonMutDoc getPayload(const std::string& model,
                                  const std::string& text) const = 0;
    virtual std::vector<float> parseResponse(const httplib::Result& res) const = 0;
    virtual void configure(const std::optional<uint64_t>& dimensions,
                           const std::optional<std::string>& region) = 0;
};
```

### Execution Flow (`execFunc`)

1. Retrieve the text value from the input `ValueVector`.
2. Build the HTTP payload via `provider->getPayload(model, text)`.
3. POST to `provider->getClient()` + `provider->getPath(model)` with `provider->getHeaders(...)`.
4. If the connection fails → throw `ConnectionException`.
5. If HTTP status ≠ 200 → throw `ConnectionException` with the response body.
6. Parse the JSON response via `provider->parseResponse(res)` and write the float vector into the output `ValueVector` as `LIST<FLOAT>`.

### Factory (`EmbeddingProviderFactory`)

Provider instances are created via a static factory map. Each entry maps a string key to a `std::function<std::shared_ptr<EmbeddingProvider>()>`:

```cpp
// extension/llm/src/function/create_embedding.cpp (simplified)
static const std::unordered_map<std::string, ...> providerMap = {
    {"openai",         OpenAIEmbedding::getInstance},
    {"open-ai",        OpenAIEmbedding::getInstance},   // compat alias
    {"ollama",         OllamaEmbedding::getInstance},
    {"bedrock",        BedrockEmbedding::getInstance},
    {"amazon-bedrock", BedrockEmbedding::getInstance},  // compat alias
    {"google-gemini",  GoogleGeminiEmbedding::getInstance},
    {"google-vertex",  GoogleVertexEmbedding::getInstance},
    {"vertex",         GoogleVertexEmbedding::getInstance}, // alias
    {"voyageai",       VoyageAIEmbedding::getInstance},
    {"voyage-ai",      VoyageAIEmbedding::getInstance},  // compat alias
};
```

### Configure / Overload Selection

After provider instantiation, `provider->configure(dimensions, region)` is called. Each provider validates that the combination of arguments it received is valid for that provider. If not, `configure` throws a `std::string` containing the valid function signatures (not an exception class). The bind function catches this and rethrows as a `BinderException`.

---

## Implementation File Map

| File                                                              | Purpose                                              |
|-------------------------------------------------------------------|------------------------------------------------------|
| `extension/llm/src/include/providers/provider.h`                  | `EmbeddingProvider` abstract base class (6 methods)  |
| `extension/llm/src/function/create_embedding.cpp`                 | Factory, `execFunc`, `bindFunc`, all 4 overloads     |
| `extension/llm/src/providers/open-ai.cpp`                         | OpenAI implementation                                |
| `extension/llm/src/providers/ollama.cpp`                          | Ollama with `OLLAMA_URL` env fallback                |
| `extension/llm/src/providers/amazon-bedrock.cpp`                  | Bedrock with AWS SigV4 signing                       |
| `extension/llm/src/providers/google-gemini.cpp`                   | Google Gemini implementation                         |
| `extension/llm/src/providers/google-vertex.cpp`                   | Google Vertex AI implementation                      |
| `extension/llm/src/providers/voyage-ai.cpp`                       | Voyage AI implementation                             |
| `extension/llm/src/main/llm_extension.cpp`                        | Extension load, C exports (`init`, `name`)           |
