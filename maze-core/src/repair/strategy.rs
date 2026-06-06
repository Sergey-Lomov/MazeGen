use rand::RngCore;
use crate::Maze;
use crate::space::Field;
use crate::quality_control::Issue;
use super::params::{StrategyParam, StrategyParams};
use super::result::RepairResult;

pub trait RepairStrategy<F: Field> {
    fn params(&self) -> &'static [StrategyParam] {
        &[]
    }

    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<F>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
    ) -> RepairResult;
}
