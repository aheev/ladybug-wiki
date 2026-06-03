# Local Storage

> Status: implementation-oriented engineering reference.
>
> Scope: native writable storage only.
>
> Primary sources: `local_storage.*`, `local_node_table.*`, `local_rel_table.*`, `local_hash_index.h`, `node_table.cpp`, `rel_table.cpp`, `transaction.cpp`, `scan_node_table.cpp`, and `optimistic_allocator.*`.

## Why this document exists

It explains how those structures interact with MVCC, undo, WAL, index maintenance, scans, and checkpointing.

If you need background on transaction visibility first, read [MVCC](/transaction/mvcc).

If you need rollback record details, read [Undo Buffer](/transaction/undo-buffer).

If you need crash-recovery details, read [Shadow + WAL](/storage/shadow-wal) and [WAL Internals](/storage/wal-internals).

## One-sentence model

A write transaction owns a private in-memory `LocalStorage` object.

That object stores transaction-private node and relationship rows that do not yet exist in committed storage.

Committed-table updates and deletes still use normal MVCC versioning and the undo buffer.

At commit time, local node rows are materialized first, local relationship rows are materialized second, and optimistic page allocations are finalized last.

At rollback time, undo is processed before local storage is cleared.

## Authoritative code map

The key implementation files are:

- `src/include/storage/local_storage/local_storage.h`
- `src/storage/local_storage/local_storage.cpp`
- `src/include/storage/local_storage/local_table.h`
- `src/include/storage/local_storage/local_node_table.h`
- `src/storage/local_storage/local_node_table.cpp`
- `src/include/storage/local_storage/local_rel_table.h`
- `src/storage/local_storage/local_rel_table.cpp`
- `src/include/storage/local_storage/local_hash_index.h`
- `src/storage/table/node_table.cpp`
- `src/storage/table/rel_table.cpp`
- `src/include/transaction/transaction.h`
- `src/transaction/transaction.cpp`
- `src/processor/operator/scan/scan_node_table.cpp`
- `src/include/storage/optimistic_allocator.h`
- `src/storage/optimistic_allocator.cpp`

The most important implementation facts verified from code are:

- `LocalStorage` owns `tables` and `optimisticAllocators`.
- `LocalStorage` is explicitly documented as not thread-safe for general table-local structures.
- `LocalStorage::commit()` commits node local tables first.
- `LocalStorage::commit()` commits relationship local tables second.
- `LocalStorage::commit()` commits optimistic allocators last.
- `Transaction::rollback()` rolls back the undo buffer before calling `localStorage->rollback()`.
- `LocalNodeTable` assigns offsets beginning at the committed row count that existed when the local table was created.
- `LocalNodeTable` uses a `NodeGroupCollection` with compression disabled.
- `LocalNodeTable` uses `LocalHashIndex` for transaction-local primary-key tracking.
- `LocalRelTable` stores all local relationship tuples in a single local `NodeGroup`.
- `LocalRelTable` keeps one transaction-local `DirectedCSRIndex` per storage direction.
- Uncommitted relationship IDs are allocated from `MAX_NUM_ROWS_IN_TABLE + localRowIdx`.
- `RelTable::commit()` rewrites those temporary relationship offsets into committed offsets before CSR materialization.
- `ScanNodeTableSharedState` schedules committed morsels first and uncommitted morsels second.
- Relationship scans also read committed storage first and then switch to local storage if necessary.
- Columnar backends such as Arrow and IceDisk are read-only and do not use these local-write paths.

## What local storage is

Local storage is the transaction-private staging area for rows that do not yet belong to committed on-disk structures.

It exists only for write transactions.

It is allocated when the transaction is constructed.

It is destroyed with the transaction.

It is not shared across transactions.

It is not visible to readers running under other transaction timestamps.

It is not itself checkpointed.

It is not replayed directly during recovery.

It is not a substitute for the undo buffer.

It is not the same thing as the WAL.

## What local storage is not

Local storage is not the mechanism for committed-row version management.

Updates to already-committed node rows still go through the normal MVCC update/delete path on committed node groups.

Deletes of already-committed node rows also stay on committed storage and produce undo records.

Local storage is not a background spill manager.

The current implementation does not expose a dedicated “spill local storage to disk under pressure” policy in these files.

Local storage is not used by Arrow-backed tables.

Local storage is not used by IceDisk-backed tables.

Local storage is not used to make reads globally visible.

Visibility remains transaction-scoped until commit updates committed storage and WAL state.

## High-level ownership graph

```text
Transaction
├── LocalStorage
│   ├── tables : unordered_map<table_id_t, unique_ptr<LocalTable>>
│   │   ├── LocalNodeTable     (for node tables)
│   │   └── LocalRelTable      (for rel tables)
│   └── optimisticAllocators : vector<unique_ptr<OptimisticAllocator>>
├── UndoBuffer
├── LocalWAL
└── LocalCacheManager
```

The important boundary is:

- `LocalStorage` owns private uncommitted rows.
- `UndoBuffer` owns rollback records for committed-storage mutations and catalog/sequence changes.
- `LocalWAL` owns per-transaction WAL bytes before they are flushed into the shared WAL on commit.

## Transaction lifecycle placement

A write transaction constructs:

- a `LocalStorage`
- an `UndoBuffer`
- a `LocalWAL`

This happens in `Transaction` construction.

At commit:

1. `localStorage->commit()` runs.
2. `undoBuffer->commit(commitTS)` runs.
3. the local WAL is finalized and appended to the shared WAL if WAL logging is enabled.
4. catalog version bookkeeping is updated if needed.

At rollback:

1. `undoBuffer->rollback(clientContext)` runs first.
2. `localStorage->rollback()` runs second.
3. catalog-change flags are reset.

That rollback order is intentional.

The source comment explains why.

Local-storage rollback can free and evict optimistically allocated pages.

Undo rollback may still need to scan data structures such as indexes.

So undo must run before local storage is cleared.

## `LocalStorage` top-level manager

### Core fields

`LocalStorage` contains two durable-in-transaction collections:

- `std::unordered_map<table_id_t, std::unique_ptr<LocalTable>> tables`
- `std::vector<std::unique_ptr<OptimisticAllocator>> optimisticAllocators`

The `tables` map holds one local table per modified table.

The key is the physical table ID.

For node tables, that is straightforward.

For relationship tables, the key is the relationship table ID, even though catalog lookup must go through the relationship-group entry in some places.

### Thread-safety status

The header is explicit here.

Local-storage data structures are not thread-safe.

The code comments say the current system only supports single-thread insertions and updates for these structures.

There is one mutex in `LocalStorage`.

That mutex is only for optimistic allocator registration.

Do not read that mutex as proof that the whole local-storage subsystem is concurrency-safe.

It is not.

### `getOrCreateLocalTable(Table&)`

`LocalStorage::getOrCreateLocalTable()` is the factory and lookup function for table-local staging structures.

Behavior:

- It computes the table ID from the incoming `Table`.
- If a local table already exists, it returns the existing instance.
- Otherwise it creates a new local table matching the table type.

For node tables:

- it fetches the node table catalog entry by table ID
- it creates `LocalNodeTable(tableEntry, table, mm)`

For relationship tables:

- it fetches the relationship-group catalog entry by `relGroupID`
- it creates `LocalRelTable(tableEntry, table, mm)`

That relationship-group lookup matters.

A relationship table is part of a relationship-group catalog entry.

The local table therefore needs the group entry to derive the current property layout correctly.

### `getLocalTable(tableID)`

This is a nullable lookup.

If a transaction never touched a table, no local table exists.

Readers and commit paths use that fact heavily.

Many code paths start with:

- “if there is a local table, merge it into the read path”
- otherwise “stay on committed storage only”

### `addOptimisticAllocator()`

Optimistic allocators are separate from `LocalTable` objects.

They are used for page allocations that should become immediately rewritable again if the transaction rolls back.

Behavior:

- If the data file handle is in-memory mode, `addOptimisticAllocator()` simply returns the main `PageManager`.
- Otherwise it creates a new `OptimisticAllocator` bound to the main `PageManager`.
- The allocator is stored in `optimisticAllocators`.
- The returned pointer is a `PageAllocator*`.

This design lets callers request a page allocator without caring whether the database is fully in-memory or on disk.

### `commit()` ordering

`LocalStorage::commit()` has a strict order.

That order is part of the storage contract.

The order is:

1. commit every local node table
2. commit every local relationship table
3. commit every optimistic allocator

Why nodes before relationships?

Because local relationships may point at local nodes.

Node commit gives those nodes stable committed offsets first.

Relationship commit can then rewrite temporary relationship IDs and append CSR data while referring to already-materialized node offsets.

### `rollback()` ordering and cleanup

`LocalStorage::rollback()` also has a strict order.

The order is:

1. clear all local tables
2. roll back all optimistic allocators
3. merge free pages in the `PageManager`
4. clear evicted buffer-manager entries if needed

This is post-undo cleanup.

By the time `LocalStorage::rollback()` runs, the undo buffer has already reversed committed-storage side effects that needed rollback.

## `LocalTable` common contract

`LocalTable` is the abstract base class for transaction-local table storage.

It defines the operations that committed tables can delegate to when a row lives only in the transaction-private staging area.

The required virtual operations are:

- `insert(...)`
- `update(...)`
- `delete_(...)`
- `addColumn(...)`
- `clear(...)`
- `getTableType() const`
- `getNumTotalRows()`

Important observations:

- `LocalTable` stores a reference to the underlying committed `Table`.
- It does not own catalog metadata itself.
- It does not try to unify node and relationship storage formats.
- Node and relationship local storage are intentionally different.

## `LocalNodeTable`

### Role

`LocalNodeTable` stores node rows that have been inserted by the current transaction and do not yet exist in committed node groups.

It also stores transaction-local updates and deletes against those newly inserted rows.

It does **not** own updates against already committed rows.

Those still happen on committed node groups with MVCC version records.

### Constructor behavior

Construction does several important things immediately.

It:

- builds a local `NodeGroupCollection`
- disables compression for that collection
- creates a transaction-local hash index for PK tracking
- snapshots the committed row count into `startOffset`

The key line is:

- `startOffset = table.getNumTotalRows(nullptr)`

That means the local node namespace begins at the committed row count that existed when the local table was first created.

It is not a global reserved ID range.

It is not `MAX_NUM_ROWS_IN_TABLE`.

It is simply the first offset after the table’s current committed row count at local-table creation time.

### Local storage format

`LocalNodeTable` uses a `NodeGroupCollection` as its row container.

Compression is disabled.

This makes local insert/update/delete handling simpler and cheaper than routing everything through compressed committed storage.

The collection is organized as local node groups in the same broad shape as committed node groups.

But it is transaction-private.

And its offset base starts at `startOffset`.

### `startOffset` and local node IDs

Every local node inserted into a `LocalNodeTable` gets an offset computed as:

```text
nodeOffset = startOffset + nodeGroups.getNumTotalRows()
```

That offset is immediately turned into an internal node ID:

```text
internalID_t{nodeOffset, tableID}
```

So as soon as an insert succeeds, the transaction can reference the new node by a stable transaction-local ID.

This is why local relationships can point at local nodes before commit.

### Insert path

The insert path is simple but important.

Steps:

1. Read the current local row count.
2. Compute `nodeOffset = startOffset + localRowCount`.
3. Insert the PK into the local hash index.
4. If the PK already exists and is visible, throw duplicate-PK.
5. Write the generated internal ID into the caller’s node-ID vector.
6. Append property vectors into the local `NodeGroupCollection` using `DUMMY_TRANSACTION`.

Two details matter here.

First:

- inserts into local node storage use `DUMMY_TRANSACTION`

Second:

- the PK uniqueness check is performed against transaction-local state before the append

The local row therefore exists immediately for “read your own write” semantics.

### Why `DUMMY_TRANSACTION` is used on local appends

Local node groups are private to one transaction.

They do not need full timestamp-based MVCC bookkeeping internally.

The transaction already owns them exclusively.

So the implementation uses `DUMMY_TRANSACTION` for local append/update/delete operations.

That is not the same as saying local rows are outside transaction semantics.

It only means local row containers do not need the same per-row MVCC metadata model as committed storage.

### Visibility in local node storage

`LocalNodeTable::isVisible()` computes local visibility from the local node groups.

It:

1. translates a table-level offset into a local row index by subtracting `startOffset`
2. finds the local node group and offset-in-group
3. returns false if the row is locally deleted
4. otherwise returns whether the row is locally inserted

This function is used by:

- local PK lookup
- transaction-level visibility helpers
- mixed committed/local read paths

### Update path for local nodes

`LocalNodeTable::update()` only handles updates to rows that are already in local storage.

The implementation asserts that the incoming transaction is dummy.

It also asserts the target offset is at least `startOffset`.

It rejects PK-column updates.

Then it:

- translates the global table offset into a local row index by subtracting `startOffset`
- finds the target node group
- applies the update to the target column in the local node group

If the updated node is committed rather than local, `NodeTable::update()` does not use this path.

It updates the committed node group directly.

### Delete path for local nodes

`LocalNodeTable::delete_()` also expects `DUMMY_TRANSACTION`.

It:

- looks up the row’s table offset
- asserts the row is local
- removes the PK from the local hash index via `hashIndex->delete_(...)`
- translates the local offset into node-group coordinates
- marks the local row deleted in the local node group

Local deletion does not renumber surviving local rows.

That stability is important for local relationship references.

### Add-column handling

Schema changes can happen while a write transaction already owns local state.

`LocalNodeTable::addColumn()` forwards the add-column operation into the local `NodeGroupCollection`.

That keeps the local tuple layout aligned with the current node-table property layout.

### Clear behavior

`LocalNodeTable::clear()` does two things.

It:

- rebuilds the local PK hash index
- clears the local node groups

The method does not physically preserve old local rows.

After commit or rollback, the local node table becomes an empty staging area again.

### Stats and row counts

`LocalNodeTable` contributes to transactional row counts.

`NodeTable::getNumTotalRows(transaction)` adds the committed row count and the local row count.

That means a writer sees its own inserted nodes in cardinality-sensitive operations.

### Important invariant

`LocalNodeTable` row order must remain stable until commit or rollback clears it.

The node commit path relies on that stability.

The relationship local-storage path also relies on that stability.

The code comments in `NodeTable::commit()` explicitly warn that removing deleted local tuples early could shift offsets and break connected local relationships.

## `LocalHashIndex`

### Role

`LocalHashIndex` is the transaction-local primary-key structure used by `LocalNodeTable`.

It prevents duplicate PK inserts within the writer’s view.

It also lets lookup see transaction-local inserts and deletes without scanning committed storage first.

### Two-part design

The implementation is split into:

- `localInsertions`
- `localDeletions`

In code, those live in `HashIndexLocalStorage<T>`.

`localInsertions` is an `InMemHashIndex<T>`.

`localDeletions` is an in-memory set of deleted keys.

The comment in the header summarizes the intent:

- one structure tracks newly inserted entries
- one structure tracks newly deleted entries that were not in `localInsertions`

### Why two structures exist

A transaction may do any of these:

- insert a new PK
- delete a PK that it inserted earlier in the same transaction
- delete a PK that came from committed storage
- re-insert a PK that it had previously marked deleted locally

A single “map of key to state” could represent this.

But the current implementation uses separate insertion and deletion structures because it fits the expected transaction-local workload and the in-memory hash-index helper APIs.

### Lookup states

Internal lookup can distinguish three states:

- `KEY_FOUND`
- `KEY_DELETED`
- `KEY_NOT_EXIST`

The logic is:

1. if the key is in `localDeletions`, report deleted
2. else if the key is in `localInsertions` and the pointed row is visible, report found
3. else report not-exist

The public `LocalHashIndex` wrapper usually collapses that into an offset or `INVALID_OFFSET`.

### Insert behavior

On insert:

- the code acquires the local hash-index lock
- removes the key from `localDeletions` if present
- appends the key and offset to `localInsertions`

This is how delete-then-reinsert is handled.

A reinsertion cancels the local deletion marker.

### Delete behavior

On delete:

- the code first tries to delete the key from `localInsertions`
- if that fails, it inserts the key into `localDeletions`

That behavior distinguishes between:

- “delete a row inserted in this same transaction”
- “delete a row that comes from committed state”

### Locking story

Unlike the overall `LocalStorage` comment, `HashIndexLocalStorage<T>` does use a `shared_mutex`.

That gives the hash-index structure internal read/write coordination.

But this does **not** make the surrounding local-storage subsystem generally thread-safe.

Treat this as an internal detail of the local hash-index container.

### String keys and overflow storage

For string PKs, `LocalNodeTable` creates an `InMemOverflowFile` and passes a handle into `LocalHashIndex`.

For primitive PK types, the overflow handle is unnecessary.

This mirrors the difference between variable-length and fixed-size key storage requirements.

### `applyLocalChanges(...)`

`HashIndexLocalStorage<T>` exposes `applyLocalChanges(...)`.

That callback-based API is important because higher-level index maintenance can apply local deletions and insertions to a persistent index structure during commit/checkpoint flows.

It is part of the reason this helper exists as a separate storage abstraction rather than being folded directly into `LocalNodeTable`.

### What local PK lookup actually does

A common misconception is that node PK lookup must first search committed storage and then overlay local changes.

That is not what the current code does.

`NodeTable::lookupPK(...)` first checks local storage.

If a local table exists and `LocalNodeTable::lookupPK(...)` finds a visible local row, lookup returns immediately.

Only then does the code consult the committed PK index or a scan fallback.

The sequence is:

1. local lookup
2. committed PK index lookup, if present
3. scan-based fallback, if no PK index exists

That lookup order is the transactional overlay.

## `LocalRelTable`

### Role

`LocalRelTable` stores relationship rows inserted by the current transaction.

It also stores transaction-local updates and deletes against those newly inserted relationships.

It does **not** rewrite committed CSR storage in place before commit.

Committed relationship updates/deletes use committed-table logic.

### Construction

The constructor does two core things.

It:

- allocates one local `NodeGroup` to hold all local relationship tuples
- creates one `DirectedCSRIndex` per storage direction of the relationship table

The local relationship tuple store is not a full committed CSR structure.

It is a single append-only row store plus direction-specific maps from bound node offset to local row indices.

### Local tuple layout

The effective tuple layout is:

```text
[srcNodeID, dstNodeID, relID, property0, property1, ...]
```

The first two columns are internal IDs for the source and destination nodes.

The third column is the relationship ID.

Property columns follow.

This differs from committed relationship storage.

Committed relationship storage is organized in CSR-oriented structures per direction.

The local store is intentionally simpler.

### Directed CSR indices

For each storage direction, `LocalRelTable` keeps a `DirectedCSRIndex`.

Conceptually each index is:

```text
boundNodeOffset -> [localRowIdx0, localRowIdx1, ...]
```

This gives the transaction a fast way to answer:

- “what local relationships are adjacent to this bound node in this direction?”

The lists store local row indices into the one local `NodeGroup`.

They do not store copies of the relationship tuples.

### Insert path

The insert path is the heart of `LocalRelTable`.

Steps:

1. validate that required bound-node IDs are non-null in every stored direction
2. compute the current local row count
3. assign temporary relationship IDs for each incoming row
4. append all vectors into the local `NodeGroup`
5. register the new local row indices in every direction’s `DirectedCSRIndex`

The temporary relationship ID formula is:

```text
relOffset = MAX_NUM_ROWS_IN_TABLE + numRowsInLocalTable + i
```

The table ID portion is the real relationship table ID.

So the internal ID written to the rel-ID vector is:

```text
internalID_t{temporaryRelOffset, relTableID}
```

### Why uncommitted relationship IDs start at `MAX_NUM_ROWS_IN_TABLE`

Node local offsets are based on `startOffset`.

Relationship local offsets use a different scheme.

They are assigned in a high reserved range above the maximum committed-row namespace.

That makes them easy to recognize as uncommitted relationship IDs.

It also gives `RelTable::commit()` a clean rewrite rule when converting them into committed offsets.

### Append into the local row store

After temporary IDs are assigned, `LocalRelTable` builds the list of vectors to append:

- source node ID vector
- destination node ID vector
- relationship ID vector
- all property vectors

Then it appends those rows into the single local `NodeGroup` using `DUMMY_TRANSACTION`.

### Updating direction maps on insert

Once rows are appended, the local row indices are inserted into every direction’s `DirectedCSRIndex`.

For each appended row and each direction:

- read the relevant bound node ID
- extract its node offset
- append the local row index to the bound-node entry in that direction’s map

This is what makes local relationship scans cheap.

The scan path can locate candidate local rows by bound node before touching the row store.

### Update path for local relationships

`LocalRelTable::update()` expects a local relationship row.

It does not scan the entire local relationship store.

Instead it narrows candidates in stages.

The steps are:

1. use each relevant directed index to get candidate local row lists for the bound node(s)
2. intersect those row lists
3. scan the local relationship-ID column for the target rel ID among the intersection
4. if found, update the requested property column in the local row store

This means update cost is driven by adjacency fan-out and intersection size rather than local-table size alone.

### Delete path for local relationships

`LocalRelTable::delete_()` is similar.

It:

1. collects row-index lists from the relevant directional maps
2. intersects them
3. scans the local rel-ID column to find the exact target row
4. erases that row index from each involved directional list

Two details are important.

First:

- the delete path does not immediately compact the local row store

Second:

- emptiness is tracked effectively through the direction maps rather than by shrinking the underlying row store on every delete

This mirrors the node-local design choice of keeping local-row numbering stable.

### `isEmpty()` meaning

The local relationship table can be logically empty even if its local node group still contains historical rows that were deleted from the directional maps.

That is why emptiness is not simply “local node group has zero physical rows”.

The committed `RelTable::commit()` path checks logical emptiness and can simply clear the local table if there is nothing left to materialize.

### Column-ID rewriting for local scans and updates

Committed relationship scans use committed column IDs.

The local relationship tuple layout shifts those IDs because the first local columns are:

- source node ID
- destination node ID
- local rel ID

So `LocalRelTable` provides rewrite helpers:

- `rewriteLocalColumnID(...)`
- `rewriteLocalColumnIDs(...)`

Special case:

- `NBR_ID_COLUMN_ID` maps to one of the local node-ID columns depending on scan direction

All other committed property IDs are shifted by one in the local layout because the local row store has the two node-ID columns prepended and the relationship ID column already in position.

### Local relationship scan algorithm

`LocalRelTable::scan(...)` drives the uncommitted branch of relationship scans.

The algorithm is:

1. get the current bound node from the cached bound-node selection vector
2. look up its row-index list in the direction-appropriate `DirectedCSRIndex`
3. batch up to `DEFAULT_VECTOR_CAPACITY` row indices
4. write those row indices into the scan state’s row-index vector
5. run `lookupMultiple(...)` against the local node group
6. return one vector batch
7. continue until the bound-node list is exhausted

This is not a CSR materialization step.

It is a row-store lookup guided by adjacency lists.

### Matching rows by rel ID

When update/delete needs the exact local relationship row, `findMatchingRow(...)` performs the final disambiguation.

It:

- sorts candidate row lists
- intersects them
- scans the rel-ID column only for the surviving candidates
- returns the matching local row index or `INVALID_ROW_IDX`

That keeps the expensive part narrow.

### `checkIfNodeHasRels(...)`

This is a simple but important helper.

It checks whether the directional index contains any local rows for a bound node.

Detach-delete and similar paths can use this to mix committed and local adjacency checks.

### Add-column behavior

`LocalRelTable::addColumn()` adds the new property column to the local row store.

The current local node group is expanded in-place.

That keeps local relationship tuple shape aligned with the evolving table schema.

## Transaction-local offset translation

The transaction object owns helper methods that tie local storage to table-level IDs.

The key helpers are:

- `isUnCommitted(tableID, nodeOffset)`
- `getLocalRowIdx(tableID, nodeOffset)`
- `getUncommittedOffset(tableID, localRowIdx)`
- `getMinUncommittedNodeOffset(tableID)`

For node tables, `getMinUncommittedNodeOffset(tableID)` comes from the local node table’s `startOffset`.

The rule is:

- if a node offset is greater than or equal to that minimum local offset, and a local table exists, the node is considered transaction-local

The conversion formulas are:

```text
localRowIdx = nodeOffset - minUncommittedOffset
uncommittedOffset = minUncommittedOffset + localRowIdx
```

These helpers are what let scan and lookup code switch between committed and local physical coordinate systems without changing the public node-ID format.

## How node reads merge committed and local state

### Visibility checks

`NodeTable::isVisible(...)` first checks whether a target offset is uncommitted for the current transaction.

If yes:

- it delegates to `LocalNodeTable::isVisible(...)`

If not:

- it reads visibility from committed node groups

That is the core overlay rule for node visibility.

### PK lookup path

As noted earlier, PK lookup order is:

1. local PK index
2. committed PK index
3. scan fallback

This gives correct read-your-own-write semantics for inserts and deletes.

### `lookup(...)` and `lookupMultiple(...)`

Random node lookups do explicit source switching.

For each requested node ID, the code decides whether the ID is committed or uncommitted.

Then it computes:

- source = `COMMITTED` or `UNCOMMITTED`
- node-group index in the relevant storage namespace
- row index within that node group

If the target is local, the code uses `transaction->getLocalRowIdx(...)` and then looks in the local node groups.

If the target is committed, it uses normal committed offsets.

### Node scan scheduling

`ScanNodeTableSharedState` is the clearest statement of scan merge behavior.

During initialization it calculates:

- number of committed morsels/node groups
- number of uncommitted local node groups, but only for write transactions

During `nextMorsel(...)` it schedules:

1. committed groups first
2. uncommitted groups second
3. then `NONE`

That means the node scan is **not** a single row-by-row overlay pass.

It is a source-aware scan with explicit phase switching.

### Node scan state translation

`NodeTableScanState::scanNext(...)` and `NodeTableScanState::scanNext(transaction, startOffset, numNodes)` both translate local offsets when `source == UNCOMMITTED`.

Specifically:

- the node-group start offset is converted with `transaction->getUncommittedOffset(tableID, localGroupStartOffset)`

So output node IDs from local scans still use the correct transaction-visible table offsets.

### Semi-mask interaction

Semi-mask handling lives on committed scan flows.

The code paths that build rollback PK deleters and committed scans explicitly attach semi-masks to committed scan states.

Local-only scans are separate `UNCOMMITTED` source paths.

So when reading the current implementation, do **not** assume one semi-mask is applied uniformly across a combined committed+local stream.

The local scan branch is explicit.

## How relationship reads merge committed and local state

`RelTableScanState` makes the relationship-side behavior explicit.

When a scan state is bound to a table:

- it configures committed relationship columns and CSR columns
- if a local relationship table exists, it creates a `LocalRelTableScanState`

Initialization then chooses:

- committed source first if a committed node group is present
- otherwise uncommitted if local data exists
- otherwise none

`scanNext()` loops like this:

1. scan committed relationship storage
2. if that committed node group is exhausted and local data exists, switch to uncommitted
3. scan the local relationship table
4. when both are exhausted, return false

Again, this is a source-switching algorithm.

It is not a single merged iterator over one unified physical structure.

## How writes decide between committed and local paths

### Node insert

Node inserts always create or reuse a `LocalNodeTable`.

The committed `NodeTable` object delegates the row append to local storage.

Secondary index insert bookkeeping may still be prepared at the `NodeTable` layer.

### Node update

`NodeTable::update()` checks whether the target node offset is uncommitted for this transaction.

If yes:

- delegate to `localTable->update(&DUMMY_TRANSACTION, ...)`

If not:

- update the committed node group directly using the real transaction

### Node delete

`NodeTable::delete_()` follows the same split.

If the node is local:

- delete in local storage using `DUMMY_TRANSACTION`

If the node is committed:

- delete in the committed node group
- append delete info to the undo buffer if appropriate

### Relationship insert

Relationship inserts create or reuse `LocalRelTable` and append into the transaction-private local relationship store.

The committed CSR structures are not updated until commit.

### Relationship update/delete

When a relationship ID is still in the uncommitted local-ID range, relationship update/delete paths can route to local storage.

When it is committed, they operate on committed relationship storage.

The current `rel_table.cpp` code contains explicit branches for local delete/update and detach-delete interactions.

## Node commit algorithm

`NodeTable::commit(...)` is the authoritative node-local materialization algorithm.

It is four stages.

### Stage 1: append all local tuples

The code first appends **all** tuples from the local node table into committed `nodeGroups`.

This includes tuples that were locally deleted.

That sounds odd at first.

But the code comment explains why it is required.

If locally deleted tuples were removed before append, local node offsets could shift.

That would break relationships that were created against those local node offsets earlier in the same transaction.

So stability wins.

### Stage 2: re-apply local deletions on committed storage

After append, the code walks local node groups.

For every locally deleted row, it finds the new committed node offset corresponding to that appended row and marks the committed row deleted.

If undo-buffer appends are enabled for the transaction, a delete record is pushed for the committed row.

### Stage 3: commit index insertions

Indexes that need commit-time insert processing are handled next.

The code builds an `UncommittedIndexInserter` beginning at `startNodeOffset`.

Then it scans index columns from the **local** node groups.

That local scan matters.

Some locally inserted rows may have been deleted before commit.

Scanning local storage with visibility logic avoids inserting deleted rows into committed indexes.

### Stage 4: clear the local table

After rows and indexes are materialized, `localTable->clear(...)` resets the local node table.

At that point the committed table is the source of truth.

## Relationship commit algorithm

`RelTable::commit(...)` is the relationship-local materialization algorithm.

It is also staged.

### Fast exit on logical emptiness

If the local relationship table is logically empty, commit clears it and returns.

No CSR materialization work is needed.

### Stage 1: rewrite temporary relationship IDs

The first real step is `updateRelOffsets(localRelTable)`.

This does two things:

- reserves committed relationship offsets with `reserveRelOffsets(...)`
- rewrites each local temporary relationship offset in-place

The rewrite formula is:

```text
committed = uncommitted - MAX_NUM_ROWS_IN_TABLE + maxCommittedOffset
```

After rewriting, the rel-ID column’s table ID is also set correctly.

### Stage 2: materialize local rows into committed CSR node groups

For each stored direction and each bound node present in that direction’s `DirectedCSRIndex`, commit:

- locates or creates the correct committed CSR node group
- prepares insert info for that node group
- scans the local row store for the relevant local rows
- appends them into committed CSR storage, skipping the column that is only an implementation detail for that direction

This is the point where the simple local row store becomes committed direction-specific CSR data.

### Stage 3: clear the local relationship table

Once all directions are materialized, the local relationship table is cleared.

## Why node tables commit before relationship tables

The top-level `LocalStorage::commit()` order is not accidental.

Nodes must commit first because:

- local node offsets are already being used by local relationships
- node commit appends those nodes into committed storage without shifting relative order
- relationship commit then materializes edges against stable node offsets

If relationship materialization happened first, its references to local node offsets would have no committed target yet.

## Rollback behavior in detail

### Transaction-level sequence

Rollback begins at `Transaction::rollback()`.

The sequence is:

1. undo-buffer rollback
2. local-storage rollback
3. clear transaction catalog-change flag

### What undo rollback covers

Undo rollback covers committed-storage mutations that already touched versioned committed structures.

That includes, for example:

- committed-row deletes
- committed-row updates
- index cleanup that needs to scan committed data
- catalog and sequence rollbacks

### What local-storage rollback covers

Local-storage rollback then discards everything still private to the transaction.

For local tables this means:

- clear local node tables
- clear local relationship tables

For optimistic allocators this means:

- immediately free optimistically allocated page ranges for rewrite

Then page-manager housekeeping runs.

### Page-manager housekeeping after local rollback

`LocalStorage::rollback()` ends with:

- `mergeFreePages(...)`
- `clearEvictedBMEntriesIfNeeded(...)`

That ensures the free-page structures and buffer-manager eviction state are coherent after optimistic allocations have been undone.

## Optimistic allocators

### Purpose

An `OptimisticAllocator` tracks page ranges allocated optimistically during a transaction.

The class comment mentions COPY as an example.

The point is simple:

- if the transaction commits, the allocations become ordinary durable allocations
- if the transaction rolls back, those pages become immediately rewritable again

### Internal state

`OptimisticAllocator` stores:

- a reference to the shared `PageManager`
- `optimisticallyAllocatedPages : vector<PageRange>`

### Allocation behavior

`allocatePageRange(numPages)` delegates to the page manager.

If `numPages > 0`, the returned page range is recorded in `optimisticallyAllocatedPages`.

### Free behavior

`freePageRange(block)` forwards directly to `pageManager.freePageRange(block)`.

### Rollback behavior

On rollback, the allocator iterates through all recorded page ranges and calls:

- `pageManager.freeImmediatelyRewritablePageRange(...)`

Then it clears its vector.

### Commit behavior

On commit, the allocator simply clears the recorded vector.

No special page-manager rewrite is needed because the allocations are now durable transaction results.

## Durability relationship: local storage vs WAL vs checkpoint

Local storage is not durable by itself.

If the process crashes before commit, local storage disappears.

Only committed effects that reached the shared WAL or checkpointed storage survive.

The durability chain is:

- local rows exist only in the writer’s private memory until commit
- commit materializes them into committed storage structures and/or WAL-visible effects
- checkpoint later persists committed in-memory state into the durable data-file image

This is why local storage is described as staging, not persistence.

## Checkpoint interaction

Checkpointing does not serialize transaction-private local storage.

Checkpointing operates on committed table state and committed metadata.

For the current checkpoint flow, see [Checkpointing](/transaction/checkpointing).

The only direct local-storage-adjacent detail worth remembering here is:

- local rows must already have been committed into native table structures before checkpoint can materialize them

Uncommitted local rows are not part of checkpoint state.

## Native writable tables vs read-only columnar backends

The local-write paths described on this page are for native writable `NodeTable` and `RelTable` implementations.

Arrow and IceDisk table classes are different.

Their base classes explicitly reject insert/update/delete.

So they do not create `LocalNodeTable` or `LocalRelTable` instances for writes.

They also do not participate in the native local-commit materialization path.

The scan layer still has table-specific logic for Arrow and IceDisk morsel scheduling.

But that is a read-path concern.

It is not local-write storage.

## Important limitations and caveats

### General thread safety

The local-storage subsystem is not generally thread-safe.

Assume single-threaded mutation semantics for transaction-local table state.

### Hash-index snapshotting limitation

The node-table checkpoint code documents an existing limitation.

Hash-index checkpointing currently operates on live index state rather than a fully timestamp-filtered snapshot view.

That limitation belongs more to checkpointing than local storage.

But it matters when reasoning about how local changes eventually flow into durable index state.

### No documented explicit local spill policy

These local-storage files do not define a dedicated spill-to-disk policy for local rows.

Do not document one unless new code adds it.

### Local relationship storage is not committed CSR

Local relationship storage is intentionally different from committed relationship storage.

Trying to reason about it as “mini CSR on disk” will lead you astray.

It is one local row store plus directional adjacency maps.

## Common misconceptions corrected

### “Local node offsets are temporary random IDs.”

No.

They are deterministic table offsets beginning at the committed row count captured in `startOffset`.

### “All uncommitted relationship IDs are assigned by reserving committed offsets up front.”

No.

They first live in the high uncommitted range above `MAX_NUM_ROWS_IN_TABLE`.

They are rewritten to committed offsets only during `RelTable::commit()`.

### “Checkpoint flushes local storage.”

No.

Checkpoint materializes committed table state.

Uncommitted local rows are transaction-private memory only.

### “Local PK validation scans committed storage first.”

No.

The lookup order is local first, then committed index, then scan fallback.

### “Node scan merge is one combined iterator with the same mask logic for both sources.”

No.

Committed and uncommitted node scans are explicit source branches.

Committed morsels are scheduled first.

Local morsels are scheduled second.

### “Deleting a local node immediately removes it from local storage.”

No.

The row remains in the local node groups and is marked deleted.

This preserves local offset stability for connected local relationships.

## Practical debugging checklist

When a bug smells like transaction-local state, check these questions in order:

1. Is the target row actually local for the current transaction?
2. For node IDs, does `transaction->isUnCommitted(tableID, offset)` return true?
3. Was the local table created before a schema change that added columns?
4. Is a PK conflict coming from `LocalHashIndex` rather than the committed PK index?
5. For relationships, are you looking at the correct directional local CSR map?
6. If a local rel update/delete fails, did the row-list intersection eliminate the candidate?
7. If commit fails, did node commit run before rel commit?
8. If rollback fails, did some code path depend on local pages after local storage was cleared?

## Short worked examples

### Example: insert node, then read it back

1. `NodeTable::insert()` creates or reuses `LocalNodeTable`.
2. `LocalNodeTable::insert()` assigns `nodeOffset = startOffset + localRowsSoFar`.
3. The node ID vector receives `{nodeOffset, tableID}`.
4. A later lookup checks local storage first and finds the row.

### Example: insert node, delete it, then commit

1. Insert appends the row to the local node groups.
2. Delete marks the local row deleted and removes its PK from `LocalHashIndex`.
3. Commit still appends the row into committed node groups.
4. Commit then re-applies the deletion on the committed copy.
5. Index commit scans the local groups and inserts only rows still visible.

### Example: insert rel, then commit

1. `LocalRelTable::insert()` writes a temporary rel ID in the uncommitted range.
2. The row is appended to the local row store.
3. Directed adjacency maps record the local row index under each bound node.
4. Commit reserves committed rel offsets.
5. Commit rewrites temporary rel IDs in-place.
6. Commit appends rows into committed CSR node groups per direction.

## Quick reference tables

### Storage shapes

| Component               | Physical shape                       | Durability before commit | Primary purpose                      |
| ----------------------- | ------------------------------------ | ------------------------ | ------------------------------------ |
| `LocalNodeTable`      | `NodeGroupCollection`              | none                     | stage inserted local nodes           |
| `LocalRelTable`       | one `NodeGroup` + direction maps   | none                     | stage inserted local rels            |
| `LocalHashIndex`      | in-memory insertion/deletion indexes | none                     | local PK visibility and uniqueness   |
| `OptimisticAllocator` | vector of page ranges                | none                     | reclaim optimistic pages on rollback |

### Commit ordering

| Level                   | Order                                                             |
| ----------------------- | ----------------------------------------------------------------- |
| Transaction commit      | local storage -> undo commit -> WAL flush                         |
| Local storage commit    | node local tables -> rel local tables -> optimistic allocators    |
| Node-table local commit | append rows -> reapply deletions -> commit indexes -> clear local |
| Rel-table local commit  | rewrite rel IDs -> materialize CSR rows -> clear local            |

### Rollback ordering

| Level                  | Order                                                                        |
| ---------------------- | ---------------------------------------------------------------------------- |
| Transaction rollback   | undo rollback -> local storage rollback                                      |
| Local storage rollback | clear local tables -> rollback optimistic allocators -> page-manager cleanup |

## Source-backed checklist of facts to preserve in future edits

Keep these statements aligned with code unless the source changes:

- `LocalStorage` keeps `tables` in an unordered map keyed by table ID.
- `LocalStorage` tracks optimistic allocators separately from local tables.
- `LocalStorage::commit()` commits nodes before relationships.
- `LocalStorage::rollback()` clears local tables before optimistic allocator rollback.
- `LocalNodeTable.startOffset` is the committed row count at local-table creation time.
- `LocalNodeTable` appends using `DUMMY_TRANSACTION`.
- `LocalNodeTable` uses `LocalHashIndex` for PK state.
- `LocalRelTable` stores all local rel tuples in one local node group.
- `LocalRelTable` maintains one directional map per storage direction.
- Temporary local relationship IDs live above `MAX_NUM_ROWS_IN_TABLE`.
- `RelTable::commit()` rewrites temporary rel IDs before CSR materialization.
- Node scans schedule committed groups before local groups.
- Relationship scans switch from committed to uncommitted source when committed data is exhausted.
- Arrow and IceDisk backends are read-only and do not use this write path.

## References

- `src/include/storage/local_storage/local_storage.h`
- `src/storage/local_storage/local_storage.cpp`
- `src/include/storage/local_storage/local_table.h`
- `src/include/storage/local_storage/local_node_table.h`
- `src/storage/local_storage/local_node_table.cpp`
- `src/include/storage/local_storage/local_rel_table.h`
- `src/storage/local_storage/local_rel_table.cpp`
- `src/include/storage/local_storage/local_hash_index.h`
- `src/storage/table/node_table.cpp`
- `src/storage/table/rel_table.cpp`
- `src/include/transaction/transaction.h`
- `src/transaction/transaction.cpp`
- `src/processor/operator/scan/scan_node_table.cpp`
- `src/include/storage/optimistic_allocator.h`
- `src/storage/optimistic_allocator.cpp`
