import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'LadybugDB Wiki',
  description: 'Engineering reference for LadybugDB — algorithms, data structures, and implementation details',
  base: process.env.GITHUB_ACTIONS ? '/ladybug-wiki/' : '/',

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#e63946' }],
  ],

  themeConfig: {
    logo: { src: '/logo.svg', width: 24, height: 24 },
    siteTitle: 'LadybugDB Wiki',

    nav: [
      { text: 'Storage', link: '/storage/node-groups' },
      { text: 'Execution', link: '/execution/vectorized' },
      { text: 'Transactions', link: '/transaction/mvcc' },
      { text: 'Query', link: '/query/cypher-internals' },
      { text: 'Common', link: '/common/type-system' },
      { text: 'Extensions', link: '/extensions/architecture' },
      { text: 'Functions', link: '/functions/scalar-functions' },
      { text: 'Main', link: '/main/connection-lifecycle' },
      { text: 'Development', link: '/dev/building' },
      { text: 'API', link: '/api/python' },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Architecture Overview', link: '/overview' },
          { text: 'Catalog System', link: '/catalog' },
        ],
      },
      {
        text: 'Storage Engine',
        collapsed: false,
        items: [
          { text: 'Node Groups & Columnar Layout', link: '/storage/node-groups' },
          { text: 'CSR Adjacency Lists', link: '/storage/csr' },
          { text: 'Hash Index', link: '/storage/hash-index' },
          { text: 'Overflow & String Storage', link: '/storage/overflow' },
          { text: 'Buffer Manager', link: '/storage/buffer-manager' },
          { text: 'Column Compression', link: '/storage/compression' },
          { text: 'Column Statistics & Zone Maps', link: '/storage/column-stats' },
          { text: 'Shadow File & WAL', link: '/storage/shadow-wal' },
          { text: 'WAL Internals (Two-Tier)', link: '/storage/wal-internals' },
          { text: 'Storage Backends', link: '/storage/storage-backends' },
          { text: 'Icebug-Disk Format', link: '/storage/icebug-disk' },
          { text: 'Native Rel Tables', link: '/storage/native-rel-tables' },
        ],
      },
      {
        text: 'Transaction & MVCC',
        collapsed: false,
        items: [
          { text: 'Transaction Lifecycle', link: '/transaction/mvcc' },
          { text: 'TransactionManager', link: '/transaction/transaction-manager' },
          { text: 'UndoBuffer Chain', link: '/transaction/undo-buffer' },
          { text: 'Local Storage', link: '/transaction/local-storage' },
          { text: 'Checkpointing', link: '/transaction/checkpointing' },
        ],
      },
      {
        text: 'Client & Connection',
        collapsed: false,
        items: [
          { text: 'Connection & Query Lifecycle', link: '/main/connection-lifecycle' }
        ],
      },
      {
        text: 'Query Execution',
        collapsed: false,
        items: [
          { text: 'Vectorized Execution Model', link: '/execution/vectorized' },
          { text: 'Pipeline & Operator Model', link: '/execution/pipeline' },
          { text: 'Morsel-Driven Parallelism', link: '/execution/morsel' },
          { text: 'Table Scan Internals', link: '/execution/scan' },
          { text: 'GDS & Recursive Traversals', link: '/execution/gds' },
          { text: 'Semi-Mask & SIP Optimization', link: '/execution/semi-mask' },
        ],
      },
      {
        text: 'Query Compilation',
        collapsed: false,
        items: [
          { text: 'Full Query Pipeline', link: '/query/pipeline' },
          { text: 'Cypher Query Walkthroughs', link: '/query/cypher-internals' },
          { text: 'Parser & ANTLR4 Grammar', link: '/query/parser' },
          { text: 'Binder & Type System', link: '/query/binder' },
          { text: 'Logical Planner', link: '/query/planner' },
          { text: 'Optimizer', link: '/query/optimizer' },
          { text: 'Optimizer Passes (Deep Dive)', link: '/query/optimizer-passes' },
          { text: 'Physical Planner', link: '/query/physical-planner' },
          { text: 'Expression Evaluator', link: '/query/expressions' },
          { text: 'Factorization & Schema Groups', link: '/query/factorization' },
          { text: 'Join-Order Enumeration', link: '/query/join-order' },
        ],
      },
    {
        text: 'IMPORT mechanics',
        collapsed: false,
        items: [
            { text: 'COPY FROM', link: '/main/copy-mechanics' },
        ]
      },
      {
        text: 'Common Utilities',
        collapsed: false,
        items: [
          { text: 'Type System', link: '/common/type-system' },
          { text: 'Data Chunk & Vector Layer', link: '/common/data-chunk' },
          { text: 'File System Abstraction', link: '/common/file-system' },
          { text: 'Task Scheduler & Progress', link: '/common/task-scheduler' },
        ],
      },
      {
        text: 'Development',
        collapsed: false,
        items: [
          { text: 'Building LadybugDB', link: '/dev/building' },
          { text: 'Testing Guide', link: '/dev/testing' },
          { text: 'Incident Reports', link: '/dev/incidents' },
        ],
      },
      {
        text: 'Extension System',
        collapsed: true,
        items: [
          { text: 'Extension Architecture', link: '/extensions/architecture' },
          { text: 'Vector Index (HNSW)', link: '/extensions/vector-index' },
          { text: 'Full-Text Search (BM25)', link: '/extensions/fts' },
          { text: 'LLM Embeddings', link: '/extensions/llm' },
          { text: 'HTTPFS (HTTP / S3 / GCS / Xet)', link: '/extensions/httpfs' },
          { text: 'External Scanners (DuckDB / Postgres / SQLite / ADBC / Neo4j)', link: '/extensions/external-scanners' },
          { text: 'Lakehouse (Delta / Iceberg / Unity Catalog)', link: '/extensions/lakehouse' },
          { text: 'Graph Algorithms (ALGO)', link: '/extensions/algo' },
          { text: 'JSON', link: '/extensions/json' },
        ],
      },
      {
        text: 'Functions',
        collapsed: false,
        items: [
          { text: 'Scalar Functions', link: '/functions/scalar-functions' },
          { text: 'Table Functions', link: '/functions/table-functions' },
          { text: 'Aggregate Functions', link: '/functions/aggregate-functions' },
        ],
      },
      {
        text: 'Reference',
        collapsed: true,
        items: [
          { text: 'Glossary', link: '/glossary' },
        ],
      },
      {
        text: 'API Bindings',
        collapsed: false,
        items: [
          { text: 'Python',      link: '/api/python' },
          { text: 'Java',        link: '/api/java' },
          { text: 'Node.js',     link: '/api/nodejs' },
          { text: 'Rust',        link: '/api/rust' },
          { text: 'C API',       link: '/api/c-api' },
          { text: 'WebAssembly', link: '/api/wasm' },
        ],
      },
    ],

    search: {
      provider: 'local',
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/LadybugDB/ladybug' },
    ],

    footer: {
      message: 'Internal engineering reference — not for external distribution.',
    },

    editLink: {
      pattern: 'https://github.com/aheev/ladybug-wiki/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },

  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
    lineNumbers: true,
  },
})
