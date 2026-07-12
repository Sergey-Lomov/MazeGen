use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::UnreachableFinishIssue;

pub struct UnreachableFinishCheck {
    pub instance_id: String,
}

impl<T: Tessellation> Check<T, UnreachableFinishIssue> for UnreachableFinishCheck {
    fn check_type_id(&self) -> &'static str { "unreachable_finish" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<UnreachableFinishIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let (Some(start), Some(finish)) = (maze.meta.start, maze.meta.finish) else {
            return;
        };
        if !maze.graph.reachable_from(start).contains(&finish) {
            issues.push(UnreachableFinishIssue::new_from_check(&self.instance_id));
        }
    }
}
