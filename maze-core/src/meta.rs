use crate::ids::NodeId;

#[derive(Clone)]
pub struct MazeMeta {
    pub start: Option<NodeId>,
    pub finish: Option<NodeId>,
    pub route_score: Option<f64>,
}

impl MazeMeta {
    pub fn empty() -> Self {
        Self { start: None, finish: None, route_score: None }
    }
}
