use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::MissingEndpointsIssue;

pub struct MissingEndpointsCheck {
    pub instance_id: String,
}

impl<T: Tessellation> Check<T, MissingEndpointsIssue> for MissingEndpointsCheck {
    fn check_type_id(&self) -> &'static str { "missing_endpoints" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn RngCore) {
        if maze.meta.start.is_none() || maze.meta.finish.is_none() {
            issues.push(MissingEndpointsIssue::new_from_check(&self.instance_id));
        }
    }
}
