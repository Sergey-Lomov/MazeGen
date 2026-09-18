use crate::ids::NodeId;

#[derive(Clone)]
pub struct MazeMeta {
    pub start: Option<NodeId>,
    pub finish: Option<NodeId>,
}

impl MazeMeta {
    pub fn empty() -> Self {
        Self {
            start: None,
            finish: None,
        }
    }
}
