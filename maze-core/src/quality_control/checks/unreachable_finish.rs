use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, UNREACHABLE_FINISH};
use crate::repair::CheckId;

pub const UNREACHABLE_FINISH_CHECK_ID: CheckId = CheckId::UnreachableFinish;

pub struct UnreachableFinishCheck;

impl<T: Tessellation> Check<T> for UnreachableFinishCheck {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        let (Some(start), Some(finish)) = (maze.meta.start, maze.meta.finish) else {
            return;
        };
        if !maze.graph.reachable_from(start).contains(&finish) {
            issues.push(Issue::new_from_check(UNREACHABLE_FINISH, UNREACHABLE_FINISH_CHECK_ID));
        }
    }
}
