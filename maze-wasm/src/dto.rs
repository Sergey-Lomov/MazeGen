use serde::Serialize;

#[derive(Serialize)]
pub struct NodeDto {
    pub id: u32,
    pub x: i32,
    pub y: i32,
}

#[derive(Serialize)]
pub struct EdgeDto {
    pub a: u32,
    pub b: u32,
}

#[derive(Serialize)]
pub struct MazeSnapshot {
    pub nodes: Vec<NodeDto>,
    pub edges: Vec<EdgeDto>,
}
