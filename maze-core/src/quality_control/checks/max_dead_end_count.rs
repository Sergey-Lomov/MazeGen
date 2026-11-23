use super::dead_end_core::dead_end_nodes;
use crate::Maze;
use crate::quality_control::InvalidDeadEndGroupIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;

pub const MAX_DEAD_END_COUNT_DEFAULT: u32 = 20;

/// Flags every dead end in each over-budget scope. The group retains all candidates and its
/// `to_remove` communicates the exact excess for UI/debug consumers.
pub struct MaxDeadEndCountCheck {
    pub instance_id: String,
    pub max_dead_end_count: u32,
}

impl<T: Tessellation> Check<T, InvalidDeadEndGroupIssue> for MaxDeadEndCountCheck {
    fn check_type_id(&self) -> &'static str {
        "max_dead_end_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidDeadEndGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let nodes = dead_end_nodes(maze);
        let groups = {
            let count = nodes.len() as u32;
            if count > self.max_dead_end_count {
                vec![(nodes, count - self.max_dead_end_count)]
            } else {
                Vec::new()
            }
        };
        if groups.is_empty() {
            return;
        }
        issues.push(
            InvalidDeadEndGroupIssue::new_from_check(&self.instance_id, groups).with_detail(
                &self.instance_id,
                "max_dead_end_count",
                self.max_dead_end_count.to_string(),
            ),
        );
    }
}
