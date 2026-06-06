use crate::Maze;
use crate::space::Field;
use super::issue::{Issue, IssueKind};

pub trait Check<F: Field> {
    fn issue_kinds(&self) -> &'static [IssueKind];
    fn check(&self, maze: &Maze<F>, issues: &mut Vec<Issue>);
}
