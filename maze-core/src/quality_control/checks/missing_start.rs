use crate::Maze;
use crate::space::Field;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MISSING_START};

pub struct MissingStartCheck;

impl<F: Field> Check<F> for MissingStartCheck {
    fn check(&self, maze: &Maze<F>, issues: &mut Vec<Issue>) {
        if maze.meta.start.is_none() {
            issues.push(Issue::new(MISSING_START));
        }
    }
}
