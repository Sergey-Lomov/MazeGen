use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IssueKind {
    MissingEndpoints,
    UnreachableFinish,
    InvalidLoop,
    MissingLoops,
    CycleAnalysisOverflowed,
    RepairLimitReached,
    QcNoProgress,
    ExcessiveSccCount,
    RegionNeedsExpansion,
    MissingRegions,
    InvalidTeleport,
    TeleportGroupProximity,
}

pub const MISSING_ENDPOINTS: IssueKind = IssueKind::MissingEndpoints;
pub const UNREACHABLE_FINISH: IssueKind = IssueKind::UnreachableFinish;
/// A cycle is invalid for some check-specific reason (currently: shorter than a configured
/// minimum tile-length — see `MinLoopLengthCheck`). Future checks may flag cycles invalid for
/// other reasons entirely (e.g. too long) and reuse this same kind — see `InvalidLoopIssue` and
/// `Issue::source_checks` for how multiple checks contributing to one kind are distinguished.
pub const INVALID_LOOP: IssueKind = IssueKind::InvalidLoop;
/// The maze has fewer loops than some check requires (currently only `MinLoopsCountCheck`).
/// Mirrors `INVALID_LOOP`'s role for invalid cycles, but for a missing-count condition instead
/// of a specific-cycle one — future checks needing more loops added can reuse this kind. Carries
/// `MissingLoopsIssue { missing }` — see that type's doc comment.
pub const MISSING_LOOPS: IssueKind = IssueKind::MissingLoops;
/// Not a toggleable QC check — raised directly by `build_analytics_snapshot`
/// (maze-wasm/src/analytics.rs) whenever `GraphAnalytics::cycle_analysis_overflowed` is true.
/// Unlike the other kinds here, no `Check<T, I>` implementation produces this; it surfaces a
/// condition from the always-on analytics computation, not a user-selected check.
pub const CYCLE_ANALYSIS_OVERFLOWED: IssueKind = IssueKind::CycleAnalysisOverflowed;
/// Not a toggleable QC check — pushed directly by `build_maze` (`generation::pipeline`) when the
/// repair fixpoint loop exits because a `RepairLimits` bound was hit (max iterations or time
/// budget), rather than via convergence (no active issues) or no-progress. Carries
/// `RepairLimitReachedIssue { limit }` identifying which bound fired. Surfaces as a critical
/// analytics issue so the user can tell "still broken because the cap cut repair short" apart
/// from "still broken because no strategy could fix it".
pub const REPAIR_LIMIT_REACHED: IssueKind = IssueKind::RepairLimitReached;
/// Not a toggleable QC check — pushed directly by `build_maze` when the repair fixpoint loop
/// exits via the no-progress guard (the same `(rule_id, Issue)` set repeated identically across
/// two iterations), rather than via convergence or a `RepairLimits` cap. Carries
/// `QcNoProgressIssue { rule_ids }` naming the stuck rule(s) — typically a sign of two active
/// rules whose strategies fight to a net-zero change each iteration (e.g. contradictory min/max
/// thresholds on the same metric), distinct from simply running out of iterations/time.
pub const QC_NO_PROGRESS: IssueKind = IssueKind::QcNoProgress;
/// The graph is split into more strongly-connected components than a check's configured limit
/// allows (currently only `SccCountCheck`) — often signals a poorly-connected or fragmented
/// maze even when other checks pass. Reuses `build_scc` (`graph::scc`) rather than
/// re-implementing SCC computation.
pub const EXCESSIVE_SCC_COUNT: IssueKind = IssueKind::ExcessiveSccCount;
/// An SCC region needs to be expanded for some check-specific reason (currently: smaller than a
/// configured absolute tile count, or smaller than a configured share of the field — see
/// `MinRegionSizeCheck`/`MinRegionRatioCheck`). Mirrors `INVALID_LOOP`'s role for cycles: a
/// semantic category, not tied to size specifically or to any one reason — future checks may
/// flag a region as needing expansion for reasons unrelated to size and reuse this same kind.
/// Carries `RegionNeedsExpansionIssue` — see that type's doc comment.
pub const REGION_NEEDS_EXPANSION: IssueKind = IssueKind::RegionNeedsExpansion;
/// The maze has fewer regions of some `RegionClass` than a check's configured minimum requires
/// (currently only `MinRegionCountCheck`) — e.g. guaranteeing at least N trap or alternative-route
/// regions for structural variety. Carries `MissingRegionsIssue { balance_by_class }` — see that
/// type's doc comment. No `RepairStrategy` registered yet for this kind.
pub const MISSING_REGIONS: IssueKind = IssueKind::MissingRegions;
/// A teleport edge (`EdgeKind::Teleport`) is invalid for some check-specific reason (currently:
/// a regular, non-teleport connection already exists between the same pair in the same direction
/// — see `TeleportDuplicatesConnectionCheck`). Mirrors `INVALID_LOOP`'s role for cycles: a
/// semantic category, not tied to one specific reason — future per-teleport validation checks
/// (geometric length, waypoint distance, super-hub avoidance) may flag teleports invalid for
/// other reasons and reuse this same kind. Carries `InvalidTeleportIssue` — see that type's doc
/// comment.
pub const INVALID_TELEPORT: IssueKind = IssueKind::InvalidTeleport;
/// A pair of teleport edges sit topologically closer than a check's configured minimum distance
/// (currently only `TeleportGroupProximityCheck`) — see GitHub issue #75. Distinct from
/// `INVALID_TELEPORT`: that kind flags a single teleport edge invalid on its own; this one flags
/// a *relationship* between two teleport edges, neither of which is individually invalid. Carries
/// `TeleportGroupProximityIssue` — see that type's doc comment.
pub const TELEPORT_GROUP_PROXIMITY: IssueKind = IssueKind::TeleportGroupProximity;

impl IssueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueKind::MissingEndpoints => "missing_endpoints",
            IssueKind::UnreachableFinish => "unreachable_finish",
            IssueKind::InvalidLoop => "invalid_loop",
            IssueKind::MissingLoops => "missing_loops",
            IssueKind::CycleAnalysisOverflowed => "cycle_analysis_overflowed",
            IssueKind::RepairLimitReached => "repair_limit_reached",
            IssueKind::QcNoProgress => "qc_no_progress",
            IssueKind::ExcessiveSccCount => "excessive_scc_count",
            IssueKind::RegionNeedsExpansion => "region_needs_expansion",
            IssueKind::MissingRegions => "missing_regions",
            IssueKind::InvalidTeleport => "invalid_teleport",
            IssueKind::TeleportGroupProximity => "teleport_group_proximity",
        }
    }

    /// Round-trips every variant including `CycleAnalysisOverflowed`, even though the latter
    /// can never have a registered `RepairStrategy` (it's not a toggleable QC check — see
    /// `CYCLE_ANALYSIS_OVERFLOWED`'s doc comment). `IssueKind::from_str` is also used by
    /// `maze-wasm/src/runner.rs` to validate `config.strategies` keys; a config naming this
    /// kind will parse here, then fail downstream with "unknown strategy" the same way any
    /// other kind with no matching strategy registration would — there is no dedicated
    /// rejection at this layer, by design, since strategy availability is the repair engine's
    /// concern, not `IssueKind`'s.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "missing_endpoints"  => Some(IssueKind::MissingEndpoints),
            "unreachable_finish" => Some(IssueKind::UnreachableFinish),
            "invalid_loop"       => Some(IssueKind::InvalidLoop),
            "missing_loops"      => Some(IssueKind::MissingLoops),
            "cycle_analysis_overflowed" => Some(IssueKind::CycleAnalysisOverflowed),
            "repair_limit_reached" => Some(IssueKind::RepairLimitReached),
            "qc_no_progress" => Some(IssueKind::QcNoProgress),
            "excessive_scc_count" => Some(IssueKind::ExcessiveSccCount),
            "region_needs_expansion" => Some(IssueKind::RegionNeedsExpansion),
            "missing_regions" => Some(IssueKind::MissingRegions),
            "invalid_teleport" => Some(IssueKind::InvalidTeleport),
            "teleport_group_proximity" => Some(IssueKind::TeleportGroupProximity),
            _ => None,
        }
    }
}

impl std::fmt::Display for IssueKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Shared `source_checks`/`details` bookkeeping every concrete `Issue` type embeds — see
/// `Issue`'s trait doc comment for the split between what's object-safe (`kind`/`meta`/
/// `meta_mut`/`as_any`) and what's not (`KIND`/`merge`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct IssueMeta {
    /// Opaque check id(s) that produced or contributed to this issue — the same id passed to
    /// `new_from_check`, expected to be `maze-wasm/src/runner.rs`'s composite routing key. Empty
    /// for issues not raised by a toggleable `Check<T, I>` — currently only
    /// `CYCLE_ANALYSIS_OVERFLOWED`, pushed directly by `build_analytics_snapshot` (see its doc
    /// comment). Merging two issues of the same kind (within one `Rule`, see GitHub issue #106)
    /// unions this list without duplicates.
    ///
    /// Private — a raw (pre-merge) issue must carry exactly one source check, and
    /// `Rule::run_checks_typed` (`quality_control/rule.rs`) reads only the first element under
    /// that assumption. Making this a public `Vec` field let any code construct an issue with 0
    /// or 2+ raw sources, bypassing `new_from_check` — a release build (no `debug_assert`) would
    /// then silently route by an arbitrary single id, dropping the rest. `source_checks()`
    /// exposes the list read-only; `push_source` is the only way to add to it, used solely by
    /// `IssueMerge::merge` implementations after merge has already established the issue may
    /// legitimately carry several.
    source_checks: Vec<String>,
    /// Generic per-source-check display data, e.g. `"max_loop_length" -> {"threshold" -> "100"}`.
    /// Raw values only (numbers/ids as strings) — never assembled messages; the web UI owns all
    /// wording and looks values up by key via its own i18n templates keyed by check id. Keyed by
    /// check id (not merged into one flat map) because a merged issue may carry details from
    /// several checks at once (e.g. `min_loop_length`'s and `max_loop_length`'s thresholds both
    /// present on one merged `INVALID_LOOP` issue) and a UI bubble is rendered per source check.
    details: HashMap<String, HashMap<&'static str, String>>,
}

impl IssueMeta {
    /// For issues not raised by a toggleable `Check<T, I>` (currently only
    /// `CYCLE_ANALYSIS_OVERFLOWED`) — `source_checks` is empty since there is no check id to
    /// attribute this to. Checks should use `new_from_check` instead. Also used for synthetic
    /// issues built by a parent `RepairStrategy` for a nested-strategy call.
    pub fn new() -> Self {
        Self::default()
    }

    /// Zeroes `source_checks` to `vec![source_check]` — mirrors the pre-#113 `Issue::new_from_check`.
    pub fn new_from_check(source_check: &str) -> Self {
        Self { source_checks: vec![source_check.to_string()], details: HashMap::new() }
    }

    /// Attaches a display detail under `source_check` (raw value only, e.g. a threshold — never
    /// an assembled message, see `details`' doc comment above). Chainable — a `Check` calls this
    /// right after constructing its issue's `IssueMeta` via `new_from_check`. `source_check`
    /// should be the same id the issue was constructed with.
    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.details.entry(source_check.to_string()).or_default().insert(key, value);
        self
    }

    pub fn source_checks(&self) -> &[String] {
        &self.source_checks
    }

    /// Display details keyed by source check id, then by detail key — see `details`' doc
    /// comment for why this isn't a flat map.
    pub fn details(&self) -> &HashMap<String, HashMap<&'static str, String>> {
        &self.details
    }

    /// Adds `source` to this issue's recorded sources if not already present — the only way to
    /// grow `source_checks` past its construction-time value. Used exclusively by
    /// `IssueMerge::merge` implementations once two issues are confirmed to share a rule and are
    /// being combined into one.
    pub(crate) fn push_source(&mut self, source: &str) {
        if !self.source_checks.iter().any(|s| s == source) {
            self.source_checks.push(source.to_string());
        }
    }

    /// Merges `incoming`'s details into `self`'s, keyed by source check id. Since each check id
    /// only ever appears as a raw (pre-merge) issue's sole source, `incoming`'s entries simply
    /// overwrite any existing entry for the same check id — there is no same-check-id conflict
    /// to reconcile. Used exclusively by `IssueMerge::merge` implementations.
    pub(crate) fn merge_details(&mut self, incoming: HashMap<String, HashMap<&'static str, String>>) {
        self.details.extend(incoming);
    }
}

/// A concrete quality-control issue type — one `impl` per `IssueKind` variant (see
/// `quality_control::issue_kinds`). `Issue: Any` (supertrait) + `as_any(&self) -> &dyn Any` is
/// the fixed mechanism for the erased boundary (`Stage`'s `Box<dyn Issue>`, nested-strategy
/// slots) and its downcast back to a concrete type.
///
/// `dyn Issue` is **object-safe** through exactly `kind()`/`meta()`/`meta_mut()`/`as_any()` —
/// these four methods are the only ones callable on `&dyn Issue`/`Box<dyn Issue>`. `const KIND`
/// (see `IssueKindConst`) and `merge` (see `IssueMerge`) are **not** object-safe and are never
/// called through the erased boundary: this rustc rejects a `where Self: Sized`-bounded
/// associated const directly on a dyn-compatible trait (`generic_const_items` is not yet stable),
/// so `KIND` lives on the separate `IssueKindConst: Issue + Sized` trait instead of directly here
/// — `merge` lives on the separate `IssueMerge: Issue + Sized` trait for the same reason (it's
/// simply not object-safe by nature, no feature-gate workaround needed there). Everywhere `Self`
/// is statically known, code reads `Self::KIND` directly, never `self.kind()`.
pub trait Issue: std::any::Any {
    /// Object-safe mirror of `Self::KIND` — exists solely for callers going through `dyn
    /// Issue`/`Box<dyn Issue>`. Code that knows `Self` statically reads `Self::KIND` instead.
    fn kind(&self) -> IssueKind;

    fn meta(&self) -> &IssueMeta;
    fn meta_mut(&mut self) -> &mut IssueMeta;
    fn as_any(&self) -> &dyn std::any::Any;

    /// Object-safe value equality for `Box<dyn Issue>`/`&dyn Issue` — used by `Stage`'s
    /// no-progress fingerprint (`Stage::check_progress`), the one place two erased issues need
    /// comparing. Different concrete types are always unequal; same type compares by `PartialEq`.
    /// Must be part of `dyn Issue`'s vtable (called via `Box<dyn Issue>`), so it cannot carry a
    /// `where Self: Sized` default body — every concrete type instead gets this one-line body via
    /// `impl_issue_dyn_boilerplate!` (below), not hand-duplicated.
    fn eq_dyn(&self, other: &dyn Issue) -> bool;

    /// Object-safe clone for `Box<dyn Issue>` — used by `Stage`'s no-progress fingerprint, which
    /// must keep a snapshot of the previous iteration's active issues to compare against the next.
    /// Same object-safety constraint as `eq_dyn` — see that method's doc comment.
    fn clone_box(&self) -> Box<dyn Issue>;

    fn source_checks(&self) -> &[String] {
        self.meta().source_checks()
    }

    fn details(&self) -> &HashMap<String, HashMap<&'static str, String>> {
        self.meta().details()
    }
}

/// Generates `Issue::eq_dyn`/`Issue::clone_box` for one concrete Issue type — both bodies are
/// identical across every type (only `Self` varies, implicitly), so this exists purely to avoid
/// hand-duplicating them in each of `quality_control::issue_kinds`'s 12 files, where a copy-paste
/// slip (e.g. `downcast_ref::<Self>()` accidentally left referencing a different type after
/// copying) would silently break `Stage`'s no-progress fingerprint instead of failing to compile.
/// Invoked inside each type's own `impl Issue for ConcreteType { ... }` block, after the other
/// four required methods (`kind`/`meta`/`meta_mut`/`as_any`) — see any `issue_kinds/*.rs` file.
#[macro_export]
macro_rules! impl_issue_dyn_boilerplate {
    () => {
        fn eq_dyn(&self, other: &dyn $crate::quality_control::Issue) -> bool {
            $crate::quality_control::Issue::as_any(other).downcast_ref::<Self>().is_some_and(|o| self == o)
        }
        fn clone_box(&self) -> Box<dyn $crate::quality_control::Issue> {
            Box::new(self.clone())
        }
    };
}

/// The compile-time `IssueKind` for a concrete `Issue` type — split out from `Issue` itself
/// solely because this rustc rejects a `where Self: Sized`-bounded associated const on a
/// dyn-compatible trait (see `Issue`'s doc comment). Every concrete `Issue` type implements this.
pub trait IssueKindConst: Issue + Sized {
    const KIND: IssueKind;
}

/// Merge behavior for a concrete `Issue` type — deliberately **not** part of `Issue` itself (not
/// object-safe: `Self: Sized`), so it can never be called through `dyn Issue`/`Box<dyn Issue>`.
/// Only called from `Rule<T, I>::run_checks_typed`, where `I` is statically known. Requires
/// `IssueKindConst` too — every place generic over `I: Issue + IssueMerge` (`Check<T, I>`,
/// `RepairStrategy<T, I>`, `Rule<T, I>`) also needs `I::KIND`, so bundling it here means those
/// bounds don't need to separately spell out `IssueKindConst`.
pub trait IssueMerge: Issue + IssueKindConst {
    /// Merges `other` into `self` — both share `Self::KIND`. Used when two checks within the
    /// same `Rule` (or, in principle, the same check twice) produce an issue of the same kind in
    /// one QC pass. Always unions data rather than picking one side — there is no precedence
    /// between sources, nothing is discarded (see `Specs/quality_control.md`'s "Dedup
    /// interaction" section).
    fn merge(&mut self, other: Self);
}

/// Describes what subset of `Self` a `RepairStrategy<T, Self>` may ask its producing `Check` to
/// compute (see `RepairStrategy::requirement`) — see GitHub issue #105. Every concrete `Issue`
/// type implements this (with `type Requirement = ()` where no narrower variant exists yet),
/// so `Check<T, I>`/`RepairStrategy<T, I>` can bound on it uniformly rather than splitting into
/// two parallel trait hierarchies for "has a requirement" vs "doesn't".
///
/// `Self::Requirement::default()` **must** mean "compute everything" — `Check::report_check`'s
/// default body (`quality_control/check.rs`) has no strategy to consult, so it always passes the
/// default and relies on this meaning "full".
pub trait IssueRequirement: Issue {
    type Requirement: Default + Copy + 'static;
}

#[cfg(test)]
mod dyn_issue_tests {
    use super::*;
    use crate::quality_control::issue_kinds::{MissingEndpointsIssue, UnreachableFinishIssue};

    // `eq_dyn`'s "different concrete types are always unequal" branch — every issue_kinds/*.rs
    // test only ever compares an issue against another instance of its own type (needed to
    // exercise the real per-field `PartialEq`), so this is the one place two *different* concrete
    // `Issue` types are compared via `eq_dyn`, proving `downcast_ref::<Self>()` actually gates on
    // the concrete type rather than, say, only on `kind()` or field shape.
    #[test]
    fn eq_dyn_is_false_for_different_concrete_types() {
        let a: Box<dyn Issue> = Box::new(MissingEndpointsIssue::new_from_check("check"));
        let b: Box<dyn Issue> = Box::new(UnreachableFinishIssue::new_from_check("check"));
        assert!(!a.eq_dyn(b.as_ref()));
        assert!(!b.eq_dyn(a.as_ref()));
    }

    #[test]
    fn eq_dyn_is_true_for_equal_same_type_issues() {
        let a: Box<dyn Issue> = Box::new(MissingEndpointsIssue::new_from_check("check"));
        let b: Box<dyn Issue> = Box::new(MissingEndpointsIssue::new_from_check("check"));
        assert!(a.eq_dyn(b.as_ref()));
    }

    #[test]
    fn clone_box_produces_an_equal_but_independently_owned_copy() {
        let original: Box<dyn Issue> = Box::new(MissingEndpointsIssue::new_from_check("check"));
        let cloned = original.clone_box();
        assert!(original.eq_dyn(cloned.as_ref()));
    }
}
