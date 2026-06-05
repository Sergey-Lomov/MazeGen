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
pub struct MazeSnapshot {
    pub nodes: Vec<NodeDto>,
    pub edges: Vec<EdgeDto>,
    pub start: Option<u32>,
    pub finish: Option<u32>,
    pub warnings: Vec<String>,
}
