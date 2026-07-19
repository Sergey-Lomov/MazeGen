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
- It is not an endpoint (`from` or `to`) of any `EdgeKind::Teleport` edge.

All other nodes are **junction nodes** and become `NavNode` entries.

**Teleport endpoints are never passage nodes**, unconditionally — even if the node's degree happens to satisfy the 2-symmetric-pairs shape above (e.g. exactly one `Basic` pair plus one `Teleport` edge can still total 2 outgoing/2 incoming with identical neighbor sets). See GitHub issue #74: `distance_from_start`/`distance_from_finish` (`analysis.md`) are keyed on `NavNodeId`, and teleport-specific QC checks (`TeleportWaypointDistanceCheck`) need `NavGraph::nav_node_for` to resolve a `NavNodeId` for every teleport endpoint to look up its distance-to-waypoint. Silently compressing a teleport endpoint into some other nav-edge's `path` would make `nav_node_for` return `None` for it, making such a check wrongly treat the endpoint as unreachable instead of measuring its real distance. This exemption is unconditional — nav-graph structure must not depend on which QC checks happen to be configured — same rationale as the `pinned` exemption above.

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
    /// Index of the reverse edge (same corridor, opposite direction), if it exists.
    pub reverse_edge: Option<usize>,
    /// True if this is a single-hop (`path.len() == 2`) edge backed by a `Teleport`-kind graph
    /// edge between `path[0]` and `path[1]`.
    pub is_teleport: bool,
}
```

- `path[0]` is the maze node of the source `NavNode`.
- `path[last]` is the maze node of the target `NavNode`.
- Intermediate entries are the passage nodes absorbed into this edge.
- For a bidirectional passage `A⇄X⇄B`, two edges are produced: `A→B` with path `[A, X, B]` and `B→A` with path `[B, X, A]`.
- `reverse_edge` is populated post-construction by `link_reverse_edges`, keyed on `(path, is_teleport)` — see "Reverse edge linking" below.
- `is_teleport` (GitHub issue #197): only a single-hop edge can be teleport-backed — passage nodes are never teleport endpoints (see above), so a multi-hop `path` is always `Basic` hops end to end. A `Basic` edge may coexist in the same direction between the same pair as a `Teleport` edge (`Graph::add_edge`'s kind-aware dedup); construction then builds two distinct one-hop `NavEdge`s sharing the same `path`, disambiguated by this flag. Set at construction time from the specific graph `EdgeId` being processed — not re-derived via `Graph::edge_between_kind(path[0], path[1], ..)` afterward, which would be ambiguous between the two coexisting kinds.

### Reverse edge linking

After construction, `link_reverse_edges` scans all edges and links each to its reverse (same corridor, opposite direction) via `reverse_edge`, where a reverse exists. Two edges are reverses of each other when one's `path` is the exact reverse of the other's **and** both have the same `is_teleport` value — keying on `path` alone would risk linking a `Basic` edge's `reverse_edge` to an unrelated `Teleport` edge (or vice versa) when both a `Basic` and a `Teleport` one-hop edge exist in each direction between the same node pair.

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

`MazeAnalysis::nav_graph` (see `analysis.md`) always calls this with `meta.start`/`meta.finish` (whichever are set) as the pinned set — this is the project-wide policy, not a per-caller choice. `MazeAnalysis::route_info` separately pins its own `(start, finish)` pair, independent of `meta`.

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

`NavGraph` is stored lazily in `MazeAnalysis`. See `analysis.md` for the caching contract and its current limitation (no invalidation on graph mutation — issue #20).
