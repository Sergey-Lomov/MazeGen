use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::Issue;
use crate::generation::PresetState;
use super::params::{StrategyParam, StrategyParams};
use super::result::RepairResult;
use super::snapshot::SnapshotStack;

pub trait RepairStrategy<T: Tessellation> {
    /// Strategy id — matches `maze-wasm`'s `StrategyConfig.id` (e.g. `"invalid_loop_random"`).
    /// Used to aggregate per-strategy timing, distinct from `rule_id` (a rule may use any
    /// registered strategy, and the same strategy can back multiple rules).
    fn strategy_id(&self) -> &'static str;

    fn params(&self) -> &'static [StrategyParam] {
        &[]
    }

    /// Whether this strategy is experimental — its results or performance may still be
    /// unpredictable. Surfaced to the UI (see `maze-wasm`'s `StrategyDescriptor`) as a warning,
    /// not enforced by core itself. Default `false`.
    fn is_experimental(&self) -> bool {
        false
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
