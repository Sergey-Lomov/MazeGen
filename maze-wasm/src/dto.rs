use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use crate::generation_config::TessellationConfig;

#[derive(Serialize)]
pub struct NodeDto {
    pub id: u32,
    pub x: i32,
    pub y: i32,
}

#[derive(Serialize)]
pub struct EdgeDto {
    pub from: u32,
    pub to: u32,
}

#[derive(Serialize)]
pub struct NavNodeDto {
    pub node_id: u32,
}

#[derive(Serialize)]
pub struct NavEdgeDto {
    pub from: u32,
    pub to: u32,
    /// Maze NodeIds along this corridor, inclusive of both endpoints.
    pub path: Vec<u32>,
}

#[derive(Serialize)]
pub struct IssueDto {
    pub kind: String,
    /// Present only for `invalid_loop` issues, keyed by source check id — each inner Vec is one
    /// invalid cycle flagged by that check, expressed as base-graph [from, to] maze node-id pairs
    /// for highlight rendering. Keyed per check (not one flat list) so that when one merged issue
    /// renders as several bubbles (one per `source_checks` entry — see `quality_control.md`'s
    /// "Dedup interaction"), hovering a bubble highlights only the cycles *that check* flagged,
    /// not every contributing check's cycles combined (e.g. `min_loop_length`'s short loops must
    /// not highlight when hovering the `max_loop_length` bubble).
    pub invalid_loop_edges: HashMap<String, Vec<Vec<[u32; 2]>>>,
    /// Present only for `region_needs_expansion` issues, keyed by source check id — each inner
    /// Vec is one flagged SCC region's member maze node ids (not edges — the web side derives the
    /// region's perimeter client-side from this node set, the same way it already derives preset
    /// boundary walls from a cell set). Keyed per check for the same reason as
    /// `invalid_loop_edges` — `min_region_size` and `min_region_ratio` can both flag regions and
    /// merge into one issue, but hovering one bubble must highlight only that check's regions.
    pub region_needs_expansion_nodes: HashMap<String, Vec<Vec<u32>>>,
    /// Check id(s) that produced or contributed to this issue (`Issue::source_checks()`) —
    /// lets the web UI render one bubble per contributing check rather than one per `kind`,
    /// distinguishing e.g. `min_loop_length`'s and `max_loop_length`'s issues even though both
    /// share the `invalid_loop` kind.
    pub source_checks: Vec<String>,
    /// Raw display values keyed by source check id then by detail key (`Issue::details()`),
    /// e.g. `{"max_loop_length": {"max_loop_length": "100"}}`. Values are never assembled
    /// messages — the web UI looks them up by key via its own i18n templates per check id.
    pub details: HashMap<String, HashMap<String, String>>,
}

#[derive(Serialize)]
pub struct GenerationStepDto {
    pub edges:        Vec<EdgeDto>,
    pub active_nodes: Vec<u32>,
    pub current_src:  u32,
}


#[derive(Serialize)]
pub struct JunctionBucket {
    pub degree: usize,
    pub count: usize,
}

#[derive(Serialize)]
pub struct NodeStatsDto {
    pub dead_ends: usize,
    pub straight: usize,
    pub turns: usize,
    pub junctions: Vec<JunctionBucket>,
}

#[derive(Serialize)]
pub struct SpatialEdgeStatsDto {
    pub bidirectional: usize,
    pub one_way: usize,
    pub walls: usize,
}

#[derive(Serialize)]
pub struct RouteInfoDto {
    pub path_length: usize,
    pub junction_count: usize,
    pub one_way_count: usize,
    pub score: Option<f64>,
    pub path: Vec<u32>,
}

#[derive(Serialize)]
pub struct GraphAnalyticsDto {
    pub node_count: usize,
    pub edge_count: usize,
    /// Number of base-graph SCCs (matches `node_component`'s id range — for RegionsRenderer).
    pub component_count: usize,
    /// Number of independent cycles (E - V + C on the pure-cycle core).
    pub cycle_count: usize,
    /// Number of connected cyclic regions (WCC on the pure-cycle core).
    pub cycle_region_count: usize,
    /// maze node id (as string — `json_compatible()` serialization requires string map keys)
    /// → component_id. Covers junction nodes and corridor nodes.
    pub node_component: HashMap<String, usize>,
    /// maze node ids in the pure-cycle core (real cycles only, no bridges).
    pub pure_cycle_node_ids: Vec<u32>,
    /// nav-edge pairs [from_maze_id, to_maze_id] in the pure-cycle core.
    pub pure_cycle_edge_pairs: Vec<[u32; 2]>,
    /// True if cycle enumeration aborted because the graph has too many simple cycles to
    /// analyze (see `GraphAnalytics::cycle_analysis_overflowed`) — when `true`, `cycle_count`,
    /// `cycle_region_count`, `pure_cycle_node_ids`, and `pure_cycle_edge_pairs` are all
    /// empty/zero placeholders, not real results.
    pub cycle_analysis_overflowed: bool,
}

#[derive(Deserialize)]
pub struct PostEditEdgeDto {
    pub from: u32,
    pub to: u32,
    /// "basic" | "one_way" — direction already normalized: from→to is the actual passage direction.
    pub kind: String,
}

#[derive(Deserialize)]
pub struct ComputeAnalyticsConfig {
    pub tessellation: TessellationConfig,
    /// Node coordinates — included for API clarity; field is reconstructed from tessellation.points.
    #[allow(dead_code)]
    pub nodes: Vec<[i32; 2]>,
    /// Actual edges (passages only — walls are absence of edge).
    pub edges: Vec<PostEditEdgeDto>,
    pub start: Option<u32>,
    pub finish: Option<u32>,
    #[serde(default)]
    pub checks: Vec<String>,
    #[serde(default)]
    pub check_params: HashMap<String, HashMap<String, String>>,
}

#[derive(Serialize)]
pub struct MazeSnapshot {
    pub nodes: Vec<NodeDto>,
    pub edges: Vec<EdgeDto>,
    pub start: Option<u32>,
    pub finish: Option<u32>,
    pub issues: Vec<IssueDto>,
    pub nav_nodes: Vec<NavNodeDto>,
    pub nav_edges: Vec<NavEdgeDto>,
    pub node_stats: NodeStatsDto,
    pub edge_stats: SpatialEdgeStatsDto,
    pub route_info: Option<RouteInfoDto>,
    pub graph_analytics: GraphAnalyticsDto,
    pub debug_steps: Vec<GenerationStepDto>,
}
