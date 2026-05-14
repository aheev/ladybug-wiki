# Local Storage

**Source files:** `src/storage/local_storage/local_node_table.cpp`, `src/storage/local_storage/local_rel_table.cpp`, `src/include/storage/local_storage/`

## Concept

Every write transaction maintains an **in-memory staging area** (local storage) that buffers all inserts, updates, and deletes before they are flushed to the persistent node groups on commit. Reads from the same transaction see their own local writes immediately, achieving read-your-writes consistency.

## Structure Overview

```
Transaction (write)
  ├─ LocalNodeTable (one per modified node table)
  │    ├─ LocalNodeGroup (one per modified node group)
  │    │    ├─ insertedNodeOffsets: vector<offset_t>
  │    │    ├─ deletedNodeOffsets:  unordered_set<offset_t>
  │    │    └─ updates: map<column_id_t, map<offset_t, ValueBuffer>>
  │    └─ newNodeGroups: vector<LocalNodeGroup>  ← new nodes beyond committed capacity
  └─ LocalRelTable (one per modified rel table)
       ├─ LocalRelGroup (one per src node)
       │    ├─ insertedRels: vector<RelRecord>
       │    └─ deletedRelOffsets: unordered_set<offset_t>
       └─ newRelGroups: similar structure
```

## LocalNodeTable

### Inserts

```cpp
// INSERT (:Person {name: 'Alice', age: 30})
offset_t LocalNodeTable::insert(Transaction& tx, ValueVector** propertyVectors) {
    // Assign a new transient nodeOffset
    auto offset = nextOffset++;
    // Map it to the appropriate local node group
    auto groupIdx  = offset / NODE_GROUP_SIZE;
    auto localIdx  = offset % NODE_GROUP_SIZE;
    // Record insert for each column
    for (auto colID = 0; colID < numColumns; colID++) {
        localNodeGroups[groupIdx].updates[colID][localIdx] = extract(propertyVectors[colID], localIdx);
    }
    insertedNodeOffsets.push_back(offset);
    tx.undoBuffer->appendInsertInfo(tableID, offset);
    return offset;
}
```

The `offset` returned is a **transient offset** — it is only valid within the transaction and is converted to a permanent offset at flush time.

### Updates

```cpp
void LocalNodeTable::update(Transaction& tx, offset_t nodeOffset, column_id_t colID,
                            ValueVector* newValues) {
    auto& group = getOrCreateLocalGroup(nodeOffset / NODE_GROUP_SIZE);
    auto localIdx = nodeOffset % NODE_GROUP_SIZE;
    // Save old value to undo buffer before overwriting
    auto oldValue = group.getCommittedValue(colID, localIdx);
    tx.undoBuffer->appendUpdateInfo(tableID, nodeOffset, colID, oldValue);
    // Write new value to local group
    group.updates[colID][localIdx] = extract(newValues, 0);
}
```

### Deletes

```cpp
void LocalNodeTable::deleteNode(Transaction& tx, offset_t nodeOffset) {
    auto& group = getOrCreateLocalGroup(nodeOffset / NODE_GROUP_SIZE);
    group.deletedNodeOffsets.insert(nodeOffset % NODE_GROUP_SIZE);
    tx.undoBuffer->appendDeleteInfo(tableID, nodeOffset);
}
```

## Scan Merging

During a scan, the executor merges committed data with local data:

```
ScanNodeTable operator:
  ├─ Scan committed node groups (MVCC-filtered by commitID)
  │    └─ Apply LocalNodeTable overrides:
  │         ├─ Skip rows in deletedNodeOffsets
  │         └─ Substitute local updated values
  └─ Scan local-only new node groups (invisible to other TXs)
```

The merge is handled by `NodeTableScanState` which checks both `TableScanSource::COMMITTED` and the transaction's local storage.

::: tip Semi-mask interaction
Semi-masks from SIP optimization are only applied to `COMMITTED` source scans, never to local storage scans. Local writes are unconditionally included.
:::

## LocalRelTable

Relationship local storage mirrors the node table pattern but tracks both:
- `localRelGroups[srcNodeOffset]` — one group per source node with new outgoing edges
- `localRelGroupsBackward[dstNodeOffset]` — backward direction for undirected scans

Each group holds `insertedRels` (as `RelRecord` structs with dst node ID and property values) and `deletedRelOffsets`.

### Flush at Commit

```cpp
void LocalStorage::flush(transaction_t commitID) {
    for (auto& [tableID, localNodeTable] : nodeTables) {
        localNodeTable->flush(commitID, *persistentNodeTable);
    }
    for (auto& [tableID, localRelTable] : relTables) {
        localRelTable->flush(commitID, *persistentRelTable);
    }
}
```

`flush()` converts all local inserts/updates/deletes into committed node group mutations, writes shadow pages for the modified groups, and stamps each written row with `commitID`.

## LocalHashIndex

Each modified hash index also has a local counterpart:

```cpp
class LocalHashIndex {
    // Pending inserts: key → transient offset
    unordered_map<string_t, offset_t> insertions;
    // Pending deletes: keys removed but not yet visible to others
    unordered_set<string_t> deletions;
};
```

Lookup order for reads:
1. Check `LocalHashIndex.deletions` — if key deleted locally, return not-found
2. Check `LocalHashIndex.insertions` — if key inserted locally, return transient offset
3. Fall through to committed `HashIndex`

## Related Files

- `src/storage/local_storage/local_node_table.cpp` — insert, update, delete, flush
- `src/storage/local_storage/local_rel_table.cpp` — rel local storage
- `src/include/storage/local_storage/local_hash_index.h` — local hash index
- `src/storage/table/node_table.cpp` — merges committed + local on scan
- `src/include/transaction/transaction.h` — Transaction.localStorage
