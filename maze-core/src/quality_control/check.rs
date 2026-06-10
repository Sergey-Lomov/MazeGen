use crate::Maze;
use crate::space::Tessellation;
use super::issue::Issue;

pub trait Check<T: Tessellation> {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>);
}
