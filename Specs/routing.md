# Routing

Shortest-path computation between two maze nodes (start and finish) over the navigation graph.

## Location

`maze_core::graph::classify` — `compute_route_info`

## Input

```rust
pub fn compute_route_info(nav: &NavGraph, start: NodeId, finish: NodeId) -> Option<RouteInfo>
```

- `nav` must be built with `build_nav_graph_pinned` where both `start` and `finish` are in the pinned set. This guarantees they are nav nodes and that pathfinding begins and ends exactly at those maze nodes.
- Returns `None` if no path exists (disconnected graph).

## Output

```rust
pub struct RouteInfo {
    pub path_length: usize,    // number of maze nodes including start and finish
    pub junction_count: usize, // nav nodes with >= 3 distinct outgoing nav neighbors on the path
    pub one_way_count: usize,  // nav edges without a reverse nav edge on the path
    pub score: Option<f64>,    // filled externally from ScoredEndpointsStrategy; always None here
    pub path: Vec<NodeId>,     // all maze nodes in order from start to finish
}
```

### path_length

Count of maze nodes traversed inclusive of both endpoints. For a straight 5-node corridor `[A, X1, X2, X3, B]` the path_length is 5.

### junction_count

Number of nav nodes on the path (including start and finish) where the number of **distinct outgoing nav neighbors** is ≥ 3. A nav node that is a dead-end on the route but a junction in the full graph counts only if it has ≥ 3 outgoing edges in the nav graph.

### one_way_count

Number of nav edges on the path for which no reverse nav edge exists (i.e. you can traverse this passage in one direction only).

### path

Full ordered list of maze `NodeId`s from `start` to `finish`. Built by concatenating the `NavEdge.path` segments; shared junction nodes at segment boundaries are deduplicated (the first node of each subsequent segment is skipped).

### Special case: same nav node

Under the required precondition (both `start` and `finish` pinned), `start_nav == finish_nav` can only occur when `start == finish` (same maze node used as both endpoints). The two-node case `path = [start, finish]` exists as a guard but is not reachable in practice.

- `path_length` = 1 if `start == finish`, else 2.
- `path` = `[start]` if `start == finish`, else `[start, finish]`.
- `junction_count` = 0, `one_way_count` = 0.

## Algorithm

Dijkstra over the nav graph. Edge weight = `NavEdge.path.len() - 1` (number of maze nodes traversed, not counting the source endpoint). This finds the path with the minimum number of maze nodes.

Adjacency list (`NavNodeId → outgoing edges`) is built once before the search from the flat edge list, giving O((V + E) log V) overall complexity.

Path reconstruction walks `prev_edge` from finish back to start. A safety guard terminates reconstruction if the step count exceeds the number of nav nodes (which cannot happen in a correct Dijkstra tree but guards against future bugs).

## Nullability

`compute_route_info` returns `None` when:
- `start` or `finish` cannot be resolved to a nav node (should not happen when using `build_nav_graph_pinned` with those nodes pinned).
- No path exists between start and finish in the nav graph (disconnected graph).

In WASM: `route_info` in the snapshot is `None` when `maze.meta.start` or `maze.meta.finish` is absent.
