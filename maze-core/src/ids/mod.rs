use crate::space::{Field, Tessellation};

pub type NodeId = u64;
pub type EdgeId = usize;

#[derive(Clone)]
pub struct IdGenerator {
    next: u64,
}

impl IdGenerator {
    pub fn new() -> Self {
        Self { next: 0 }
    }

    pub fn next_id(&mut self) -> NodeId {
        let id = self.next;
        self.next += 1;
        id
    }

    /// Builds a generator guaranteed not to collide with any `NodeId` already present in `field`
    /// — one past the maximum existing ID (or `Self::new()` if the field is somehow empty). See
    /// GitHub issue #219: `Maze::new` uses this instead of accepting an `IdGenerator` as a
    /// parameter, so there is no way for a caller to accidentally pass in a fresh, incompatible
    /// generator that would collide with IDs the field already holds.
    pub(crate) fn resume_after<T: Tessellation>(field: &Field<T>) -> Self {
        let next = field.max_node_id().map_or(0, |max| max + 1);
        Self { next }
    }
}

impl Default for IdGenerator {
    fn default() -> Self {
        Self::new()
    }
}
