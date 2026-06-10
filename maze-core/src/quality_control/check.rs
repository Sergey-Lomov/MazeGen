use crate::Maze;
use crate::space::Tessellation;
use super::issue::{Issue, IssueKind};

pub trait Check<T: Tessellation> {
    fn issue_kinds(&self) -> &'static [IssueKind];
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>);
}
