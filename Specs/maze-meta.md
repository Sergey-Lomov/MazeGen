# MazeMeta

Semantic annotations attached to a maze after generation. Stores identities of special nodes that are not part of the graph structure itself.

## Structure

```rust
pub struct MazeMeta {
    pub start: Option<NodeId>,
    pub finish: Option<NodeId>,
}
```

Both fields are `Option` — a meta value is absent until explicitly assigned by a repair strategy.

## Invariants

- `start` and `finish` are expected to differ when both are `Some`. This is not enforced by the type; it is the responsibility of the strategies that assign them.
- `MazeMeta` does not own or reference graph nodes. It holds `NodeId` values only. Validity (i.e. the node actually exists in the graph) is not checked by `MazeMeta` itself; repair keeps it valid — removing or replacing a start/finish node moves the endpoint onto the point's surviving node (see `repair.md`, "Node removal is graph+field atomic").

## Construction

```rust
MazeMeta::empty()  // both fields None
```

## Lifecycle

`MazeMeta` is created empty inside `Maze::new`, then populated by repair strategies during the pipeline run:

```
generate_maze(graph, field, seed, start_node)
build_maze(field, graph, seed, qc_engine, repair_engine, preset_state, limits)
  → Maze::new(field, graph)          // MazeMeta::empty() inside
  → QC + Repair loop
  → meta fields assigned by strategies
```

## Future Extension

New semantic annotations (regions, checkpoints, difficulty zones) are added as explicit fields, not as generic storage. Each new field follows the same `Option<T>` pattern.
