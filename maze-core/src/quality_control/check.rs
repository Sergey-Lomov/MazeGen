use crate::Maze;
use crate::space::Field;
use super::issue::Issue;

pub trait Check<F: Field> {
    fn check(&self, maze: &Maze<F>, issues: &mut Vec<Issue>);
}
