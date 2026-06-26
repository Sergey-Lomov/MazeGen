use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MISSING_ENDPOINTS};
use crate::repair::CheckId;

pub const MISSING_ENDPOINTS_CHECK_ID: CheckId = CheckId::MissingEndpoints;

pub struct MissingEndpointsCheck;

impl<T: Tessellation> Check<T> for MissingEndpointsCheck {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        if maze.meta.start.is_none() || maze.meta.finish.is_none() {
            issues.push(Issue::new_from_check(MISSING_ENDPOINTS, MISSING_ENDPOINTS_CHECK_ID));
        }
    }
}
