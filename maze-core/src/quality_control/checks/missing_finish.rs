use crate::Maze;
use crate::space::Field;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MISSING_FINISH};

pub struct MissingFinishCheck;

impl<F: Field> Check<F> for MissingFinishCheck {
    fn check(&self, maze: &Maze<F>, issues: &mut Vec<Issue>) {
        if maze.meta.finish.is_none() {
            issues.push(Issue::new(MISSING_FINISH));
        }
    }
}
