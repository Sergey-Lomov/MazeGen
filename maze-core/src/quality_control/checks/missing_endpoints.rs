use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MISSING_ENDPOINTS};

pub const MISSING_ENDPOINTS_CHECK_ID: &str = "missing_endpoints";

pub struct MissingEndpointsCheck;

impl<T: Tessellation> Check<T> for MissingEndpointsCheck {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>) {
        if maze.meta.start.is_none() || maze.meta.finish.is_none() {
            issues.push(Issue::new_from_check(MISSING_ENDPOINTS, MISSING_ENDPOINTS_CHECK_ID));
        }
    }
}
