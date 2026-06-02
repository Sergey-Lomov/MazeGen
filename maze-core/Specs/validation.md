# Validation

## Purpose

Verify correctness of a Maze after generation or rule application.

## Current Checks

### is_connected

BFS from `start` node through `maze.graph.neighbors()`. Counts visited nodes, compares to `maze.graph.node_count()`.

```rust
pub fn is_connected<F: Field>(maze: &Maze<F>, start: NodeId) -> bool
```

Returns `true` if all nodes are reachable from `start`. Empty graph returns `true`.

## Future Checks

- Reachability with rule semantics (keys before doors, one-way constraints)
- Structural sanity (no orphaned nodes, valid EdgeKind combinations)
- Custom rule validators plugged in by rules module
