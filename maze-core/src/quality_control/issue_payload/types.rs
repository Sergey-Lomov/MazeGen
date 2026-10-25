use std::collections::HashMap;

/// One flagged edge-group element (a cycle, a one-way/teleport group, or a single flagged edge
/// treated as a size-one group) resolved for the web/tape wire boundary — pairs the group's
/// base-graph edges with whether every one of them is preset-protected (GitHub issue #245).
/// `preset_locked: true` means repair can never fix this specific element (every edge in it is a
/// user-placed Passage/OneWay connection `PresetState.preset_edges` forbids removing) — distinct
/// from the element simply not having been fixed yet. Named struct (not a bare tuple) so the
/// wasm/TS wire shape carries field names instead of positional indices.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueEdgeGroupPayload {
    pub edges: Vec<[u32; 2]>,
    pub preset_locked: bool,
}

/// One tile's own node list inside a flagged split-tile/split-node-group element — pairs the
/// tile's member node ids with whether the WHOLE tile is preset-locked: every node in it would be
/// declined by repair's `RemoveNode`/`ReplacePointNodes` machinery (`PresetState::is_node_locked_for_removal`
/// — the same predicate `remove_node_feasible`/`replace_point_nodes_feasible` use at apply time).
/// An empty tile is vacuously not locked, same convention as `all_preset_locked`'s empty guard.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueSplitTilePayload {
    pub nodes: Vec<u32>,
    pub preset_locked: bool,
}

/// One flagged split-tile "instance" resolved for the wire boundary — a single tile
/// (`InvalidSplitTileIssue`, `InvalidSplitNodeIssue`'s single node treated as a 1-node tile,
/// `InvalidSplitNodeGroupIssue`'s per-tile groups) or a genuine multi-tile group
/// (`InvalidSplitTileGroupIssue`'s proximity pairs / field-wide max-count-or-density bundle).
/// `preset_locked` is true iff every tile in `tiles` is itself preset-locked (GitHub issue #245's
/// split extension). Web-side counting of "how many preset instances" picks its own granularity
/// per check type — some checks (`max_split_count`/`max_split_density`) want one instance per
/// *tile*, others want one instance per *group* — see `issueRegistry.ts`'s `presetLockElementsFor`.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueSplitGroupPayload {
    pub tiles: Vec<IssueSplitTilePayload>,
    pub preset_locked: bool,
}

/// One edge of a flagged split route, in traversal order — `is_split_edge` mirrors the route's own
/// `SplitRouteEdge` flag (edge incident to the split tile the route was found for) and carries no
/// bearing on `IssueRoutePayload::preset_locked`, which depends only on preset protection.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueRouteEdge {
    pub from: u32,
    pub to: u32,
    pub is_split_edge: bool,
}

/// One flagged split route resolved for the wire boundary — `preset_locked` is true when every
/// edge on the route is preset-protected (`all_preset_locked`), independent of each edge's own
/// `is_split_edge` flag.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueRoutePayload {
    pub edges: Vec<IssueRouteEdge>,
    pub preset_locked: bool,
}

/// One flagged SCC region resolved for the wire boundary — pairs the region's member maze node
/// ids with whether repair can never fix it because of preset configuration (GitHub issue #245's
/// region extension). For `RegionNeedsShrink`, "locked" means the region's only possible cut-set
/// is entirely preset-protected edges. For `RegionNeedsExpansion`, "locked" means every geometric
/// boundary pair (a region node, a neighbor outside the region) is infeasible per `PresetState` —
/// see `region_preset_locked_for_expansion`'s doc comment for the underlying invariant this
/// relies on.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueRegionPayload {
    pub region: Vec<u32>,
    pub preset_locked: bool,
}

/// Whether every edge in `edges` is preset-protected (`PresetState::is_preset_edge`) — an empty
/// list resolves `false`, not vacuously `true` via `Iterator::all`, since an element with no
/// edges can't meaningfully be "locked" by anything.
pub(super) fn all_preset_locked(
    edges: &[crate::ids::EdgeId],
    graph: &crate::graph::Graph,
    preset_state: &crate::generation::PresetState,
) -> bool {
    !edges.is_empty()
        && edges.iter().all(|&eid| {
            graph
                .edge(eid)
                .is_some_and(|e| preset_state.is_preset_edge(e.from, e.to))
        })
}

/// Structural payload data for an `Issue`, resolved against the current `Graph`/`ConnectedComponents`
/// — one shared source of truth for both `maze-wasm`'s JSON `IssuePayloadDto` (via a thin
/// conversion, `maze-wasm/src/dto.rs`) and the narration-level QC event tape's binary
/// `RuleChecked` payload (`quality_control::event`). Only `InvalidLoopIssue`/
/// `InvalidLoopGroupIssue`/`RegionNeedsExpansionIssue`/`RegionNeedsShrinkIssue`/
/// `InvalidTeleportIssue`/`InvalidTeleportGroupIssue`/`InvalidOneWayIssue`/
/// `InvalidOneWayGroupIssue`/`InvalidVerticalPassageIssue`/`InvalidVerticalPassageGroupIssue`/
/// `InvalidSplitNodeConnectionGroupIssue`/`InvalidSplitTileIssue`/
/// `InvalidSplitTileGroupIssue`/`InvalidSplitNodeIssue`/`InvalidSplitNodeGroupIssue`/
/// `InvalidSplitRouteIssue` carry structural edge/node data today — every other concrete `Issue`
/// type resolves to `None`, same as `build_analytics_snapshot`'s pre-existing behavior.
/// `InvalidLoopGroupIssue` reuses the `InvalidLoop` payload variant (identical shape) rather than
/// getting its own wire tag — `InvalidTeleportGroupIssue` reuses `InvalidTeleport` the same way,
/// and `InvalidOneWayGroupIssue` reuses `InvalidOneWay` the same way (see GitHub issue #205).
#[derive(Debug, Clone, PartialEq, Default)]
pub enum IssuePayload {
    #[default]
    None,
    /// Keyed by source check id — each inner `Vec` is one invalid cycle flagged by that check,
    /// paired with whether every edge in it is preset-protected (GitHub issue #245). Mirrors
    /// `IssuePayloadDto::InvalidLoop`.
    InvalidLoop {
        edges: HashMap<String, Vec<IssueEdgeGroupPayload>>,
    },
    /// Keyed by source check id — each entry is one flagged SCC region, paired with its own
    /// `preset_locked` status (GitHub issue #245's region extension). Mirrors
    /// `IssuePayloadDto::RegionNeedsExpansion`.
    RegionNeedsExpansion {
        nodes: HashMap<String, Vec<IssueRegionPayload>>,
    },
    /// Keyed by source check id — same shape as `RegionNeedsExpansion`, but for an oversized
    /// region flagged for shrinking (see GitHub issue #177). Mirrors
    /// `IssuePayloadDto::RegionNeedsShrink`.
    RegionNeedsShrink {
        nodes: HashMap<String, Vec<IssueRegionPayload>>,
    },
    /// Keyed by source check id — each inner `Vec` is one flagged teleport "group", expressed as
    /// base-graph `[from, to]` maze node-id pairs, one pair per teleport edge in the group.
    /// `InvalidTeleportIssue` (a single flagged teleport is really a group of size one) and
    /// `InvalidTeleportGroupIssue` (a problematic pair) both resolve into this same shape rather
    /// than getting their own payload variant each — see GitHub issue #195, mirrors
    /// `InvalidLoop`'s reuse across `InvalidLoopIssue`/`InvalidLoopGroupIssue`. Mirrors
    /// `IssuePayloadDto::InvalidTeleport`.
    InvalidTeleport {
        groups: HashMap<String, Vec<IssueEdgeGroupPayload>>,
    },
    /// Keyed by source check id — each inner `Vec` is one flagged one-way "group", expressed as
    /// base-graph `[from, to]` maze node-id pairs, one pair per one-way edge in the group.
    /// `InvalidOneWayIssue` (a single flagged one-way is a group of size one) and
    /// `InvalidOneWayGroupIssue` (a proximity/super-hub/count-excess group of any size) both
    /// resolve into this same shape — mirrors `InvalidTeleport`'s reuse across
    /// `InvalidTeleportIssue`/`InvalidTeleportGroupIssue` — see GitHub issue #205. Mirrors
    /// `IssuePayloadDto::InvalidOneWay`. Kept a distinct variant from `InvalidTeleport` (not
    /// reused) so `payload.kind` still mirrors `IssueKind::as_str()` (`invalid_one_way` vs.
    /// `invalid_teleport`), same rationale as every other variant here.
    InvalidOneWay {
        groups: HashMap<String, Vec<IssueEdgeGroupPayload>>,
    },
    /// Keyed by source check id — each inner `Vec` is one flagged vertical-passage "group",
    /// expressed as base-graph `[from, to]` maze node-id pairs, one pair per `VerticalPassage`
    /// edge in the group. `InvalidVerticalPassageIssue` (a single flagged edge is a group of size
    /// one) and `InvalidVerticalPassageGroupIssue` (a proximity pair) both resolve into this same
    /// shape — mirrors `InvalidTeleport`'s reuse across `InvalidTeleportIssue`/
    /// `InvalidTeleportGroupIssue` — see GitHub issue #395. Mirrors
    /// `IssuePayloadDto::InvalidVerticalPassage`. Kept a distinct variant from `InvalidTeleport`
    /// (not reused) so `payload.kind` still mirrors `IssueKind::as_str()`.
    InvalidVerticalPassage {
        groups: HashMap<String, Vec<IssueEdgeGroupPayload>>,
    },
    /// Keyed by source check id — each entry is one flagged "instance" (a single tile, or a
    /// genuine multi-tile group for proximity/count/density checks — see `IssueSplitGroupPayload`'s
    /// doc comment), each paired with its own `preset_locked` flag (GitHub issue #245's split-node
    /// extension). Shared wire variant for `invalid_split_tile`/`invalid_split_tile_group`/
    /// `invalid_split_node`/`invalid_split_node_group` — `source_checks`/`payload.kind` plus the
    /// check's own `type_id` is the only way to tell which check produced a given element, same
    /// contract as `InvalidSplitNodeConnectionGroupIssue`'s reuse of `InvalidOneWay` below. Mirrors
    /// `IssuePayloadDto::InvalidSplitTile`.
    InvalidSplitTile {
        groups: HashMap<String, Vec<IssueSplitGroupPayload>>,
    },
    /// Keyed by source check id — each inner `Vec` is one flagged route, paired with its own
    /// `preset_locked` flag. Mirrors `IssuePayloadDto::InvalidSplitRoute`.
    InvalidSplitRoute {
        routes: HashMap<String, Vec<IssueRoutePayload>>,
    },
    /// Keyed by source check id — whether repair can never reduce the SCC count at all because
    /// every single region on the field is preset-locked against expansion (GitHub issue #245's
    /// extension to `ExcessiveSccCountIssue`, which carries no specific region list of its own —
    /// `ReduceSccCountStrategy` picks its merge targets fresh from live component sizes, not from
    /// data on the issue). No per-element highlight data, unlike every variant above — this issue
    /// never highlights specific regions on the canvas. Mirrors `IssuePayloadDto::ExcessiveSccCount`.
    ExcessiveSccCount {
        preset_locked: HashMap<String, bool>,
    },
    /// Keyed by source check id — each inner `Vec` is one flagged elevator, expressed as base-graph
    /// `[from, to]` pairs, one pair per `EdgeKind::Elevator` edge currently connecting its stops
    /// (re-resolved against `graph` at payload time, since `ElevatorNodes` names the elevator by its
    /// stop-node set, not by saved edge ids — see GitHub issue #397, mirrors `RemoveElevatorStrategy`'s
    /// own re-resolution). Mirrors `IssuePayloadDto::InvalidElevator`.
    InvalidElevator {
        groups: HashMap<String, Vec<IssueEdgeGroupPayload>>,
    },
    /// Keyed by source check id — each entry is one flagged elevator stop, wrapped as a
    /// single-node "region" (reuses `IssueRegionPayload`'s shape — see GitHub issue #399). A single
    /// flagged stop (`INVALID_ELEVATOR_STOP`) and a jointly-flagged stop group
    /// (`INVALID_ELEVATOR_STOP_GROUP`, excess count/density) both resolve into this same shape:
    /// a group's stops are emitted as separate single-node entries rather than one multi-node
    /// region, since each stop highlights independently (unlike a region's contiguous cell set).
    /// Mirrors `IssuePayloadDto::InvalidElevatorStop`.
    InvalidElevatorStop {
        nodes: HashMap<String, Vec<IssueRegionPayload>>,
    },
    /// Keyed by source check id — one single-node region per dead end in an over-budget scope.
    /// This is intentionally a distinct debug payload kind so warnings and QC narration identify
    /// dead-end nodes without implying that they are elevator stops or repair candidates.
    InvalidDeadEnd {
        nodes: HashMap<String, Vec<IssueRegionPayload>>,
    },
    /// Keyed by source check id — each entry is one flagged deficit area: `Some(level_index)` if
    /// the deficit is scoped to a specific floor (`RepairArea::Level`, the index being the floor's
    /// `levels_ordered()` position, same convention `NodeDto.level`/`level_index_of` already use
    /// at the wire boundary), or `None` for a whole-maze deficit (`RepairArea::WholeMaze`, e.g.
    /// `MissingElevatorsIssue`'s only scope) which has no specific floor to highlight — same
    /// "no per-element highlight" precedent as `ExcessiveSccCount` above. Shared wire variant for
    /// `missing_vertical_passages`/`missing_teleports`/`missing_elevators`/
    /// `area_missing_elevator_stops` — all four carry a `Vec<(RepairArea, u32)>` deficit list of
    /// identical shape, and none of them track which specific check flagged which entry (unlike
    /// e.g. `InvalidLoopIssue`'s `invalid_sources`), so every entry is attributed uniformly to
    /// every one of the issue's `source_checks()`. Mirrors `IssuePayloadDto::AreaDeficit`.
    AreaDeficit {
        areas: HashMap<String, Vec<Option<u32>>>,
    },
    /// Keyed by source check id — each entry is one flagged elevator's stop-count deficit: the
    /// elevator's currently-live fan of `EdgeKind::Elevator` edges (same shape as
    /// `InvalidElevator`'s `edges`, re-resolved against `graph` the same way), how many stops are
    /// still requested, and the available floor candidates resolved to base-graph node ids
    /// (`LevelId` isn't wire-safe) — see GitHub issue #402. Lets the web side highlight both the
    /// elevator itself and its candidate floors on hover. `MissingElevatorHeight`/
    /// `ExcessiveElevatorStopGap` reuse `InvalidElevator`'s plain edge-group shape instead — both
    /// leave candidate-floor selection to their own repair strategy, so neither has anything to
    /// offer here. Mirrors `IssuePayloadDto::MissingElevatorStopCount`.
    MissingElevatorStopCount {
        groups: HashMap<String, Vec<IssueMissingElevatorStopsPayload>>,
    },
    /// Keyed by source check id — each inner `Vec<CrossElementPayloadEntry>` is one flagged
    /// too-close pair (always two entries), one entry per logical element of the pair. Produced by
    /// `CrossElementGeometricProximityCheck` / `CrossElementGraphProximityCheck` (GitHub issue
    /// #376); the two checks share this one wire variant, told apart by `payload.kind` /
    /// `source_checks` like every other reused variant here. `to_remove` (always 1) carries no
    /// highlight meaning and is dropped. Mirrors `IssuePayloadDto::InvalidCrossElementGroup`.
    InvalidCrossElementGroup {
        groups: HashMap<String, Vec<Vec<CrossElementPayloadEntry>>>,
    },
}

/// One element of a flagged cross-element proximity group resolved for the wire boundary (GitHub
/// issue #376). A group is one too-close unordered pair; each entry classifies one of its two
/// logical elements (`kind`) and carries whatever highlight geometry that type has — `edges` for
/// a teleport / one-way / vertical passage (base-graph `[from, to]` pairs, re-resolved against
/// `graph` at payload time), `tile` for a split tile, `nodes` for a start / finish endpoint or an
/// `elevator_stop` (a single-node list — just the flagged stop cell; `edges` stays empty, since a
/// stop's fan edges reach every other floor and would light up cells there too). `removable` is
/// `false` for `start` / `finish` (repair never
/// deletes them — a pair of two unremovable elements survives repair) and `true` otherwise.
/// `preset_locked` is per-element: every underlying edge preset-protected for an edge element,
/// the whole tile preset-locked for a split, and for a `start` / `finish` endpoint `true` when a
/// `preset_start` / `preset_finish` marker pins that exact node (repair can't move a pinned
/// waypoint), `false` for a generator-chosen one.
///
/// `kind` is one of `"teleport" | "one_way" | "vertical_passage" | "elevator_stop" | "split" |
/// "start" | "finish"`. `"elevator_stop"` flags a single stop of an elevator (not the whole
/// elevator); the repair removes just that stop, leaving the rest of the elevator intact.
#[derive(Debug, Clone, PartialEq)]
pub struct CrossElementPayloadEntry {
    pub kind: &'static str,
    pub edges: Vec<[u32; 2]>,
    pub nodes: Vec<u32>,
    pub tile: Option<IssueSplitTilePayload>,
    pub removable: bool,
    pub preset_locked: bool,
}

/// One flagged elevator's stop-deficit resolved for the wire boundary (GitHub issue #402) — pairs
/// the elevator's live `EdgeKind::Elevator` edge fan with the requested stop count and the
/// available floor candidates (as base-graph node ids at the elevator's point, resolved from the
/// issue's `LevelId` list via `MultiLevelField::node_at`). `preset_locked` mirrors
/// `IssueEdgeGroupPayload`'s meaning: every one of the elevator's current edges is preset-protected.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueMissingElevatorStopsPayload {
    pub edges: Vec<[u32; 2]>,
    pub missing: u32,
    pub available: Vec<u32>,
    pub preset_locked: bool,
}
