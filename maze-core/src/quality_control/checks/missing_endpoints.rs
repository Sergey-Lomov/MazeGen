use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MISSING_ENDPOINTS};

pub struct MissingEndpointsCheck;

impl<T: Tessellation> Check<T> for MissingEndpointsCheck {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>) {
        if maze.meta.start.is_none() || maze.meta.finish.is_none() {
            issues.push(Issue::new(MISSING_ENDPOINTS));
        }
    }
}
