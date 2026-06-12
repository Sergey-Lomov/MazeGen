use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, IssueKind};

pub const MIN_LOOPS_DEFAULT: u32 = 1;

pub struct MinLoopsCountCheck {
    pub min_loops: u32,
}

impl<T: Tessellation> Check<T> for MinLoopsCountCheck {
    fn check(&self, _maze: &Maze<T>, issues: &mut Vec<Issue>) {
        // Loop detection not yet implemented — always fires
        issues.push(Issue::new(IssueKind::MinLoopsCount));
    }
}
