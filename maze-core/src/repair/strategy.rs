use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::Issue;
use super::params::{StrategyParam, StrategyParams};
use super::result::RepairResult;

pub trait RepairStrategy<T: Tessellation> {
    fn params(&self) -> &'static [StrategyParam] {
        &[]
    }

    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
    ) -> RepairResult;
}
