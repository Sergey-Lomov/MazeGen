use crate::Maze;
use crate::quality_control::MissingEndpointsIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;

pub struct MissingEndpointsCheck {
    pub instance_id: String,
}

impl<T: Tessellation> Check<T, MissingEndpointsIssue> for MissingEndpointsCheck {
    fn check_type_id(&self) -> &'static str {
        "missing_endpoints"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingEndpointsIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let missing_start = maze.meta.start.is_none();
        let missing_finish = maze.meta.finish.is_none();
        if missing_start || missing_finish {
            issues.push(MissingEndpointsIssue::new_from_check(
                &self.instance_id,
                missing_start,
                missing_finish,
            ));
        }
    }
}
