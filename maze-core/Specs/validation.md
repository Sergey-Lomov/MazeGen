# Validation

## Purpose

Verify correctness of a Maze after generation or rule application.

## Current Checks

### is_connected

```rust
pub fn is_connected(graph: &Graph, start: NodeId) -> bool
```

BFS from `start` over the union of outgoing and incoming edges. Counts visited nodes, compares to `graph.node_count()`. Returns `true` if all nodes are reachable. Empty graph returns `true`.

Union traversal (outgoing + incoming) makes this correct for both fully bidirectional mazes and graphs with one-way edges — connectivity is checked in the undirected sense.

## Future Checks

- Reachability with rule semantics (keys before doors, one-way constraints)
- Structural sanity (no orphaned nodes, valid EdgeKind combinations)
- Custom rule validators plugged in by rules module
