use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IssueKind {
    MissingEndpoints,
    UnreachableFinish,
    InvalidLoop,
    InvalidLoopGroup,
    MissingLoops,
    CycleAnalysisOverflowed,
    RepairLimitReached,
    ExcessiveSccCount,
    RegionNeedsExpansion,
    RegionNeedsShrink,
    MissingRegions,
    InvalidTeleport,
    InvalidTeleportGroup,
    InvalidOneWay,
    InvalidOneWayGroup,
    MissingOneWays,
    MissingTeleports,
    InvalidSplitTile,
    InvalidSplitTileGroup,
}

pub const MISSING_ENDPOINTS: IssueKind = IssueKind::MissingEndpoints;
pub const UNREACHABLE_FINISH: IssueKind = IssueKind::UnreachableFinish;
/// A cycle is invalid for some check-specific reason (currently: shorter than a configured
/// minimum tile-length — see `MinLoopLengthCheck`). Future checks may flag cycles invalid for
/// other reasons entirely (e.g. too long) and reuse this same kind — see `InvalidLoopIssue` and
/// `Issue::source_checks` for how multiple checks contributing to one kind are distinguished.
pub const INVALID_LOOP: IssueKind = IssueKind::InvalidLoop;
/// A cycle is flagged not for a property of its own, but as part of a group decision across every
/// loop on the field (currently only excess field-density — see `MaxLoopDensityCheck`). Mirrors
/// `INVALID_TELEPORT_GROUP`'s split from `INVALID_TELEPORT`: `INVALID_LOOP` flags a single cycle
/// invalid on its own terms, this kind flags cycles selected as part of a group-level fix (e.g.
/// "pick enough loops to remove until density drops"), so it gets its own kind and strategies
/// rather than being folded into `INVALID_LOOP`. Carries `InvalidLoopGroupIssue` — same shape as
/// `InvalidLoopIssue`, see that type's doc comment.
pub const INVALID_LOOP_GROUP: IssueKind = IssueKind::InvalidLoopGroup;
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
/// An SCC region needs to be shrunk for some check-specific reason (currently: larger than a
/// configured absolute tile count, or larger than a configured share of the field — see
/// `MaxRegionSizeCheck`/`MaxRegionRatioCheck`) — see GitHub issue #177. Distinct from
/// `REGION_NEEDS_EXPANSION`: min/max on region size are a count-shaped deficit/surplus pair (the
/// two directions need different repair actions — grow vs. shrink), not a single-entity
/// min/max-comparison pair, so they get separate `IssueKind`s and strategies rather than merging
/// via `Comparison`. Carries `RegionNeedsShrinkIssue` — see that type's doc comment.
pub const REGION_NEEDS_SHRINK: IssueKind = IssueKind::RegionNeedsShrink;
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
/// `InvalidTeleportGroupIssue` — see that type's doc comment.
pub const INVALID_TELEPORT_GROUP: IssueKind = IssueKind::InvalidTeleportGroup;
/// A one-way passage edge (`EdgeKind::Basic`, single direction) is invalid for some check-specific
/// reason — see GitHub issue #198 (part of the one-way management epic, issue #92). Currently
/// produced by `OneWayWaypointDistanceCheck`. Mirrors `INVALID_TELEPORT`'s role for teleports: a
/// semantic category, not tied to one specific reason — future per-one-way validation checks may
/// flag one-way edges invalid for other reasons and reuse this same kind. Carries
/// `InvalidOneWayIssue` — see that type's doc comment. Two repair strategies register against
/// this kind — `OneWayToPassageStrategy` (converts to a full bidirectional passage) and
/// `OneWayToWallStrategy` (removes the edge entirely) — a rule picks exactly one, same as every
/// other kind with more than one registered strategy.
pub const INVALID_ONE_WAY: IssueKind = IssueKind::InvalidOneWay;
/// A set of one-way passage edges (`EdgeKind::Basic`, single direction) sit topologically or
/// geometrically closer than a check's configured minimum distance — see GitHub issue #199.
/// Distinct from `INVALID_ONE_WAY`: that kind flags a single one-way edge invalid on its own;
/// this one flags a *relationship* between two or more one-way edges, none of which is
/// individually invalid. Mirrors `INVALID_TELEPORT_GROUP`'s split from `INVALID_TELEPORT`.
/// Carries `InvalidOneWayGroupIssue` — see that type's doc comment.
pub const INVALID_ONE_WAY_GROUP: IssueKind = IssueKind::InvalidOneWayGroup;
/// The maze has fewer one-way passage edges (`EdgeKind::Basic`, single direction) than some check
/// requires (currently `MinOneWayCountCheck`/`MinOneWayRatioCheck`) — see GitHub issue #201, part
/// of the one-way management epic (#92). Mirrors `MISSING_LOOPS`'s role for loops: a
/// missing-count condition rather than a specific-edge one. Carries `MissingOneWaysIssue {
/// missing }` — see that type's doc comment.
pub const MISSING_ONE_WAYS: IssueKind = IssueKind::MissingOneWays;
/// The maze has fewer teleport edges (`EdgeKind::Teleport`) than some check requires (currently
/// `MinTeleportCountCheck`/`MinTeleportRatioCheck`) — see GitHub issue #211. Mirrors
/// `MISSING_ONE_WAYS`'s role for one-ways: a missing-count condition rather than a specific-edge
/// one. Carries `MissingTeleportsIssue { missing }` — see that type's doc comment. No repair
/// strategy registered yet for this kind (deliberately out of scope for #211).
pub const MISSING_TELEPORTS: IssueKind = IssueKind::MissingTeleports;
/// An extra split node (`Field::add_node_at`'s minted node, never a point's slot-0 original) is
/// invalid for some check-specific reason — currently `SplitDistanceFromWaypointCheck` (the
/// node's point sits too close to/far from `meta.start`/`meta.finish`, per a configured
/// `Comparison`). Mirrors `INVALID_TELEPORT`'s role for teleports: a semantic category, not tied
/// to one specific reason — future per-split-node checks may flag a split node invalid for other
/// reasons and reuse this same kind. Carries `InvalidSplitTileIssue { invalid: Vec<SplitTileNodes>, .. }`
/// — see that type's doc comment. Repaired by `RemoveSplitStrategy` (see `repair.md`), which
/// collapses every removable node of each flagged tile back into its point's slot-0 original —
/// never removes slot-0 itself (a hard constraint across every split-QC strategy, see GitHub epic #246).
pub const INVALID_SPLIT_TILE: IssueKind = IssueKind::InvalidSplitTile;

/// A field-wide/aggregate condition over the set of split tiles — see GitHub issue #249, part of
/// epic #246. `InvalidSplitTileGroup` is a distinct kind from `InvalidSplitTile`, not a reuse —
/// mirrors `InvalidOneWayGroup`'s split from `InvalidOneWay`. Where `InvalidSplitTile` flags a
/// single tile invalid on its own terms, `InvalidSplitTileGroup` flags tiles selected as part of
/// a group-level decision across the field (excess split count, excess split density, or a pair
/// of tiles placed too close together). Carries `InvalidSplitTileGroupIssue` — see that type's
/// doc comment. Repaired by `SplitGroupSelectStrategy`, which delegates each candidate tile's
/// collapse to a nested `INVALID_SPLIT_TILE` strategy (`RemoveSplitStrategy`).
pub const INVALID_SPLIT_TILE_GROUP: IssueKind = IssueKind::InvalidSplitTileGroup;

impl IssueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueKind::MissingEndpoints => "missing_endpoints",
            IssueKind::UnreachableFinish => "unreachable_finish",
            IssueKind::InvalidLoop => "invalid_loop",
            IssueKind::InvalidLoopGroup => "invalid_loop_group",
            IssueKind::MissingLoops => "missing_loops",
            IssueKind::CycleAnalysisOverflowed => "cycle_analysis_overflowed",
            IssueKind::RepairLimitReached => "repair_limit_reached",
            IssueKind::ExcessiveSccCount => "excessive_scc_count",
            IssueKind::RegionNeedsExpansion => "region_needs_expansion",
            IssueKind::RegionNeedsShrink => "region_needs_shrink",
            IssueKind::MissingRegions => "missing_regions",
            IssueKind::InvalidTeleport => "invalid_teleport",
            IssueKind::InvalidTeleportGroup => "invalid_teleport_group",
            IssueKind::InvalidOneWay => "invalid_one_way",
            IssueKind::InvalidOneWayGroup => "invalid_one_way_group",
            IssueKind::MissingOneWays => "missing_one_ways",
            IssueKind::MissingTeleports => "missing_teleports",
            IssueKind::InvalidSplitTile => "invalid_split_tile",
            IssueKind::InvalidSplitTileGroup => "invalid_split_tile_group",
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
            "invalid_loop_group" => Some(IssueKind::InvalidLoopGroup),
            "missing_loops"      => Some(IssueKind::MissingLoops),
            "cycle_analysis_overflowed" => Some(IssueKind::CycleAnalysisOverflowed),
            "repair_limit_reached" => Some(IssueKind::RepairLimitReached),
            "excessive_scc_count" => Some(IssueKind::ExcessiveSccCount),
            "region_needs_expansion" => Some(IssueKind::RegionNeedsExpansion),
            "region_needs_shrink" => Some(IssueKind::RegionNeedsShrink),
            "missing_regions" => Some(IssueKind::MissingRegions),
            "invalid_teleport" => Some(IssueKind::InvalidTeleport),
            "invalid_teleport_group" => Some(IssueKind::InvalidTeleportGroup),
            "invalid_one_way" => Some(IssueKind::InvalidOneWay),
            "invalid_one_way_group" => Some(IssueKind::InvalidOneWayGroup),
            "missing_one_ways" => Some(IssueKind::MissingOneWays),
            "missing_teleports" => Some(IssueKind::MissingTeleports),
            "invalid_split_tile" => Some(IssueKind::InvalidSplitTile),
            "invalid_split_tile_group" => Some(IssueKind::InvalidSplitTileGroup),
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

    /// Unions `other`'s source checks and details into `self` — the meta-only half of every
    /// `IssueMerge::merge` impl; each impl still merges its own data fields on top of this.
    pub(crate) fn merge_from(&mut self, other: IssueMeta) {
        for source in other.source_checks() {
            self.push_source(source);
        }
        self.merge_details(other.details);
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

    fn source_checks(&self) -> &[String] {
        self.meta().source_checks()
    }

    fn details(&self) -> &HashMap<String, HashMap<&'static str, String>> {
        self.meta().details()
    }
}

/// Generates the identical `Issue` impl every concrete issue type needs — `kind()`/`meta()`/
/// `meta_mut()`/`as_any()` all just delegate to `Self::KIND` and the type's own `meta` field.
/// Requires the struct to name its `IssueMeta` field `meta` and already have `IssueKindConst`
/// implemented (for `Self::KIND`).
#[macro_export]
macro_rules! impl_issue {
    ($ty:ty) => {
        impl $crate::quality_control::issue::Issue for $ty {
            fn kind(&self) -> $crate::quality_control::issue::IssueKind { Self::KIND }
            fn meta(&self) -> &$crate::quality_control::issue::IssueMeta { &self.meta }
            fn meta_mut(&mut self) -> &mut $crate::quality_control::issue::IssueMeta { &mut self.meta }
            fn as_any(&self) -> &dyn std::any::Any { self }
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
