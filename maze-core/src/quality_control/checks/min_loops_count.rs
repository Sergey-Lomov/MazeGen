use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, IssueKind};
use crate::repair::CheckId;

pub const MIN_LOOPS_DEFAULT: u32 = 1;
pub const MIN_LOOPS_COUNT_CHECK_ID: CheckId = CheckId::MinLoopsCount;

pub struct MinLoopsCountCheck {
    pub min_loops: u32,
}

impl<T: Tessellation> Check<T> for MinLoopsCountCheck {
    fn check(&self, _maze: &Maze<T>, issues: &mut Vec<Issue>) {
        // Loop detection not yet implemented — always fires
        issues.push(Issue::new_from_check(IssueKind::MinLoopsCount, MIN_LOOPS_COUNT_CHECK_ID));
    }
}
