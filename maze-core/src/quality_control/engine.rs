use crate::Maze;
use crate::space::Field;
use super::check::Check;
use super::issue::Issue;

pub struct QualityControlEngine<F: Field> {
    checks: Vec<Box<dyn Check<F>>>,
}

impl<F: Field> QualityControlEngine<F> {
    pub fn new(checks: Vec<Box<dyn Check<F>>>) -> Self {
        Self { checks }
    }

    pub fn run(&self, maze: &Maze<F>) -> Vec<Issue> {
        let mut issues = Vec::new();
        for check in &self.checks {
            check.check(maze, &mut issues);
        }
        issues
    }
}
