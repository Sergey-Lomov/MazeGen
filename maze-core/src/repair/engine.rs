use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Field;
use crate::quality_control::{Issue, IssueKind};
use super::params::{build_params, StrategyParams};
use super::result::RepairResult;
use super::strategy::RepairStrategy;

pub struct RepairEngine<F: Field> {
    strategies: HashMap<IssueKind, Box<dyn RepairStrategy<F>>>,
    param_overrides: HashMap<IssueKind, HashMap<String, String>>,
}

impl<F: Field> RepairEngine<F> {
    pub fn new(
        strategies: HashMap<IssueKind, Box<dyn RepairStrategy<F>>>,
        param_overrides: HashMap<IssueKind, HashMap<String, String>>,
    ) -> Self {
        Self { strategies, param_overrides }
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
                let overrides = self.param_overrides.get(issue.kind);
                let params: StrategyParams = build_params(strategy.params(), overrides);
                let result = strategy.apply(issue, maze, rng, &params);
                results.push((issue.kind, result));
            }
        }
        results
    }
}
