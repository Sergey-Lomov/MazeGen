# Routing

Shortest-path computation between two maze nodes (start and finish) over the navigation graph.

## Location

`maze_core::graph::routing` — `compute_route_info`

## Input

```rust
pub fn compute_route_info<T: Tessellation>(nav: &NavGraph, field: &Field<T>, start: NodeId, finish: NodeId) -> Option<RouteInfo>
```

- `nav` must be built with `build_nav_graph_pinned` where both `start` and `finish` are in the pinned set. This guarantees they are nav nodes and that pathfinding begins and ends exactly at those maze nodes.
- `field` is the same tessellated field the maze/nav graph was built from — used only to look up which points are split tiles (`field.nodes_at(point).len() >= 2`) for `split_count`.
- Returns `None` if no path exists (disconnected graph).

## Output

```rust
pub struct RouteInfo {
    pub path_length: usize,    // number of maze nodes including start and finish
    pub junction_count: usize, // nav nodes with >= 3 distinct outgoing nav neighbors on the path
    pub one_way_count: usize,  // nav edges without a reverse nav edge on the path
    pub split_count: usize,    // occurrences of a split tile's node among path nodes (see below)
    pub teleport_count: usize, // Teleport-kind nav edges on the path
    pub vertical_bidirectional_count: usize, // VerticalPassage-kind nav edges on the path with a reverse edge
    pub vertical_one_way_count: usize,       // VerticalPassage-kind nav edges on the path without a reverse edge
    pub elevator_count: usize, // Elevator-kind nav edges on the path
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

### split_count

Count of path nodes (by position, not deduplicated by field point) that sit on a split tile — a field point with two or more nodes (GitHub issue #261). Each occurrence on the path adds to the count independently: a route that passes through two distinct nodes of the same split point (entering via one, exiting via the other) counts 2, even though no single `NodeId` is ever revisited (Dijkstra shortest paths never repeat a node).

### teleport_count / vertical_bidirectional_count / vertical_one_way_count / elevator_count

Per-kind counts of nav edges on the path (GitHub issue #531), each derived from the corresponding `NavEdge` flag (`Specs/nav-graph.md`):

- `teleport_count`: number of path edges with `is_teleport` set.
- `vertical_bidirectional_count` / `vertical_one_way_count`: path edges with `is_vertical` set, split by whether the edge has a `reverse_edge` (bidirectional passage) or not (one-way passage). The two counts are disjoint and together cover every `VerticalPassage`-kind hop on the path.
- `elevator_count`: number of path edges with `is_elevator` set.

All four are `0` in the same-nav-node special case below, since that case never walks any nav edges.

### path

Full ordered list of maze `NodeId`s from `start` to `finish`. Built by concatenating the `NavEdge.path` segments; shared junction nodes at segment boundaries are deduplicated (the first node of each subsequent segment is skipped).

### Special case: same nav node

Under the required precondition (both `start` and `finish` pinned), `start_nav == finish_nav` can only occur when `start == finish` (same maze node used as both endpoints). The two-node case `path = [start, finish]` exists as a guard but is not reachable in practice.

- `path_length` = 1 if `start == finish`, else 2.
- `path` = `[start]` if `start == finish`, else `[start, finish]`.
- `junction_count` = 0, `one_way_count` = 0, `teleport_count` = 0, `vertical_bidirectional_count` = 0, `vertical_one_way_count` = 0, `elevator_count` = 0.
- `split_count` = 1 if the single node sits on a split tile, else 0 (0 if `start == finish` and `path = [start]`; each of the two path nodes checked independently when `start != finish`).

## Algorithm

Dijkstra over the nav graph. Edge weight = `NavEdge.path.len() - 1` (number of maze nodes traversed, not counting the source endpoint). This finds the path with the minimum number of maze nodes.

Adjacency list (`NavNodeId → outgoing edges`) is built once before the search from the flat edge list, giving O((V + E) log V) overall complexity.

Path reconstruction walks `prev_edge` from finish back to start. A safety guard terminates reconstruction if the step count exceeds the number of nav nodes (which cannot happen in a correct Dijkstra tree but guards against future bugs).

## Nullability

`compute_route_info` returns `None` when:
- `start` or `finish` cannot be resolved to a nav node (should not happen when using `build_nav_graph_pinned` with those nodes pinned).
- No path exists between start and finish in the nav graph (disconnected graph).

In WASM: `route_info` in the snapshot is `None` when `maze.meta.start` or `maze.meta.finish` is absent.
