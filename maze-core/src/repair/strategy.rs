use super::command::MutationCommand;
use super::params::{StrategyParam, StrategyParams};
use super::result::RepairResult;
use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::{Issue, IssueKind, IssueRequirement};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

/// Describes one nested-strategy slot a parent strategy accepts — what `IssueKind` the
/// synthetic issue the parent builds for it will carry, and how many strategies may fill this
/// slot. A strategy with no nested slots (the overwhelming majority) returns `&[]` from
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
///
/// `kind` stays a runtime `IssueKind` — nested-slot resolution is a second, independent axis of
/// heterogeneity from a strategy's own `I` (a parent handling one issue type may delegate to a
/// nested strategy of a completely different issue type, e.g. `ReduceSccCountStrategy` handling
/// `EXCESSIVE_SCC_COUNT` delegating to a `REGION_NEEDS_EXPANSION` nested strategy) — see
/// `ErasedRepairStrategy` below.
/// How a parent strategy picks which of a slot's several nested candidates to actually run —
/// purely descriptive metadata for the UI (which controls/labels to show per candidate), never
/// read by core's own dispatch logic (each dispatcher — `dispatch_weighted`/`dispatch_priority` —
/// already has its selection order hard-wired into the strategy that calls it). Extend this enum,
/// not an id allowlist, whenever a new dispatch-order convention ships alongside a new shared
/// `nested_dispatch.rs` helper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NestedDispatchKind {
    /// No ordering convention among a slot's candidates — either the slot holds at most one
    /// entry (`max: Some(1)`), or (as with a `*GroupSelectStrategy`'s own `fix_target`) there's
    /// exactly one required fixer with nothing to pick between. Default for every existing slot
    /// that isn't `Weighted`/`Priority`.
    Unordered,
    /// Candidates are picked weighted-randomly, with retry-on-`Failed` — see `dispatch_weighted`
    /// (GitHub issue #90). UI shows each candidate's configured weight and its resulting share.
    Weighted,
    /// Candidates are tried strictly in configured list order, falling through to the next on
    /// `Failed` — see `dispatch_priority` (GitHub issue #259). UI shows each candidate's rank and
    /// lets the user reorder the list.
    Priority,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NestedSlot {
    pub slot_id: &'static str,
    pub kind: IssueKind,
    pub min: usize,
    /// `None` = no upper bound (e.g. a "pick one of N nested" strategy — `Weighted`/`Priority`).
    pub max: Option<usize>,
    /// See `NestedDispatchKind`'s doc comment. Default `Unordered` via each slot literal simply
    /// omitting this field is not possible for a `const`/`static` struct literal in current Rust,
    /// so every `NestedSlot` literal must set this explicitly — a compile error otherwise, which
    /// is the point: a slot's dispatch convention is never left to an implicit default.
    pub dispatch_kind: NestedDispatchKind,
}

/// One nested strategy assignment — same shape as a `RepairRuleConfig`'s own strategy binding,
/// minus the `QcRule` (a nested call has no independent QC rule; its issue is synthesized by
/// the parent, never derived from a check). Erased (`Box<dyn ErasedRepairStrategy<T>>`) since a
/// nested strategy's issue type is independent of its parent's — see `ErasedRepairStrategy`.
pub struct NestedStrategyConfig<T: Tessellation> {
    /// Which of the parent's `expected_nested()` slots this fills — the full slot descriptor,
    /// not just its id, so `apply()` and any future consumer get `kind`/`min`/`max` and
    /// whatever fields `NestedSlot` grows later for free, without a second lookup back into
    /// `expected_nested()`. Points into the `&'static [NestedSlot]` the parent's
    /// `expected_nested()` returned — never owned/cloned.
    pub slot: &'static NestedSlot,
    pub strategy: Box<dyn ErasedRepairStrategy<T>>,
    pub param_overrides: HashMap<String, String>,
    /// Recursive — a nested strategy can itself have nested strategies.
    pub nested: Vec<NestedStrategyConfig<T>>,
}

pub trait RepairStrategy<T: Tessellation, I: IssueRequirement> {
    /// Strategy id — matches `maze-wasm`'s `StrategyConfig.id` (e.g. `"invalid_loop_random"`).
    /// Used to aggregate per-strategy timing, distinct from `rule_id` (a rule may use any
    /// registered strategy, and the same strategy can back multiple rules).
    fn strategy_id(&self) -> &'static str;

    fn params(&self) -> &'static [StrategyParam] {
        &[]
    }

    /// Param ids that are hidden and inert when this strategy runs *nested under a dispatcher*
    /// (`dispatch_priority` / `dispatch_weighted`), because the dispatcher owns them — see GitHub
    /// issue #486. For an element-adding strategy this is `["reserve_percent", "attempts_limit"]`
    /// (via `standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS`): the dispatcher computes the target
    /// count and attempt budget once and feeds them down, so a per-nested-strategy value would only
    /// cause conflicting behavior. `src_mode` is never suppressed — it drives geometry inside one
    /// strategy, which a dispatcher has no say over. Default: none.
    ///
    /// The web UI hides these rows on a nested node; the dispatchers strip any stale override from
    /// `param_overrides` before building the nested `StrategyParams`. At the top level (a strategy
    /// invoked directly by a rule, not under a dispatcher) every param stays visible and active.
    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        &[]
    }

    /// What subset of `I` this strategy needs its producing `Check` to compute — see GitHub
    /// issue #105. Resolved once by `Rule::new` (not per fixpoint iteration) and threaded into
    /// every `Check::repair_check` call in that rule. Default `I::Requirement::default()` —
    /// which `IssueRequirement`'s contract fixes to mean "compute everything" — so an
    /// unmigrated strategy changes nothing.
    fn requirement(&self, _params: &StrategyParams) -> I::Requirement {
        I::Requirement::default()
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

    /// `maze` is an immutable snapshot — see GitHub issue #118, `Specs/repair.md`'s
    /// mutation-command contract. A strategy never mutates `Maze` directly; it inspects `maze`
    /// (and, for a strategy needing intermediate state — currently only `MissingRegionsStrategy`
    /// — a `maze.draft()`/`DraftMaze` working copy, see `repair::draft`) and returns the list of
    /// `MutationCommand`s it wants applied. The caller (`Rule::check_and_repair_typed`) applies and
    /// revalidates those commands against the real `Maze` immediately after this call returns —
    /// a command that no longer holds by then is silently dropped, not an error, and does not
    /// change the `RepairResult` this method returns. `rng` is owned by the caller, one instance
    /// per top-level `apply()` call, shared across the whole call including any nested
    /// delegation.
    ///
    /// `nested` carries this call's configured nested-strategy assignments, resolved against
    /// `expected_nested()` — empty for every strategy that declares no nested slots (the
    /// overwhelming majority, which simply ignore this parameter). A strategy that does declare
    /// nested slots is responsible for locating the entry for each slot it needs (matching on
    /// `NestedStrategyConfig::slot`) and calling `entry.strategy.apply(...)` (the erased
    /// `ErasedRepairStrategy::apply`, taking `&dyn Issue`) with a synthesized issue of that
    /// slot's `kind`, against the same `&Maze` it was itself given (never a mutated copy — there
    /// is nothing to mutate here since `maze` is immutable) — then **concatenating** the nested
    /// call's returned commands onto its own, own-commands-so-far first (`parent, then nested`,
    /// see `Specs/repair.md`). Core does not dispatch nested calls on the strategy's behalf.
    fn apply(
        &self,
        issue: &I,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>);
}

/// Type-erased view of `RepairStrategy<T, I>` for the one place genuine cross-`I` heterogeneity
/// is unavoidable: nested-strategy slots (`NestedStrategyConfig<T>`) and the `maze-runner`
/// factory's nested-strategy resolution (`build_nested`), where a parent strategy's own `I` and
/// its nested strategy's `I` are independent (see `NestedSlot`'s doc comment).
///
/// **Not a blanket impl** — `impl<T, I, S: RepairStrategy<T, I>> ErasedRepairStrategy<T> for S`
/// does not compile in Rust (the compiler cannot prove `S` implements `RepairStrategy<T, I>` for
/// only one `I`). Every concrete strategy gets its own `impl ErasedRepairStrategy<T> for
/// ConcreteStrategy`, generated once via `impl_erased_repair_strategy!` (below) rather than
/// hand-written per strategy.
pub trait ErasedRepairStrategy<T: Tessellation> {
    fn strategy_id(&self) -> &'static str;
    fn handles(&self) -> IssueKind;
    fn params(&self) -> &'static [StrategyParam];
    fn nested_suppressed_params(&self) -> &'static [&'static str];
    fn is_experimental(&self) -> bool;
    fn expected_nested(&self) -> &'static [NestedSlot];
    /// Erased form of `RepairStrategy::requirement` — see GitHub issue #105. Returns
    /// `Box<dyn Any>` wrapping the strategy's own `I::Requirement`; the only caller,
    /// `maze-runner`'s `downcast_strategy`, already knows the concrete `I` (it's generic over it)
    /// and downcasts this back via `downcast_ref::<I::Requirement>()`. Needed because
    /// `RepairStrategy::requirement()`'s return type is generic over `I` and can't cross the
    /// erased boundary any other way — same rationale as `apply`'s `&dyn Issue` erasure.
    fn requirement_erased(&self, params: &StrategyParams) -> Box<dyn std::any::Any>;
    fn apply(
        &self,
        issue: &dyn Issue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>);
}

/// Generates `impl ErasedRepairStrategy<T> for $StrategyTy`, delegating each method to
/// `$StrategyTy`'s own `RepairStrategy<T, $IssueTy>` impl — `apply` downcasts the erased `&dyn
/// Issue` back to `&$IssueTy` via `as_any()`, panicking (via `expect`) if it doesn't match. That
/// panic signals a caller bug (a nested slot / `build_nested` kind mismatch), never a reachable
/// runtime condition given `NestedSlot.kind` is validated against `ErasedRepairStrategy::handles()`
/// at config-parse time (`maze-runner::build_nested`) before any `apply()` call happens.
///
/// Invoked once per concrete strategy, right after its `impl RepairStrategy<T, IssueTy> for
/// StrategyTy` block, in each `repair/strategies/*.rs` file.
#[macro_export]
macro_rules! impl_erased_repair_strategy {
    ($StrategyTy:ty, $IssueTy:ty) => {
        impl<T: $crate::space::Tessellation> $crate::repair::ErasedRepairStrategy<T> for $StrategyTy {
            fn strategy_id(&self) -> &'static str {
                <Self as $crate::repair::RepairStrategy<T, $IssueTy>>::strategy_id(self)
            }
            fn handles(&self) -> $crate::quality_control::IssueKind {
                <$IssueTy as $crate::quality_control::IssueKindConst>::KIND
            }
            fn params(&self) -> &'static [$crate::repair::StrategyParam] {
                <Self as $crate::repair::RepairStrategy<T, $IssueTy>>::params(self)
            }
            fn nested_suppressed_params(&self) -> &'static [&'static str] {
                <Self as $crate::repair::RepairStrategy<T, $IssueTy>>::nested_suppressed_params(self)
            }
            fn is_experimental(&self) -> bool {
                <Self as $crate::repair::RepairStrategy<T, $IssueTy>>::is_experimental(self)
            }
            fn expected_nested(&self) -> &'static [$crate::repair::NestedSlot] {
                <Self as $crate::repair::RepairStrategy<T, $IssueTy>>::expected_nested(self)
            }
            fn requirement_erased(&self, params: &$crate::repair::StrategyParams) -> Box<dyn ::std::any::Any> {
                Box::new(<Self as $crate::repair::RepairStrategy<T, $IssueTy>>::requirement(self, params))
            }
            fn apply(
                &self,
                issue: &dyn $crate::quality_control::Issue,
                maze: &$crate::Maze<T>,
                rng: &mut dyn ::rand::RngCore,
                params: &$crate::repair::StrategyParams,
                preset_state: &$crate::generation::PresetState,
                nested: &[$crate::repair::NestedStrategyConfig<T>],
            ) -> ($crate::repair::RepairResult, Vec<$crate::repair::MutationCommand>) {
                let typed: &$IssueTy = $crate::quality_control::Issue::as_any(issue)
                    .downcast_ref::<$IssueTy>()
                    .expect(concat!(
                    "ErasedRepairStrategy::apply: issue kind must match strategy's own I (",
                    stringify!($IssueTy),
                    ") — caller (build_nested/parent strategy) is responsible for kind agreement"
                ));
                <Self as $crate::repair::RepairStrategy<T, $IssueTy>>::apply(
                    self, typed, maze, rng, params, preset_state, nested,
                )
            }
        }
    };
}
