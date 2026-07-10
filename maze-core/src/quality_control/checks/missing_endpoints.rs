use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MISSING_ENDPOINTS};

pub struct MissingEndpointsCheck {
    pub instance_id: String,
}

impl<T: Tessellation> Check<T> for MissingEndpointsCheck {
    fn check_type_id(&self) -> &'static str { "missing_endpoints" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        if maze.meta.start.is_none() || maze.meta.finish.is_none() {
            issues.push(Issue::new_from_check(MISSING_ENDPOINTS, &self.instance_id));
        }
    }
}
