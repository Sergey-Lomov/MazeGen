use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::Issue;
use crate::generation::PresetState;
use super::params::{StrategyParam, StrategyParams};
use super::result::RepairResult;
use super::snapshot::SnapshotStack;

pub trait RepairStrategy<T: Tessellation> {
    fn params(&self) -> &'static [StrategyParam] {
        &[]
    }

    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        snapshots: &mut SnapshotStack,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
    ) -> RepairResult;
}
