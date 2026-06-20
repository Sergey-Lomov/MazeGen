# Navigation Graph

A derived read-only structure built from the maze graph. Compresses linear passages into single edges, exposing only junction nodes. Used for pathfinding, analytics, and visualization.

## Location

`maze_core::graph::nav`

## Core Concepts

### Passage Node

A maze node is a **passage node** if and only if:
- It has exactly 2 outgoing edges and exactly 2 incoming edges.
- The sets of outgoing neighbors and incoming neighbors are identical (two symmetric bidirectional pairs).
- It is not in the **pinned** set (see `build_nav_graph_pinned`).

All other nodes are **junction nodes** and become `NavNode` entries.

> **Note on terminology:** "Corridor" in generation settings (`corridor_chance`, `corridor_length`) refers to multi-node passages generated as a unit — a different concept. The nav graph uses "passage node" for the topological property (exactly 2 symmetric bidirectional neighbors), independent of how the maze was generated. The geometric stat "Straight" in `GeometricNodeStats` is a related but distinct concept: a node with 2 outgoing neighbors where the path is geometrically straight (per `field.is_straight`).

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
- Intermediate entries are the passage nodes absorbed into this edge.
- For a bidirectional passage `A⇄X⇄B`, two edges are produced: `A→B` with path `[A, X, B]` and `B→A` with path `[B, X, A]`.

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

## NavGraph internal indices

`NavGraph` maintains two lookup maps built during construction:

- `node_index: HashMap<NodeId, NavNodeId>` — maps junction maze nodes to their nav node ID.
- `corridor_index: HashMap<NodeId, NavNodeId>` — maps interior passage maze nodes to the `NavNodeId` of the edge's destination nav node.

Both support O(1) lookup. `nav_node_for` queries `node_index`; routing code queries `corridor_index` for corridor nodes that are not themselves nav nodes.

## Builder

```rust
pub fn build_nav_graph(graph: &Graph) -> NavGraph
pub fn build_nav_graph_pinned(graph: &Graph, pinned: &HashSet<NodeId>) -> NavGraph
```

`build_nav_graph` delegates to `build_nav_graph_pinned` with an empty pinned set.

`build_nav_graph_pinned` accepts a set of **pinned** maze nodes that must become `NavNode` entries regardless of their passage status. This is used to force route endpoints to be nav nodes so that pathfinding can start and end exactly at those nodes rather than at some arbitrary nav node within the same passage.

### Algorithm: DFS with passage compression

1. Collect all maze nodes into a `remaining` pool.
2. While `remaining` is non-empty:
   a. Pick `seed = remaining.iter().min()`. If seed is a junction, use it directly. Otherwise walk forward along the passage chain using `advance_chain` (always picks the minimum-id outgoing neighbor that is not the previous node, to avoid back-tracking). Track visited nodes in a `visited` set; if the walk returns to `seed`, the component is a pure ring; if it reaches a node already in `visited` (but not `seed`), that node is the ring anchor. If the walk reaches a junction, use that junction as the component start.
   b. **Junction component**: DFS from the junction. For each outgoing edge:
      - If the neighbor is a passage node: walk the passage until the next junction, consuming all intermediate nodes from `remaining`. Emit one `NavEdge`.
      - If the neighbor is a junction: emit a direct `NavEdge` with `path = [from, to]`.
   c. **Ring component**: pick the anchor node as the single `NavNode`. Walk both outgoing directions from the anchor using `advance_chain` until the path closes back to the anchor, emitting two self-edges. Remove all visited nodes (including the anchor and any `ring_start` discovered during seed walk) from `remaining`.
3. Determinism is guaranteed by always selecting `remaining.iter().min()` as the component seed, and by always following the minimum-id neighbor via `advance_chain` at each step.

### Corner case: pure ring

A set of nodes forming a ring with no junctions (e.g. `A⇄B⇄C⇄A`) produces:
- One `NavNode` (the anchor, chosen by min id).
- Two self-edges, one per direction, with paths that start and end at the anchor.

### Corner case: ring with pinned nodes

If a pure ring component contains a pinned node, the pinned node is promoted to the ring anchor nav node (instead of the min-id passage node). The self-edges then start and end at the pinned node.

## Isolation

- `build_nav_graph` does not modify the input `Graph`.
- The result is fully owned and does not borrow from the graph.
- Isolated components (nodes unreachable from each other) are each processed independently.

## Caching

`NavGraph` is stored lazily in `MazeAnalysis`. See `analysis.md`.
