use serde::Serialize;

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
    pub id: u32,
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
}
