use std::collections::HashMap;

#[path = "issue_kind_ids.rs"]
mod issue_kind_ids;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, maze_core_macros::IdEnum)]
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
    MissingSplitTiles,
    InvalidSplitNode,
    InvalidSplitNodeConnection,
    InvalidSplitNodeConnectionGroup,
    InvalidSplitNodeGroup,
    InvalidSplitRoute,
    InvalidVerticalPassage,
    InvalidVerticalPassageGroup,
    MissingVerticalPassages,
    InvalidElevator,
    InvalidElevatorGroup,
    InvalidElevatorStop,
    InvalidElevatorStopGroup,
    MissingElevators,
    AreaMissingElevatorStops,
    MissingElevatorStopCount,
    MissingElevatorHeight,
    ExcessiveElevatorStopGap,
    InvalidCrossElementGroup,
    InvalidDeadEnd,
    InvalidDeadEndGroup,
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
/// never removes a tile's last remaining node (a hard constraint across every split-QC strategy, see GitHub epic #246).
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

/// A single dead-end node selected from an aggregate group for repair. This nested-only kind is
/// synthesized by `DeadEndGroupSelectStrategy`; no check emits it directly. Carries
/// `InvalidDeadEndIssue` and is repaired by `DeadEndToPassageStrategy`.
pub const INVALID_DEAD_END: IssueKind = IssueKind::InvalidDeadEnd;
/// A field-wide aggregate condition over dead-end nodes. `InvalidDeadEndGroup` is produced by
/// the maximum dead-end count and density checks; its groups retain every candidate node in the
/// affected scope together with the excess count for consistent warning/debug attribution.
pub const INVALID_DEAD_END_GROUP: IssueKind = IssueKind::InvalidDeadEndGroup;

/// The maze has fewer split tiles than some check requires (currently `SplitCountCheck`/
/// `SplitDensityCheck`) — part of epic #246. Mirrors `MISSING_LOOPS`'s role for loops: a
/// missing-count condition rather than a specific-tile one. Carries `MissingSplitTilesIssue {
/// missing }` — see that type's doc comment. Repaired by `AddSplitStrategy`, which mints new split
/// tiles at eligible points to close the deficit — never removes or alters any existing tile's
/// last remaining node (the hard constraint across every split-QC strategy in this epic).
pub const MISSING_SPLIT_TILES: IssueKind = IssueKind::MissingSplitTiles;

/// A single split node (any node of a split tile, slot-0 included) is invalid for some
/// check-specific reason — currently `SplitNodeConnectionCountCheck` (the node's connection count,
/// filtered by direction, compares against a configured threshold, per a configured `Comparison`)
/// — see GitHub issue #250, part of epic #246. Distinct from `INVALID_SPLIT_TILE`: that kind's
/// unit of work is a whole tile (`SplitTileNodes`), this one's is a single node (`NodeId`) — a
/// check here may flag any node of the tile, including its last remaining one, but the registered
/// repair strategy (`RemoveSplitNodeStrategy`) still never removes a tile's last remaining node,
/// mirroring the hard constraint every strategy in this epic shares. Carries `InvalidSplitNodeIssue
/// { invalid: Vec<NodeId>, .. }` — see that type's doc comment.
pub const INVALID_SPLIT_NODE: IssueKind = IssueKind::InvalidSplitNode;

/// A single connection (edge) from one node of a split tile out to an outside neighbor is
/// invalid for some check-specific reason — see GitHub issue #251, part of epic #246. Mirrors
/// `INVALID_ONE_WAY`'s role for one-ways: a semantic category, not tied to one specific reason.
/// Carries `InvalidSplitNodeConnectionIssue { invalid: Vec<EdgeId>, .. }` — see that type's doc
/// comment. Exists purely as the nested-strategy target for
/// `SplitNodeConnectionGroupSelectStrategy` (below) — no check produces this kind directly, only
/// `INVALID_SPLIT_NODE_CONNECTION_GROUP`'s own checks do, mirroring `INVALID_ONE_WAY`'s dual role
/// as both a directly-checked kind and a group-select nested target.
pub const INVALID_SPLIT_NODE_CONNECTION: IssueKind = IssueKind::InvalidSplitNodeConnection;

/// A split tile's nodes collectively over-connect to the outside world — see GitHub issue #251,
/// part of epic #246. Two producing checks: `SplitNodeConnectionPerNeighborCheck` (too many
/// connections from different nodes of the same split converging on one outside neighbor) and
/// `SplitNodeConnectionPerFaceCheck` (too many connections from different nodes of the same split
/// going out through the same tile face direction) — mirrors
/// `OneWayGroupGeometricProximityCheck`/`OneWayGroupGraphProximityCheck` staying two distinct
/// checks rather than one dual-metric check. Distinct from `INVALID_SPLIT_NODE`: that kind flags
/// a single node's own connection count invalid on its own terms; this one flags a *relationship*
/// across several nodes of the same split (excess connections converging on one neighbor/face),
/// none of which is individually invalid. Carries `InvalidSplitNodeConnectionGroupIssue` — see
/// that type's doc comment. Repaired by `SplitNodeConnectionGroupSelectStrategy`, which delegates
/// each candidate connection's removal to a nested `INVALID_SPLIT_NODE_CONNECTION` strategy
/// (`RemoveSplitNodeConnectionStrategy`).
pub const INVALID_SPLIT_NODE_CONNECTION_GROUP: IssueKind =
    IssueKind::InvalidSplitNodeConnectionGroup;

/// A split tile has more nodes than a check's configured limit allows (currently
/// `SplitTileNodeCountCheck`, compared via the shared `Comparison` operator) — see GitHub issue
/// #252, part of epic #246. Distinct from `INVALID_SPLIT_NODE_CONNECTION_GROUP`: that kind flags
/// excess *connections* converging on a neighbor/face; this one flags excess *node count* within a
/// single split tile, none of whose individual nodes is invalid on its own. Carries
/// `InvalidSplitNodeGroupIssue` — see that type's doc comment. Repaired by
/// `SplitNodeGroupSelectStrategy`, which delegates each candidate node's removal to a nested
/// `INVALID_SPLIT_NODE` strategy (`RemoveSplitNodeStrategy`) — never selects a tile's last remaining node.
pub const INVALID_SPLIT_NODE_GROUP: IssueKind = IssueKind::InvalidSplitNodeGroup;

/// A graph path shorter than a configured minimum detour connects two split nodes of the same
/// split tile — see GitHub issue #277, part of epic #246. Distinct from every other split-related
/// kind: this one's unit of work is a whole traversal *route* (an ordered sequence of edges), not
/// a single node, a single connection, or an unordered group — a repair strategy needs the full
/// path (not just its two endpoint edges) to be able to cut any edge along the way, distinguishing
/// edges incident to the split tile itself from every other edge on the route. Carries
/// `InvalidSplitRouteIssue { routes, .. }` — see that type's doc comment. Repaired by
/// `SplitRouteCutStrategy`, which delegates a chosen split-tile edge's removal to a nested
/// `INVALID_SPLIT_NODE_CONNECTION` strategy (`RemoveSplitNodeConnectionStrategy`) and cuts any
/// other chosen edge itself.
pub const INVALID_SPLIT_ROUTE: IssueKind = IssueKind::InvalidSplitRoute;

/// A `VerticalPassage` edge is invalid for some check-specific reason — see GitHub issue #343.
/// Mirrors `INVALID_TELEPORT`'s role for teleports: a semantic category, not tied to one specific
/// reason — currently produced by `VerticalPassageGroupGeometricProximityCheck`/
/// `VerticalPassageGroupGraphProximityCheck`. Carries `InvalidVerticalPassageIssue` — see that type's
/// doc comment. Repaired by `RemoveVerticalPassageStrategy`. Also the nested-strategy target for
/// `INVALID_VERTICAL_PASSAGE_GROUP`'s own checks, mirroring `INVALID_ONE_WAY`'s dual role.
pub const INVALID_VERTICAL_PASSAGE: IssueKind = IssueKind::InvalidVerticalPassage;
/// A set of `VerticalPassage` edges is jointly invalid — see GitHub issue #343. Distinct from
/// `INVALID_VERTICAL_PASSAGE`: that kind flags a single vertical-passage edge invalid on its own;
/// this one flags a *relationship*/*aggregate* condition over two or more of them, none of which
/// is individually invalid. Currently produced by `MaxVerticalPassageCountCheck`/
/// `MaxVerticalPassageRatioCheck` (maze-wide/per-floor excess). Carries
/// `InvalidVerticalPassageGroupIssue` — see that type's doc comment. Repaired by
/// `VerticalPassageGroupSelectStrategy`, which delegates each candidate edge's removal to a
/// nested `INVALID_VERTICAL_PASSAGE` strategy (`RemoveVerticalPassageStrategy`).
pub const INVALID_VERTICAL_PASSAGE_GROUP: IssueKind = IssueKind::InvalidVerticalPassageGroup;
/// The maze has fewer `VerticalPassage` edges than some check requires (currently
/// `MinVerticalPassageCountCheck`/`MinVerticalPassageRatioCheck`) — see GitHub issue #343. Mirrors
/// `MISSING_TELEPORTS`'s role for teleports: a missing-count condition rather than a specific-edge
/// one. Carries `MissingVerticalPassagesIssue { missing }` — see that type's doc comment. Repaired
/// by `AddVerticalPassageStrategy`.
pub const MISSING_VERTICAL_PASSAGES: IssueKind = IssueKind::MissingVerticalPassages;
/// A single `Elevator` (a connected fan of `EdgeKind::Elevator` edges across a point's floors,
/// see `checks::elevator_core`) is invalid for a check-specific reason — currently
/// `ElevatorStopCountCheck`/`ElevatorSpanCheck` — see GitHub issue #397. Carries
/// `InvalidElevatorIssue { invalid }`, one `ElevatorNodes` (the elevator's own stop node set) per
/// flagged elevator — mirrors `InvalidSplitTileIssue`'s "whole entity is the unit" shape. Repaired
/// by `RemoveElevatorStrategy`/`ReplaceElevatorWithPassagesStrategy`.
pub const INVALID_ELEVATOR: IssueKind = IssueKind::InvalidElevator;
/// A set of `Elevator`s is jointly invalid — see GitHub issue #398, part of epic #344. Distinct
/// from `INVALID_ELEVATOR`: that kind flags a single elevator invalid on its own; this one flags
/// an aggregate condition over the whole-maze elevator group (excess count, excess density), none
/// of which is individually invalid. Mirrors `INVALID_VERTICAL_PASSAGE_GROUP`'s split from
/// `INVALID_VERTICAL_PASSAGE`. Carries `InvalidElevatorGroupIssue` — see that type's doc comment.
/// Repaired by `ElevatorGroupSelectStrategy`, which delegates each candidate elevator's removal to
/// a nested `INVALID_ELEVATOR` strategy (`RemoveElevatorStrategy`/`ReplaceElevatorWithPassagesStrategy`).
pub const INVALID_ELEVATOR_GROUP: IssueKind = IssueKind::InvalidElevatorGroup;
/// One or more of a single elevator's own stop nodes are individually invalid — see GitHub issue
/// #399, part of epic #344. Distinct from `INVALID_ELEVATOR`: that kind flags a whole elevator for
/// removal/conversion; this one flags specific stop nodes within an otherwise-fine elevator for
/// removal, shrinking the elevator by that many stops rather than removing it outright. Carries
/// `InvalidElevatorStopIssue` — a `Vec<NodeId>` of the stop nodes to remove, mirroring
/// `InvalidElevatorIssue`'s shape but at stop-node rather than whole-elevator granularity. Repaired
/// by `RemoveElevatorStopStrategy`.
pub const INVALID_ELEVATOR_STOP: IssueKind = IssueKind::InvalidElevatorStop;
/// A set of stop nodes across one or more elevators is jointly invalid — see GitHub issue #399,
/// part of epic #344. Distinct from `INVALID_ELEVATOR_STOP`: that kind flags specific stop nodes
/// invalid on their own; this one flags an aggregate condition (excess stop count on a single
/// elevator, or excess elevator-stop density on a single floor), none of which is individually
/// invalid. Carries `InvalidElevatorStopGroupIssue` — see that type's doc comment. Repaired by
/// `ElevatorStopGroupSelectStrategy`, which delegates each candidate stop's removal to a nested
/// `INVALID_ELEVATOR_STOP` strategy (`RemoveElevatorStopStrategy`).
pub const INVALID_ELEVATOR_STOP_GROUP: IssueKind = IssueKind::InvalidElevatorStopGroup;
/// The maze has fewer elevators (`elevator_core::elevator_groups`) than some check requires —
/// currently `MinElevatorCountCheck`/`MinElevatorDensityCheck` — see GitHub issue #401, part of
/// epic #344. Mirrors `MISSING_TELEPORTS`'s role for teleports: a missing-count condition rather
/// than a specific-edge one, whole-maze scope only (an elevator inherently spans several floors,
/// so there is no single "checked floor" to attribute a deficit to — same rationale as
/// `MaxElevatorCountCheck`/`MaxElevatorDensityCheck`). Carries `MissingElevatorsIssue { missing }`
/// — see that type's doc comment. Repaired by `AddElevatorStrategy`.
pub const MISSING_ELEVATORS: IssueKind = IssueKind::MissingElevators;
/// An existing elevator group has too few stops, scoped either per-floor or whole-maze — see
/// GitHub issue #408, part of epic #344. Distinct from `MISSING_ELEVATORS`: that kind flags too
/// few elevators (count of distinct elevator groups); this one flags too few *stops* across the
/// elevators that already exist (an elevator with a single stop is still one elevator, but
/// contributes zero usable vertical connections). Carries `AreaMissingElevatorStopsIssue
/// { missing }` — see that type's doc comment. Repaired by `AddElevatorStopStrategy`.
pub const AREA_MISSING_ELEVATOR_STOPS: IssueKind = IssueKind::AreaMissingElevatorStops;
/// An existing elevator has fewer stops overall than `MinElevatorStopCountCheck` requires — see
/// GitHub issue #402, part of epic #344. Distinct from `MISSING_ELEVATORS`: that kind flags a
/// deficit in the overall elevator count (build brand-new elevators); this one flags a deficit in
/// one *existing* elevator's own stop count (add stops to it). Carries
/// `MissingElevatorStopCountIssue { missing }` — see that type's doc comment. Repaired by
/// `AddElevatorStopCountStrategy`. Split from a single shared `MISSING_ELEVATOR_STOPS` kind (see
/// git history) into its own kind, `MISSING_ELEVATOR_HEIGHT`, and `EXCESSIVE_ELEVATOR_STOP_GAP` —
/// each deficit reason needs its own candidate-floor search geometry (plain "any free floor" here
/// vs. height-satisfying floors vs. floors strictly between one gap's endpoints), which doesn't
/// combine cleanly into one repair strategy.
pub const MISSING_ELEVATOR_STOP_COUNT: IssueKind = IssueKind::MissingElevatorStopCount;
/// An existing elevator's vertical span (topmost stop's floor index minus bottommost's) is below
/// `MinElevatorHeightCheck`'s configured minimum — see GitHub issue #402, part of epic #344.
/// Carries `MissingElevatorHeightIssue { missing }` — see that type's doc comment. Repaired by
/// `AddElevatorHeightStopStrategy`, which grows the elevator's own floor interval (randomly,
/// optionally balanced between both ends) until it's long enough, then adds one stop below and one
/// above it.
pub const MISSING_ELEVATOR_HEIGHT: IssueKind = IssueKind::MissingElevatorHeight;
/// An existing elevator has a consecutive stop pair (adjacent after sorting by floor index) whose
/// gap — the number of floors skipped between them — exceeds `MaxElevatorStopGapCheck`'s
/// configured maximum — see GitHub issue #402, part of epic #344. Carries
/// `ExcessiveElevatorStopGapIssue { missing }` — see that type's doc comment. Repaired by
/// `AddElevatorStopForGapStrategy`.
pub const EXCESSIVE_ELEVATOR_STOP_GAP: IssueKind = IssueKind::ExcessiveElevatorStopGap;
/// Two special maze elements of a user-selected type set (teleport / one-way / vertical passage /
/// elevator / split tile / start / finish) sit closer than a configured minimum distance — see
/// GitHub issue #376. Produced by `CrossElementGeometricProximityCheck` /
/// `CrossElementGraphProximityCheck`; carries `InvalidCrossElementGroupIssue` (the generic
/// `InvalidGroupIssue` shape, one group per too-close logical pair). Repaired by
/// `CrossElementGroupSelectStrategy`, which removes one element of the pair; a pair whose two
/// elements are both unremovable (e.g. `[Start, Finish]`, or route-protected) is left in place.
pub const INVALID_CROSS_ELEMENT_GROUP: IssueKind = IssueKind::InvalidCrossElementGroup;

/// `as_str`/`from_str`/`Display` for `IssueKind` are generated (`codegen`'s `id_enum` module, see
/// GitHub issue #361) into the sibling `issue_kind_ids.rs` from the variant list above — do not
/// hand-write them here. `from_str` round-trips every variant including `CycleAnalysisOverflowed`,
/// even though the latter can never have a registered `RepairStrategy` (it's not a toggleable QC
/// check — see `CYCLE_ANALYSIS_OVERFLOWED`'s doc comment): also used by `maze-wasm/src/runner.rs`
/// to validate `config.strategies` keys, where a config naming this kind parses here, then fails
/// downstream with "unknown strategy" the same way any other kind with no matching strategy
/// registration would — there is no dedicated rejection at this layer, by design, since strategy
/// availability is the repair engine's concern, not `IssueKind`'s.
///
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
        Self {
            source_checks: vec![source_check.to_string()],
            details: HashMap::new(),
        }
    }

    /// Attaches a display detail under `source_check` (raw value only, e.g. a threshold — never
    /// an assembled message, see `details`' doc comment above). Chainable — a `Check` calls this
    /// right after constructing its issue's `IssueMeta` via `new_from_check`. `source_check`
    /// should be the same id the issue was constructed with.
    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.details
            .entry(source_check.to_string())
            .or_default()
            .insert(key, value);
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
    pub(crate) fn merge_details(
        &mut self,
        incoming: HashMap<String, HashMap<&'static str, String>>,
    ) {
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
            fn kind(&self) -> $crate::quality_control::issue::IssueKind {
                Self::KIND
            }
            fn meta(&self) -> &$crate::quality_control::issue::IssueMeta {
                &self.meta
            }
            fn meta_mut(&mut self) -> &mut $crate::quality_control::issue::IssueMeta {
                &mut self.meta
            }
            fn as_any(&self) -> &dyn std::any::Any {
                self
            }
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
