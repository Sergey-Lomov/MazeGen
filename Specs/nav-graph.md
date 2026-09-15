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
- It is not an endpoint (`from` or `to`) of any `EdgeKind::Elevator` edge.
- It is not an endpoint (`from` or `to`) of any `EdgeKind::VerticalPassage` edge.

All other nodes are **junction nodes** and become `NavNode` entries. The three edge-kind exemptions above are computed once per `build_nav_graph_pinned` call as a single combined lookup set (`non_corridor_endpoints`, `nav/build.rs`), not three separate sets — a per-node `HashSet::contains` check against one combined set rather than three, avoiding both a per-call O(E) rescan and three separate parameters threaded through every corridor-walking function.

**Teleport endpoints are never passage nodes**, unconditionally — even if the node's degree happens to satisfy the 2-symmetric-pairs shape above (e.g. exactly one `Basic` pair plus one `Teleport` edge can still total 2 outgoing/2 incoming with identical neighbor sets). See GitHub issue #74: `distance_from_start`/`distance_from_finish` (`analysis.md`) are keyed on `NavNodeId`, and teleport-specific QC checks (`TeleportWaypointDistanceCheck`) need `NavGraph::nav_node_for` to resolve a `NavNodeId` for every teleport endpoint to look up its distance-to-waypoint. Silently compressing a teleport endpoint into some other nav-edge's `path` would make `nav_node_for` return `None` for it, making such a check wrongly treat the endpoint as unreachable instead of measuring its real distance. This exemption is unconditional — nav-graph structure must not depend on which QC checks happen to be configured — same rationale as the `pinned` exemption above.

**Elevator endpoints are never passage nodes**, for a structural reason rather than a QC-consumer one (GitHub issue #372): an `Elevator` connects its floors as a fully-connected fan (`Specs/generation.md`'s "Vertical Connections"), so a 3-floor elevator's floor node ends up with exactly 2 outgoing/2 incoming symmetric neighbors (the other two floors) — coincidentally satisfying the passage-node degree shape. Without this exemption such a node would be silently compressed into a corridor's interior path, hiding the fan structure from `NavGraph` entirely and defeating `cycle_core`'s elevator-fan cycle filter (see `graph-analytics.md`), which needs a real `NavNodeId` per floor endpoint to detect a cycle made purely of elevator hops. Unconditional, same as the `pinned`/teleport exemptions.

**VerticalPassage endpoints are never passage nodes**, same rationale and same unconditional scope as the teleport/elevator exemptions above (GitHub issue #517): a `VerticalPassage` endpoint can coincidentally satisfy the 2-symmetric-pairs degree shape (e.g. two bidirectional vertical passages to two other-floor nodes). Without this exemption such a node got silently compressed into some other nav-edge's interior `path`, so `nav_node_for` returned `None` for it — any caller keying off the endpoint's own `NavNodeId` (routing, QC distance checks, the web renderers' cross-floor badge/marker placement) resolved a neighboring corridor node instead, rendering the passage's marker/badge on the wrong cell.

Like `NavEdge.is_teleport`/`is_elevator` below, a single-hop `NavEdge` backed by a `VerticalPassage` graph edge carries its own `is_vertical` flag (GitHub issue #531), set the same way and for the same reason: `VerticalPassage` endpoints are never passage nodes (see above), so a `VerticalPassage` hop is always single-hop.

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
    /// True if this is a single-hop (`path.len() == 2`) edge backed by an `Elevator`-kind graph
    /// edge between `path[0]` and `path[1]`.
    pub is_elevator: bool,
    /// True if this is a single-hop (`path.len() == 2`) edge backed by a `VerticalPassage`-kind
    /// graph edge between `path[0]` and `path[1]`.
    pub is_vertical: bool,
}
```

- `path[0]` is the maze node of the source `NavNode`.
- `path[last]` is the maze node of the target `NavNode`.
- Intermediate entries are the passage nodes absorbed into this edge.
- For a bidirectional passage `A⇄X⇄B`, two edges are produced: `A→B` with path `[A, X, B]` and `B→A` with path `[B, X, A]`.
- `reverse_edge` is populated post-construction by `link_reverse_edges`, keyed on `(path, is_teleport, is_elevator, is_vertical)` — see "Reverse edge linking" below.
- `is_teleport` (GitHub issue #197): only a single-hop edge can be teleport-backed — passage nodes are never teleport endpoints (see above), so a multi-hop `path` is always `Basic` hops end to end. A `Basic` edge may coexist in the same direction between the same pair as a `Teleport` edge (`Graph::add_edge`'s kind-aware dedup); construction then builds two distinct one-hop `NavEdge`s sharing the same `path`, disambiguated by this flag. Set at construction time from the specific graph `EdgeId` being processed — not re-derived via `Graph::edge_between_kind(path[0], path[1], ..)` afterward, which would be ambiguous between the two coexisting kinds.
- `is_elevator` (GitHub issue #372): same rationale as `is_teleport`, for `EdgeKind::Elevator` instead — only a single-hop edge can be elevator-backed, since elevator endpoints are never passage nodes (see above).
- `is_vertical` (GitHub issue #531): same rationale as `is_teleport`/`is_elevator`, for `EdgeKind::VerticalPassage` instead — only a single-hop edge can be vertical-passage-backed, since vertical-passage endpoints are never passage nodes (see above). Used by `routing::compute_route_info` to report `vertical_bidirectional_count`/`vertical_one_way_count` on the route (`Specs/routing.md`).

### Reverse edge linking

After construction, `link_reverse_edges` scans all edges and links each to its reverse (same corridor, opposite direction) via `reverse_edge`, where a reverse exists. Two edges are reverses of each other when one's `path` is the exact reverse of the other's **and** both have the same `is_teleport`, `is_elevator`, and `is_vertical` values — keying on `path` alone would risk linking a `Basic` edge's `reverse_edge` to an unrelated `Teleport`/`Elevator`/`VerticalPassage` edge (or vice versa) when more than one kind of one-hop edge exists in each direction between the same node pair.

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

`NavGraph` maintains three lookup maps built during construction:

- `node_index: HashMap<NodeId, NavNodeId>` — maps junction maze nodes to their nav node ID.
- `corridor_index: HashMap<NodeId, NavNodeId>` — maps interior passage maze nodes to the `NavNodeId` of the edge's destination nav node.
- `corridor_positions: HashMap<NodeId, Vec<(edge_idx: usize, index_within_path: usize)>>` — every `(edge, position)` pair an interior maze node appears as part of. A corridor node can be interior to up to two edges (a corridor edge and its separately-built reverse, see "Reverse edge linking" below), so this is a `Vec`, not a single pair — `corridor_index`'s `entry().or_insert()` only ever keeps the first-built edge's destination, silently dropping the other when both exist.

All three support O(1) lookup. `nav_node_for` queries `node_index`; routing code queries `corridor_index` for corridor nodes that are not themselves nav nodes (an approximation — see below); exact tile-hop distance queries `corridor_positions` via the accessors below.

### Exact intra-corridor offset (GitHub issue #249)

`corridor_index` alone only ever gives the destination nav-node of *whichever* edge happened to be built first for a given interior node — it discards the node's actual position within the corridor. This is an acceptable approximation for routing code that just needs *a* reasonable nav-node to start a search from (`routing::resolve_nav_node`, `SplitDistanceFromWaypointCheck`'s waypoint-distance lookup), but wrong for anything that reports the distance value itself, since the discarded tile count can be arbitrarily large.

Three public accessors expose the precise position, all backed by `corridor_positions`:

```rust
impl NavGraph {
    /// Every (nav_node, forward_hops) pair reachable by continuing forward from `node_id` along
    /// a corridor edge it's interior to -- forward_hops is the exact tile-hop count to that
    /// edge's destination. Empty for a junction/nav node itself.
    pub fn corridor_exit_offsets(&self, node_id: NodeId) -> impl Iterator<Item = (NavNodeId, usize)>;

    /// Every (nav_node, forward_hops) pair such that continuing forward from `nav_node` reaches
    /// `node_id` -- forward_hops is the exact tile-hop count from that edge's source.
    pub fn corridor_entry_offsets(&self, node_id: NodeId) -> impl Iterator<Item = (NavNodeId, usize)>;

    /// Raw (edge_idx, index_within_path) pairs `node_id` is interior to -- lets a caller detect
    /// two corridor-interior nodes sharing the very same edge (direct in-path distance) instead
    /// of always routing through each side's nav-node endpoint.
    pub fn corridor_edge_positions(&self, node_id: NodeId) -> impl Iterator<Item = (usize, usize)>;
}
```

Used by `graph::distance_map::exact_tile_distance` (see `graph-analytics.md`'s "Distance Maps" section) to compute the true directed tile-hop distance between any two maze nodes, corridor-interior or not.

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
