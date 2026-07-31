# Quality Control

A read-only analysis pass that detects problems in a `Maze` and produces a list of `Issue` values. Runs before and after each repair iteration in the pipeline.

## Core Concepts

### IssueKind

```rust
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
    TeleportGroupProximity,
    MissingSplitTiles,
    InvalidSplitNode,
}
```

`LoopDistanceFromStartCheck`/`LoopDistanceFromFinishCheck` (below) reuse `InvalidLoop` — no new `IssueKind` variant, same as every other check flagging cycles invalid for a check-specific reason.

`InvalidLoopGroup` is a distinct kind from `InvalidLoop`, not a reuse — mirrors `TeleportGroupProximity`'s split from `InvalidTeleport` (below). Where `InvalidLoop` flags a single cycle invalid on its own terms, `InvalidLoopGroup` flags cycles selected as part of a group-level decision across every loop on the field (currently `MaxLoopDensityCheck`'s excess field-density and `MaxLoopsCountCheck`'s excess independent-loop count). Carries `InvalidLoopGroupIssue` — `invalid: Vec<Vec<EdgeId>>`/`valid: Vec<Vec<EdgeId>>` (direct cycle lists, not `InvalidLoopIssue`'s `all`/index scheme) plus `invalid_sources`, see that type's doc comment. Every producing check flags the *entire* field-wide cycle set invalid at once when it fires (no partial selection at the check level) — see GitHub issue #183. `InvalidLoopGroupSelectStrategy` (see `Specs/repair.md`'s "Built-in Strategies") is the registered repair strategy: it samples a subset of the flagged cycles and delegates breaking each one to a nested `INVALID_LOOP` strategy.

`MissingLoops` mirrors `InvalidLoop`'s role, but for a missing-count condition (too few loops overall) instead of a specific invalid cycle — currently produced by `MinLoopsCountCheck`/`MinLoopDensityCheck`; future checks needing more loops added may reuse this kind rather than inventing a new one.

`MissingSplitTiles` mirrors `MissingLoops`'s role, but for a deficit in the count of split tiles (GitHub issue #247, part of epic #246) instead of loops — currently produced by `SplitCountCheck`/`SplitDensityCheck`. Carries `MissingSplitTilesIssue { missing: u32 }` — same "just the deficit count" shape as `MissingLoopsIssue`/`MissingRegionsIssue`, see "Built-in Checks" below. Repaired by `AddSplitStrategy` (see `repair.md`).

`InvalidSplitNode` — see GitHub issue #250, part of epic #246. A single split node (any node of a split tile, slot-0 included) is invalid for some check-specific reason — currently `SplitNodeConnectionCountCheck` (the node's connection count, filtered by direction, compares against a configured threshold). Distinct from `InvalidSplitTile`: that kind's unit of work is a whole tile (`SplitTileNodes`), this one's is a single node (`NodeId`) — a check here may flag slot-0 itself (epic #246's "slot-0 is not otherwise special" rule), but the registered repair strategy (`RemoveSplitNodeStrategy`) still never removes it, mirroring the hard constraint every strategy in this epic shares. Carries `InvalidSplitNodeIssue { invalid: Vec<NodeId>, .. }` — see that type's doc comment.

`InvalidSplitNodeConnectionGroup` — see GitHub issue #251, part of epic #246. A field-wide/relationship condition over a split tile's own outgoing connections: too many of them (from different nodes of the same split) converge on the same single outside neighbor, or go out through the same tile face direction. Distinct from both `InvalidSplitNode` (a single node's own connection *count*) and `InvalidSplitTile`/`InvalidSplitTileGroup` (excess node *count*, not excess *connections*). Produced by `SplitNodeConnectionPerNeighborCheck`/`SplitNodeConnectionPerFaceCheck` — distinct check types, same "no dual-metric check" rationale as `OneWayGroupGeometricProximityCheck`/`OneWayGroupGraphProximityCheck`. Carries `InvalidSplitNodeConnectionGroupIssue { groups, invalid_sources, .. }` — a type alias onto the generic `InvalidGroupIssue<SplitNodeConnectionGroupKind>` shape (`Element = EdgeId`), same as `InvalidOneWayGroupIssue`/`InvalidTeleportGroupIssue`. Repaired by `SplitNodeConnectionGroupSelectStrategy`, which delegates each candidate connection's removal to a nested `INVALID_SPLIT_NODE_CONNECTION` strategy (`RemoveSplitNodeConnectionStrategy`) — mirrors `OneWayGroupSelectStrategy`'s shape.

`InvalidSplitRoute` — see GitHub issue #277, part of epic #246. Flags a whole traversal *route* (an ordered sequence of edges), not a single node, a single connection, or an unordered group: a graph path shorter than a configured minimum detour connecting two nodes of the same split tile, suggesting the split doesn't meaningfully separate its own paths. Distinct from `InvalidSplitNodeConnectionGroup` (an earlier design iteration of the same check carried only the path's two endpoint edges as a proximity-style pair; superseded because a repair strategy needs the *whole* path to be able to cut any edge along the way, not just the two ends). Carries `InvalidSplitRouteIssue { routes: Vec<Vec<SplitRouteEdge>>, invalid_sources, .. }` where `SplitRouteEdge = (EdgeId, bool)` — the `bool` marks an edge incident to the split tile the route was found for (`from`/`to` resolves to that tile's own point). `routes`' order is significant (a route is a path, not a set) and, unlike every cycle/group `Issue` type, entries are deduplicated by *exact* sequence identity on merge, never by edge-set — two different routes sharing edges (or the same edges in a different order) are kept as distinct entries. Produced by `SplitNodeConnectionTraversalDistanceCheck`. Repaired by `SplitRouteCutStrategy`.

### SplitNodeConnectionTraversalDistanceCheck

GitHub issue #277, part of epic #246. For each ordered pair `(a, b)` of a split tile's own nodes (`a != b`), runs a directed BFS from `a` over the raw `maze.graph` (not the corridor-compressed `NavGraph` — same "count every real hop" rationale `MissingTeleportsStrategy::bfs_distances` uses), capped at `min_detour - 1` steps with early exit once `b` is reached. If found, the whole found path is flagged as one route — every edge along it, in traversal order, each paired with whether it's incident to the split tile itself. Both directions (`a -> b` and `b -> a`) are checked independently and, when both are found short, recorded as two separate routes — directed edges mean a short path one way doesn't guarantee one the other way, and each route may need its own cut. `min_detour` (default 10) is the minimum path length a pair must clear; a path of exactly `min_detour` steps is not flagged, only strictly shorter.

`InvalidSplitNodeGroup` — see GitHub issue #252, part of epic #246. A single split tile's node count exceeds a configured maximum — distinct from `InvalidSplitNodeConnectionGroup` (excess *connections*, not excess *node count*) and from `InvalidSplitTile`/`InvalidSplitTileGroup` (whose unit of work is a whole tile collapsing back to slot-0, not picking individual excess nodes to remove from an otherwise-kept tile). Produced by `MaxSplitTileNodeCountCheck` — fixed "too many" semantics only (no generic `Comparison`, unlike `SplitNodeConnectionCountCheck`): the only registered repair strategy for this kind can only remove nodes, so a "too few" comparison would have no way to ever resolve. Carries `InvalidSplitNodeGroupIssue { groups, invalid_sources, .. }` — a type alias onto the generic `InvalidGroupIssue<SplitNodeGroupKind>` shape (`Element = NodeId`), one group per over-limit split tile, `to_remove` = excess node count over the max. Repaired by `SplitNodeGroupSelectStrategy`, which delegates each candidate node's removal to a nested `INVALID_SPLIT_NODE` strategy (`RemoveSplitNodeStrategy`) — never selects a tile's slot-0.

Each variant has a canonical string representation used in serialization and config:

```rust
impl IssueKind {
    pub fn as_str(self) -> &'static str { ... }   // "missing_endpoints", etc.
    pub fn from_str(s: &str) -> Option<Self> { ... }
}
```

Named constants alias the variants for use across crates:

```rust
pub const MISSING_ENDPOINTS: IssueKind = IssueKind::MissingEndpoints;
pub const UNREACHABLE_FINISH: IssueKind = IssueKind::UnreachableFinish;
pub const INVALID_LOOP:       IssueKind = IssueKind::InvalidLoop;
pub const INVALID_LOOP_GROUP: IssueKind = IssueKind::InvalidLoopGroup;
pub const MISSING_LOOPS:      IssueKind = IssueKind::MissingLoops;
pub const CYCLE_ANALYSIS_OVERFLOWED: IssueKind = IssueKind::CycleAnalysisOverflowed;
pub const INVALID_TELEPORT:  IssueKind = IssueKind::InvalidTeleport;
pub const MISSING_SPLIT_TILES: IssueKind = IssueKind::MissingSplitTiles;
```

`IssueKind` still exists exactly as above and remains the runtime-erased representation used for
config, DTOs, and serialization — see "Issue trait and the 12 concrete types" below for how it
relates to the type-level `Issue` design (GitHub issue #113).

`MissingRegions` mirrors `MissingLoops`'s role, but for a deficit in the count of regions of a specific `RegionClass` (Path/Alternative/Unreachable/Trap — see "Region Classes" in `graph-analytics.md`) instead of overall loop count — currently produced only by `MinRegionCountCheck`.

`InvalidTeleport` mirrors `InvalidLoop`'s role, but for a `Teleport` edge (`EdgeKind::Teleport`) flagged invalid for a check-specific reason instead of a cycle — see GitHub issue #74. Currently produced by `TeleportDuplicatesConnectionCheck` (a regular connection already duplicates the teleport), `TeleportWaypointDistanceCheck` (the teleport's distance to a waypoint compares against a configured threshold), `TeleportGeometricLengthCheck` (the teleport's geometric length compares against a configured threshold), and `TeleportSuperHubAvoidanceCheck` (an endpoint vertex already has too many outgoing connections). Carries `IssueData::InvalidTeleports` — see that variant's doc comment. Repaired by `RemoveTeleportStrategy` (see `repair.md`).

`TeleportGroupProximity` is a distinct kind from `InvalidTeleport`, not a reuse — see GitHub issue #75. Where `InvalidTeleport` flags a single teleport edge invalid on its own, `TeleportGroupProximity` flags a *relationship* between two teleport edges (neither individually invalid). Currently produced only by `TeleportGroupProximityCheck`. Carries `InvalidTeleportGroupIssue { groups, invalid_sources, .. }` — since GitHub issue #209, a type alias onto the generic `InvalidGroupIssue<TeleportGroupKind>` shape (see the `InvalidGroupIssue<K>` writeup below), each problematic pair expressed as a two-element `groups` entry paired with `to_remove: 1`. Repaired by `TeleportGroupSelectStrategy`, which delegates to the same shared `group_select_apply` mechanics `OneWayGroupSelectStrategy` uses (see `repair.md`).

`InvalidOneWay` mirrors `InvalidTeleport`'s role, but for a one-way passage edge (`EdgeKind::Basic`, single direction — the opposite direction between the same node pair does not exist) flagged invalid for a check-specific reason instead of a teleport — see GitHub issue #198, part of the one-way management epic (#92). Currently produced only by `OneWayWaypointDistanceCheck` (the one-way's distance to a waypoint compares against a configured threshold). Carries `InvalidOneWayIssue { invalid, invalid_sources, .. }` — same `EdgeId`-list shape as `InvalidTeleportIssue`, see that type's doc comment. Two repair strategies are registered against this kind — `OneWayToPassageStrategy` (completes the flagged edge into a full bidirectional passage) and `OneWayToWallStrategy` (removes the flagged edge entirely) — a rule picks exactly one, same as any other kind with more than one registered strategy.

`InvalidOneWayGroup` mirrors `TeleportGroupProximity`'s role, but for one-way edges instead of teleports — see GitHub issue #199, generalized in #200 and #202, part of the one-way management epic (#92). Where `InvalidOneWay` flags a single one-way edge invalid on its own, `InvalidOneWayGroup` flags a *relationship*/*aggregate* condition over two or more one-way edges (none individually invalid). Produced by five checks sharing the same issue shape: `OneWayGroupGeometricProximityCheck`/`OneWayGroupGraphProximityCheck` (proximity pairs, Euclidean vs. topological distance — kept as two distinct check types rather than one dual-metric check, mirroring how `TeleportGeometricLengthCheck`/`TeleportGraphDistanceCheck` stay separate), `OneWayGroupSuperHubCheck` (per-vertex excess connection count), and `MaxOneWayCountCheck`/`MaxOneWayRatioCheck` (maze-wide count/ratio excess). Carries `InvalidOneWayGroupIssue { groups, invalid_sources, .. }`, shaped as `groups: Vec<(Vec<EdgeId>, u32)>` pairing each group's edge set with how many of its edges still need fixing, so the repair strategy can uniformly handle any group size and any per-group fix count — same generic `InvalidGroupIssue<K>` shape `InvalidTeleportGroupIssue` uses (see below), `OneWayGroupKind` in place of `TeleportGroupKind`. Repaired by `OneWayGroupSelectStrategy` (see `repair.md`).

**`InvalidGroupIssue<K>` (GitHub issue #208, extended to teleports in #209)** — `InvalidOneWayGroupIssue`/`InvalidTeleportGroupIssue` are both type aliases (`InvalidGroupIssue<OneWayGroupKind>`, `InvalidGroupIssue<TeleportGroupKind>`) onto a generic "group of elements paired with a per-group fix count" shape extracted into `quality_control::issue_kinds::group_issue`. `K: InvalidGroupIssueKind` is a zero-sized marker type selecting the instantiation — purely data: `type Element` (the type of one group member; `EdgeId` for both `OneWayGroupKind` and `TeleportGroupKind`), `const KIND` (the `IssueKind` this instantiation carries), and `const NESTED_KIND`/`NESTED_SLOT_ID` (identifying the nested-strategy slot `group_select_apply`'s caller delegates each candidate's fix to). `groups: Vec<(Vec<K::Element>, u32)>` and `invalid_sources: HashMap<Vec<K::Element>, Vec<String>>` are the same fields `InvalidOneWayGroupIssue` always had, generic over `K::Element` instead of hardcoded to `EdgeId`; `IssueMerge::merge` is the same canonical-group-key dedup/max-`to_remove` algorithm, unchanged in behavior. For `TeleportGroupKind`, every group is exactly two elements (`to_remove: 1`) — one `TeleportGroupProximityCheck`-flagged pair per group, the pair-vs-arbitrary-group-size distinction `InvalidOneWayGroup`'s five checks needed doesn't apply here.

**GitHub issue #210: nested-issue-building and candidate-invalidation moved out of `K`, into the calling strategy.** Pre-#210, `InvalidGroupIssueKind` carried `fn nested_issue`/`fn resolved_elements` as trait methods, one impl per `K`. `group_select_apply` (see `repair.md`) now takes these as ordinary closure parameters (`build_nested_issue`, `element_invalidated`) supplied by the calling `RepairStrategy::apply` instead — only the strategy has the full picture of what its own nested slot actually needs. `element_invalidated(element, nested_commands, maze) -> bool` replaces the old fixed `resolved_elements` list with a per-candidate hook: `OneWayGroupSelectStrategy` flags a candidate invalidated when it equals a removed edge id; `TeleportGroupSelectStrategy` additionally checks `Graph::teleport_reverse` against the pre-mutation `maze` snapshot, since `removed_edge_ids` never surfaces a `RemoveTeleportWithReverse` command's reverse id (GitHub issue #171's known gap). The offered `target` itself always counts as invalidated regardless of what the hook says (mirrors the old `resolved_elements` contract of always including `target`), since a nested strategy that converts rather than removes it (e.g. `OneWayToPassageStrategy`) must still retire its own budget.

**Scope note**: `InvalidLoopGroupIssue` is shaped differently (a cycle-set with `valid`/`invalid` context, not a flat group list) and is not migrated onto this shape — its own unit of fix is a cycle (`Vec<EdgeId>`), but the nested strategy cuts one *edge inside* the offered cycle, not the cycle itself, and scores that pick well only when it sees several invalid cycles at once (see `InvalidLoopScoredStrategy`'s cross-cycle `short_overlap` term, `repair.md`) — `group_select_apply`'s one-candidate-per-nested-call contract would force every cycle through its own isolated call, losing that cross-cycle signal. GitHub issue #210 explored this migration and reverted it for exactly this reason; `InvalidLoopGroupSelectStrategy` stays its own bespoke batch-sample implementation (see `repair.md`).

Always use the named constant — never use string literals or enum variants inline.

**Hard rule: `IssueKind` is a semantic category, not a producer id.** `InvalidLoop` means "this cycle is invalid for some check-specific reason" — it does not identify *which* check found it. Multiple checks (or multiple instances of the same check, e.g. two `LoopLengthCheck` instances with different `comparison`/`length`) can legitimately produce the same `IssueKind` for different underlying reasons; future checks may flag cycles invalid for still other reasons and reuse this same kind rather than inventing a new one per reason. Which check(s) actually contributed to a given `Issue` is tracked separately, in `Issue.source_checks` (below) — never by adding more `IssueKind` variants.

`RegionNeedsExpansion` mirrors `InvalidLoop`'s role for SCC regions: a semantic category ("this region needs to be expanded for some check-specific reason"), not tied to size specifically or to any one reason. Currently produced by `MinRegionSizeCheck` (region smaller than a configured absolute tile count) and `MinRegionRatioCheck` (region smaller than a configured share of the field), but future checks may flag a region as needing expansion for reasons unrelated to size and reuse this same kind. Carries `IssueData::RegionsNeedingExpansion` — see that variant's doc comment.

`RegionNeedsShrink` — see GitHub issue #177 — mirrors `RegionNeedsExpansion`'s role for the opposite direction: a region that needs to be shrunk for some check-specific reason. Currently produced by `MaxRegionSizeCheck`/`MaxRegionRatioCheck`. Kept a **distinct** `IssueKind` from `RegionNeedsExpansion` rather than merged via `Comparison` — see the "Comparison operator" section above: min/max region size name different corrective actions (grow vs. shrink), not the same action with a different comparison direction, so they get separate kinds, check types, and (eventually) repair strategies. **No repair strategy is registered for this kind yet** — see GitHub issue #181; a `RegionNeedsShrinkIssue` surfaces in the QC report but is never auto-fixed until that follow-up lands. Carries `RegionNeedsShrinkIssue` — see that type's doc comment.

**`CycleAnalysisOverflowed` is not a toggleable QC check** — every other kind here is produced by a `Check<T, I>` implementation the user selects via `config.checks`; this one is raised directly by `build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) whenever `GraphAnalytics::cycle_analysis_overflowed` is true (cycle enumeration aborted past `MAX_SIMPLE_CYCLES` — see `graph-analytics.md`). It bypasses `QualityControlEngine` entirely: `build_analytics_snapshot` pushes `Box::new(CycleAnalysisOverflowedIssue::default())` straight into the issue list after the engine (or `issues_override`) has already run, so it surfaces unconditionally — same `IssuesBlock`/`FeatureCard` UI as any other issue, but with no corresponding `Check<T, I>` or `RepairStrategy` and no way for a user to disable it. `IssueKind::from_str` still parses it like any other kind (used to validate `config.strategies` keys), but no strategy can ever be registered against it — see `from_str`'s doc comment.

### Issue trait and the 12 concrete types

See GitHub issue #113. `Issue` used to be one concrete struct with a runtime `kind: IssueKind`
field and an `Option<IssueData>` payload — nothing in the type system connected a `Check`'s
output, a `Rule`'s configured `kind`, and the `RepairStrategy` it dispatched to, so a mismatch
between them was only ever caught (if at all) by a handful of manual
`debug_assert_eq!(issue.kind, self.handles())` calls. `Issue` is now a **trait**, with one
concrete type per former `IssueKind` variant living in `quality_control::issue_kinds`:
`MissingEndpointsIssue`, `UnreachableFinishIssue`, `InvalidLoopIssue`, `MissingLoopsIssue`,
`CycleAnalysisOverflowedIssue`, `RepairLimitReachedIssue`,
`ExcessiveSccCountIssue`, `RegionNeedsExpansionIssue`, `MissingRegionsIssue`,
`InvalidTeleportIssue`, `InvalidTeleportGroupIssue`. `Check<T, I>`, `RepairStrategy<T, I>`, and
`Rule<T, I>` are all generic over the concrete `I` — the compiler now guarantees that a `Rule`'s
checks and its one strategy agree on exactly which `Issue` type they produce/consume; there is no
longer a runtime `kind` field on `Rule` to independently agree with.

```rust
pub trait Issue: std::any::Any {
    fn kind(&self) -> IssueKind;               // object-safe mirror of Self::KIND, for dyn Issue callers
    fn meta(&self) -> &IssueMeta;
    fn meta_mut(&mut self) -> &mut IssueMeta;
    fn as_any(&self) -> &dyn std::any::Any;     // downcast entry point at the erased boundary

    fn source_checks(&self) -> &[String] { self.meta().source_checks() }
    fn details(&self) -> &HashMap<String, HashMap<&'static str, String>> { self.meta().details() }
}

/// Split out from `Issue` itself only because associated consts with a `where Self: Sized` bound
/// aren't stable yet (`generic_const_items`) — logically part of the same contract.
pub trait IssueKindConst: Issue + Sized {
    const KIND: IssueKind;
}

/// Not object-safe (`Self: Sized`) — never called through `dyn Issue`/`Box<dyn Issue>`. Only
/// called from `Rule<T, I>::run_checks_typed`, where `I` is statically known.
pub trait IssueMerge: Issue + IssueKindConst {
    fn merge(&mut self, other: Self);
}

/// See GitHub issue #105. Describes what subset of `Self` a `RepairStrategy<T, Self>` may ask its
/// producing `Check` to compute — every concrete `Issue` type implements this (`type Requirement
/// = ()` where no narrower variant exists yet), so `Check<T, I>`/`RepairStrategy<T, I>` can bound
/// on it uniformly instead of splitting into two parallel trait hierarchies. `Self::Requirement::
/// default()` **must** mean "compute everything" — `Check::report_check`'s default body has no
/// strategy to consult and always passes the default.
pub trait IssueRequirement: Issue {
    type Requirement: Default + Copy + 'static;
}
```

**`InvalidLoopIssue`'s `Requirement` — a bitflags layer set, not the whole story yet.**
`InvalidLoopRequirement` (in `issue_kinds/invalid_loop.rs`) is a `bitflags!` type with one flag,
`VALID_CYCLES`. A `Check` producing `InvalidLoopIssue` always builds the base layer (the flagged/
invalid cycles, resolved to `EdgeId`s); `VALID_CYCLES` set additionally resolves every non-flagged
cycle into `all` and builds `invalid_sources` — unset, `all`/`invalid` cover only the flagged
cycles (re-indexed from `0`) and `invalid_sources` stays empty. `Default` is `Self::all()` (every
flag set), per `IssueRequirement`'s contract, via a hand-written `impl Default` (the `bitflags!`
macro's own derive would give `empty()` instead). Bitflags were chosen over a plain enum so a
future second, independent layer doesn't force a combinatorial variant explosion (`Full`,
`SourceOnly`, `SourceAndFull`, ...) — each new layer is one more flag, requestable independently of
the others. A strategy requests a set of flags via `RepairStrategy::requirement()` (see
`repair.md`'s "RepairStrategy trait" section) — it must name the specific flag(s) its `apply()`
actually reads (e.g. `InvalidLoopRequirement::VALID_CYCLES`), not `all()`, unless it genuinely needs
every layer that exists today; `all()` used as a stand-in for "the one flag I need" silently starts
requesting any future flag too.

`dyn Issue` is object-safe through exactly `kind()`/`meta()`/`meta_mut()`/`as_any()` — the only
methods callable on `&dyn Issue`/`Box<dyn Issue>`. `const KIND` (via `IssueKindConst`) and `merge`
(via `IssueMerge`) are **not** object-safe and are never called through the erased boundary —
everywhere `Self` is statically known, code reads `Self::KIND` directly, never `self.kind()`.
(Pre-GitHub-issue-#170, `Issue` also carried object-safe `eq_dyn`/`clone_box` methods solely for
`Stage`'s no-progress fingerprint — removed along with that guard, since nothing else needed them.)

Each concrete type carries its own data fields directly (what used to be one `IssueData` enum
variant) plus a shared `meta: IssueMeta` for `source_checks`/`details` bookkeeping:

```rust
pub struct InvalidLoopIssue {
    meta: IssueMeta,   // private — see accessors below
    pub all: Vec<Vec<EdgeId>>,
    pub invalid: Vec<usize>,
    pub invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
}
impl InvalidLoopIssue {
    pub fn new_from_check(source_check: &str, all: Vec<Vec<EdgeId>>, invalid: Vec<usize>, invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>) -> Self;
    pub fn with_detail(self, source_check: &str, key: &'static str, value: String) -> Self;  // chainable
}
```

**`source_checks`/`details` carry a rule-scoped composite id, not a check type id** — see GitHub
issue #60. Two active configurations of the same check type (e.g. two `min_region_count`
instances, each with its own `region_class`/`count`) need distinct routing identity, so the
string here is `{rule_id}:{local_id}` (built once, by `composite_check_id()` in
`maze-runner`/`maze-wasm`'s `runner.rs`, never reconstructed or parsed back apart anywhere in
`maze_core`). Treat it as opaque: compare and pass it through, never split on `:`.

Every concrete type is mostly an **internal QC artifact** — its own data fields are plumbing
between a `Check<T, I>` and the matching `RepairStrategy<T, I>` within one QC pass and are never
serialized (see "Not exposed over WASM" below). `kind()`, `source_checks()`, and `details()` are
the exception: the WASM layer (`maze-wasm/src/analytics.rs`) does serialize these into `IssueDto`
for the web UI, downcasting `&dyn Issue` to whichever concrete type it needs a payload from (e.g.
`InvalidLoopIssue`/`RegionNeedsExpansionIssue` for `IssuePayloadDto`, `RepairLimitReachedIssue`
for its own no-source-check detail entry — see "IssueDto" below).

`IssueMeta`'s `source_checks`/`details` fields are private, mutated only via `push_source`/
`merge_details` (both `pub(crate)`, called exclusively from each concrete type's own `IssueMerge`
impl) — nothing outside a merge can append to `source_checks` or construct an issue with an
already-multi-source list before merge has legitimately produced one. `details` carries **raw
display values only** — e.g. a check's configured threshold as a string — keyed by source check
composite id, then by detail key. Never an assembled message: wording belongs entirely to the web
UI's own i18n layer (see `quality-feature.md`'s issue rendering section — the web side needs
`IssueDto.source_check_types` to recover the type id from the composite instance id for this
lookup).

**Erased boundary — where `Box<dyn Issue>` is unavoidable.** Two places in the pipeline need
genuine cross-`I` heterogeneity and stay type-erased by design:
- `Stage.rules: Vec<Box<dyn RuleTrait<T>>>` — a `Stage` deliberately groups rules of different
  concrete `Issue` types together. `RuleTrait<T>` is the erased view of `Rule<T, I>` for exactly
  this boundary — `report_checks` returns `Vec<Box<dyn Issue>>`. Since GitHub issue #170,
  `check_and_repair` (the one erased entry point covering both checking and repair dispatch) never
  takes or returns a `Box<dyn Issue>`/`&dyn Issue` at all — the merged issue stays entirely inside
  `Rule<T, I>::check_and_repair_typed`'s own generic `I`, never erased in the first place, so there
  is no downcast for this call to get wrong.
- Nested-strategy slots (`NestedStrategyConfig<T>`, see `repair.md`) — a parent strategy's own `I`
  and its nested strategy's `I` are independent (e.g. `ReduceSccCountStrategy` handles
  `ExcessiveSccCountIssue` but delegates to a `RegionNeedsExpansionIssue`-handling nested
  strategy). `ErasedRepairStrategy<T>` is the erased view of `RepairStrategy<T, I>` for this
  boundary.

Both erased boundaries downcast via `Issue::as_any()` + `downcast_ref::<ConcreteType>()`, and both
document the invariant the caller must uphold instead of runtime-validating it on every call — the
compile-time-checked path (a `Rule<T, I>`'s own checks and strategy) never needs this at all;
only the two genuinely-heterogeneous boundaries above do.

- **Dedup interaction**: multiple checks may produce an issue of the same concrete type in one QC pass. The pipeline (see `repair.md`'s "Pipeline" section) **merges** them into a single issue via `IssueMerge::merge` rather than keeping only the first and dropping the rest. The merge rule is per-concrete-type: for `InvalidLoopIssue`, cycles are merged canonically (a cycle is identified by its edge set, not by `Vec` order, so the same cycle found by two checks collapses to one entry instead of being duplicated); `invalid_sources` is unioned per canonical key (no remap needed); `source_checks`/`details` (via `IssueMeta`) are unioned. A type whose fields have no sensible merge rule is a `debug_assert!`/panic in debug builds, not a silent pick-one-side fallback.
- **Not exposed over WASM**: the WASM layer serializes `kind()`, `source_checks()`, and `details()` (see `IssueDto` below) but never a concrete type's own data fields directly — those stay internal, Check-to-Strategy plumbing only, except where `analytics.rs` explicitly downcasts to build a payload DTO (`InvalidLoopIssue`/`RegionNeedsExpansionIssue`) or a synthetic detail entry (`RepairLimitReachedIssue`, raised outside any `Check<T, I>` — see its own doc comment in `issue_kinds/`).

### Check trait

```rust
pub trait Check<T: Tessellation, I: IssueRequirement> {
    fn check_type_id(&self) -> &'static str;

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<I>, rng: &mut dyn RngCore, requirement: I::Requirement);

    fn report_check(&self, maze: &Maze<T>, rng: &mut dyn RngCore) -> Vec<I> {
        let mut issues = Vec::new();
        self.repair_check(maze, &mut issues, rng, I::Requirement::default());
        issues
    }
}
```

**`requirement` — see GitHub issue #105.** The bound rule's strategy's `RepairStrategy::requirement()`
(see `repair.md`'s "RepairStrategy trait" section), resolved once by `Rule::new` — not re-resolved
per fixpoint iteration — and threaded into every `repair_check` call that rule makes. A check is
free to ignore it and always compute the maximal `I` (the correct, safe default for a check that
hasn't been migrated to branch on it — e.g. any check whose `I::Requirement` is `()`, or an
`InvalidLoopIssue`-producing check that hasn't been taught to skip `VALID_CYCLES` resolution).
`report_check`'s default body always passes `I::Requirement::default()` — it has no strategy to
consult, and `IssueRequirement`'s contract fixes `default()` to mean "compute everything", so the
final QC report is never accidentally built from a narrowed issue.

- **Read-only**: `maze` is immutable. A `Check` must not mutate any state.
- **No side effects**: neither method may access global state or perform I/O.
- **`rng` is available but currently unused by every check**: all checks (including `MaxLoopDensityCheck`/`MaxLoopsCountCheck` — both flag their entire field-wide cycle set at once rather than picking a subset, see `INVALID_LOOP_GROUP`'s doc comment) ignore it (`_rng`) and stay fully deterministic; which cycles get sampled for actual repair is a *repair strategy*'s job (`InvalidLoopGroupSelectStrategy`, see `repair.md`), not the check's. `Rule::run_checks_typed`/`report_checks_typed` (see `repair.md`'s "Rule, Stage, and the unified QualityControlEngine" section, GitHub issue #106) still take `rng` from their caller (ultimately the pipeline's per-`build_maze`-call `MazeRng`, seeded from the generation seed) so a future randomized check can draw from it without a signature change, and so a whole QC pass stays reproducible for a given seed.
- A check may produce zero or more issues per call.
- A check may read `maze.analysis` to avoid redundant computation.
- **`repair_check` vs `report_check`** — see GitHub issue #102. Both methods detect the exact same problems; they differ only in how many issue values they produce per flagged instance:
  - `repair_check` is the detection the repair fixpoint loop (`Rule::run_checks_typed`, driven by `Stage::run_repair`) drives. It may bundle every flagged problem instance into one merged issue per call (e.g. `LoopLengthCheck` bundles all flagged cycles into one `InvalidLoopIssue { all, invalid, invalid_sources }`), since the loop dispatches one repair strategy call per rule against the whole batch — batching there is a feature, not a limitation, of the repair-dispatch contract.
  - `report_check` is the detection the final QC report (`remaining_issues`, analytics, UI) drives — driven by `Rule::report_checks_typed`, called both by `build_maze`'s final report pass and by `build_analytics_snapshot`'s check-only path (unified since GitHub issue #106; see `repair.md`). It must produce one issue per flagged problem instance instead, since a batched issue can't be split into accurate per-item counts, per-item highlighting, or (eventually) one-issue-per-cycle repair dispatch. Default implementation delegates to `repair_check` (calls it into a temporary `Vec` and returns it) — no behavior change for a check that doesn't override it.
  - Both methods return/populate the same concrete `I` — there is no separate report-only issue type.
  - `check_type_id()` identifies the check **type** (e.g. `"loop_length"`), used by `Rule::run_checks_typed`/`report_checks_typed` to aggregate per-check-type timing — distinct from `instance_id`, the per-instance composite routing key.

### QualityControlEngine, Rule, and Stage

See GitHub issue #106 (Stage/Rule ownership) and GitHub issue #113 (`Rule<T, I>` typing).
`QualityControlEngine` is not a flat holder of `checks: Vec<Box<dyn Check<T, I>>>` — it owns an
ordered list of `Stage<T>`s, each owning `Vec<Box<dyn RuleTrait<T>>>` (erased — see "Erased
boundary" above), each concrete `Rule<T, I>` owning its own checks plus (optionally) one
`RepairStrategy<T, I>`, all sharing the same `I`. Merging issues of the same concrete type
produced by different checks **within one `Rule`** (not dropping duplicates) is that `Rule`'s own
responsibility (`Rule::run_checks_typed`, via `IssueMerge::merge`) — see `repair.md`'s "Rule,
Stage, and the unified QualityControlEngine" section for the full type shapes and dispatch
algorithm, and the "Dedup interaction" note above for the per-type merge rules themselves. A
`Rule`'s checks always run in the order they were configured, same as the pre-#106 flat engine's
insertion order.

### Narration-level debug instrumentation (`QcEvent`)

See GitHub issue #147. Mirrors the narration-level `EventLog` instrumentation already built for
every generation algorithm (`Specs/event_log.md`) — a debug-events run threads an optional
`EventLog<QcEvent>`/`ScopeGuard<QcEvent>` through the whole repair fixpoint call chain
(`QualityControlEngine::run_full` → `run_repair_stages` → `Stage::run_repair` →
`check_and_dispatch` → `RuleTrait::check_and_repair` → `Rule::check_and_repair_typed` →
`apply_commands`, `quality_control/rule.rs`), the same zero-cost `Option<&mut T>` opt-out pattern
every other instrumented pass already uses — every signature in this chain grows one extra
parameter, always the last, always `None` on the normal (non-debug) path. `build_maze`
(`generation/pipeline.rs`) forwards its own `event_log` parameter straight into `run_full` —
`maze-wasm/src/runner.rs::run_generate` is the only caller that builds a real `EventLog::new()`
(when `config.debug_events` is set) and is also the single place that calls
`crate::event_log::merge_tapes` to fold this QC tape together with generation's own tape into one
merged arena (see `Specs/event_log.md`'s "#147" notes on why `merge_tapes` moved out of
`generate_maze_with_events` for this).

**Only the repair loop is instrumented — `run_check_only` (the check-only path
`build_analytics_snapshot` uses) is not.** There is no narrative of iterations/dispatch there,
only a flat report pass, so no `EventLog` parameter was added to it.

**Scope shape** — nested `"stage <id>"` → `"iteration N"` → `"rule <id>"`, with two further
scopes nested inside `"rule <id>"` only when that rule's strategy was actually dispatched:
- `run_repair_stages` opens one `"stage {stage.id}"` scope per `Stage` (named by the stage's own
  opaque `id`, not its user-facing `name` — see below).
- `Stage::run_repair` opens one `"iteration N"` scope (`enter_numbered("iteration")`, mirrors RB's
  `"step N"`) per fixpoint pass, emitting `IterationStarted(n)` on entry and
  `IterationLimitReached(kind)` on the corresponding exit path (no event for a clean
  `StageOutcome::Done` — convergence is visible as "no further iterations").
- `Rule::check_and_repair_typed` opens one `"rule {rule.id}"` scope per rule, always (whether or
  not any check found anything) — `run_checks_typed` emits one `CheckRan` per check directly into
  it, then `IssuesMerged` once if more than one check contributed to the same merged issue. If a
  check found an issue and this rule has a registered strategy, two more scopes open as *siblings*
  inside `"rule <id>"`, in order:
  - `"strategy {strategy_id}"`, holding one `*Proposed` event per `MutationCommand` the strategy's
    `apply()` returned — narrating what was *asked for*, before any of it is revalidated.
  - `"apply requests"` (only when the strategy proposed at least one command), holding the
    mutating/`*Declined` event `apply_commands` emits for each of those same commands as it
    revalidates and applies them. This scope's own label is resolved from its children's
    mutating-vs-`*Declined` counts (`"Apply requests (applied/total)"`) rather than a dedicated
    summary event — mirrors `CustomVertexBased`'s `"junction_count"` scope label precedent
    (`Specs/event_log.md`'s Contract C section) — there is no `QcEvent` carrying `proposed`/
    `applied` directly.

Every scope is opened and dropped **within its own block** inside the loop body that creates it —
a `ScopeGuard` kept alive across a loop iteration boundary would keep the parent guard borrowed and
the borrow checker would refuse to let it `emit` on the next pass (same caveat
`Specs/event_log.md`'s `ScopeGuard::enter` doc describes for Wilson's `"walk N"` scope).

**Scope ids are opaque wire strings, not display titles.** `"stage <id>"`/`"rule <id>"` embed each
`Stage`/`Rule`'s own config `id` (a client-generated string, e.g. `rule_<uuid>`) — core has no
concept of a rule's user-facing `name` at all (`QcRuleConfig` on the wire carries only `id`;
`StageConfig` carries both `id` and `name`, but only `id` is ever embedded in a scope name). The
web replay UI resolves a scope's id to its current display title itself, live from the running
store's config (`maze-web/src/debug/algorithmRegistry.ts`'s `ScopeTitleLookup`) rather than having
core send the title across the wire — a title round-tripped through the wire would be exactly as
stale after a later rename as one resolved from the live store, so there is no correctness argument
for sending it, only unnecessary wire/type surface.

**Trace events**:
- `IterationStarted(u32)` — one fixpoint pass began (`Stage`-level).
- `CheckRan { check_id, issue: Option<(IssueKind, IssuePayload, HashMap<&'static str, String>)> }` —
  one check within a rule ran this iteration (`Rule`-level, emitted by `run_checks_typed`).
  `check_id` (GitHub issue #171) is the check's own *instance* id — the composite
  `"{rule_id}:{local_id}"` routing key `IssueMeta::source_checks`/`details` are keyed by (see
  `issue.rs`'s doc comment on `new_from_check`), not its `check_type_id()` — matches
  `IssueDto.source_checks`/`details`' own keys, so web-side narration resolves this check's display
  label/detail the same way `IssuesBlock`'s `IssueBubble` does (via the live rule/check config,
  `CheckInstance.typeId`), not a second independent lookup. `issue: None` when this check found
  nothing this call — emitted for every check regardless of outcome, so narration can show "check X
  found nothing" too. `IssuePayload` is resolved via `resolve_issue_payload`
  (`quality_control::issue_payload`, shared with `maze-wasm/src/analytics.rs`'s JSON
  `IssuePayloadDto` — same source of truth, no second independently-maintained downcast/resolve
  copy) against an `scc` built once per `run_checks_typed` call (lazily, only when
  `event_log.is_some()`), resolved for each check immediately as that check runs — before this
  rule's own strategy dispatch (if any) might mutate the maze afterward. The third tuple element
  (GitHub issue #171) is this one check's own raw display details (`Issue::details().get(check_id)`
  — same values `IssueDto.details` carries for the analytics panel), empty for the majority of
  issue kinds that record no detail.
- `IssuesMerged { kind: IssueKind, payload: IssuePayload, details: HashMap<String, HashMap<&'static str, String>> }` —
  two or more of this rule's checks each found an issue of the same `kind` this iteration, and
  `IssueMerge::merge` folded them into one. Emitted once per rule iteration, only when a merge
  actually happened — a rule with a single contributing check never emits this. `payload` (GitHub
  issue #171) is the *merged* issue's own structural data, resolved the same way `CheckRan`'s
  per-check payload is (`resolve_issue_payload` against the same `scc`) — lets narration highlight
  the final combined set of flagged cycles/regions, not only a single contributing check's own.
  `details` (GitHub issue #171) is the merged issue's full `Issue::details()` map, keyed by every
  contributing check's own instance id — narration shows one "reason" per contributing check when
  there's more than one, mirroring how `IssuesBlock` renders one bubble per `source_checks` entry
  for a merged `IssueDto`.
- `IterationLimitReached(RepairLimitKind)` — the shared `RepairBudget` was exhausted. The only way
  a stage's fixpoint loop stops without converging — GitHub issue #170 removed the previous
  no-progress guard (both the `(rule_id, Issue)` value-equality check and the "commands dropped"
  streak) as unreliable and easily defeated; `RepairLimits` (see `repair.md`) is now the sole
  termination guarantee, enforced once at construction rather than re-checked every iteration.

There is no dedicated "rule dispatch result" event — a rule's applied/proposed repair outcome is
narrated by resolving the `"apply requests"` scope's own label from its children's mutating-vs-
`*Declined` counts (see the "Scope shape" note above), not a summary event carrying
`RepairResult`/`ApplyOutcome` fields directly. The one exception is `RepairResult::Failed` itself:
`StrategyFailed { strategy_id: &'static str }` (GitHub issue #248) is emitted into the `"strategy
<id>"` scope, alongside that strategy's own `*Proposed` events, whenever `apply()` returns `Failed`
this iteration — one shared trace event for every strategy (not a dedicated variant per strategy
type), since "this strategy gave up" carries the same narration meaning regardless of which
strategy it was. `strategy_id` duplicates the scope name's own strategy id so a caller with only
the flat event (no scope context) can still tell which strategy failed.

**Proposed events — one variant per `repair::MutationCommand` variant (12 total)**
(`DirectedEdgeProposed`, `BidirectionalEdgeProposed`, `DirectedTeleportProposed`,
`BidirectionalTeleportProposed`, `EdgeRemoveProposed`, `EdgeRemoveBetweenProposed`,
`EdgeRemoveWithReverseProposed`, `TeleportRemoveWithReverseProposed`, `StartSetProposed`,
`FinishSetProposed`, `NodeRemoveProposed`, `PointNodesReplaceProposed`) — emitted into the `"strategy <id>"` scope for every
command a strategy's `apply()` returned, before any of them has been revalidated or applied by
`apply_commands`. Narrates what was *asked for*, independent of whether the separate "apply
requests" scope right after actually honors it. Not a field-for-field mirror for all 11:
`RemoveEdge`/`RemoveEdgeWithReverse`/`RemoveTeleportWithReverse` carry only an opaque `EdgeId`,
meaningless to web-side narration on its own —
`EdgeRemoveProposed`/`EdgeRemoveWithReverseProposed`/`TeleportRemoveWithReverseProposed` instead
carry the resolved `(from: NodeId, to: NodeId)` pair, read off the still-intact graph before
anything is mutated (GitHub issue #171's follow-up fix). If resolution fails (stale id), no event
is emitted for that command rather than fabricating a `(0, 0)` pair — node id `0` is a real, valid
id, so a fabricated pair would be indistinguishable from a genuine edge. `NodeRemoveProposed`
(GitHub issue #248) carries `node: NodeId` directly — a node's own id is meaningful on its own,
unlike an `EdgeId`, so no resolution step is needed.

**Mutating events — one variant per `repair::MutationCommand` variant (12 total)**
(`DirectedEdgeAdded`, `BidirectionalEdgeAdded`, `DirectedTeleportAdded`,
`BidirectionalTeleportAdded`, `EdgeRemoved`, `EdgeRemovedBetween`, `EdgeRemovedWithReverse`,
`TeleportRemovedWithReverse`, `StartSet`, `FinishSet`, `NodeRemoved`, `PointNodesReplaced`) — emitted by
`apply_commands` (`quality_control/rule.rs`) for exactly the commands its own revalidation
actually applied (`is_mutating()` is `true` for these twelve and only these twelve).
`NodeRemoved(NodeId)` (GitHub issue #248) narrates `MutationCommand::RemoveNode` actually applied —
see `Specs/repair.md`'s `RemoveNode`/`RemoveSplitStrategy` sections for what removes a node and
why. `PointNodesReplaced { at: NodeId, old_nodes: Vec<NodeId>, new_nodes: Vec<NodeId>, nodes: Vec<Vec<SplitNodeEdge>> }`
(GitHub issue #247) narrates `MutationCommand::ReplacePointNodes` actually applied — see
`Specs/repair.md`'s `AddSplitStrategy` section for what replaces a split tile's nodes and why;
`old_nodes` is every node that was at `at`'s point before the command ran (slot-0 included),
`new_nodes` is the freshly minted replacement ids (one per `nodes` entry, same order, `new_nodes[0]`
the new slot-0) — both distinct from `at`, which only identifies the affected point and does not
necessarily survive the command. Each also has a same-fields,
trace-only `*Declined` counterpart (`DirectedEdgeDeclined`, etc.) emitted when revalidation rejects
a proposed command — one dedicated variant per command kind rather than a single payload-less
`CommandDeclined`, so narration/tests can say exactly which command failed revalidation, not just
that some command did. A `*Declined` variant encodes to the exact same bytes as its mutating mirror
except for the wire tag — see `quality_control/event.rs`'s own test. Same `EdgeId → (from, to)`
resolution as the Proposed events above applies here too:
`EdgeRemoved`/`EdgeRemoveDeclined`/`EdgeRemovedWithReverse`/`EdgeRemoveWithReverseDeclined`/
`TeleportRemovedWithReverse`/`TeleportRemoveWithReverseDeclined` carry the edge's endpoints,
resolved from the graph immediately before removal (`apply_commands` snapshots them ahead of its
own mutating `match`, since `graph.edge(id)` returns `None` once the edge is gone); a resolution
failure again means no event is emitted, never a fabricated `(0, 0)` pair. `apply_commands` emits
every event itself, inline in its existing per-command loop (not returned to the caller for logging
elsewhere) — it is the only place that knows both the command's real fields (already at hand from
the `match`) and its actual revalidation outcome; a caller re-deriving that from `ApplyOutcome`'s
aggregate counts couldn't tell *which* command in a multi-command batch was declined.

**`reverse_removed` (GitHub issue #185's follow-up fix)** — `EdgeRemovedWithReverse`/
`EdgeRemoveWithReverseDeclined`/`TeleportRemovedWithReverse`/`TeleportRemoveWithReverseDeclined`
each carry an extra `reverse_removed: bool` field beyond `from`/`to`, sourced straight from
`try_remove_edge_with_reverse`/`try_remove_teleport_with_reverse`'s own `Vec<EdgeId>` return length
(`> 1` means the reverse leg genuinely existed and was removed too), not assumed from the
command's shape. Without this, a replay consumer folding these events into a `(from,to)` +
`(to,from)` keyed accumulator (web-side `applyQc`, `qc.ts`) would have no way to tell "both
directions removed" from "only the primary was, because the reverse never existed" — a one-way
edge/teleport that degenerates one of these commands to a single-direction removal would otherwise
have its non-existent reverse blindly cleared too, fabricating a phantom removed-edge entry. On the
`*Declined` variants this field is always `false` (a declined command means
`try_remove_edge_with_reverse`/`try_remove_teleport_with_reverse` removed nothing at all, so the
reverse can't have been removed either) — carried anyway so the field shape stays identical between
a mutating variant and its own `*Declined` mirror, same "same bytes except the tag" property every
other pair already has. Wire-encoded as one trailing byte after `from`/`to` (`0`/`1`), pushing these
four variants' payload from 16 to 17 bytes — `Proposed`-shaped mirrors of these two commands
(`EdgeRemoveWithReverseProposed`/`TeleportRemoveWithReverseProposed`) do **not** carry this field:
proposal time is before revalidation, so whether the reverse will actually be removed isn't known
yet, and nothing downstream consumes it at that stage.

**No `DebugValueDelta`/`DebugMapDelta`/`DebugVertexDelta` impls** — QC has no natural analogue to a
generation algorithm's "debug value" (RB's `recursion_stack`, Wilson's `current_walk`, etc.);
deliberately out of scope, not a gap.

**Wire tags** are assigned via `#[wire(tag = N)]` attributes on each `QcEvent` variant, generated
into `quality_control/qc_wire.rs`'s `wire_tags` module by `codegen` (`Specs/event_log.md`'s
"Wire-Format Codegen" section) — never hand-typed. Ordinary local tags in `1..=44` (well under the
255 a single source's local tag byte allows) — namespaced by source index only when `merge_tapes`
folds this tape together with generation's, same mechanism every merged source already uses
(`Specs/event_log.md`'s "#169" section). `38`/`39`/`40` are
`NodeRemoved`/`NodeRemoveDeclined`/`NodeRemoveProposed` (GitHub issue #248); `41` is
`StrategyFailed`; `42`/`43`/`44` are `PointNodesReplaced`/`PointNodesReplaceDeclined`/
`PointNodesReplaceProposed` (GitHub issue #247). `CheckRan.issue`/`IssuesMerged`'s `issue_kind`/
`payload`/`details` fields go through named custom codecs (`CheckIssueCodec`/`IssueKindCodec`/
`IssuePayloadCodec`/`DetailsMapMapCodec`) rather than standard wire types — see that same codegen
section for the whitelist mechanism.

## Built-in Checks

### MissingEndpointsCheck

Produces `MissingEndpointsIssue::new_from_check(instance_id, missing_start, missing_finish)` — `missing_start`/`missing_finish` set from `maze.meta.start`/`maze.meta.finish` being `None` — if either is missing. The issue itself is the source of truth for *which* endpoint(s) are absent; every registered `RepairStrategy` (`ScoredEndpointsStrategy`, `FarthestEndpointsStrategy`, `RandomEndpointsStrategy`) branches on `issue.missing_start`/`issue.missing_finish`, not on re-reading `maze.meta` directly — see GitHub issue #215. `IssueMerge::merge` ORs the flags from multiple contributing checks (`missing_start = a.missing_start || b.missing_start`, same for `missing_finish`), same union rule every other boolean-flag-bearing merge in this file uses.

### UnreachableFinishCheck

Produces `UnreachableFinishIssue::new_from_check("unreachable_finish")` if both `maze.meta.start` and `maze.meta.finish` are `Some` but `finish` is not reachable from `start` via directed graph traversal.

Skips the check silently if either endpoint is `None` — those cases are covered by `MissingEndpointsCheck`.

### Comparison operator (`Comparison`)

```rust
pub enum Comparison { Lt, Gt, Le, Ge, Eq }
```

`Comparison` (`quality_control::comparison`) — see GitHub issue #177. A shared operator for checks that validate a single entity's numeric property against a threshold, letting a min/max pair whose two directions both flag the *same* problem on the *same* entity (4.2, "this entity is invalid" — same `IssueKind`, same repair strategy) merge into one check type instead of staying two near-duplicate types. `comparison.compare(value, threshold)`/`compare_f64` return whether `value` triggers the check for that operator.

**When to merge, when not to** — the rule that decides whether a min/max pair becomes one `Comparison`-parametrized check or stays two separate checks:
- **Merge** when both directions validate one entity and both name the *same* corrective action (4.2 checks) — e.g. `LoopLengthCheck`'s `Lt`/`Gt` both mean "this cycle is invalid, cut it", so `min_loop_length`/`max_loop_length` merged into one `loop_length` check type. `TeleportGeometricLengthCheck` and `TeleportWaypointDistanceCheck`'s `comparison` param follow the same rule.
- **Do not merge** when the two directions name *different* corrective actions — a deficit (4.1, "add more") vs. a surplus (4.3, "remove the excess") are semantically different problems even when they're a min/max pair on the same metric, so they keep separate `IssueKind`s, separate check types, and separate repair strategies. `MinRegionSizeCheck`/`MaxRegionSizeCheck` (and their `*_ratio` counterparts) are the standing example: `min_region_size` flags `REGION_NEEDS_EXPANSION` (grow the region), `max_region_size` flags `REGION_NEEDS_SHRINK` (shrink it) — see `REGION_NEEDS_SHRINK`'s doc comment. Count-vs-count pairs (`min_loops_count`/`max_loops_count`, `min_region_count`'s balance) follow the same non-merge rule for the same reason — `min_loops_count` flags `MISSING_LOOPS` (add more), `max_loops_count` flags `INVALID_LOOP_GROUP` (break the excess).

### MinLoopsCountCheck / MinLoopDensityCheck

```rust
pub const MIN_LOOPS_DEFAULT: u32 = 1;

pub struct MinLoopsCountCheck {
    pub min_loops: u32,
}

pub const MIN_LOOP_DENSITY_DEFAULT: u32 = 30;
pub const AVG_LOOP_LENGTH_ESTIMATE_DEFAULT: u32 = 10;

pub struct MinLoopDensityCheck {
    pub min_density: u32,
    pub avg_loop_length_estimate: u32,
}
```

Two separate check types, both flagging `MISSING_LOOPS`. GitHub issue #177 originally merged these into one `MinLoopsCheck` parametrized by a `LoopsMode` enum (`Absolute`/`Ratio`); that merge was reverted — an absolute count and a field-coverage share are genuinely different metrics with no shared "same corrective action on the same entity" relationship (see the "Comparison operator" section's merge rule above), so they don't belong in one check type the way a `Comparison`-parametrized min/max pair does.

`MinLoopsCountCheck` (`check_type_id() == "min_loops_count"`) — counts loops via `maze.analysis.graph_analytics(&maze.graph, &maze.meta).cycle_count` — the **independent** cycle count (Euler's formula, `E - V + C` on the pure-cycle core, see `graph-analytics.md`), the same number shown to the user as the "Cycle count" analytics stat. Deliberately **not** `find_deduped_simple_cycles`'s raw simple-cycle enumeration: that is a different (usually much larger) metric, and using it here would make this check disagree with what the UI displays as the maze's loop count. Silently skips (no issue) when `graph_analytics.cycle_analysis_overflowed` is true, same overflow rationale as the simple-cycle checks below (shared underlying enumeration). If `cycle_count` is below `min_loops`, `missing = min_loops.saturating_sub(cycle_count)`.

`MinLoopDensityCheck` (`check_type_id() == "min_loop_density"`) — flags too few loops when too small a share of the field is covered by loops overall. Symmetric counterpart to `MaxLoopDensityCheck` (below): same **density** metric (count of distinct field cells covered by any simple loop, a cell shared by several loops counted once, expressed per 100 field cells via `maze.field.point_count()`), same cycle enumeration pipeline (`nav_graph` → `find_deduped_simple_cycles` → `resolve_to_edge_ids`), same silent skip on `CycleSearchResult::TooManyCycles` overflow — but checked against a **minimum** instead of a maximum, and producing `MISSING_LOOPS` (a loop-count deficit) instead of `INVALID_LOOP_GROUP` (specific cycles to cut), since adding loops rather than removing them is the only way to raise coverage. If density is at or above `min_density`, the check is silent. If density is below `min_density`, the deficit is converted from a cell count into a loop count: `missing_cells = (min_density - density) * field_cells / 100`, then `missing = ceil(missing_cells / avg_loop_length_estimate)` — rounded up so the request never undershoots the actual deficit (the repair strategy can always add more loops than asked, but never fewer to safely close the gap, since `avg_loop_length_estimate` is only an estimate, not a guarantee any newly added loop covers exactly that many cells).

Either way, if `missing` is `0`, the check is silent; otherwise fires `MissingLoopsIssue::new_from_check(instance_id, missing)` with `.with_detail(instance_id, "missing", missing.to_string())` chained on — the same detail key regardless of which check type fired, so the web UI's per-source-check label resolver renders both with one shared message shape. Repaired by `MissingLoopsRandomStrategy` (see `repair.md`) — no strategy-side branching on which check produced the issue, since both types produce the same `MissingLoopsIssue` shape.

### CycleKind (cycle-directionality filter)

```rust
pub enum CycleKind { Any, TwoWay, OneWay }
```

`CycleKind` (`quality_control::cycle_kind`) — see GitHub issue #217. A shared per-check option on the `cycle_check_core::find_invalid_cycles` skeleton (below), letting a user restrict a loop-based check to a specific cycle directionality instead of one threshold applying to every cycle regardless of shape. `Any` (the default, reproducing pre-#217 behavior) considers every cycle; `TwoWay` restricts to cycles where every nav-edge has a `reverse_edge` (see `nav-graph.md`'s "Reverse edge linking") — a fully bidirectional loop; `OneWay` restricts to cycles containing at least one nav-edge with no `reverse_edge`. Every check built on `find_invalid_cycles` (`LoopLengthCheck`, `ExternalEscapeDiversityCheck`, `LoopDistanceFromStartCheck`, `LoopDistanceFromFinishCheck`) picks this filter up automatically via a `cycle_kind: CycleKind` field, applied inside `find_invalid_cycles` itself before the check's own predicate runs — no check reimplements the directionality test.

### cycle_check_core (shared loop-check skeleton)

`quality_control::checks::cycle_check_core` — see GitHub issue #107. `find_invalid_cycles(maze, cycle_kind, invalid)` builds the nav graph, enumerates simple cycles (`find_deduped_simple_cycles`), restricts them to `cycle_kind`, then applies the caller's own `invalid` predicate to the surviving cycles — silently skipping (returning `None`) if enumeration overflows (`CycleSearchResult::TooManyCycles`, issue #22) or nothing is flagged. `build_issue` resolves the flagged (and, per `InvalidLoopRequirement`, valid) cycles into an `InvalidLoopIssue`. Every loop-based check owns only its own predicate and detail key/value; cycle enumeration, the `cycle_kind` filter, and issue-building are shared.

### LoopLengthCheck

```rust
pub const LOOP_LENGTH_DEFAULT: u32 = 10;

pub struct LoopLengthCheck {
    pub comparison: Comparison,
    pub length: u32,
    pub cycle_kind: CycleKind,
}
```

Merges the former `MinLoopLengthCheck`/`MaxLoopLengthCheck` — see GitHub issue #177's "Comparison operator" rule above (`comparison: Lt` reproduces the old `min_loop_length`'s "shorter than" behavior, `Gt` reproduces `max_loop_length`'s "longer than"; `Le`/`Ge`/`Eq` are new). `check_type_id() == "loop_length"`.

A separate, unrelated check from `MinLoopsCountCheck`/`MinLoopDensityCheck` (those count total loops; this one checks individual loop *length*). Uses `maze.analysis.nav_graph(&maze.graph, &maze.meta)` (the shared, pinned-by-`meta` cache — see `analysis.md`), then `find_all_simple_cycles` (`maze-core/src/graph/cycles.rs`, Johnson's algorithm — see `graph-analytics.md` for the full description of this shared, single-source-of-truth cycle enumeration), `dedup_bidirectional_pairs` (collapses each visual loop walked in either direction to one entry, drops trivial reverse-pair turn-arounds). Every resulting cycle (short and long alike) is resolved to base-`Graph` `EdgeId`s and stored in `InvalidLoopIssue.all`; the subset satisfying `comparison.compare(tile_length, length)` becomes `invalid` (indices into `all`).

Not a fundamental cycle basis — a basis only yields β₁ cycles relative to one spanning tree and can miss short cycles that are the symmetric difference of two longer fundamental cycles (unacceptable false negatives for a health check). `find_all_simple_cycles` enumerates ALL simple directed cycles with no length bound; this check filters the already-complete result by tile-length afterward, rather than embedding a bound into the search itself (kept uniform with the other consumers of `find_all_simple_cycles` — see `graph-analytics.md`).

Self-loop nav-edges (junction-free rings) are included — previously a known gap (a ring with at most one junction compresses into a self-loop `NavEdge` that the old `build_cyclic_core` unconditionally excluded, making such loops invisible to this check). Fixed by `find_all_simple_cycles` treating self-loops as first-class cycles.

If any cycles satisfy `comparison` against `length` (`invalid` non-empty), fires a single `InvalidLoopIssue::new_from_check("loop_length", all, invalid, invalid_sources)` with `.with_detail("loop_length", "threshold", self.length.to_string())` chained on — the configured threshold, for the web UI to render a specific message instead of the generic `INVALID_LOOP` label. No issue is fired if `invalid` is empty, even if `all` is not. Other checks may also produce `INVALID_LOOP` issues for different reasons in the same pass — see the pipeline's merge behavior in `repair.md`. Two active `loop_length` instances with different `comparison`/`length` (e.g. one `Lt` and one `Gt`) reproduce the pre-#177 "both min and max active" configuration — they merge into one `INVALID_LOOP` issue per the same dedup rule.

`cycle_kind` (GitHub issue #217, see `CycleKind`'s doc comment above) restricts which enumerated cycles this check evaluates by directionality — `Any` (default) considers every cycle, `TwoWay` only cycles with every edge bidirectional, `OneWay` only cycles containing at least one edge with no reverse.

### ExternalEscapeDiversityCheck

```rust
pub const EXTERNAL_ESCAPE_DIVERSITY_DEFAULT: u32 = 3;

pub struct ExternalEscapeDiversityCheck {
    pub min_distinct_exits: u32,
    pub cycle_kind: CycleKind,
}
```

Detects cycles that are "locally trapped" despite having many outgoing connections — see issue #32. Uses the same enumeration pipeline as `LoopLengthCheck` (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs`, same silent skip on `CycleSearchResult::TooManyCycles`), but the filter is purely topological rather than length- or geometry-based: for each cycle, collect the set of cycle vertices (nav-nodes touched by any of its nav-edges), then count the distinct nav-nodes outside that set reached by a direct outgoing nav-edge from any cycle vertex (`distinct_exit_count`). No further traversal past that one hop, no geometry, no connected-component analysis on the rest of the graph — a cycle with 8 outgoing edges that all land on the same external node scores 1, not 8.

If any cycle's distinct exit count is below `min_distinct_exits`, fires a single `InvalidLoopIssue::new_from_check("external_escape_diversity", all, invalid, invalid_sources)` with `.with_detail("external_escape_diversity", "min_distinct_exits", self.min_distinct_exits.to_string())` chained on. No issue is fired if `invalid` is empty. Can be active alongside `LoopLengthCheck` — both merge into one `INVALID_LOOP` issue per the same dedup rule.

`cycle_kind` (GitHub issue #217) restricts which enumerated cycles this check evaluates by directionality — see `CycleKind`'s doc comment above.

### LoopDistanceFromStartCheck

```rust
pub const LOOP_DISTANCE_FROM_START_DEFAULT: u32 = 0;

pub struct LoopDistanceFromStartCheck {
    pub min_distance_from_start: u32,
    pub cycle_kind: CycleKind,
}
```

Flags simple cycles placed too close to `meta.start` in progression space — see GitHub issue #33. Uses `maze.analysis.distance_from_start` (`HashMap<NavNodeId, usize>`, tile distance, lazily computed and cached — see `graph-analytics.md`'s "Distance Maps" section), then the same cycle enumeration pipeline as the other loop checks (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs`, same silent skip on `CycleSearchResult::TooManyCycles`). A cycle's distance from start is the **minimum** tile distance among all nav-nodes the cycle touches (every `from`/`to` endpoint of its nav-edges) — the cycle's closest point to start, not its average or farthest — computed by `cycle_min_distance` (`maze-core/src/graph/distance_map.rs`), the single shared reduction `LoopDistanceFromFinishCheck` (below) reuses too, rather than each check carrying its own copy. A nav-node unreachable from start is excluded from that minimum; if every touched nav-node is unreachable the cycle is treated as having no defined distance and never flagged.

Silently skips (no issue, no panic) if `meta.start` is unset — `distance_from_start` returns `None` in that case, and that failure mode belongs to `MissingEndpointsCheck`, not this check.

Default `0` never fires on its own — the threshold has no natural default (unlike a tile-length minimum), so the check is a no-op until a user picks a value. If any cycles closer than the threshold are found, fires a single `InvalidLoopIssue::new_from_check("loop_distance_from_start", all, invalid, invalid_sources)` with `.with_detail("loop_distance_from_start", "min_distance_from_start", self.min_distance_from_start.to_string())` chained on. Can be active alongside any other `INVALID_LOOP`-producing check — all merge into one issue per the same dedup rule.

`cycle_kind` (GitHub issue #217) restricts which enumerated cycles this check evaluates by directionality — see `CycleKind`'s doc comment above.

### LoopDistanceFromFinishCheck

```rust
pub const LOOP_DISTANCE_FROM_FINISH_DEFAULT: u32 = 0;

pub struct LoopDistanceFromFinishCheck {
    pub min_distance_from_finish: u32,
    pub cycle_kind: CycleKind,
}
```

Symmetric counterpart to `LoopDistanceFromStartCheck` — flags simple cycles placed too close to `meta.finish` instead. Uses `maze.analysis.distance_from_finish` (distance **to** finish, following directed edges backward), same cycle enumeration pipeline, same "minimum among touched nav-nodes" rule, same silent skip on missing `meta.finish` or `TooManyCycles` overflow.

Fires `InvalidLoopIssue::new_from_check("loop_distance_from_finish", all, invalid, invalid_sources)` with `.with_detail("loop_distance_from_finish", "min_distance_from_finish", self.min_distance_from_finish.to_string())` chained on.

`cycle_kind` (GitHub issue #217) restricts which enumerated cycles this check evaluates by directionality — see `CycleKind`'s doc comment above.

### MaxLoopDensityCheck

```rust
pub const MAX_LOOP_DENSITY_DEFAULT: u32 = 30;

pub struct MaxLoopDensityCheck {
    pub max_density: u32,
}
```

Flags every simple loop invalid when too large a share of the field is covered by loops overall — see GitHub issue #37. Unlike the other loop checks, this one judges the maze's loops as a set rather than each cycle independently — which is also why it flags `INVALID_LOOP_GROUP` rather than `INVALID_LOOP`: a flagged loop here isn't invalid on its own terms (the way a too-short or too-long loop is), it's picked as part of a group-level decision across every loop on the field. See `INVALID_LOOP_GROUP`'s doc comment and `InvalidLoopGroupIssue` (`invalid`/`valid: Vec<Vec<EdgeId>>`, distinct type/kind from `InvalidLoopIssue`'s `all`/index scheme).

Same cycle enumeration pipeline as the other loop checks (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs`, same silent skip on `CycleSearchResult::TooManyCycles` overflow), then resolves every cycle to its base-`Graph` `EdgeId`s via `resolve_to_edge_ids` same as the others, but additionally maps each cycle's edges to the set of base-`Graph` `NodeId`s (cells) its edges touch. **Density** is the count of distinct field cells covered by any loop (a cell shared by several loops counts once), expressed per 100 field cells (`maze.field.point_count()`): `covered_cells * 100 / field_cells`. If density is at or below `max_density`, the check is silent — same as every other loop check producing no issue when nothing is wrong.

If density exceeds `max_density`, the check does **not** pick a subset — it flags every enumerated loop `invalid` at once (`valid` stays empty). Deciding *which* loops to actually break is a repair strategy's job (`InvalidLoopGroupSelectStrategy`, see `repair.md`), not this check's — see GitHub issue #183. This is why `rng` goes unused here (see the `Check` trait's `rng` note above): there is no per-check selection to randomize.

Fires a single `InvalidLoopGroupIssue::new_from_check("max_loop_density", invalid, vec![], invalid_sources)` with `.with_detail("max_loop_density", "max_density", self.max_density.to_string())` chained on.

### MaxLoopsCountCheck

```rust
pub const MAX_LOOPS_COUNT_DEFAULT: u32 = 20;

pub struct MaxLoopsCountCheck {
    pub max_loops_count: u32,
}
```

Count-based sibling of `MaxLoopDensityCheck` — see GitHub issue #37/#183 and the `Comparison` section's count-vs-count merge rule above (kept a separate check type from `min_loops_count` since a deficit and a surplus name different corrective actions). Also flags `INVALID_LOOP_GROUP`, same all-or-nothing semantics as `MaxLoopDensityCheck` (the check flags every loop it finds `invalid` at once when it fires; picking a subset to actually break is `InvalidLoopGroupSelectStrategy`'s job).

**The fire/no-fire threshold compares against `analytics.cycle_count`** — the same independent-cycle count (Euler's formula, `E - V + C` on the pure-cycle core, see `graph-analytics.md`) shown to the user as the "Cycle count" analytics stat, and what `MinLoopsCountCheck` already compares against. This is deliberately **not** the raw count from `find_deduped_simple_cycles`'s simple-cycle enumeration, which also counts every composite cycle (a union of two or more independent loops walked as one bigger loop) and so is a much larger, unstable number — comparing against it would make the check refire on the same composite cycle indefinitely even after every independent loop underneath it has already been broken down to the target count. Once `cycle_count` exceeds `max_loops_count`, the check falls back to `find_deduped_simple_cycles` to actually build the flagged (and offered-to-repair) cycle list — a repair strategy needs concrete edge-id cycles to cut, and cutting any one of them (independent or composite) lowers `cycle_count` by exactly one, so the raw simple-cycle enumeration is the right shape for `invalid` even though it's the wrong shape for the threshold comparison. Silently skips (no issue) if `analytics.cycle_analysis_overflowed`.

Fires a single `InvalidLoopGroupIssue::new_from_check("max_loops_count", invalid, vec![], invalid_sources)` with `.with_detail("max_loops_count", "max_loops_count", self.max_loops_count.to_string())` chained on.

`max_loop_density` and `max_loops_count` are currently the only two checks producing `INVALID_LOOP_GROUP` — if both are active in the same rule, they merge via `InvalidLoopGroupIssue`'s own `IssueMerge` impl (a dedicated implementation, not a reuse of `InvalidLoopIssue`'s `merge_cycle_sets`, since the two types no longer share the same `all`/index field shape): `invalid`/`valid` are deduped independently by `canonical_cycle_key`, and a cycle flagged invalid by either side wins over the other side calling it valid — see that type's doc comment for the exact rule.

`InvalidLoopGroupSelectStrategy` (see `repair.md`'s "Built-in Strategies") is the registered repair strategy for `INVALID_LOOP_GROUP`.

### SccCountCheck

```rust
pub const MAX_SCC_COUNT_DEFAULT: u32 = 1;

pub struct SccCountCheck {
    pub max_scc_count: u32,
}
```

Flags an excessively fragmented graph — see GitHub issue #48. Uses `maze.analysis.scc(&maze.graph)` (cached per `graph.version()` — see `analysis.md`), itself backed by `build_scc` (`maze-core/src/graph/scc.rs`, Tarjan's algorithm), rather than re-implementing or directly recomputing SCC; counts `ConnectedComponents::components.len()`. If the count is at or below `max_scc_count`, the check is silent. If it exceeds `max_scc_count`, fires `ExcessiveSccCountIssue::new_from_check("scc_count", self.max_scc_count)` with `.with_detail("scc_count", "max_scc_count", self.max_scc_count.to_string())` and `.with_detail("scc_count", "scc_count", count.to_string())` chained on — both raw values for the web UI to render a specific message, `max_scc_count` for `ReduceSccCountStrategy` (see `repair.md`) to compute how many regions to merge.

### MinRegionSizeCheck

```rust
pub const MIN_REGION_SIZE_DEFAULT: u32 = 20;

pub struct MinRegionSizeCheck {
    pub min_region_size: u32,
    pub region_classes: Vec<RegionClass>,
}
```

Flags SCC regions with fewer tiles than a configured absolute minimum — see GitHub issue #50. Uses `maze.analysis.scc(&maze.graph)` (same cache `SccCountCheck` reads), and flags every component whose `len()` is below `min_region_size`. If no region is undersized, the check is silent. Otherwise fires a single `RegionNeedsExpansionIssue::new_from_check("min_region_size", invalid, invalid_sources)` with `.with_detail("min_region_size", "min_region_size", self.min_region_size.to_string())` chained on — `invalid` holds every undersized component's index into `scc.components`.

`region_classes` restricts the check to SCC regions of the listed `RegionClass`(es) (Path/Alternative/Unreachable/Trap — see `graph-analytics.md`'s "Region Classes" section) — see GitHub issue #54. Empty means no region matches (the check is always silent). All four classes (`ALL_REGION_CLASSES`, the wasm layer's `"all"` dropdown option) means every region is checked, the pre-#54 behavior, and skips computing `RegionClass`es entirely (no `start`/`finish` requirement in that case). For any other non-empty subset, the check additionally needs `maze.analysis.region_classes(&maze.graph, start, finish)` to look up each component's class; if either `maze.meta.start` or `maze.meta.finish` is `None`, the check is silent (classification unavailable — same failure mode `MinRegionCountCheck` has).

### MinRegionRatioCheck

```rust
pub const MIN_REGION_RATIO_DEFAULT: u32 = 25;

pub struct MinRegionRatioCheck {
    pub min_region_ratio: u32,
    pub region_classes: Vec<RegionClass>,
}
```

Counterpart to `MinRegionSizeCheck` using a relative threshold instead of an absolute tile count — see GitHub issue #50. Flags every SCC region covering less than `min_region_ratio` percent of the field (`maze.field.point_count()`): `region.len() * 100 < min_region_ratio * field_cells`. Silently skips (no issue) if the field has zero cells. If no region is undersized, the check is silent. Otherwise fires a single `RegionNeedsExpansionIssue::new_from_check("min_region_ratio", invalid, invalid_sources)` with `.with_detail("min_region_ratio", "min_region_ratio", self.min_region_ratio.to_string())` chained on.

`region_classes` works exactly as for `MinRegionSizeCheck` above — see GitHub issue #54.

Can be active alongside `MinRegionSizeCheck` — both produce `REGION_NEEDS_EXPANSION` and merge into one issue (see `merge_regions_needing_expansion` in `repair.md`'s "Pipeline" section): since both checks read the same `scc()` cache entry within one QC pass, a region's component index is stable across the merge, so unioning `invalid` and `invalid_sources` needs no remap, unlike the cycle-index remap `merge_invalid_loops` must do.

### MaxRegionSizeCheck

```rust
pub const MAX_REGION_SIZE_DEFAULT: u32 = 1_000_000;

pub struct MaxRegionSizeCheck {
    pub max_region_size: u32,
    pub region_classes: Vec<RegionClass>,
}
```

Flags SCC regions with more tiles than a configured absolute maximum — see GitHub issue #177. Symmetric counterpart to `MinRegionSizeCheck`, but flags `REGION_NEEDS_SHRINK` (a distinct issue kind — see that kind's doc comment above for why this isn't a `Comparison`-merged variant of `MinRegionSizeCheck`) instead of `REGION_NEEDS_EXPANSION`. Uses the same `scc()` cache, flags every component whose `len()` is above `max_region_size`. If no region is oversized, the check is silent. Otherwise fires a single `RegionNeedsShrinkIssue::new_from_check("max_region_size", invalid, invalid_sources)` with `.with_detail("max_region_size", "max_region_size", self.max_region_size.to_string())` chained on.

`region_classes` works exactly as for `MinRegionSizeCheck` — see GitHub issue #54.

**No repair strategy is registered for `REGION_NEEDS_SHRINK` yet** — see GitHub issue #181.

### MaxRegionRatioCheck

```rust
pub const MAX_REGION_RATIO_DEFAULT: u32 = 75;

pub struct MaxRegionRatioCheck {
    pub max_region_ratio: u32,
    pub region_classes: Vec<RegionClass>,
}
```

Counterpart to `MaxRegionSizeCheck` using a relative threshold instead of an absolute tile count — see GitHub issue #177, mirrors `MinRegionRatioCheck`'s relationship to `MinRegionSizeCheck`. Flags every SCC region covering more than `max_region_ratio` percent of the field: `region.len() * 100 > max_region_ratio * field_cells`. Silently skips (no issue) if the field has zero cells. Otherwise fires a single `RegionNeedsShrinkIssue::new_from_check("max_region_ratio", invalid, invalid_sources)` with `.with_detail("max_region_ratio", "max_region_ratio", self.max_region_ratio.to_string())` chained on.

`region_classes` works exactly as for `MinRegionSizeCheck` — see GitHub issue #54. Can be active alongside `MaxRegionSizeCheck` — both produce `REGION_NEEDS_SHRINK` and merge into one issue, same rationale as `MinRegionSizeCheck`/`MinRegionRatioCheck`'s merge.

### MinRegionCountCheck

```rust
pub const MIN_REGION_COUNT_DEFAULT: u32 = 0;

pub struct MinRegionCountCheck {
    pub min_counts: HashMap<RegionClass, u32>,
}
```

Flags a region-count shortfall or surplus per `RegionClass` (Path/Alternative/Unreachable/Trap — see `graph-analytics.md`'s "Region Classes" section) — see GitHub issue #55 and issue #59's "Region Balance" data model. Lets a user enforce structural variety (e.g. guarantee at least N trap or alternative-route regions) instead of only constraining individual region size/ratio, and lets `MissingRegionsStrategy` (see `repair.md`) spend any class's surplus above its minimum when fixing a different class's shortfall.

A single instance carries one `min_count` threshold per class (`MIN_REGION_COUNT_DEFAULT = 0` — unset, that class is never checked either way). Unlike before GitHub issue #60 (retired), there is normally exactly **one** active instance: it evaluates all four classes' counts in one pass rather than needing one instance per class.

Uses `maze.analysis.region_classes(&maze.graph, start, finish)` and counts entries per class. Silently skips (no issue) if either `maze.meta.start` or `maze.meta.finish` is `None` — same as `UnreachableFinishCheck`/the loop-distance checks, that failure mode belongs to `MissingEndpointsCheck`, not this check. For each class with a non-zero configured minimum, computes `balance = count as i64 - min_count as i64`; a class at exactly its minimum (`balance == 0`) is omitted from the result entirely — only off-target classes are reported, each as `+N` (surplus) or `-N` (shortfall). If every configured class is at its minimum, the check is silent. Otherwise fires `MissingRegionsIssue::new_from_check("min_region_count", balance_by_class)` with `.with_detail("min_region_count", "region_classes", <comma-joined list of off-target classes>)` chained on.

`MissingRegionsStrategy` (see `repair.md`) is the registered `RepairStrategy` for `MISSING_REGIONS`: it creates/converts regions for every `-N` class, optionally spending `+N` surplus from other classes via cross-region growth or reuse-merge to reach a configured `min_region_size`.

### TeleportDuplicatesConnectionCheck

```rust
pub struct TeleportDuplicatesConnectionCheck {
    pub instance_id: String,
    pub protect_route: bool,
}
```

Flags a teleport edge (`EdgeKind::Teleport`) as invalid when a regular (`EdgeKind::Basic`) connection already exists between the same pair of vertices in the same direction — see GitHub issue #74. A teleport that duplicates a passage the maze already has adds no new connectivity, only visual/navigational noise.

For every `Teleport` edge in `maze.graph`, checks whether a `Basic` edge exists with the same `from`/`to` (direction-specific — a `Basic` edge only in the *reverse* direction does not count as a duplicate). Each direction of a two-way teleport is its own `Teleport` edge and is flagged independently if it has its own matching `Basic` duplicate. If no teleport is flagged, the check is silent. Otherwise fires `InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", invalid)` — `invalid` holds every flagged teleport's `EdgeId` directly.

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

### TeleportWaypointDistanceCheck

```rust
pub const TELEPORT_WAYPOINT_DISTANCE_DEFAULT: u32 = 0;

pub enum TeleportWaypoint { Start, Finish, Any }
pub enum TeleportEdgeSelector { EntryOnly, EntryOrExit }

pub struct TeleportWaypointDistanceCheck {
    pub instance_id: String,
    pub distance: u32,
    pub comparison: Comparison,
    pub waypoint: TeleportWaypoint,
    pub edge: TeleportEdgeSelector,
    pub protect_route: bool,
}
```

Flags a teleport edge whose distance to a waypoint (start/finish) in progression space compares against a configured threshold — see GitHub issue #74/#177. Multiple instances may be active at once (different `waypoint`/`edge`/`distance`/`comparison` combinations are all legitimate simultaneously, e.g. "entry must be far from start" AND separately "exit must be far from finish") — `allow_multiple_instances: true` (see "Available checks" below), same rationale as `MinRegionCountCheck`.

`comparison` (GitHub issue #177, default `Lt`) — see the "Comparison operator" section above. `Lt` reproduces the pre-#177 "too close" behavior (flag if closer than `distance`); other operators (e.g. `Gt`, "too far") are new, added for taxonomy completeness even though the issue that introduced `Comparison` didn't name this check explicitly.

Distance is logical (tile count via `maze.analysis.distance_from_start`/`distance_from_finish`, see `graph-analytics.md`'s "Distance Maps" section), never geometric. For each teleport edge, resolves the relevant endpoint(s) (`from` only for `EntryOnly`, both `from` and `to` for `EntryOrExit`) to a `NavNodeId` via `maze.analysis.nav_graph(...).nav_node_for(...)` — always `Some` for a teleport endpoint, since a node touching a `Teleport` edge is never compressed into a passage node (see `nav-graph.md`'s "Passage Node" exemption). Looks up each resolved endpoint's distance in the relevant map(s) (`distance_from_start` for `Start`, `distance_from_finish` for `Finish`, both for `Any`) and takes the **minimum** across every relevant (endpoint, waypoint) combination — a teleport is flagged if `comparison.compare(min_distance, distance)` is true. A combination whose endpoint is absent from the relevant distance map (unreachable from that waypoint) is skipped entirely, not treated as distance `0` — if every relevant combination is unreachable, the teleport is never flagged, symmetric with `LoopDistanceFromStartCheck`'s "cycle has no defined distance" rule.

Silently skips (no issue) if the maze doesn't have the waypoint(s) this instance needs set (`meta.start` for `Start`/`Any`, `meta.finish` for `Finish`/`Any`) — covered by `MissingEndpointsCheck`, same rationale as the loop-distance checks. Default `distance` of `0` never fires on its own under `Lt`, same as `LoopDistanceFromStartCheck`'s `min_distance_from_start`.

If any teleports are flagged, fires `InvalidTeleportIssue::new_from_check("teleport_waypoint_distance", invalid)` with `.with_detail("teleport_waypoint_distance", "distance", self.distance.to_string())` chained on. Can be active alongside `TeleportDuplicatesConnectionCheck` (or another `teleport_waypoint_distance` instance) — all merge into one `INVALID_TELEPORT` issue per the dedup rule in `repair.md`'s "Pipeline" section.

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

`RemoveTeleportStrategy` (see `repair.md`) is the registered `RepairStrategy` for `INVALID_TELEPORT` — removes every flagged teleport edge outright.

### Geometric distance (`space::Tessellation::cartesian` / `space::geometric_distance`)

Shared utility the two checks below build on — see GitHub issue #74. `Tessellation::cartesian(point) -> (f64, f64)` (`maze-core/src/space/mod.rs`) projects a tessellation's own `Point` type into a canonical Cartesian coordinate, unit tile scale (one tile = 1.0), implemented separately per tessellation (`SquarePoint`, `HexPoint`, `TriPoint`). Never a pixel coordinate, and carries no rendering-specific orientation/rotation (hex flat_top/pointy_top, tri r0/r90/r180/r270 are display-only choices that live entirely in `maze-web`, which scales and — for hex/tri — rotates this canonical projection itself rather than duplicating per-tessellation formulas; see `maze-wasm`'s `cartesian_coords` below). Each tessellation's impl only needs to be internally consistent — `SquarePoint`'s returns the raw `(x, y)` grid coordinate, while `HexPoint`'s and `TriPoint`'s happen to bake in a screen-style Y flip (ported directly from `maze-web`'s pre-existing pixel-space formulas) — see `cartesian`'s own doc comment for the full rationale. This has no effect on distance calculations, since translation/reflection are isometries.

`space::geometric_distance::<T>(a, b) -> f64` is the Euclidean distance between two points (nodes) of the same tessellation, via `cartesian`. Purely geometric — unrelated to graph/nav distance (`MazeAnalysis::distance_from_start`/`distance_from_finish`, used by `TeleportWaypointDistanceCheck` above), which counts tile-hops along actual edges instead of straight-line distance.

`Tessellation::edge_position(from, to) -> (f64, f64)` (GitHub issue #199 follow-up) is the canonical Cartesian position of the *edge* between two nodes, same convention/scale as `cartesian` — needed because an edge like a one-way passage renders visually on the tile border it crosses, not at either endpoint node, so node-to-node distance systematically underestimates how far apart two edges actually render. Default impl (used by every current tessellation) is the midpoint of the two endpoints' `cartesian` positions; a future tessellation whose edges don't sit at the node midpoint overrides this method instead of every caller reimplementing the correction. `space::geometric_edge_distance::<T>(a_from, a_to, b_from, b_to) -> f64` is the Euclidean distance between two edges' `edge_position`s — the edge-to-edge counterpart of `geometric_distance`, used by `OneWayGroupGeometricProximityCheck` (see below).

**WASM Interface**: `cartesian_coords(config: { tessellation_type, points }) -> [[f64; 2]]` (`maze-wasm/src/lib.rs`) exposes `cartesian` to the frontend — given a tessellation type and a list of points, returns each point's canonical projection in the same order. `maze-web`'s single caller is `cartesianCache.ts`: `warmCartesianCache(cfg)` batches one call over every field cell whenever the tessellation kind changes (confirmTessellation, project load, generate), populating a `Map<"x,y", [number, number]>` that `getCartesian(x, y, cfg)` reads from synchronously — render loops call tile-center lookups every frame, so a per-call wasm round-trip would be far too slow. A cache miss (a point outside the prewarmed field, e.g. an invalid preset connection's endpoint) falls back to a single-point wasm call, cached afterward. `tessellationGeometry.ts`'s `squareCenter`/`hexCenter`/`triCenter` read from this cache and apply their own tile-size scale, half-tile offset, and (for hex/tri) orientation rotation on top — the single source of truth for tile geometry, replacing what used to be independently-maintained TypeScript formulas.

### TeleportGeometricLengthCheck

```rust
pub const TELEPORT_GEOMETRIC_LENGTH_DEFAULT: f64 = 0.0;

pub struct TeleportGeometricLengthCheck {
    pub instance_id: String,
    pub comparison: Comparison,
    pub length: f64,
    pub protect_route: bool,
}
```

Merges the former `TeleportMinGeometricLengthCheck`/`TeleportMaxGeometricLengthCheck` — see GitHub issue #74/#177's "Comparison operator" rule above (`comparison: Lt` reproduces the old "shorter than minimum" behavior, `Gt` reproduces "longer than maximum"). `check_type_id() == "teleport_geometric_length"`. Flags a teleport edge whose geometric (Euclidean, unit tile scale) distance between its entry and exit compares against `length`. A teleport meant to feel like a meaningful "jump" across the maze becomes pointless noise if its endpoints are only a couple of tiles apart in Cartesian space, even when they're topologically far (no direct passage); conversely a maximum keeps teleports from spanning the entire field when a more local "jump" is desired.

Distance is purely geometric — via `space::geometric_distance` (`Tessellation::cartesian`, see the "Geometric distance" section above), resolving each teleport edge's `from`/`to` maze `NodeId` to its tessellation `Point` via `maze.field.point_of(...)`. Never logical/graph distance (that's `TeleportWaypointDistanceCheck`'s concern). A teleport endpoint whose point can't be resolved (shouldn't happen for a live edge in a well-formed `Maze`) is silently excluded from `invalid`, not treated as distance `0`.

No waypoint/edge-selector parameters — unlike `TeleportWaypointDistanceCheck`, geometric length is a property of the teleport edge alone, not relative to start/finish. Default `length` of `0.0` with `comparison: Lt` never fires on its own (no distance is negative).

If any teleports are flagged, fires `InvalidTeleportIssue::new_from_check("teleport_geometric_length", invalid)` with `.with_detail("teleport_geometric_length", "length", self.length.to_string())` chained on. Can be active alongside any other `INVALID_TELEPORT`-producing check — all merge into one issue per the dedup rule in `repair.md`'s "Pipeline" section. Two active instances with different `comparison`/`length` (e.g. one `Lt` and one `Gt`) reproduce the pre-#177 "both min and max active" configuration.

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

### TeleportGraphDistanceCheck

```rust
pub const TELEPORT_GRAPH_DISTANCE_DEFAULT: u32 = 0;

pub struct TeleportGraphDistanceCheck {
    pub instance_id: String,
    pub comparison: Comparison,
    pub distance: u32,
    pub protect_route: bool,
}
```

`check_type_id() == "teleport_graph_distance"` — see GitHub issue #191. Mirrors `TeleportGeometricLengthCheck`'s shape (`comparison` + threshold, `protect_route`), but flags a teleport edge whose logical (graph/tile-hop) distance between its entry and exit compares against `distance`, instead of Euclidean distance. A teleport can be geometrically short (adjacent tiles) yet logically very far apart (or unreachable without it), and vice versa — only the geometric case was previously covered.

Distance is computed via the same nav-graph Dijkstra infrastructure `TeleportWaypointDistanceCheck`/`TeleportGroupProximityCheck` use (`graph::distance_map::compute_distance_map_filtered_bounded`), but as a **single directed forward pass** (entry -> exit) — unlike those two checks, which reduce `min(forward, reverse)` because either direction is equally meaningful for their own questions (a waypoint distance, a proximity relation). Here the question is inherently directional: "can a pedestrian walk from entry to exit without this edge" — a reverse-direction path (exit -> entry) says nothing about that. This matters concretely for a two-way teleport (two independent `EdgeId`s, entry->exit and exit->entry): the opposite-direction edge trivially connects exit -> entry in one hop, but including a reverse pass would let that hop masquerade as evidence of an entry -> exit path, wrongly reporting distance `1` for a teleport pair with no other connection at all. The Dijkstra pass excludes exactly the teleport edge being measured itself — "as if the teleport edge itself were absent" per the issue — **not** every teleport hop in the graph, unlike `TeleportGroupProximityCheck`'s exclusion: this check cares whether *some other* teleport can substitute as a shortcut is irrelevant here, only whether a pedestrian (or other-teleport-assisted) path exists without this specific edge. The exclusion is kind-aware, same rule as `TeleportGroupProximityCheck::is_not_teleport_hop`: a one-hop nav-edge with `path == [from, to]` is only excluded when no `Basic` edge also exists between the pair (`graph.edge_between_kind(from, to, Basic)`) — a `Basic` edge may run parallel to the teleport in the same direction between the same pair (`Graph::add_edge`'s kind-aware dedup builds one one-hop `NavEdge` per physical edge in that case, not one shared `NavEdge`), and matching on `path` alone would wrongly exclude that genuine pedestrian passage too.

An endpoint pair with no defined path between them (absent from the distance map once the teleport edge is excluded) is treated the same way `TeleportWaypointDistanceCheck` treats unreachable nodes — never flagged for that reason alone, regardless of `comparison`.

If any teleports are flagged, fires `InvalidTeleportIssue::new_from_check("teleport_graph_distance", invalid)` with `.with_detail("teleport_graph_distance", "distance", self.distance.to_string())` chained on. Can be active alongside any other `INVALID_TELEPORT`-producing check — all merge into one issue per the dedup rule in `repair.md`'s "Pipeline" section.

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

### TeleportSuperHubAvoidanceCheck

```rust
pub const TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT: u32 = 1_000;

pub enum TeleportHubEdgeSelector {
    Entry,
    Exit,
    EntryOrExit,
}

pub struct TeleportSuperHubAvoidanceCheck {
    pub instance_id: String,
    pub max_connections: u32,
    pub edge: TeleportHubEdgeSelector,
    pub protect_route: bool,
}
```

Flags a teleport edge whose entry and/or exit vertex already has more than a configured maximum number of outgoing connections (of any `EdgeKind`, not just `Basic`) — see GitHub issue #74. Prevents a teleport from turning an already-busy vertex ("hub") into an even busier one, which would make that vertex a disproportionately convenient shortcut hub.

Outgoing-connection count is computed once per check call (a single pass building a `HashMap<NodeId, u32>` of per-vertex outgoing-edge counts across the whole graph, not per-teleport), then looked up per teleport edge: for `Entry`, the count at the teleport's own `from` vertex (which always includes the teleport itself, since it originates there); for `Exit`, the count at the teleport's `to` vertex, counting edges outgoing *from* `to` — the teleport itself never contributes to this count, since it originates from `from`, not `to`. `EntryOrExit` flags the teleport if *either* end's count exceeds `max_connections` (`over(entry) || over(exit)`, "worst wins", same reduction shape as `TeleportWaypointDistanceCheck`'s `EntryOrExit`, though that one takes the closest/min instead since it flags on being *too small*).

Default `max_connections` of `1_000` is high enough that it never fires in practice, while still being a sane UI slider bound (unlike `u32::MAX`, which the WASM descriptor would otherwise have to clamp down separately — see "WASM Interface" below).

If any teleports are flagged, fires `InvalidTeleportIssue::new_from_check("teleport_super_hub_avoidance", invalid)` with `.with_detail("teleport_super_hub_avoidance", "max_connections", self.max_connections.to_string())` chained on. Can be active alongside any other `INVALID_TELEPORT`-producing check — all merge into one issue per the same dedup rule.

The wire-level (WASM/web) param id for `edge` is `edge_hub`, not `edge` — despite matching `TeleportWaypointDistanceCheck`'s Rust field name, it's a deliberately distinct param id so the two checks don't share i18n text (`edge`'s label/description talk about distance-to-waypoint, which makes no sense for a connection-count check — see GitHub issue #74's follow-up fix).

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

### TeleportSplitIntersectionCheck

```rust
pub enum TeleportSplitEdgeSelector {
    Entry,
    Exit,
    EntryOrExit,
}

pub struct TeleportSplitIntersectionCheck {
    pub instance_id: String,
    pub edge: TeleportSplitEdgeSelector,
    pub protect_route: bool,
}
```

Flags a `Teleport` edge (`EdgeKind::Teleport`) as invalid (`INVALID_TELEPORT`) when an end selected by `edge` belongs to a split cell (`Field::nodes_at(point).len() >= 2` — slot-0 counts the same as any other slot, see "Split tiles vs. split nodes" above) — see GitHub issue #257. Mirror check to `SplitTeleportIntersectionCheck` above (that one flags the split cell itself, `INVALID_SPLIT_TILE`; this one flags the teleport edge, `INVALID_TELEPORT`, for the same intersection).

`Entry` tests the teleport's `from` vertex (where a traveler enters the teleport), `Exit` tests its `to` vertex (where a traveler exits into — "leads into a split cell" per the issue title), `EntryOrExit` fires if either end sits in a split cell. Same `Entry`/`Exit`/`EntryOrExit` naming and semantics as `TeleportHubEdgeSelector` above.

If any teleports are flagged, fires `InvalidTeleportIssue::new_from_check("teleport_split_intersection", invalid)` — no `.with_detail` call (`edge` is a mode, not a narrated value). Can be active alongside any other `INVALID_TELEPORT`-producing check — all merge into one issue per the same dedup rule.

Repaired by the existing `RemoveTeleportStrategy` (already registered against `INVALID_TELEPORT`) — no new strategy.

The wire-level (WASM/web) param id for `edge` is `edge_split`, not `edge` — same rationale as `edge_hub` above: a deliberately distinct param id so this check doesn't share i18n text with `TeleportWaypointDistanceCheck`'s `edge`.

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

### TeleportGroupProximityCheck

```rust
pub const TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;

pub enum TeleportProximityEdge { Entry, Exit, EntryOrExit }

pub struct TeleportGroupProximityCheck {
    pub instance_id: String,
    /// `f64`, not an integer type — a fractional value (e.g. `1.5`) cleanly separates an integer
    /// tile-hop count (`1` fails, `2` passes) without off-by-one ambiguity. Compared as
    /// `(tile_hop_count as f64) < distance`.
    pub distance: f64,
    pub own_edge: TeleportProximityEdge,
    pub other_edge: TeleportProximityEdge,
    pub protect_route: bool,
}
```

Flags a *pair* of teleport edges placed topologically too close to each other — see GitHub issue #75. Every other teleport check (issue #74) evaluates one teleport edge in isolation; this one instead catches problems that only emerge from the relationship between two teleports, which no single-edge check can detect. Produces `TELEPORT_GROUP_PROXIMITY`, a distinct `IssueKind` from `INVALID_TELEPORT` — neither edge in a flagged pair is individually invalid, so reusing `INVALID_TELEPORT`/`InvalidTeleportIssue` (a flat set of "remove this edge" ids) would lose the pair membership `TeleportGroupSelectStrategy`'s `problematic` priority needs.

Distance is topological (tile-hops via the nav-graph distance map), `min(forward, reverse)` between the two configured endpoints — the graph stays directed-only (each direction computed via its own Dijkstra pass), but a pair close in *either* direction is equally a proximity problem, so neither direction is preferred (same "either-direction" rationale as `LoopDistanceFromStartCheck`/`TeleportWaypointDistanceCheck`'s own reductions).

**Teleport hops are excluded from the traversal (GitHub issue #190)** — unlike `TeleportWaypointDistanceCheck` (which uses the plain, unfiltered `compute_distance_map`), this check uses `compute_distance_map_filtered` with a predicate that blocks any single-hop nav-edge that can *only* be a `Teleport` ride (`DirectedDistanceCache::is_not_teleport_hop`). This check measures *pedestrian* topological proximity between teleport endpoints, not reachability via teleporting — without the exclusion, Dijkstra could "cheat" through the very teleport being scanned, or any unrelated third teleport, for a free 1-tile hop, making two teleports look close merely because a teleport ride connects them. A `Basic` edge running parallel to a `Teleport` edge between the same node pair (edges of different kinds may coexist between the same pair — see `Graph::add_edge`) still counts as pedestrian proximity: the exclusion only blocks a hop when *no* `Basic` edge exists between that pair, so a genuine passage sitting alongside a teleport is never hidden.

`own_edge`/`other_edge` are two independent selectors — the two ends of the *pair* being compared are independently configurable (e.g. "exit of the scanned teleport vs. entry of the other teleport"). `EntryOrExit` considers both ends of that side of the pair and takes the closest combination — same "min across every relevant combination" reduction `TeleportWaypointDistanceCheck`'s own `EntryOrExit` uses; e.g. `own_edge = EntryOrExit`, `other_edge = Entry` checks both (own entry, other entry) and (own exit, other entry) and keeps the smaller distance. When *both* sides are `EntryOrExit`, all four combinations are checked — (own entry, other entry), (own entry, other exit), (own exit, other entry), (own exit, other exit) — and the overall minimum across all four wins; this is the same rule applied twice, not a special case.

For each teleport edge, scans every other teleport edge for the first one whose `other_edge` endpoint(s) are closer than `distance` to the scanned teleport's `own_edge` endpoint(s) (closest combination, per the `EntryOrExit` rule above) — as soon as one problematic pair is found for a teleport, it's recorded and the scan moves to the next teleport (no need to enumerate every pair a teleport participates in, per the issue's own spec). Each direction of a two-way teleport is its own independent element of this scan, same as every other per-teleport check from issue #74 — **except** against its own opposite-direction counterpart (`Graph::teleport_reverse(own_id)`, GitHub issue #190), which is excluded from candidacy: both directions belong to the same physical teleport, so they can never form a legitimate "two teleports too close to each other" pair with each other, however close the teleport's own entry/exit happen to sit. Aside from that exclusion, a pair `(a, b)` found while scanning from `a`'s side and the symmetric `(b, a)` found while scanning from `b`'s side are both recorded (not deduplicated within one check call; `merge_issue`'s unordered-pair dedup, see `repair.md`'s "Pipeline" section, only applies across *merged* issues from different check instances).

Default `distance` of `0` never fires on its own, same as every other teleport distance check. If no pair is found, the check is silent. Otherwise fires `InvalidTeleportGroupIssue::new_from_check("teleport_group_proximity", groups)` (each pair expressed as a two-element `groups` entry, `to_remove: 1` — see the `InvalidGroupIssue<K>` writeup above) with `.with_detail("teleport_group_proximity", "distance", self.distance.to_string())` chained on.

Multiple instances may be active at once (`allow_multiple_instances: true`) — distinct `own_edge`/`other_edge`/`distance` combinations are a legitimate simultaneous configuration, same rationale as `TeleportWaypointDistanceCheck`.

**`protect_route` (GitHub issue #78, default `true`) — different rule than the per-edge checks below.** A close pair is only excluded when *both* teleports are route-critical (`graph::route_protection::is_teleport_route_protected`, checked on `own_id`/`other_id` right when a hit is found): if only one side of the pair sits on the maze's start→finish route, the pair is still recorded, since the non-route side remains a legitimate removal candidate — `TeleportGroupSelectStrategy`'s own `protect_route` (see `repair.md`) is what actually decides *which* side to spare in that mixed case. Excluding a pair for being fully route-protected does **not** end the scan for the teleport being scanned (`own_id`) — a farther, non-protected candidate is still searched for and recorded if found, so a route-critical teleport doesn't silently "use up" its one scan slot on a pair that turns out to be unresolvable.

### `protect_route`: route protection for per-teleport checks

`TeleportDuplicatesConnectionCheck`, `TeleportWaypointDistanceCheck`, `TeleportGeometricLengthCheck`, `TeleportGraphDistanceCheck`, and `TeleportSuperHubAvoidanceCheck` all share the same `protect_route` rule (GitHub issue #78) — `TeleportGroupProximityCheck`'s own variant is described above, since it works on pairs rather than single edges.

For these six checks: when `protect_route` is `true` (the default), a teleport edge that would otherwise be flagged is excluded from `invalid` if `graph::route_protection::is_teleport_route_protected(maze, edge_id)` reports it lies on the maze's current start→finish route (`maze.analysis.route_info(&maze.graph, &maze.meta)`, reusing that cache rather than recomputing the path). For a two-way teleport (two independent `EdgeId`s in the base `Graph` — no `reverse_edge` link like `NavEdge` has), protection covers both directions: if either direction is itself a route hop, both are excluded, so `protect_route` never silently downgrades a two-way teleport to one-way. Setting `protect_route` to `false` reproduces the pre-#78 behavior exactly (every teleport meeting the check's own criterion is flagged, regardless of route).

Route protection lives entirely on the producing check, never on `RemoveTeleportStrategy` (see `repair.md`) — the strategy stays a pure "remove everything flagged" executor with no route-awareness of its own, since a route-critical teleport is simply never placed in `invalid` to begin with.

`TeleportGroupSelectStrategy` (see `repair.md`) is the registered `RepairStrategy` for `TELEPORT_GROUP_PROXIMITY` — since GitHub issue #209, a thin teleport-specific wrapper around the shared `group_select_apply` mechanics, delegating each candidate's actual removal to a nested `RemoveTeleportStrategy`.

### MinTeleportCountCheck / MinTeleportRatioCheck

```rust
pub const MIN_TELEPORT_COUNT_DEFAULT: u32 = 1;
pub const MIN_TELEPORT_RATIO_DEFAULT: u32 = 10;

pub struct MinTeleportCountCheck {
    pub instance_id: String,
    pub min_teleports: u32,
}

pub struct MinTeleportRatioCheck {
    pub instance_id: String,
    pub min_teleport_ratio: u32,
}
```

Flag a deficit of teleports — see GitHub issue #211. Mirrors `MinOneWayCountCheck`/`MinOneWayRatioCheck`'s role for one-ways: `MinTeleportCountCheck` compares a count against `min_teleports`; `MinTeleportRatioCheck` compares the count per 100 field cells (via `maze.field.point_count()`) against `min_teleport_ratio`. Both checks count via the shared `count_distinct_teleports` helper (`quality_control::checks::teleport_count_core`) rather than a plain `maze.graph.edges().filter(kind == Teleport).count()`.

**Counting must dedup bidirectional teleport pairs (GitHub issue #211).** Unlike a one-way passage — which is filtered by excluding a `Basic`-kind reverse, since a bidirectional `Basic` pair is genuinely not a one-way — `EdgeKind::Teleport` has no equivalent "reverse cancels it out" rule to filter by: a bidirectional teleport is built as two independent `Teleport`-kind edges (`A->B` plus a parallel `B->A`; see `maze-wasm/src/analytics.rs`'s `build_graph_from_post_edit_edges` doc comment), and both directions are one logical portal, not two. `count_distinct_teleports` dedups by the unordered node pair (`min(from,to), max(from,to)` as the `HashSet` key) so a bidirectional teleport counts once, the same as a one-way teleport.

Same cross-multiplied-comparison rule as `MinOneWayRatioCheck`: `MinTeleportRatioCheck` compares `count * 100` against `min_teleport_ratio * field_cells` directly rather than computing an intermediate `count * 100 / field_cells` ratio first, avoiding the floor-rounding gap where a true ratio just short of the minimum could otherwise silently pass.

Both checks report a numeric deficit via `MissingTeleportsIssue { missing }` (`MISSING_TELEPORTS` `IssueKind`), mirroring `MissingOneWaysIssue`'s shape exactly: `MinTeleportCountCheck`'s `missing = min_teleports.saturating_sub(count)`; `MinTeleportRatioCheck`'s `missing = (min_teleport_ratio * field_cells).div_ceil(100).saturating_sub(count)`. `MissingTeleportsIssue::merge` takes the larger of the two sides' `missing` values, same rationale as `MissingOneWaysIssue::merge`.

**No repair strategy is registered for `MISSING_TELEPORTS` yet** — deliberately out of scope for issue #211 (unlike a one-way edge, which just needs a wall/passage pair to flip, "add a teleport" needs a decision on endpoint placement and direction left for separate follow-up work).

### OneWayWaypointDistanceCheck

```rust
pub const ONE_WAY_WAYPOINT_DISTANCE_DEFAULT: u32 = 0;

pub enum OneWayWaypoint { Start, Finish, Any }

pub struct OneWayWaypointDistanceCheck {
    pub instance_id: String,
    pub distance: u32,
    pub comparison: Comparison,
    pub waypoint: OneWayWaypoint,
    pub protect_route: bool,
}
```

Flags a one-way passage edge (`EdgeKind::Basic`, single direction — the reverse direction between the same node pair does not exist) whose distance to a waypoint (start/finish) in progression space compares against a configured threshold — see GitHub issue #198. Multiple instances may be active at once (`allow_multiple_instances: true`), same rationale as `TeleportWaypointDistanceCheck`.

Distance is logical (tile count via `maze.analysis.distance_from_start`/`distance_from_finish`, same shared distance maps `TeleportWaypointDistanceCheck` uses). Unlike `TeleportWaypointDistanceCheck`, there is no edge-role selector (`entry`/`exit`): a one-way edge is flagged if *either* of its two endpoints (`from` or `to`) compares against the threshold, taking the closer of the two (`min`) — there is no "entry"/"exit" distinction meaningful for a plain directed passage the way there is for a teleport jump. `waypoint` selects which waypoint(s) to measure against (`Start`/`Finish`/`Any`, `Any` taking the closer of the two waypoints), same shape as `TeleportWaypoint`. An endpoint unreachable from the relevant waypoint (absent from the distance map) is treated as having no defined distance and is never flagged for that waypoint, symmetric with `TeleportWaypointDistanceCheck`'s same rule. Silently skips (no issue) if the maze doesn't have the waypoint(s) this instance needs set — covered by `MissingEndpointsCheck`.

One-way detection filters `maze.graph.edges()` to `EdgeKind::Basic` edges with no `Basic`-kind reverse between the same pair (`graph.edge_between_kind(to, from, &EdgeKind::Basic).is_none()`) — kind-filtered specifically because a `Basic` edge may run parallel to an opposite-direction `Teleport` edge between the same pair (`Graph::add_edge`'s kind-aware dedup permits this); the kind-agnostic `edge_between` would wrongly treat such a Teleport as the Basic edge's own reverse and mask a genuine one-way from detection.

If any one-ways are flagged, fires `InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", invalid)` with `.with_detail("one_way_waypoint_distance", "distance", self.distance.to_string())` chained on.

`protect_route` (GitHub issue #198, default `true`) — a one-way edge lying on the maze's current start→finish route (`graph::route_protection::is_edge_on_route`, the same generic-over-`Tessellation` helper used to protect `Basic` route hops elsewhere) is never included in `invalid`, so the check never proposes repairing the only route through the maze. Unlike the per-teleport checks' `protect_route` (which additionally covers a two-way teleport's opposite direction via `teleport_reverse`), a one-way edge has no reverse by definition, so protection here is the plain single-edge `is_edge_on_route` check.

`OneWayToPassageStrategy`/`OneWayToWallStrategy` (see `repair.md`) are the two registered `RepairStrategy` options for `INVALID_ONE_WAY` — a rule picks one.

### OneWayGroupGeometricProximityCheck / OneWayGroupGraphProximityCheck

```rust
pub const ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;
pub const ONE_WAY_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;

pub struct OneWayGroupGeometricProximityCheck {
    pub instance_id: String,
    pub distance: f64,
    pub protect_route: bool,
}

pub struct OneWayGroupGraphProximityCheck {
    pub instance_id: String,
    pub distance: f64,
    pub protect_route: bool,
}
```

Flag a pair of one-way passage edges (`EdgeKind::Basic`, single direction) placed too close to each other — see GitHub issue #199, part of the one-way management epic (#92). Individual one-way checks (issue #198) only ever look at one edge at a time; these instead catch problems that emerge from *pairs* of one-way edges being close to each other, which no single-edge check can detect. Mirror `TeleportGroupProximityCheck`'s role, split into two independently configurable checks for the two metrics that check's `own_edge`/`other_edge`-agnostic one-way equivalent needs: `OneWayGroupGeometricProximityCheck` (Euclidean, unit tile scale) and `OneWayGroupGraphProximityCheck` (topological tile-hops via the shared nav-graph distance map, same `compute_distance_map_filtered_bounded` infrastructure `TeleportGroupProximityCheck` uses, excluding teleport hops from the traversal for the same reason that check does). Both share identical scan/protection shape; only the distance metric differs.

**`OneWayGroupGeometricProximityCheck` measures edge-to-edge, not node-to-node (GitHub issue #199 follow-up)**: a one-way edge renders visually on the tile *border* it crosses, not at either endpoint node — so distance is `space::geometric_edge_distance(own_from, own_to, other_from, other_to)`, the Euclidean distance between the two edges' `Tessellation::edge_position`s directly, not a `min` over node-endpoint combinations. `Tessellation::edge_position(from, to)` defaults to the midpoint of `cartesian(from)`/`cartesian(to)` — correct for every current tessellation (square/hex/tri all place an edge crossing squarely between its two nodes); a future tessellation whose edges don't sit at the node midpoint overrides `edge_position` itself rather than this check special-casing it.

`OneWayGroupGraphProximityCheck` has no equivalent edge-position notion (topological distance is measured in tile-hops between nodes, not Cartesian points) — instead, unlike `TeleportGroupProximityCheck`, there is no edge-role selector: raw distance between two one-way edges is the closest pairing across both endpoints of each edge (`min` over the 2×2 `from`/`to` combinations, directed `min(forward, reverse)` per combination, mirroring `TeleportGroupProximityCheck`'s "worst-case/either-direction" reduction), same rationale as `OneWayWaypointDistanceCheck`'s own no-role-selector design.

**`OneWayGroupGraphProximityCheck`'s +1 offset (GitHub issue #199 follow-up)**: the raw tile-hop count from the `min` above is bumped by one before comparing against `distance`. One-way edges render visually on tile borders, not at nodes — a user perceives two one-ways sharing a `from` node as adjacent (distance 1), not the same place (the raw node-distance, 0), and two one-ways leaving neighboring tiles as distance 2, not the raw 1. The offset is applied once, to the final `min` across every endpoint combination, not per individual endpoint-pair distance (equivalent for the `min`, but keeps the underlying cache holding plain tile-hop counts).

One-way detection is the same single-direction `Basic`-edge filter `OneWayWaypointDistanceCheck` uses (`kind == Basic` with no `Basic`-kind reverse between the pair).

For each one-way edge, scans every other one-way edge for the first one closer than `distance` — as soon as one problematic pair is found for an edge, it's recorded and the scan moves to the next edge (no need to enumerate every pair a one-way participates in). Because the scan runs independently per edge, a symmetric pair is typically recorded twice within one check call (once as `own=A, other=B`, once as `own=B, other=A`) — both entries land in `InvalidOneWayGroupIssue.groups` as separate 2-element groups, each with `to_remove: 1` (fixing either edge in the pair breaks the pair); `OneWayGroupSelectStrategy` treats this the same way `TeleportGroupSelectStrategy` treats symmetric teleport pairs (resolving one group drops the other automatically once it shares the fixed edge).

`protect_route` (GitHub issue #199, default `true`) — mirrors `TeleportGroupProximityCheck`'s own rule (issue #78): a pair is only excluded from being recorded when *both* one-way edges lie on the maze's current start→finish route (`graph::route_protection::is_edge_on_route`); if only one side sits on the route, the pair is still recorded, since the non-route side remains a legitimate repair candidate. Excluding a pair for being fully route-protected does not end the scan for the edge being scanned — a farther, non-protected candidate is still searched for.

If any pairs are found, fires `InvalidOneWayGroupIssue::new_from_check(instance_id, groups)` (each group paired with `to_remove: 1`, see `OneWayGroup` below) with `.with_detail(instance_id, "distance", self.distance.to_string())` chained on. Multiple instances of either check may be active at once (`allow_multiple_instances: true`) — distinct `distance` thresholds are a legitimate simultaneous configuration, same rationale as `teleport_group_proximity`'s own multi-instance allowance.

`OneWayGroupSelectStrategy` (see `repair.md`) is the registered `RepairStrategy` for `INVALID_ONE_WAY_GROUP`.

#### InvalidOneWayGroupIssue / OneWayGroup

```rust
pub type OneWayGroup = (Vec<EdgeId>, u32);

pub struct InvalidOneWayGroupIssue {
    pub groups: Vec<OneWayGroup>,
    pub invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
    // meta: IssueMeta
}
```

`groups` pairs each flagged group's edge set with a `to_remove: u32` count — see GitHub issue #202 follow-up. A group's edge set is "every one-way edge implicated in this problem" (both edges of a proximity pair, every one-way incident to an over-connected super-hub vertex, or the maze's entire one-way set for a count/ratio excess); `to_remove` is "how many of those edges must actually be fixed before the problem is resolved" — 1 for a proximity pair (fixing either edge breaks the pair), a super-hub vertex's own excess over its configured maximum, or a count/ratio check's own excess over its configured maximum. Earlier revisions assumed every group needed exactly one fix; `to_remove` lets `OneWayGroupSelectStrategy` converge a large excess (e.g. a maze-wide count/ratio group) within one `apply()` call instead of needing one repair iteration per excess edge.

`IssueMerge` dedups by unordered edge-set identity (`canonical_group_key`) same as before; when both sides flag the same edge set with different `to_remove`, the larger value wins (the more demanding requirement must be satisfied for the group to count as resolved) — `invalid_sources` still unions both sides' source checks regardless of which one's `to_remove` won.

### MinOneWayCountCheck / MinOneWayRatioCheck

```rust
pub const MIN_ONE_WAY_COUNT_DEFAULT: u32 = 1;
pub const MIN_ONE_WAY_RATIO_DEFAULT: u32 = 10;

pub struct MinOneWayCountCheck {
    pub instance_id: String,
    pub min_one_ways: u32,
}

pub struct MinOneWayRatioCheck {
    pub instance_id: String,
    pub min_ratio: u32,
}
```

Flag a deficit of one-way passage edges (`EdgeKind::Basic`, single direction) — see GitHub issue #201, part of the one-way management epic (#92). `MinOneWayCountCheck` compares the raw count against `min_one_ways`; `MinOneWayRatioCheck` compares the count per 100 field cells (via `maze.field.point_count()`) against `min_ratio`. One-way detection is the same single-direction `Basic`-edge filter every other one-way check uses (`kind == Basic` with no `Basic`-kind reverse between the pair) — a bidirectional passage is never mistaken for a one-way even though each direction is itself `EdgeKind::Basic`.

Both checks compare `count * 100` against `min_ratio * field_cells` (or, for `MinOneWayCountCheck`, just `count` against `min_one_ways`) without computing an intermediate `count * 100 / field_cells` ratio first — the intermediate division floors, which can silently pass a ratio that's genuinely short of the minimum (e.g. a true 29.9% floors to 29%, comparing fine against a minimum it doesn't actually meet). Comparing the cross-multiplied products instead is exact, no rounding involved.

Unlike `MaxOneWayCountCheck`/`MaxOneWayRatioCheck` (which report every one-way edge as a single group with an excess `to_remove` count), both checks here report a numeric deficit: `MissingOneWaysIssue { missing }`, produced via `MissingOneWaysIssue::new_from_check(instance_id, missing).with_detail(instance_id, "missing", missing.to_string())`. `MissingOneWaysIssue` carries `MISSING_ONE_WAYS`, a distinct `IssueKind` from `INVALID_ONE_WAY_GROUP` — adding a missing one-way is a different corrective action from removing an excess one, same rationale as `RegionNeedsExpansion`/`RegionNeedsShrink`. For `MinOneWayCountCheck`, `missing = min_one_ways.saturating_sub(count)`. For `MinOneWayRatioCheck`, `missing` is the smallest count such that `(count + missing) * 100 >= min_ratio * field_cells` — computed as `(min_ratio * field_cells).div_ceil(100).saturating_sub(count)`, rounding the required count up (never down) so a genuine shortfall never rounds away to zero.

`MissingOneWaysIssue::merge` takes the larger of the two sides' `missing` values — `min_one_way_count`/`min_one_way_ratio` are independent checks that can both be active in the same rule and legitimately disagree on how many one-ways are missing; a repair strategy must fix at least the largest reported deficit.

`MissingOneWaysFromPassageStrategy`/`MissingOneWaysFromWallStrategy` (see `repair.md`) are the two registered `RepairStrategy` options for `MISSING_ONE_WAYS` — a rule picks one.

### MaxOneWayCountCheck / MaxOneWayRatioCheck

```rust
pub const MAX_ONE_WAY_COUNT_DEFAULT: u32 = 1_000;
pub const MAX_ONE_WAY_RATIO_DEFAULT: u32 = 100;

pub struct MaxOneWayCountCheck {
    pub instance_id: String,
    pub max_one_ways: u32,
}

pub struct MaxOneWayRatioCheck {
    pub instance_id: String,
    pub max_ratio: u32,
}
```

Flag an excess of one-way passage edges (`EdgeKind::Basic`, single direction) — see GitHub issue #202, part of the one-way management epic (#92). Symmetric counterparts to `MinOneWayCountCheck`/`MinOneWayRatioCheck` (issue #201): same counting rule (raw count vs. `MinOneWayCountCheck`; count per 100 field cells via `maze.field.point_count()` vs. `MinOneWayRatioCheck`), just the excess side of the threshold rather than the deficit side. The excess case gets its own issue kind (`INVALID_ONE_WAY_GROUP`, not `MISSING_ONE_WAYS`) rather than reusing `MissingOneWaysIssue` via a comparison flip — removing an excess one-way is a different corrective action (convert to bidirectional/wall) from adding one, same rationale as `RegionNeedsExpansion`/`RegionNeedsShrink`.

One-way detection is the same single-direction `Basic`-edge filter every other one-way check uses (`kind == Basic` with no `Basic`-kind reverse between the pair).

Unlike `MinOneWayCountCheck`/`MinOneWayRatioCheck` (which report a numeric deficit in `MissingOneWaysIssue`), both checks here report every one-way edge in the maze as a single group in `InvalidOneWayGroupIssue.groups`, paired with the excess count as `to_remove` (GitHub issue #202 follow-up — see `OneWayGroup`'s doc comment above): the strategy, not the check, decides *which* edges within the group are the ones actually fixed, but the check itself says *how many*. For `MaxOneWayCountCheck`, `to_remove = count - max_one_ways`. For `MaxOneWayRatioCheck`, `to_remove = count - target_count`, where `target_count` is `max_ratio * field_cells / 100` **rounded to the nearest integer** (`(max_ratio * field_cells + 50) / 100` in integer arithmetic, `saturating_sub` guarding the rare small-field case where rounding pushes `target_count` above `count`) — round-to-nearest, not floor/ceil, so a fractional target (e.g. 4.3) resolves to the closest whole edge count (4) rather than always truncating down (GitHub issue #202 follow-up review: an earlier floor-based version under-reported `to_remove` by one whenever the fraction rounded up). `OneWayGroupSelectStrategy` (registered against `INVALID_ONE_WAY_GROUP`) already handles groups of any size and already applies its own `protect_route` exclusion when picking a candidate — neither check carries a `protect_route` param of its own, same as `OneWayGroupSuperHubCheck`.

If the count/ratio is above the configured maximum, fires `InvalidOneWayGroupIssue::new_from_check(instance_id, vec![(one_ways, to_remove)])` with `.with_detail(instance_id, "max_one_ways", ...)` / `.with_detail(instance_id, "max_ratio", ...)` chained on.

`OneWayGroupSelectStrategy` (see `repair.md`) is the registered `RepairStrategy` for `INVALID_ONE_WAY_GROUP`.

### SplitDistanceFromWaypointCheck

```rust
pub const SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT: u32 = 0;
pub const SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT_COMPARISON: Comparison = Comparison::Lt;

pub enum SplitWaypoint { Start, Finish, Any }

pub struct SplitDistanceFromWaypointCheck {
    pub instance_id: String,
    pub distance: u32,
    pub comparison: Comparison,
    pub waypoint: SplitWaypoint,
}
```

Part of the split-QC epic (#246), GitHub issue #248. Flags an extra split node (`Field::add_node_at`'s minted node — never a point's slot-0 original, `Field::nodes_at(point)[0]`) whose point sits too close to/far from a waypoint (start/finish) in progression space. Mirrors `TeleportWaypointDistanceCheck`'s shape (`SplitWaypoint` is `TeleportWaypoint`'s split-tile counterpart, `Any` uses whichever of start/finish is closer).

A split point's distance to a waypoint is the **minimum** shortest-path distance (in tiles, via the shared distance maps) over *every* node at that point (`Field::nodes_at`, slot-0 included) — a split point is one physical tile, so its progression-space position is shared by all its nodes. A node absent from the relevant distance map (unreachable, or compressed out of the nav graph as an interior corridor node — see `NavGraph::nav_node_for`) contributes no distance for itself; a point where every node is undefined is never flagged. Silently skips if the maze doesn't have the waypoint(s) this instance needs set (covered by `MissingEndpointsCheck`).

Flags the whole tile (`SplitTileNodes` — every node at the point, slot-0 included, GitHub issue #260) once a point's minimum distance trips the threshold; slot-0 itself is still never a removal candidate — that's `remove_node_feasible`'s job, not this check's. Fires `InvalidSplitTileIssue::new_from_check(instance_id, invalid)` with `.with_detail(instance_id, "distance", ...)` chained on, where `invalid` is one `SplitTileNodes` per flagged point.

`RemoveSplitStrategy` (see `repair.md`) is the registered `RepairStrategy` for `INVALID_SPLIT_TILE`.

### SplitTeleportIntersectionCheck

```rust
pub enum SplitTeleportDirection { Incoming, Outgoing, Bidirectional, Any }

pub struct SplitTeleportIntersectionCheck {
    pub instance_id: String,
    pub direction: SplitTeleportDirection,
}
```

GitHub issue #256, part of epic #246. Flags a split cell (`InvalidSplitTile`) as invalid when it has a `Teleport` edge (`EdgeKind::Teleport`) connection matching a shape selected by `direction`, evaluated per node of the cell and per neighbor:

- `Incoming` — a one-way teleport leads into a node of the cell (`Teleport(neighbor -> node)` with no matching reverse `Teleport(node -> neighbor)` to the same neighbor).
- `Outgoing` — a one-way teleport leads out of a node of the cell (the mirror of `Incoming`).
- `Bidirectional` — a node of the cell has a full two-way teleport pair with some neighbor (both `Teleport(neighbor -> node)` and `Teleport(node -> neighbor)` present for the same neighbor).
- `Any` — any of the three shapes above. Default.

Scans `Field::all_points()` (deduped via a seen-points set, same as `SplitDistanceFromWaypointCheck`), keeps points with `nodes_at(point).len() >= 2`, and flags the whole tile (`SplitTileNodes`) if any of its nodes has a matching connection. Multiple matching connections on the same tile still produce one `SplitTileNodes` entry (a tile is flagged once, not once per connection). Fires `InvalidSplitTileIssue::new_from_check(instance_id, invalid)` — no `.with_detail` call (`direction` is a mode, not a narrated value).

`RemoveSplitStrategy` (see `repair.md`) is the registered `RepairStrategy` for `INVALID_SPLIT_TILE` — no new strategy for this check, it reuses the same one `SplitDistanceFromWaypointCheck` does.

### Split tiles vs. split nodes — slot-0 is not special (GitHub epic #246, GitHub issue #281)

**Hard constraint across every strategy in this epic: none of them may remove a point's *last remaining* node.** This replaced the epic's original "never remove slot-0" rule (GitHub issue #281) — slot-0 has no removal-eligibility standing of its own anymore; whichever node happens to be the sole node left at a point is what's protected, regardless of which one that is. `RemoveNode`/`remove_node_feasible` (`generation::node_ops`) enforce this at the field/graph layer; `ReplacePointNodes` has no such restriction at all, since it replaces a point's whole node set atomically rather than shrinking it by one. Outside removal-eligibility, slot-0 is an equal member of a split tile for every purpose — size/volume, connectivity/degree, distance — any metric a check or repair-priority computes over "a split tile's nodes" must include slot-0, not just the extra nodes.

A **split tile** is one `Field` point carrying more than one node (`Field::nodes_at(point).len() >= 2`) — slot-0 plus one or more extra nodes minted by `Field::add_node_at`. Every split-QC check, including `SplitDistanceFromWaypointCheck`/`SplitTeleportIntersectionCheck` above, is *tile*-level: it counts, measures, and flags whole split tiles (`SplitTileNodes`), not individual nodes. `RemoveSplitStrategy` (GitHub issue #281) collapses a whole tile atomically via `ReplacePointNodes`, so it never singles out slot-0 as the survivor — see `repair.md`'s own `RemoveSplitStrategy`/`selection` param write-up for how the one surviving node is actually picked.

### SplitTileNodes / InvalidSplitTileGroupIssue

```rust
pub struct SplitTileNodes(pub Vec<NodeId>);

impl SplitTileNodes {
    pub fn new(mut nodes: Vec<NodeId>) -> Self; // sorts on construction (canonicalized)
}

pub struct SplitGroupKind; // InvalidGroupIssueKind: Element = SplitTileNodes, KIND = INVALID_SPLIT_TILE_GROUP, NESTED_KIND = INVALID_SPLIT_TILE
pub type InvalidSplitTileGroupIssue = InvalidGroupIssue<SplitGroupKind>;
```

`SplitTileNodes` wraps one split tile's *entire* node list (slot-0 included) as a single `InvalidGroupIssueKind::Element` unit — see GitHub issue #249's regression fix. An earlier revision used a flat `Vec<NodeId>` group mixing several tiles' nodes together, which let `group_select_apply`'s per-element candidate pass pick nodes from *different* tiles independently instead of resolving one whole tile at a time; wrapping each tile's nodes in `SplitTileNodes` makes the tile — not any one of its nodes — the candidate unit. Canonicalized (sorted) on construction so two `SplitTileNodes` built from the same node set in different orders compare/hash equal, same rationale `canonical_group_key` uses for a group's own element-level dedup.

`InvalidSplitTileGroupIssue` (`groups: Vec<(Vec<SplitTileNodes>, u32)>`, the generic `InvalidGroupIssue<K>` shape) is produced by any check flagging a *relationship*/*aggregate* condition over the field's split tiles as a whole (excess count, excess density, or a too-close pair of tiles) — distinct from `INVALID_SPLIT_TILE`, which flags a single tile invalid on its own terms. A count/density excess puts every split tile on the field into one group with `to_remove` equal to the excess *tile* count (not node count); a proximity pair puts both tiles into one group with `to_remove: 1` (resolving either side breaks the pair).

### MaxSplitCountCheck / MaxSplitDensityCheck

```rust
pub const MAX_SPLIT_COUNT_DEFAULT: u32 = 20;
pub const MAX_SPLIT_DENSITY_DEFAULT: u32 = 30;

pub struct MaxSplitCountCheck {
    pub instance_id: String,
    pub max_split_count: u32,
}

pub struct MaxSplitDensityCheck {
    pub instance_id: String,
    pub max_density: u32,
}
```

See GitHub issue #249, part of epic #246. Flag a field-wide excess of split *tiles* (not nodes) — mirror `MaxLoopsCountCheck`/`MaxLoopDensityCheck`'s identical rationale: a field-wide/aggregate decision, which tiles to actually collapse is `SplitGroupSelectStrategy`'s job, not the check's. Both scan `Field::all_points()` (deduped via a seen-points set, since it yields one entry per `NodeId` and a split point has several), keep only points with `nodes_at(point).len() >= 2`, and wrap each surviving point's *entire* node list (slot-0 included) as its own `SplitTileNodes` candidate.

`MaxSplitCountCheck`: fires when the raw tile count exceeds `max_split_count`; `to_remove = count - max_split_count` directly (a tile-count excess, not converted from any node-count notion). `MaxSplitDensityCheck`: fires when `density_per_100(tile_count, field_cells)` exceeds `max_density` (same rounding helper `MaxLoopDensityCheck` uses — round-half-up, not floor); `to_remove` is the fewest tiles that would bring density back to `max_density`, found by scanning `(0..=tile_count).rev()` for the largest count whose density is still at or below the max (density is monotonic increasing in count).

Both fire `InvalidSplitTileGroupIssue::new_from_check(instance_id, vec![(tiles, to_remove)])` — one group covering every split tile on the field — with `.with_detail(instance_id, "max_split_count"/"max_density", ...)` chained on.

### SplitGroupGeometricProximityCheck / SplitGroupGraphProximityCheck

```rust
pub const SPLIT_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;
pub const SPLIT_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;

pub struct SplitGroupGeometricProximityCheck {
    pub instance_id: String,
    pub distance: f64,
}

pub struct SplitGroupGraphProximityCheck {
    pub instance_id: String,
    pub distance: f64,
}
```

See GitHub issue #249, part of epic #246. Flag a pair of split tiles placed too close to each other — mirror `OneWayGroupGeometricProximityCheck`/`OneWayGroupGraphProximityCheck`'s role: no single-tile check (`SplitDistanceFromWaypointCheck`) can catch a problem that only emerges from two tiles being close to each other. Same tile-collection shape as `MaxSplitCountCheck` (deduped `all_points()`, `nodes_at(point).len() >= 2`, full node list including slot-0).

`SplitGroupGeometricProximityCheck` measures Euclidean distance (`space::geometric_distance`) between the two tiles' points directly (unlike an edge-position check, a split tile is a whole point, not a border-crossing edge). `SplitGroupGraphProximityCheck` measures the minimum **exact** directed tile-hop distance (`min(forward, reverse)`, same "worst-case/either-direction" reduction `TeleportGroupProximityCheck`/`OneWayGroupGraphProximityCheck` use) over every combination of the two tiles' own nodes, via `graph::distance_map::exact_tile_distance` (see `graph-analytics.md`) — **not** the coarser `corridor_index`-based nav-node snapping `SplitDistanceFromWaypointCheck` accepts, since this check compares the distance value itself against a threshold (GitHub issue #249's original bug report: the coarse approximation could report two split nodes on the same long corridor as distance ≈0 regardless of their true tile-hop separation).

For each tile, scans every other tile for the first one closer than `distance` — as soon as one problematic pair is found, it's recorded and the scan moves to the next tile. A symmetric pair is typically recorded twice (once per scan direction), each as its own 2-element group with `to_remove: 1` — same shape `OneWayGroupGeometricProximityCheck` produces. If any pairs are found, fires `InvalidSplitTileGroupIssue::new_from_check(instance_id, groups)` with `.with_detail(instance_id, "distance", ...)` chained on. Both allow multiple simultaneous instances (`allow_multiple_instances: true`) — distinct thresholds are a legitimate simultaneous configuration, same rationale as the one-way/teleport proximity checks.

`SplitGroupSelectStrategy` (see `repair.md`) is the registered `RepairStrategy` for `INVALID_SPLIT_TILE_GROUP`.

### SplitCountCheck / SplitDensityCheck

```rust
pub const SPLIT_COUNT_DEFAULT: u32 = 1;

pub struct SplitCountCheck {
    pub instance_id: String,
    pub min_count: u32,
    pub patterns: Vec<SplitPattern>,
}

pub const SPLIT_DENSITY_DEFAULT: u32 = 10;
pub const SPLIT_DENSITY_ESTIMATE_DEFAULT: u32 = 1;

pub struct SplitDensityCheck {
    pub instance_id: String,
    pub min_density: u32,
    pub split_tile_estimate: u32,
    pub patterns: Vec<SplitPattern>,
}
```

See GitHub issue #247, part of epic #246. Mirror `MinLoopsCountCheck`/`MinLoopDensityCheck`'s shape exactly, one field-wide deficit check parametrized by an absolute count vs. a field-coverage share, both flagging `MISSING_SPLIT_TILES` — same "two separate check types, no merged mode enum" rationale as the loop pair (see the "Comparison operator" section's merge rule: an absolute count and a density share aren't the same corrective action on the same entity).

**"Split cell" metric — tile count, not node count.** Both checks count split *tiles* (`Field::nodes_at(point).len() >= 2`, deduped via a seen-points scan over `Field::all_points()`, same collection shape `MaxSplitCountCheck`/`MaxSplitDensityCheck` use), never the number of extra nodes beyond slot-0 — a 3-node split tile counts as one "split cell" the same as a 2-node one. `Field::point_count()` (a deduplicated count of distinct field points, **not** `Field::node_count()`) is the shared denominator for `SplitDensityCheck`'s density — `node_count()` is inflated by every extra split node already on the field and would silently understate density once any split tile exists (fixed by GitHub issue #267, filed against the pre-existing `MaxSplitDensityCheck`'s use of the same wrong denominator — the bug affected every density-style check/strategy that reached for `node_count()` instead of a field-cell count, not only that one check).

**`patterns` — optional membership filter, shared shape across all three split-QC surfaces.** `Vec<SplitPattern>` (`generation::SplitPattern`, the same type `SplitGenerationConfig`'s own `patterns` field carries): empty (the default) means "count every split tile regardless of shape"; non-empty restricts counting to only those split tiles whose actual topology matches at least one listed pattern, under any rotation/mirror (`quality_control::split_pattern_match::split_tile_matches_any` — see below). Each of generation's own `SplitGenerationConfig`, this check's `patterns`, and `AddSplitStrategy`'s own `patterns` (see `repair.md`) holds its own **independent** list — nothing links them structurally. `SplitPattern` is compared **structurally** (`faces` + `node_count`), never by identity/id — it carries none.

**Known limitation, deliberately out of scope for #247**: a check's `patterns` filter is invisible to the repair strategy that fixes its deficit — `AddSplitStrategy` has no way to know which patterns the producing check actually wanted, so a strategy configured with a different (or unconstrained) pattern set can satisfy the check's `min_count`/`min_density` with tiles the check itself wouldn't have counted, causing the check to immediately re-fire next iteration. Tracked for a future fix by issue #253's "Rule-level parameters" design (a rule-scoped recommended default a check/strategy may inherit instead of configuring independently) — not addressed here.

`SplitCountCheck` (`check_type_id() == "split_count"`): `count = count_matching_split_tiles(maze, &self.patterns)`; if below `min_count`, `missing = min_count.saturating_sub(count)`.

`SplitDensityCheck` (`check_type_id() == "split_density"`): `density = density_per_100(count, maze.field.point_count())` (same round-half-up helper `MinLoopDensityCheck`/`MaxSplitDensityCheck` use); if below `min_density`, the coverage deficit converts into a tile count the same way `MinLoopDensityCheck` converts a cell deficit into a loop count: `missing_cells = ceil((min_density - density) * field_cells / 100)`, then `missing = ceil(missing_cells / split_tile_estimate.max(1))` — `split_tile_estimate` is the estimated field-cell coverage of one newly added split tile (default `1`, i.e. "assume each new split tile covers exactly one more field cell"), the split-tile counterpart to `MinLoopDensityCheck`'s `avg_loop_length_estimate`.

Either way, if `missing` is `0`, the check is silent; otherwise fires `MissingSplitTilesIssue::new_from_check(instance_id, missing)`. Repaired by `AddSplitStrategy` (see `repair.md`) — no strategy-side branching on which check produced the issue, same as the loop pair.

### split_pattern_match — reconstructing a split tile's topology outside generation

`quality_control::split_pattern_match` (GitHub issue #247) answers "does this already-built split tile's actual topology match one of these patterns" — needed by `SplitCountCheck`/`SplitDensityCheck`'s `patterns` filter, which has no generation-time frontier/visited/reserve state to reuse `generation::split_logic`'s own pattern-application machinery.

```rust
pub fn reconstruct_tile_faces<T: Tessellation>(graph: &Graph, field: &Field<T>, nodes: &[NodeId]) -> Vec<Vec<SplitFaceRequirement>>;
pub fn split_tile_matches_any<T: Tessellation>(graph: &Graph, field: &Field<T>, nodes: &[NodeId], patterns: &[SplitPattern]) -> bool;
```

`reconstruct_tile_faces` walks each of `nodes`' outgoing/incoming edges via `T::step`, resolving each face index to `Passage`/`OneWay(Forward|Backward)`/`Wall` from what's actually connected — the tile's real topology, independent of how it was built (generation, preset, or a prior repair pass). `split_tile_matches_any` compares this reconstructed shape against every pattern in `patterns`, trying every `(rotation, mirror)` combination the same way generation's own pattern application does — `rotation` indexes `Tessellation::rotation_symmetries()`, `mirror` (`Option<usize>`, `None` = no mirror) indexes `Tessellation::mirror_symmetries()`, both applied via the single shared `space::transform_face_index` (GitHub issue #275 — an earlier per-callsite arithmetic formula silently assumed every tessellation's `faces()` order was angular, which only holds for hex) — a pattern matches if *any* orientation reproduces the tile's exact face-by-face shape. `nodes.len() < 2` (not actually a split tile) short-circuits to `false`. An empty `patterns` slice is the caller's job to special-case as "match everything" — this function only ever answers "does it match one of these listed patterns", never "no patterns configured".

### SplitNodeConnectionCountCheck

```rust
pub const SPLIT_NODE_CONNECTION_COUNT_DEFAULT: u32 = 2;
pub const SPLIT_NODE_CONNECTION_COUNT_DEFAULT_COMPARISON: Comparison = Comparison::Lt;

pub enum SplitNodeConnectionDirection { Incoming, Outgoing, Bidirectional, Any }

pub struct SplitNodeConnectionCountCheck {
    pub instance_id: String,
    pub count: u32,
    pub comparison: Comparison,
    pub direction: SplitNodeConnectionDirection,
}
```

See GitHub issue #250, part of epic #246. Validates a single split node's connection count against `count`, per `comparison` — the first node-level (not tile-level) split-QC check. Unlike `SplitDistanceFromWaypointCheck` (which always flags the *whole tile*, `SplitTileNodes`), this check flags individual nodes, one `NodeId` per flagged node — no point-level dedup: a split point contributing two flagged nodes fires with both. Iterates `Field::all_points()`, keeps only points with `nodes_at(point).len() >= 2`, then evaluates every node at that point (slot-0 included — epic #246's "slot-0 is not otherwise special" rule: a check may flag slot-0, only the repair strategy's removal step excludes it).

Every incident edge counts regardless of `EdgeKind` — `Basic` and `Teleport` both contribute.

`direction` restricts which connections count toward `count`:
- `Incoming`/`Outgoing`: raw directed-edge count in that direction (`graph.edges().filter(|e| e.to == node)` / `.filter(|e| e.from == node)`).
- `Bidirectional`: count of distinct neighbors reachable via a full two-direction passage (both `graph.edge_between(node, neighbor)` and `graph.edge_between(neighbor, node)` exist) — one physical connection between two tiles counts as one unit, not two directed edges.
- `Any`: count of distinct neighbors with any edge to or from the node, one-way or bidirectional, each counted once.

Fires `InvalidSplitNodeIssue::new_from_check(instance_id, invalid)` with `.with_detail(instance_id, "count", self.count.to_string())` chained on, where `invalid` is one `NodeId` per flagged node.

`RemoveSplitNodeStrategy` (see `repair.md`) is the registered `RepairStrategy` for `INVALID_SPLIT_NODE`.

### SplitNodeConnectionPerNeighborCheck / SplitNodeConnectionPerFaceCheck

```rust
pub const SPLIT_NODE_CONNECTION_PER_NEIGHBOR_MAX_DEFAULT: u32 = 1;

pub struct SplitNodeConnectionPerNeighborCheck {
    pub instance_id: String,
    pub max: u32,
}

pub const SPLIT_NODE_CONNECTION_PER_FACE_MAX_DEFAULT: u32 = 1;

pub struct SplitNodeConnectionPerFaceCheck {
    pub instance_id: String,
    pub max: u32,
}
```

See GitHub issue #251, part of epic #246. Two separate check types (mirrors
`OneWayGroupGeometricProximityCheck`/`OneWayGroupGraphProximityCheck` staying distinct rather than
one dual-metric check), both producing `INVALID_SPLIT_NODE_CONNECTION_GROUP` when a split tile's
nodes collectively over-connect to the outside — distinct from `INVALID_SPLIT_NODE` (which flags a
single node's own connection count) and from `INVALID_SPLIT_TILE` (which flags excess node
*count*, not excess *connections*).

Both scan `Field::all_points()` (deduped via a seen-points set), keep only points with
`nodes_at(point).len() >= 2`, then for each split tile scan every edge whose `from` is one of the
tile's own nodes (slot-0 included — epic #246's "slot-0 is not otherwise special" rule). A
connection only counts if it's genuinely **outside**: the target node's own point
(`Field::point_of(edge.to)`) must differ from the split tile's point — a sibling edge to another
node of the same split is never counted. Only **outgoing** edges count (`edge.from` at the split
point) — mirrors the issue's own wording ("connections ... go out to..."). `EdgeKind` doesn't
matter, `Basic` and `Teleport` both count.

**`SplitNodeConnectionPerNeighborCheck`** buckets each tile's outgoing outside edges by the target
`NodeId` — a bucket with more than `max` edges fires, with `to_remove = bucket.len() - max`.

**`SplitNodeConnectionPerFaceCheck`** buckets by face-direction index instead
(`T::face_between(split_point, neighbor_point)`, resolved to a stable index via `T::face_index`) —
edges toward *different* outside neighbors that happen to share the same face direction land in
the same bucket, so this check's cap is independent of how many distinct neighbors receive the
connections, unlike the per-neighbor check above.

Each over-cap bucket becomes its own group in `InvalidSplitNodeConnectionGroupIssue.groups:
Vec<(Vec<EdgeId>, u32)>` (the generic `InvalidGroupIssue<SplitNodeConnectionGroupKind>` shape —
`Element = EdgeId`, mirroring `OneWayGroupKind`/`TeleportGroupKind`'s flat-`EdgeId` shape). Fires
`InvalidSplitNodeConnectionGroupIssue::new_from_check(instance_id, groups)` with
`.with_detail(instance_id, "max", self.max.to_string())` chained on. Both allow multiple
simultaneous instances (`allow_multiple_instances: true`) — distinct `max` thresholds are a
legitimate simultaneous configuration, same rationale as the one-way/teleport proximity checks.

`SplitNodeConnectionGroupSelectStrategy` (see `repair.md`) is the registered `RepairStrategy` for
`INVALID_SPLIT_NODE_CONNECTION_GROUP`.

## WASM Interface

The WASM layer exposes check metadata and accepts check configuration from the frontend.

### IssueDto

Serialized to JSON in `MazeSnapshot.issues` (`build_analytics_snapshot`, `maze-wasm/src/analytics.rs`) for every `Issue` the QC pass (or `issues_override`) produced:

```rust
struct IssueDto {
    kind: String,                                       // IssueKind::as_str()
    payload: IssuePayloadDto,                            // tagged payload, see below
    source_checks: Vec<String>,                          // Issue::source_checks() — opaque composite instance ids
    source_check_types: HashMap<String, String>,         // source_checks entry -> check type id
    details: HashMap<String, HashMap<String, String>>,   // Issue::details()
}

#[serde(tag = "kind", rename_all = "snake_case")]
enum IssuePayloadDto {
    None,
    InvalidLoop { edges: HashMap<String, Vec<Vec<[u32; 2]>>> }, // invalid_loop only, keyed by source check instance id
    RegionNeedsExpansion { nodes: HashMap<String, Vec<Vec<u32>>> }, // region_needs_expansion only, keyed by source check instance id
    RegionNeedsShrink { nodes: HashMap<String, Vec<Vec<u32>>> }, // region_needs_shrink only, keyed by source check instance id
}
```

`payload` is a discriminated union tagged via `#[serde(tag = "kind")]`, serialized through `serde_wasm_bindgen::Serializer::json_compatible()` into a real TS discriminated union — the web side narrows on `payload.kind` (`"none" | "invalid_loop" | "region_needs_expansion" | "region_needs_shrink"`) to know which field (`edges`/`nodes`) is present, instead of reading two parallel always-mostly-empty maps. `IssueDto.kind` remains the source of truth for UI filtering/labels; `payload.kind` is purely a narrowing discriminant. `payload.kind`'s variant tags mirror `IssueKind::as_str()`'s wire strings by construction — `build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) asserts (debug-only) that they never diverge.

`source_checks` and `details` are the serialized form of `Issue`'s same-named accessors (see
"Issue" above) — the web UI uses them to render one bubble per contributing check, each with a
check-specific label built from that check's own `details` entry (see `quality-feature.md`).
`details` values are raw (numbers as strings, etc.) — the UI owns all wording.

`source_checks` entries are opaque per-**instance** composite ids (`{rule_id}:{local_id}`), not
check type ids — two active instances of the same type (e.g. two `min_region_count`s, see GitHub
issue #60) need distinct entries here. The web UI's per-check-type label lookup (`DETAIL_LABELS`
in `issueRegistry.ts`) keys off the check's **type**, not its instance, so `source_check_types`
maps each `source_checks` entry back to its type id. Built in `build_analytics_snapshot`
(`maze-wasm/src/analytics.rs`) from the same composite-id-to-type-id map `runner.rs` already
builds while constructing the active checks for this pass — invariant: exactly one
`source_check_types` entry per distinct id appearing anywhere in any issue's `source_checks` for
this snapshot, no extras.

`IssuePayloadDto::InvalidLoop.edges` is keyed by source check instance id, not one flat list — a
merged `invalid_loop` issue may carry cycles from several checks at once (e.g. two `loop_length`
instances, one `Lt` and one `Gt`), and each is attributed to its
own check's entry so the UI can highlight only the cycles relevant to the bubble being hovered,
not every contributing check's cycles combined. Built by looking up each invalid cycle's
canonical key (`canonical_cycle_key`) in `InvalidLoopIssue.invalid_sources` to find which
check(s) flagged it — the same attribution map `merge_invalid_loops` (`repair.md`'s "Pipeline"
section) already maintains across merges. `payload` is only `InvalidLoop` when the issue is
`invalid_loop` and at least one check flagged a cycle — otherwise it's `None`.

`IssuePayloadDto::RegionNeedsExpansion.nodes` mirrors `InvalidLoop.edges`'s role for
`region_needs_expansion` issues (currently produced by `MinRegionSizeCheck`/`MinRegionRatioCheck`)
— keyed by source check instance id for the same reason, so hovering one check's bubble
highlights only the regions that check flagged. Each inner `Vec<u32>` is one flagged region's
member maze node ids (not edges — the web client derives the region's perimeter and fill
client-side from this node set, the same way it derives preset boundary walls from a cell set;
see `IssueHighlightOverlay.ts`/`issueHighlightSelectors.ts`). Built from
`RegionNeedsExpansionIssue.invalid` (indices into
`maze.analysis.scc(&maze.graph).components`) and `invalid_sources` (keyed by component index, no
remap needed within one QC pass — see `RegionNeedsExpansionIssue`'s doc comment above).
`payload` is only `RegionNeedsExpansion` when the issue is `region_needs_expansion` and at least
one check flagged a region — otherwise it's `None`.

`IssuePayloadDto::RegionNeedsShrink.nodes` mirrors `RegionNeedsExpansion.nodes`'s shape and build
logic exactly, for `region_needs_shrink` issues (currently produced by
`MaxRegionSizeCheck`/`MaxRegionRatioCheck`) — built from `RegionNeedsShrinkIssue.invalid`/
`invalid_sources` the same way. `payload` is only `RegionNeedsShrink` when the issue is
`region_needs_shrink` and at least one check flagged a region — otherwise it's `None`.

### CheckDescriptor

Serialized to JSON by `available_checks()`:

```rust
struct CheckDescriptor {
    id: &'static str,           // check type id — used as CheckInstanceConfig.type_id
    label: &'static str,        // human-readable name
    description: &'static str,  // human-readable description
    issue_kinds: Vec<&'static str>, // IssueKind::as_str() values this check may produce
    params: Vec<ParamDescriptor>,
    allow_multiple_instances: bool, // see below
}
```

**`allow_multiple_instances`** gates whether the web store/UI permit more than one independent
active configuration of this check type at once (across rules, or within the same rule) — see
GitHub issue #60. `true` only for `min_region_count`: a second instance with a different
`region_class` is a legitimate, common configuration (e.g. "at least 2 trap regions" AND
separately "at least 2 alternative regions"). Every other check stays `false` — single active
instance at a time, same restriction that existed before #60's refactor. This is enforced
store-side (`addCheck`/`createRule` in `generationSlice.ts`) and mirrored in the UI's candidate
filtering (`RulesColumn.candidatesFor`, `CheckSelectDialog`) — wasm/core themselves don't reject
a duplicate `type_id` across instances; `QualityControlEngine` runs every configured instance
unconditionally regardless of this flag, since nothing in the QC/repair pipeline depends on it
being correct.

### ParamDescriptor

```rust
struct ParamDescriptor {
    id: &'static str,
    label: &'static str,
    kind: ParamKindDto,
}

#[serde(tag = "type", rename_all = "snake_case")]
enum ParamKindDto {
    Float    { default: f64, min: f64, max: f64 },
    Integer  { default: i64, min: i64, max: i64 },
    Bool     { default: bool },
    Enum     { options: Vec<&'static str>, default: &'static str },
    Interval { default_min: f64, default_max: f64, min: f64, max: f64 },
    // A split-pattern list (GitHub issue #247) — signals the web UI to render the shared
    // pattern-list dialog (`SplitPatternListEditor`) instead of a plain input. Wire value is a
    // JSON-serialized `Vec<SplitPatternDto>` string carried in the check's own `params` map, same
    // shape `SplitGenerationConfigDto.patterns` uses (parsed by `parse_split_patterns_param`).
    // `with_weights` is always `false` for the one param currently using this kind
    // (`SplitCountCheck`/`SplitDensityCheck`'s own `patterns` filter, a plain membership list, no
    // weights) — `AddSplitStrategy`'s own pattern-selection pool uses `SplitGenerationConfig`
    // below instead, not this variant, since it needs a mode switch and node-count field this
    // shape doesn't carry.
    PatternList { with_weights: bool },
    // A full split-generation config — pattern mode toggle, `max_split_nodes` (unconstrained
    // mode), and a weighted pattern list (pattern mode) — bundled behind one settings button that
    // opens the same dialog (`SplitGenerationSettingsBody`) generation's own split settings use.
    // Wire value is a JSON-serialized `SplitGenerationConfigDto` string, same shape
    // `GenerateConfig.split_generation` uses (parsed by `parse_split_config_param`); see
    // `repair.md`'s `AddSplitStrategy` section, the one param currently using this kind.
    SplitGenerationConfig,
}
```

### GenerateConfig — check fields

```rust
pub struct GenerateConfig {
    pub stages: Vec<StageConfig>, // named, ordered rule groups — see below and GitHub issue #65
    // ...
}
```

Checks exist only inside a stage's `rules` — there is no separate flat check list or global param
dict (removed as part of GitHub issue #60; see `quality-feature.md`'s store-side model for the
matching web-side shape). The runner matches each check instance by its `type_id` string
(`match type_id.as_str()`), not by `IssueKind`. Unknown `type_id` values return an error. Unknown
param keys are silently ignored; missing params fall back to the check's default constant.

### StageConfig

```rust
#[derive(Deserialize)]
pub struct StageConfig {
    pub id: String,               // opaque stage id, unique across every stage in the config
    pub name: String,              // user-facing name, e.g. "Stage 1"
    pub rules: Vec<QcRuleConfig>,  // this stage's own rules
}
```

A named, ordered group of rules — `QualityControlEngine` (`maze-core`, via its owned `Stage`s)
dispatches one stage at a time, in `stages` array order, only rules belonging to the current
stage, until it has no more active issues, then moves to the next stage. See `repair.md`'s "Rule,
Stage, and the unified QualityControlEngine" section for the full dispatch semantics and the
shared `RepairLimits` budget across stages. `maze-wasm/src/runner.rs::build_qc_and_repair`
rejects a config where a rule with a `strategy` doesn't appear in any stage's `rules`
(`"rule {id} not assigned to any stage"`), a duplicate `stage.id` across the config
(`"duplicate stage id: {id}"`), or a duplicate rule `id` across stages
(`"duplicate rule id: {id}"`).

### QcRuleConfig

```rust
#[derive(Deserialize)]
pub struct CheckInstanceConfig {
    pub local_id: String,                  // unique only within this rule's `checks`, not globally
    pub type_id: String,                   // check type id — available_checks()'s CheckDescriptor.id
    pub params: HashMap<String, String>,   // this instance's own param overrides
}

#[derive(Deserialize)]
pub struct QcRuleConfig {
    pub id: String,                        // opaque rule id, assigned by the web client
    pub checks: Vec<CheckInstanceConfig>,  // check instances, must share one IssueKind
    pub strategy: Option<StrategyConfig>,  // None = "no_fix"
}
```

One user-defined QC rule: a non-empty set of active check **instances** producing the same
`IssueKind`, sharing one repair strategy (or none — `strategy: None`, the rule's issues still
merge for attribution but no `RepairStrategy` is dispatched). Two instances of the same
`type_id` in the same rule (or in different rules) is a normal, fully supported case — see
GitHub issue #60 — not deduplicated anywhere in this pipeline; each `Rule` runs every one of its
own instances independently and completely. `local_id` only needs to be unique within its own
rule's `checks` array — `maze-wasm/src/runner.rs::build_qc_and_repair` rejects a config with a
duplicate `local_id` inside one rule (`"rule {id} has duplicate local_id: {local_id}"`), as a
defense against malformed/hand-edited configs; the web store's own monotonic per-rule counter
already guarantees this never happens via normal UI flow. See `repair.md`'s "Rule, Stage, and the
unified QualityControlEngine" section for how a `QcRuleConfig` is validated and turned into core's
`Rule`.

`GenerateConfig::default()` ships one default stage (`{ id: "stage_1", name: "Stage 1" }`) containing one default rule: `{ id: "default_missing_endpoints", checks: [{ local_id: "missing_endpoints", type_id: "missing_endpoints", params: {} }], strategy: Some(farthest_endpoints) }` — `local_id == type_id` here is a deliberate special case for this fixed bootstrap singleton, not a general pattern. `unreachable_finish` has no default rule (but does default to the same one stage, with `strategy: None`).

### Available checks

| ID | Issue kind | Params | Default selected |
|----|------------|--------|-----------------|
| `missing_endpoints` | `missing_endpoints` | — | yes |
| `unreachable_finish` | `unreachable_finish` | — | yes |
| `min_loops_count` | `missing_loops` | `min_loops: Integer(default=1, min=1, max=1_000_000)` | no |
| `min_loop_density` | `missing_loops` | `min_density: Integer(default=30, min=0, max=100)`, `avg_loop_length_estimate: Integer(default=10, min=1, max=100_000)` | no |
| `loop_length` | `invalid_loop` | `length: Integer(default=10, min=1, max=100_000)`, `comparison: Enum(options=[lt,gt,le,ge,eq], default=lt)` | no |
| `external_escape_diversity` | `invalid_loop` | `min_distinct_exits: Integer(default=3, min=0, max=1_000)` | no |
| `loop_distance_from_start` | `invalid_loop` | `min_distance_from_start: Integer(default=0, min=0, max=100_000)` | no |
| `loop_distance_from_finish` | `invalid_loop` | `min_distance_from_finish: Integer(default=0, min=0, max=100_000)` | no |
| `max_loop_density` | `invalid_loop_group` | `max_density: Integer(default=30, min=0, max=100)` | no |
| `max_loops_count` | `invalid_loop_group` | `max_loops_count: Integer(default=20, min=0, max=100_000)` | no |
| `scc_count` | `excessive_scc_count` | `max_scc_count: Integer(default=1, min=1, max=1_000_000)` | no |
| `min_region_size` | `region_needs_expansion` | `min_region_size: Integer(default=20, min=1, max=1_000_000)`, `region_class: Enum(options=[all,path,alternative,unreachable,trap], default=all)` | no |
| `min_region_ratio` | `region_needs_expansion` | `min_region_ratio: Integer(default=25, min=0, max=100)`, `region_class: Enum(options=[all,path,alternative,unreachable,trap], default=all)` | no |
| `max_region_size` | `region_needs_shrink` | `max_region_size: Integer(default=1_000_000, min=1, max=1_000_000)`, `region_class: Enum(options=[all,path,alternative,unreachable,trap], default=all)` | no |
| `max_region_ratio` | `region_needs_shrink` | `max_region_ratio: Integer(default=75, min=0, max=100)`, `region_class: Enum(options=[all,path,alternative,unreachable,trap], default=all)` | no |
| `min_region_count` | `missing_regions` | `region_class: Enum(options=[path,alternative,unreachable,trap], default=trap)`, `count: Integer(default=1, min=0, max=1_000_000)` | no |
| `teleport_duplicates_connection` | `invalid_teleport` | `protect_route: Bool(default=true)` | no |
| `teleport_waypoint_distance` | `invalid_teleport` | `distance: Integer(default=0, min=0, max=100_000)`, `comparison: Enum(options=[lt,gt,le,ge,eq], default=lt)`, `waypoint: Enum(options=[start,finish,any], default=any)`, `edge: Enum(options=[entry_only,entry_or_exit], default=entry_or_exit)`, `protect_route: Bool(default=true)` | no |
| `teleport_geometric_length` | `invalid_teleport` | `length: Float(default=0.0, min=0.0, max=1_000_000.0)`, `comparison: Enum(options=[lt,gt,le,ge,eq], default=lt)`, `protect_route: Bool(default=true)` | no |
| `teleport_graph_distance` | `invalid_teleport` | `distance: Integer(default=0, min=0, max=100_000)`, `comparison: Enum(options=[lt,gt,le,ge,eq], default=lt)`, `protect_route: Bool(default=true)` | no |
| `teleport_super_hub_avoidance` | `invalid_teleport` | `max_connections: Integer(default=1_000, min=0, max=1_000_000)`, `edge_hub: Enum(options=[entry,exit,entry_or_exit], default=entry_or_exit)`, `protect_route: Bool(default=true)` | no |
| `teleport_group_proximity` | `teleport_group_proximity` | `distance: Float(default=0.0, min=0.0, max=100_000.0)`, `own_edge: Enum(options=[entry,exit,entry_or_exit], default=entry_or_exit)`, `other_edge: Enum(options=[entry,exit,entry_or_exit], default=entry_or_exit)`, `protect_route: Bool(default=true)` | no |
| `min_teleport_count` | `missing_teleports` | `min_teleports: Integer(default=1, min=1, max=1_000_000)` | no |
| `min_teleport_ratio` | `missing_teleports` | `min_teleport_ratio: Integer(default=10, min=0, max=100)` | no |
| `min_one_way_count` | `missing_one_ways` | `min_one_ways: Integer(default=1, min=1, max=1_000_000)` | no |
| `min_one_way_ratio` | `missing_one_ways` | `min_ratio: Integer(default=10, min=0, max=100)` | no |
| `max_one_way_count` | `invalid_one_way_group` | `max_one_ways: Integer(default=1_000, min=0, max=1_000_000)` | no |
| `max_one_way_ratio` | `invalid_one_way_group` | `max_ratio: Integer(default=100, min=0, max=100)` | no |
| `split_distance_from_waypoint` | `invalid_split_tile` | `distance: Integer(default=0, min=0, max=100_000)`, `comparison: Enum(options=[lt,gt,le,ge,eq], default=lt)`, `waypoint: Enum(options=[start,finish,any], default=any)` | no |
| `max_split_count` | `invalid_split_tile_group` | `max_split_count: Integer(default=20, min=0, max=1_000_000)` | no |
| `max_split_density` | `invalid_split_tile_group` | `max_split_density: Integer(default=30, min=0, max=100)` | no |
| `split_group_geometric_proximity` | `invalid_split_tile_group` | `split_group_geometric_proximity_distance: Float(default=0.0, min=0.0, max=100_000.0)` | no |
| `split_group_graph_proximity` | `invalid_split_tile_group` | `split_group_graph_proximity_distance: Float(default=0.0, min=0.0, max=100_000.0)` | no |
| `split_count` | `missing_split_tiles` | `split_count: Integer(default=1, min=0, max=1_000_000)`, `patterns: PatternList(with_weights=false)` | no |
| `split_density` | `missing_split_tiles` | `split_density: Integer(default=10, min=0, max=100)`, `split_tile_estimate: Integer(default=1, min=1, max=100_000)`, `patterns: PatternList(with_weights=false)` | no |
| `split_node_connection_count` | `invalid_split_node` | `count: Integer(default=2, min=0, max=1_000_000)`, `comparison: Enum(options=[lt,gt,le,ge,eq], default=lt)`, `direction: Enum(options=[incoming,outgoing,bidirectional,any], default=any)` | no |
| `split_node_connection_per_neighbor` | `invalid_split_node_connection_group` | `max: Integer(default=1, min=0, max=1_000_000)` | no |
| `split_node_connection_per_face` | `invalid_split_node_connection_group` | `max: Integer(default=1, min=0, max=1_000_000)` | no |
| `max_split_tile_node_count` | `invalid_split_node_group` | `max: Integer(default=3, min=0, max=1_000_000)` | no |

Checks without params are auto-selected on `loadRegistry`. Checks with params are not auto-selected — the user must add them explicitly.

`teleport_waypoint_distance` has `allow_multiple_instances: true` (see "CheckDescriptor" above) — same rationale as `min_region_count`: distinct `waypoint`/`edge`/`distance`/`comparison` combinations are a legitimate simultaneous configuration. `split_group_geometric_proximity`/`split_group_graph_proximity` likewise allow multiple instances — distinct distance thresholds are a legitimate simultaneous configuration, same rationale as `one_way_group_geometric_proximity`/`teleport_group_proximity`. `split_node_connection_count`/`split_node_connection_per_neighbor`/`split_node_connection_per_face` also allow multiple instances — distinct threshold/direction or `max` combinations are a legitimate simultaneous configuration.

## Architectural Contract

Only code that owns the `Maze` may call `&mut self` accessors on `maze.analysis`. QC checks and repair strategies may read `maze.analysis` via shared reference but must not write to it.

`MazeAnalysis` caches derived data lazily. See `analysis.md` for the full contract.
