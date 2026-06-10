use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::issue::{Issue, IssueKind};
use super::params::{build_params, StrategyParams};
use super::result::RepairResult;
use super::strategy::RepairStrategy;

pub struct RepairEngine<T: Tessellation> {
    strategies: HashMap<IssueKind, Box<dyn RepairStrategy<T>>>,
    param_overrides: HashMap<IssueKind, HashMap<String, String>>,
}

impl<T: Tessellation> RepairEngine<T> {
    pub fn new(
        strategies: HashMap<IssueKind, Box<dyn RepairStrategy<T>>>,
        param_overrides: HashMap<IssueKind, HashMap<String, String>>,
    ) -> Self {
        Self { strategies, param_overrides }
    }

    pub fn run(
        &self,
        issues: &[Issue],
        maze: &mut Maze<T>,
        rng: &mut impl RngCore,
    ) -> Vec<(IssueKind, RepairResult)> {
        let mut results = Vec::new();
        for issue in issues {
            if let Some(strategy) = self.strategies.get(&issue.kind) {
                let overrides = self.param_overrides.get(&issue.kind);
                let params: StrategyParams = build_params(strategy.params(), overrides);
                let result = strategy.apply(issue, maze, rng, &params);
                results.push((issue.kind, result));
            }
        }
        results
    }
}
