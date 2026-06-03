# MazeMeta

Semantic annotations attached to a maze after generation. Stores identities of special nodes that are not part of the graph structure itself.

## Structure

```rust
pub struct MazeMeta {
    pub start: Option<NodeId>,
    pub finish: Option<NodeId>,
}
```

Both fields are `Option` — a meta value is absent until explicitly assigned by a rule.

## Invariants

- `start` and `finish` are expected to differ when both are `Some`. This is not enforced by the type; it is the responsibility of the rules that assign them.
- `MazeMeta` does not own or reference graph nodes. It holds `NodeId` values only. Validity (i.e. the node actually exists in the graph) is not checked.

## Construction

```rust
MazeMeta::empty()  // both fields None
```

## Lifecycle

`MazeMeta` is created empty after graph generation, populated by `RuleEngine`, then bundled into `Maze`:

```
generate_maze(graph, field, seed, start_node)
MazeMeta::empty()
RuleEngine::run(graph, meta, rng)
Maze { field, graph, meta }
```

## Future Extension

New semantic annotations (regions, checkpoints, difficulty zones) are added as explicit fields, not as generic storage. Each new field follows the same `Option<T>` pattern.
