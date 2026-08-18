use serde::{Serialize, Deserialize};
use maze_core_macros::Dto;

pub use crate::dto_issues::{
    IssueEdgeGroupPayloadDto, IssueSplitTilePayloadDto, IssueSplitGroupPayloadDto,
    IssueRegionPayloadDto, IssueRouteEdgeDto, IssueRoutePayloadDto, IssuePayloadDto, IssueDto,
};
pub use crate::dto_statistics::{
    JunctionBucket, NodeStatsDto, SpatialEdgeStatsDto, SplitFaceRequirementDto, OneWayDirectionDto,
    SplitGroupDto, ElementsStatsDto, VerticalStatsDto, GraphStatsDto, FloorScoped, MazeStatisticsDto,
};
pub use crate::dto_analytics_config::{
    PostEditEndpointDto, PostEditEdgeDto, VerticalEdgeDto, AnalyticsRuleGroupConfig, ComputeAnalyticsConfig,
};

/// `i` is a node's stable index among its point's nodes (GitHub issue #236) — `0` is always the
/// point's original node (the one that can never be removed by post-edit), `1, 2, ...` are extra
/// split-point slots in the order they were created. Unlike a position in a rebuilt list, `i`
/// never shifts when an earlier-created sibling at the same point is removed — a hole in the `i`
/// sequence is expected and does not get compacted. This is what lets `apply_split_points` address
/// a slot by its real `i` directly instead of reconstructing a mapping from array position, which
/// silently desyncs once a non-last split node is removed.
#[derive(Serialize, Deserialize, Clone, Copy, Dto)]
pub struct NodeDto {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub i: u32,
    /// The node's floor, as a 0-based index into `MultiLevelField::levels_ordered()` (GitHub issue
    /// #337) — matches the web client's `floors` array index, not the internal `LevelId`, which
    /// is never reused/renumbered and thus not stable across floor removal (`Specs/space.md`).
    /// Always `0` for a maze that never had more than one floor.
    #[dto(optional)]
    pub level: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKindDto {
    Basic,
    Teleport,
    VerticalPassage,
    Elevator,
}

/// One directed graph edge. Note: `(from, to)` is not unique in `MazeSnapshot.edges` — a
/// `Basic` and a `Teleport` edge can coexist in the same direction between the same pair (see
/// `maze_core::graph::Graph::add_edge`'s kind-aware dedup), each appearing as its own entry here.
#[derive(Serialize)]
pub struct EdgeDto {
    pub from: u32,
    pub to: u32,
    pub kind: EdgeKindDto,
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

/// One node in the hierarchical timing tree — see GitHub issue #285. `id` is a stage id, rule id,
/// check type id, or strategy id depending on nesting depth; `children` is empty for a leaf
/// (check/strategy) node.
#[derive(Serialize)]
pub struct TimingNodeDto {
    pub id: String,
    pub total_ms: f64,
    pub calls: u32,
    pub children: Vec<TimingNodeDto>,
}

/// Hierarchical timing breakdown for one generation run — see GitHub issue #285. Only populated
/// by `run_generate` (the only path that runs the full generate→QC→repair pipeline);
/// analytics-only snapshots (post-edit, `compute_analytics`) have no generation pass to time, so
/// `MazeSnapshot.timing` is `None` there.
#[derive(Serialize)]
pub struct GenerationTimingDto {
    pub initial_build_ms: f64,
    /// One entry per stage that ran at least one rule — each stage node's `children` are its own
    /// rules, each rule node's `children` are its checks and (if dispatched) its strategy.
    pub qc: Vec<TimingNodeDto>,
}

#[derive(Serialize)]
pub struct RouteInfoDto {
    pub path_length: usize,
    pub junction_count: usize,
    pub one_way_count: usize,
    pub split_count: usize,
    pub score: Option<f64>,
    pub path: Vec<u32>,
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
    pub route_info: Option<RouteInfoDto>,
    pub statistics: MazeStatisticsDto,
    /// `Some` only when this snapshot came from a generation run (`run_generate`) — see
    /// `GenerationTimingDto`'s doc comment.
    pub timing: Option<GenerationTimingDto>,
}
