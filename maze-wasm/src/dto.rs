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
    pub warnings: Vec<String>,
    pub nav_nodes: Vec<NavNodeDto>,
    pub nav_edges: Vec<NavEdgeDto>,
    /// Strongly connected components. Each entry is a sorted list of NodeIds.
    pub components: Vec<Vec<u32>>,
    pub node_stats: NodeStatsDto,
    pub edge_stats: SpatialEdgeStatsDto,
    pub route_info: Option<RouteInfoDto>,
    pub debug_steps: Vec<GenerationStepDto>,
}
