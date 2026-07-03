use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::{Issue, IssueKind};
use crate::generation::PresetState;
use super::params::{StrategyParam, StrategyParams};
use super::result::RepairResult;
use super::snapshot::SnapshotStack;

/// Describes one nested-strategy slot a parent strategy accepts — what `IssueKind` the
/// synthetic `Issue` the parent builds for it will carry, and how many strategies may fill
/// this slot. A strategy with no nested slots (the overwhelming majority) returns `&[]` from
/// `RepairStrategy::expected_nested()`.
///
/// `slot_id` distinguishes multiple slots that share the same `kind` but play different roles
/// for the parent — e.g. a future region-merge strategy that needs one "direct passage" nested
/// strategy AND, independently, one "teleport" nested strategy, both handling
/// `REGION_NEEDS_EXPANSION` but filling different roles (not interchangeable alternatives of a
/// single "pick any" slot).
///
/// **`slot_id` is part of this strategy's public configuration API**, not an internal detail —
/// `StrategyConfig.slot_id` (config JSON, `maze-runner`), `maze-wasm`'s `NestedSlotDto.slot_id`,
/// and the web store's `path: string[]` addressing all key off this exact string. Once a
/// strategy ships with a given `slot_id`, renaming it is a breaking config-format change (same
/// stability bar as `strategy_id()`/`IssueKind::as_str()` string constants elsewhere in this
/// crate) — never renamed casually. Within `maze-core`, always reference it via the owning
/// strategy's own exported constant, never a repeated string literal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NestedSlot {
    pub slot_id: &'static str,
    pub kind: IssueKind,
    pub min: usize,
    /// `None` = no upper bound (e.g. a future "pick one of N nested at random" strategy).
    pub max: Option<usize>,
}

/// One nested strategy assignment — same shape as a `RepairRuleConfig`'s own strategy binding,
/// minus the `QcRule` (a nested call has no independent QC rule; its `Issue` is synthesized by
/// the parent, never derived from a check).
pub struct NestedStrategyConfig<T: Tessellation> {
    /// Which of the parent's `expected_nested()` slots this fills — the full slot descriptor,
    /// not just its id, so `apply()` and any future consumer get `kind`/`min`/`max` and
    /// whatever fields `NestedSlot` grows later for free, without a second lookup back into
    /// `expected_nested()`. Points into the `&'static [NestedSlot]` the parent's
    /// `expected_nested()` returned — never owned/cloned.
    pub slot: &'static NestedSlot,
    pub strategy: Box<dyn RepairStrategy<T>>,
    pub param_overrides: HashMap<String, String>,
    /// Recursive — a nested strategy can itself have nested strategies.
    pub nested: Vec<NestedStrategyConfig<T>>,
}

pub trait RepairStrategy<T: Tessellation> {
    /// Strategy id — matches `maze-wasm`'s `StrategyConfig.id` (e.g. `"invalid_loop_random"`).
    /// Used to aggregate per-strategy timing, distinct from `rule_id` (a rule may use any
    /// registered strategy, and the same strategy can back multiple rules).
    fn strategy_id(&self) -> &'static str;

    /// The `IssueKind` this strategy itself expects in `issue.kind` when `apply()` is called.
    fn handles(&self) -> IssueKind;

    fn params(&self) -> &'static [StrategyParam] {
        &[]
    }

    /// Whether this strategy is experimental — its results or performance may still be
    /// unpredictable. Surfaced to the UI (see `maze-wasm`'s `StrategyDescriptor`) as a warning,
    /// not enforced by core itself. Default `false`.
    fn is_experimental(&self) -> bool {
        false
    }

    /// Nested-strategy slots this strategy accepts, if any. Default: none. A strategy that
    /// overrides this to a non-empty slice is expected to actually read `nested` in `apply()` —
    /// core does not otherwise enforce the connection between the two.
    fn expected_nested(&self) -> &'static [NestedSlot] {
        &[]
    }

    /// `issue.kind` must equal `self.handles()` (see `handles()`'s own doc comment) — new code
    /// should assert this with `debug_assert_eq!(issue.kind, self.handles())` as the first line.
    ///
    /// `snapshots`/`rng` are owned by the caller (`RepairEngine::run`/`run_timed`), one instance
    /// per top-level `apply()` call, shared across the whole call including any nested
    /// delegation. **A strategy that delegates to one of its `nested` entries must pass this
    /// same `snapshots`/`rng` straight through to the nested `apply()` call, never construct a
    /// fresh `SnapshotStack`/RNG for it** — see `Specs/repair.md`'s "Nested strategies" section
    /// ("Rollback stays the mutating strategy's own responsibility"). Passing a fresh
    /// `SnapshotStack` instead would silently break the single-rollback-stack invariant every
    /// other strategy in a nested chain relies on. `ReduceSccCountStrategy` is the reference
    /// implementation of this pattern.
    ///
    /// `nested` carries this call's configured nested-strategy assignments, resolved against
    /// `expected_nested()` — empty for every strategy that declares no nested slots (the
    /// overwhelming majority, which simply ignore this parameter). A strategy that does declare
    /// nested slots is responsible for locating the entry for each slot it needs (matching on
    /// `NestedStrategyConfig::slot`) and calling `entry.strategy.apply(...)` with a synthesized
    /// `Issue` of that slot's `kind` — core does not dispatch nested calls on the strategy's
    /// behalf.
    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        snapshots: &mut SnapshotStack,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> RepairResult;
}
