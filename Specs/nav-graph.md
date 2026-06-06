# Navigation Graph

A derived read-only structure built from the maze graph. Compresses linear corridors into single edges, exposing only junction nodes. Used for pathfinding, analytics, and visualization.

## Location

`maze_core::graph::nav`

## Core Concepts

### Corridor Node

A maze node is a **corridor node** if and only if:
- It has exactly 2 outgoing edges and exactly 2 incoming edges.
- The sets of outgoing neighbors and incoming neighbors are identical (two symmetric bidirectional pairs).

All other nodes are **junction nodes** and become `NavNode` entries.

### NavNode

```rust
pub struct NavNode {
    pub node_id: NodeId,   // corresponding maze graph node
}
```

### NavEdge

A directed edge representing a compressed corridor between two junction nodes.

```rust
pub struct NavEdge {
    pub from: NavNodeId,
    pub to: NavNodeId,
    /// Maze NodeIds from source to target, inclusive of both endpoints, in traversal order.
    pub path: Vec<NodeId>,
}
```

- `path[0]` is the maze node of the source `NavNode`.
- `path[last]` is the maze node of the target `NavNode`.
- Intermediate entries are the corridor nodes absorbed into this edge.
- For a bidirectional corridor `A⇄X⇄B`, two edges are produced: `A→B` with path `[A, X, B]` and `B→A` with path `[B, X, A]`.

### NavGraph

```rust
pub struct NavGraph {
    pub nodes: Vec<NavNode>,
    // edges field is private; use .edges(), .outgoing_edges(), .incoming_edges()
}
```

Public API:

```rust
impl NavGraph {
    /// Returns the NavNodeId for a given maze NodeId, if it is a junction node.
    pub fn nav_node_for(&self, node_id: NodeId) -> Option<NavNodeId>;

    /// Iterates all edges in the graph.
    pub fn edges(&self) -> impl Iterator<Item = &NavEdge>;

    /// Iterates outgoing edges from `node`. Panics if `node` is not a valid NavNodeId.
    pub fn outgoing_edges(&self, node: NavNodeId) -> impl Iterator<Item = &NavEdge>;

    /// Iterates incoming edges to `node`. Panics if `node` is not a valid NavNodeId.
    pub fn incoming_edges(&self, node: NavNodeId) -> impl Iterator<Item = &NavEdge>;
}
```

## Builder

```rust
pub fn build_nav_graph(graph: &Graph) -> NavGraph
```

### Algorithm: DFS with corridor compression

1. Collect all maze nodes into a `remaining` pool.
2. While `remaining` is non-empty:
   a. Walk from the smallest-id node in `remaining` to find the first junction (non-corridor node). If the walk loops back to the start, the component is a pure ring.
   b. **Junction component**: DFS from the junction. For each outgoing edge:
      - If the neighbor is a corridor node: walk the corridor until the next junction, consuming all intermediate nodes from `remaining`. Emit one `NavEdge`.
      - If the neighbor is a junction: emit a direct `NavEdge` with `path = [from, to]`.
   c. **Ring component**: pick the start node as the single `NavNode`. Walk both outgoing directions until the path closes, emitting two self-edges.
3. Determinism is guaranteed by always selecting `remaining.iter().min()` as the component seed, and by always following the minimum-id neighbor at each step of the corridor and ring walks.

### Corner case: pure ring

A set of nodes forming a ring with no junctions (e.g. `A⇄B⇄C⇄A`) produces:
- One `NavNode` (the anchor, chosen by min id).
- Two self-edges, one per direction, with paths that start and end at the anchor.

## Isolation

- `build_nav_graph` does not modify the input `Graph`.
- The result is fully owned and does not borrow from the graph.
- Isolated components (nodes unreachable from each other) are each processed independently.

## Caching

`NavGraph` is stored lazily in `MazeAnalysis`. See `analysis.md`.
