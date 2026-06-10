use crate::Maze;
use crate::space::Tessellation;
use super::check::Check;
use super::issue::Issue;

pub struct QualityControlEngine<T: Tessellation> {
    checks: Vec<Box<dyn Check<T>>>,
}

impl<T: Tessellation> QualityControlEngine<T> {
    pub fn new(checks: Vec<Box<dyn Check<T>>>) -> Self {
        Self { checks }
    }

    pub fn run(&self, maze: &Maze<T>) -> Vec<Issue> {
        let mut issues = Vec::new();
        for check in &self.checks {
            check.check(maze, &mut issues);
        }
        issues
    }
}
