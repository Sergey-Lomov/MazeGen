use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Field;
use crate::quality_control::{Issue, IssueKind};
use super::result::RepairResult;
use super::strategy::RepairStrategy;

pub struct RepairEngine<F: Field> {
    strategies: HashMap<IssueKind, Box<dyn RepairStrategy<F>>>,
}

impl<F: Field> RepairEngine<F> {
    pub fn new(strategies: HashMap<IssueKind, Box<dyn RepairStrategy<F>>>) -> Self {
        Self { strategies }
    }

    pub fn run(
        &self,
        issues: &[Issue],
        maze: &mut Maze<F>,
        rng: &mut impl RngCore,
    ) -> Vec<(IssueKind, RepairResult)> {
        let mut results = Vec::new();
        for issue in issues {
            if let Some(strategy) = self.strategies.get(issue.kind) {
                let result = strategy.apply(issue, maze, rng);
                results.push((issue.kind, result));
            }
        }
        results
    }
}
