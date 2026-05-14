# Architecture Overview

LadybugDB is an **embeddable, serverless analytical graph database** written in C++. It executes in-process, accepts Cypher queries, and stores data in a columnar format on disk. This document maps the major subsystems and how they connect.

## Component Map

```
┌──────────────────────────────────────────────────────────────────┐
│                        Host Application                         │
│           Python / Node.js / Java / Rust / Go / WASM            │
└─────────────────────────────┬────────────────────────────────────┘
                              │  Language Binding (C API)
┌─────────────────────────────▼────────────────────────────────────┐
│                     ClientContext / Connection                   │
└──────┬───────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────┐    ┌──────────┐    ┌──────────┐    ┌────────────┐
│   Parser    │───▶│  Binder  │───▶│ Planner  │───▶│ Optimizer  │
│  (ANTLR4)   │    │          │    │          │    │            │
│  Cypher.g4  │    │ resolves │    │ logical  │    │ SIP, pred  │
│  → AST/CST  │    │ names &  │    │ plan     │    │ pushdown,  │
│             │    │ types    │    │ tree     │    │ join order │
└─────────────┘    └──────────┘    └──────────┘    └─────┬──────┘
                                                         │
                                                         ▼
                                               ┌──────────────────┐
                                               │  Physical Plan   │
                                               │  (Operator Tree) │
                                               └────────┬─────────┘
                                                        │
       ┌────────────────────────────────────────────────▼──────────┐
       │                     Query Executor                        │
       │   Pipelines of operators  │  Morsel-driven thread pool    │
       │   DataChunk / ValueVector │  SelectionVector filtering    │
       └────────────────────────────────────────────────┬──────────┘
                                                        │
       ┌────────────────────────────────────────────────▼──────────┐
       │                    Storage Engine                         │
       │  NodeTable (columnar node groups)                         │
       │  RelTable  (CSR adjacency lists)                          │
       │  HashIndex (primary key lookups)                          │
       │  LocalStorage (uncommitted write-tx data)                 │
       └────────────────────────────────────────────────┬──────────┘
                                                        │
       ┌────────────────────────────────────────────────▼──────────┐
       │                   Buffer Manager                          │
       │  Page pool  │  EvictionQueue (2-hand clock)               │
       │  FileHandle │  ShadowFile  │  WAL                         │
       └────────────────────────────────────────────────────────────┘
```

## Namespace Structure

The codebase lives under namespace `lbug`. Key sub-namespaces:

| Namespace | Location | Responsibility |
|-----------|----------|----------------|
| `lbug::storage` | `src/storage/` | Storage engine, buffer manager, indexes, WAL |
| `lbug::processor` | `src/processor/` | Physical operators, executor, pipelines |
| `lbug::planner` | `src/planner/` | Logical plan generation |
| `lbug::optimizer` | `src/optimizer/` | Plan optimization rules |
| `lbug::binder` | `src/binder/` | Name resolution, type checking |
| `lbug::parser` | `src/parser/` | ANTLR4 Cypher parsing |
| `lbug::catalog` | `src/catalog/` | Schema: tables, columns, functions |
| `lbug::transaction` | `src/transaction/` | TX manager, MVCC |
| `lbug::function` | `src/function/` | Built-in scalar / aggregate functions |
| `lbug::graph` | `src/graph/` | Graph entry point, table accessors |
| `lbug::main` | `src/main/` | `Database`, `Connection`, `ClientContext` |
| `lbug::extension` | `src/extension/` | Extension loading framework |

## Data Flow: One Query End-to-End

```
MATCH (p:Person)-[:KNOWS]->(f:Person)
WHERE p.name = 'Alice'
RETURN f.name, f.age
ORDER BY f.age
```

1. **Parser** tokenizes and parses via ANTLR4 grammar → produces a parse tree
2. **Binder** walks the parse tree; resolves `Person` → `tableID=0`, `KNOWS` → `tableID=1`; type-checks `p.name = 'Alice'` as string equality
3. **Planner** emits: `OrderBy ← Project ← HashJoin ← [ScanNode(p), ScanRel(KNOWS) ← ScanNode(f)]`
4. **Optimizer** pushes `p.name='Alice'` filter down to `ScanNode(p)`; applies SIP semi-mask from build side to probe side
5. **Executor** splits plan into pipelines:
   - *Pipeline A*: `ScanNode(p)` → `Filter` → `BuildHashTable`
   - *Pipeline B*: `ScanNode(f)` *(semi-masked)* → `ProbeHashTable` → `Project` → `OrderBy`
6. **Morsel scheduler** assigns node groups to threads atomically; each thread runs the full pipeline on its morsel

## Key Design Decisions

**Columnar + factorized execution** — data is stored and processed column-by-column. The factorized execution model avoids materializing intermediate Cartesian products for multi-hop graph patterns.

**In-process embedding** — no network layer, no serialization overhead. The host application and the database share the same address space.

**Node group granularity** — the fundamental storage unit is a node group (~128K nodes). This is also the morsel granularity for native table scans, balancing parallelism overhead vs work unit size.

**Shadow file over WAL for page writes** — rather than a redo log, modified pages are written to a shadow file first. On commit, shadow pages are atomically swapped to the live file. The WAL records logical operations (catalog changes, extension loads) not page diffs.
