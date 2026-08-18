use std::collections::HashMap;
use serde::Serialize;
use maze_core_macros::Dto;

#[derive(Serialize)]
pub struct JunctionBucket {
    pub degree: usize,
    pub count: usize,
}

/// Cell (maze-node) geometric shape breakdown — GitHub issue #364: `teleport_entries` moved out
/// to `ElementsStatsDto` (it's a cross-cutting "element" concept, not a cell shape), so this
/// struct's own fields always partition `FloorScoped<NodeStatsDto>`'s node count exactly.
#[derive(Serialize)]
pub struct NodeStatsDto {
    pub dead_ends: usize,
    pub straight: usize,
    pub turns: usize,
    pub junctions: Vec<JunctionBucket>,
}

/// Spatial adjacency-pair breakdown (walls vs. passages) — GitHub issue #364:
/// `one_way_passages` moved out to `ElementsStatsDto` alongside the other directional/special
/// edge kinds, so this struct only distinguishes "connected" from "not connected".
#[derive(Serialize)]
pub struct SpatialEdgeStatsDto {
    pub bidirectional: usize,
    pub walls: usize,
    /// Total adjacent tile-pair count — `bidirectional + walls`, computed directly from the
    /// adjacency count rather than summed here, so a future edge category doesn't need this
    /// field's producer updated to stay correct.
    pub total_pairs: usize,
}

/// Mirrors `maze_core::generation::SplitFaceRequirement` — one node's per-face-position
/// requirement, as reconstructed from the built graph (see `SplitGroupDto`'s doc comment).
#[derive(Serialize, Dto)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[dto(rename_ts = "SplitFaceRequirement")]
pub enum SplitFaceRequirementDto {
    Passage,
    OneWay { direction: OneWayDirectionDto },
    Wall,
    Unspecified,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OneWayDirectionDto {
    Forward,
    Backward,
}

/// One group of maze-wide split tiles sharing the same canonical topology
/// (`maze_core::graph::split_topology::canonical_split_topology`) — the same pattern applied at
/// any rotation/mirror, with node creation order ignored. `topology[i]` is one node's
/// per-face-position requirement list (length = tessellation degree); the outer list is sorted
/// (order-independent — see `SplitTopology`'s doc comment), so it also serves as a stable
/// dedup/lookup key on the web side (e.g. for a title registry keyed by serialized topology).
#[derive(Serialize)]
pub struct SplitGroupDto {
    pub topology: Vec<Vec<SplitFaceRequirementDto>>,
    pub count: usize,
}

/// GitHub issue #364: every count that isn't a plain cell-shape or wall/passage fact — one-way
/// passages, teleports, and split tiles/nodes/groups — grouped so the "Elements" report section
/// doesn't need to reassemble them from three different DTOs.
#[derive(Serialize)]
pub struct ElementsStatsDto {
    pub one_way_passages: usize,
    pub two_way_teleports: usize,
    pub one_way_teleports: usize,
    /// Number of field points with 2+ nodes.
    pub split_tile_count: usize,
    /// Sum, over every split point, of its full node count (including the original node).
    pub split_node_count: usize,
    /// Every distinct canonical topology found on the field, with how many tiles share it.
    pub split_groups: Vec<SplitGroupDto>,
}

/// Maze-wide-only `VerticalPassage`/`Elevator`/cross-floor-`Teleport` statistics (GitHub issue
/// #346) — like `GraphStatsDto`, never broken down `by_floor`: every one of these edge kinds spans
/// 2+ floors by construction, so there's no meaningful single-floor attribution.
#[derive(Serialize)]
pub struct VerticalStatsDto {
    pub bidirectional_passages: usize,
    pub one_way_passages_up: usize,
    pub one_way_passages_down: usize,
    /// Count of distinct `Elevator` groups — a connected component of `Elevator` edges (see
    /// `maze_core::graph::Graph::elevator_groups`), never grouped by shared x-y point: two
    /// elevators can occupy the same point without being connected (e.g. one spanning floors 1-3,
    /// a separate one spanning floors 4-6) and count as two groups.
    pub elevator_groups: usize,
    pub cross_floor_teleports: usize,
}

/// Maze-wide-only graph statistics (GitHub issue #364) — unlike `MazeStatisticsDto`'s other
/// blocks, this one is never broken down `by_floor`: SCC components and cycles can span multiple
/// floors (via teleport/vertical passage/elevator edges), so a per-floor version would either
/// double-count a spanning component/cycle on every floor it touches or need its own arbitrary
/// exclusion rule — neither was worth the complexity, see the issue's discussion.
#[derive(Serialize, Dto)]
pub struct GraphStatsDto {
    /// Number of floors (`MultiLevelField::level_count()`) — always `1` for a single-floor maze.
    pub floor_count: usize,
    pub node_count: usize,
    pub edge_count: usize,
    /// Number of base-graph SCCs (matches `node_component`'s id range — for RegionsRenderer).
    pub component_count: usize,
    /// Average out-degree over the real graph (not the nav-graph) — `2*E/V` treated as
    /// undirected, `0` for an empty graph.
    pub average_degree: f64,
    /// Number of independent cycles (E - V + C on the pure-cycle core).
    pub cycle_count: usize,
    /// Number of connected cyclic regions (WCC on the pure-cycle core).
    pub cycle_region_count: usize,
    /// Raw count of all simple cycles (composite-inclusive, GitHub issue #284) — see
    /// `GraphAnalytics::simple_cycle_count`. Always `>= cycle_count`.
    pub simple_cycle_count: usize,
    /// maze node id (as string — `json_compatible()` serialization requires string map keys)
    /// → component_id. Covers junction nodes and corridor nodes.
    pub node_component: HashMap<String, usize>,
    /// maze node ids in the pure-cycle core (real cycles only, no bridges).
    pub pure_cycle_node_ids: Vec<u32>,
    /// nav-edge pairs [from_maze_id, to_maze_id] in the pure-cycle core.
    pub pure_cycle_edge_pairs: Vec<[u32; 2]>,
    /// True if cycle enumeration aborted because the graph has too many simple cycles to
    /// analyze (see `GraphAnalytics::cycle_analysis_overflowed`) — when `true`, `cycle_count`,
    /// `cycle_region_count`, `simple_cycle_count`, `pure_cycle_node_ids`, and
    /// `pure_cycle_edge_pairs` are all empty/zero placeholders, not real results.
    pub cycle_analysis_overflowed: bool,
    /// SCC region class relative to `start`/`finish` — "path" | "alternative" | "unreachable" |
    /// "trap" — keyed by `component_id` (as string, same `json_compatible()` requirement as
    /// `node_component`). Empty when `start` or `finish` is unset (region classes are
    /// unavailable without both).
    #[dto(ts_type = "Record<string, RegionClass>")]
    pub region_classes: HashMap<String, String>,
}

/// One statistic computed both maze-wide (`total`) and per-floor (`by_floor`, keyed by 0-based
/// floor index — GitHub issue #364). `total` is an independent maze-wide computation, not the sum
/// of `by_floor`'s entries: a maze-wide teleport pair with ends on different floors, for example,
/// counts toward `total` but toward neither floor's own `by_floor` entry (see
/// `maze_core::graph::stats::compute_teleport_edge_stats_scoped`'s doc comment). `by_floor` always
/// has one entry per floor, even for a single-floor maze.
#[derive(Serialize, Dto)]
pub struct FloorScoped<T> {
    pub total: T,
    #[dto(ts_type = "Record<number, T>")]
    pub by_floor: HashMap<String, T>,
}

/// Every maze statistic surfaced in the Analytics panel (GitHub issue #364), replacing the
/// previously flat `node_stats`/`edge_stats`/`teleport_edge_stats`/`graph_analytics`/
/// `split_analytics` fields on `MazeSnapshot`. `graph_stats` is the only maze-wide-only member —
/// see its own doc comment for why it isn't `FloorScoped`.
#[derive(Serialize)]
pub struct MazeStatisticsDto {
    pub graph_stats: GraphStatsDto,
    /// Real geometric cell count per floor — `Field::all_points()` count, deduped by point (a
    /// split point counts once, not once per its extra node) — unlike `cell_stats`' node-shape
    /// breakdown, this is derived straight from field shape, not reconstructed by summing
    /// `cell_stats`' own counts (which would count a split point's every extra node separately).
    pub cell_count: FloorScoped<usize>,
    pub cell_stats: FloorScoped<NodeStatsDto>,
    pub passage_stats: FloorScoped<SpatialEdgeStatsDto>,
    pub elements_stats: FloorScoped<ElementsStatsDto>,
    pub vertical_stats: VerticalStatsDto,
}
