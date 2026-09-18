use maze_core_macros::Dto;
use serde::Serialize;
use std::collections::HashMap;

/// Tagged payload carried by `IssueDto` — replaces the old parallel-optional-fields shape
/// (`invalid_loop_edges` / `region_needs_expansion_nodes`) with one discriminated union, tagged
/// via `#[serde(tag = "kind")]` so `serde_wasm_bindgen::Serializer::json_compatible()` emits a
/// real TS discriminated union (`payload.kind` narrows which field is valid) instead of two
/// always-mostly-empty maps a caller could silently read the wrong one of. Variant tags
/// intentionally mirror `IssueKind::as_str()`'s wire strings (`invalid_loop`,
/// `region_needs_expansion`) so `payload.kind` lines up with `IssueDto.kind` by construction —
/// see `build_analytics_snapshot`'s `debug_assert!`s for the runtime check that they stay in
/// sync. `IssueDto.kind` remains the source of truth for UI filtering/labels; `payload.kind` is
/// only a TS-narrowing discriminant for which payload fields are present.
/// One flagged cycle/group's base-graph edges paired with whether every one of them is
/// preset-protected (GitHub issue #245) — mirrors `maze_core`'s `IssueEdgeGroupPayload`.
/// `preset_locked: true` means repair can never fix this specific element (a user placed
/// Passage/OneWay connection on every edge in it); `false` means it's either partly or wholly
/// unprotected and repair could in principle fix it. Named struct (not a positional tuple) so the
/// wire shape carries field names through to TS.
#[derive(Debug, Serialize, Dto)]
#[dto(rename_ts = "IssueEdgeGroupPayload")]
pub struct IssueEdgeGroupPayloadDto {
    pub edges: Vec<[u32; 2]>,
    pub preset_locked: bool,
}

/// One tile's own node list inside a flagged split-tile/split-node-group element — mirrors
/// `maze_core`'s `IssueSplitTilePayload` (GitHub issue #245's split extension).
#[derive(Debug, Serialize, Dto)]
#[dto(rename_ts = "IssueSplitTilePayload")]
pub struct IssueSplitTilePayloadDto {
    pub nodes: Vec<u32>,
    pub preset_locked: bool,
}

/// One flagged split-tile "instance" (a single tile or a genuine multi-tile group) — mirrors
/// `maze_core`'s `IssueSplitGroupPayload`.
#[derive(Debug, Serialize, Dto)]
#[dto(rename_ts = "IssueSplitGroupPayload")]
pub struct IssueSplitGroupPayloadDto {
    pub tiles: Vec<IssueSplitTilePayloadDto>,
    pub preset_locked: bool,
}

/// One flagged region paired with whether it's preset-locked — mirrors `maze_core`'s
/// `IssueRegionPayload` (GitHub issue #245's region extension).
#[derive(Debug, Serialize, Dto)]
#[dto(rename_ts = "IssueRegionPayload")]
pub struct IssueRegionPayloadDto {
    pub region: Vec<u32>,
    pub preset_locked: bool,
}

/// One edge of a flagged split route, in traversal order — mirrors `maze_core`'s `IssueRouteEdge`.
#[derive(Debug, Serialize, Dto)]
#[dto(rename_ts = "IssueRouteEdge")]
pub struct IssueRouteEdgeDto {
    pub from: u32,
    pub to: u32,
    pub is_split_edge: bool,
}

/// One flagged split route paired with whether every edge on it is preset-locked — mirrors
/// `maze_core`'s `IssueRoutePayload`.
#[derive(Debug, Serialize, Dto)]
#[dto(rename_ts = "IssueRoutePayload")]
pub struct IssueRoutePayloadDto {
    pub edges: Vec<IssueRouteEdgeDto>,
    pub preset_locked: bool,
}

/// One flagged elevator's stop-deficit — the elevator's live edge fan, how many stops are still
/// requested, and the available floor candidates as base-graph node ids — mirrors `maze_core`'s
/// `IssueMissingElevatorStopsPayload` (GitHub issue #402).
#[derive(Debug, Serialize, Dto)]
#[dto(rename_ts = "IssueMissingElevatorStopsPayload")]
pub struct IssueMissingElevatorStopsPayloadDto {
    pub edges: Vec<[u32; 2]>,
    pub missing: u32,
    pub available: Vec<u32>,
    pub preset_locked: bool,
}

/// One logical element of a flagged cross-element proximity pair (GitHub issue #376) — mirrors
/// `maze_core`'s `CrossElementPayloadEntry`. `kind` is `"teleport"` / `"one_way"` /
/// `"vertical_passage"` / `"elevator_stop"` / `"split"` / `"start"` / `"finish"`; the geometry
/// field that is populated depends on it (`edges` for the edge elements, `tile` for a split,
/// `nodes` for start / finish, and just `nodes` (the stop cell, no `edges`) for `elevator_stop` —
/// a stop's fan edges reach every other floor and must not be highlighted). `"elevator_stop"`
/// flags one stop of an elevator, not the whole elevator. `removable` is `false` for start /
/// finish. `preset_locked` is per-element — for a start / finish element it is `true` when a
/// `preset_start` / `preset_finish` marker pins that node.
#[derive(Debug, Serialize, Dto)]
#[dto(rename_ts = "CrossElementPayloadEntry")]
pub struct CrossElementPayloadEntryDto {
    pub kind: String,
    pub edges: Vec<[u32; 2]>,
    pub nodes: Vec<u32>,
    pub tile: Option<IssueSplitTilePayloadDto>,
    pub removable: bool,
    pub preset_locked: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssuePayloadDto {
    None,
    /// Keyed by source check id — each entry is one invalid cycle flagged by that check, paired
    /// with its `preset_locked` status. Keyed per check (not one flat list) so that when one
    /// merged issue renders as several bubbles (one per `source_checks` entry — see
    /// `quality_control.md`'s "Dedup interaction"), hovering a bubble highlights only the cycles
    /// *that check* flagged, not every contributing check's cycles combined (e.g.
    /// `min_loop_length`'s short loops must not highlight when hovering the `max_loop_length`
    /// bubble).
    InvalidLoop {
        edges: HashMap<String, Vec<IssueEdgeGroupPayloadDto>>,
    },
    /// Keyed by source check id — each inner Vec is one flagged SCC region's member maze node ids
    /// (not edges — the web side derives the region's perimeter client-side from this node set,
    /// the same way it already derives preset boundary walls from a cell set). Keyed per check
    /// for the same reason as `InvalidLoop` — `min_region_size` and `min_region_ratio` can both
    /// flag regions and merge into one issue, but hovering one bubble must highlight only that
    /// check's regions.
    RegionNeedsExpansion {
        nodes: HashMap<String, Vec<IssueRegionPayloadDto>>,
    },
    /// Mirrors `RegionNeedsExpansion`'s shape, for an oversized region flagged for shrinking
    /// instead (`max_region_size`/`max_region_ratio` — see GitHub issue #177).
    RegionNeedsShrink {
        nodes: HashMap<String, Vec<IssueRegionPayloadDto>>,
    },
    /// Keyed by source check id — each inner Vec is one flagged teleport "group", expressed as
    /// base-graph [from, to] maze node-id pairs, one pair per teleport edge in the group. A
    /// single invalid teleport (`invalid_teleport`) is a group of size one; a proximity pair
    /// (`invalid_teleport_group`) is a group of size two — see GitHub issue #195. Reused across
    /// both kinds rather than getting its own variant each, mirroring `InvalidLoop`'s reuse
    /// across `invalid_loop`/`invalid_loop_group`.
    InvalidTeleport {
        groups: HashMap<String, Vec<IssueEdgeGroupPayloadDto>>,
    },
    /// Keyed by source check id — each inner Vec is one flagged one-way "group", expressed as
    /// base-graph [from, to] maze node-id pairs, one pair per one-way edge in the group. A
    /// single invalid one-way (`invalid_one_way`) is a group of size one; a proximity/super-hub/
    /// count-excess group (`invalid_one_way_group`) can be any size — see GitHub issue #205.
    /// Reused across both kinds, mirroring `InvalidTeleport`'s reuse across
    /// `invalid_teleport`/`invalid_teleport_group`.
    InvalidOneWay {
        groups: HashMap<String, Vec<IssueEdgeGroupPayloadDto>>,
    },
    /// Keyed by source check id — each inner Vec is one flagged vertical-passage "group",
    /// expressed as base-graph [from, to] maze node-id pairs, one pair per `VerticalPassage` edge
    /// in the group. A single invalid vertical passage (`invalid_vertical_passage`) is a group of
    /// size one; a proximity pair (`invalid_vertical_passage_group`) is a group of size two — see
    /// GitHub issue #395. Reused across both kinds, mirroring `InvalidTeleport`'s reuse across
    /// `invalid_teleport`/`invalid_teleport_group`.
    InvalidVerticalPassage {
        groups: HashMap<String, Vec<IssueEdgeGroupPayloadDto>>,
    },
    /// Keyed by source check id — each entry is one flagged "instance" (a single tile, or a
    /// genuine multi-tile group for proximity/count/density checks), each paired with its own
    /// `preset_locked` status (GitHub issue #245's split extension). Shared wire variant for
    /// `invalid_split_tile`/`invalid_split_tile_group`/`invalid_split_node`/`invalid_split_node_group`
    /// — see GitHub issues #248, #260.
    InvalidSplitTile {
        groups: HashMap<String, Vec<IssueSplitGroupPayloadDto>>,
    },
    /// Keyed by source check id — each inner Vec is one flagged route, paired with its own
    /// `preset_locked` status — order carries meaning (a route is a path, not a set), unlike every
    /// other variant above. See GitHub issue #277, #245.
    InvalidSplitRoute {
        routes: HashMap<String, Vec<IssueRoutePayloadDto>>,
    },
    /// Keyed by source check id — whether repair can never reduce the SCC count at all because
    /// every region on the field is preset-locked against expansion. No per-element highlight data
    /// (unlike every variant above): this issue never highlights specific regions on the canvas.
    /// See GitHub issue #245.
    ExcessiveSccCount {
        preset_locked: HashMap<String, bool>,
    },
    /// Keyed by source check id — each inner Vec is one flagged elevator, expressed as base-graph
    /// [from, to] maze node-id pairs, one pair per `Elevator` edge currently connecting its stops.
    /// See GitHub issue #397.
    InvalidElevator {
        groups: HashMap<String, Vec<IssueEdgeGroupPayloadDto>>,
    },
    /// Keyed by source check id — each entry is one flagged elevator stop, wrapped as a
    /// single-node "region" (reuses `IssueRegionPayloadDto`'s shape). A single flagged stop
    /// (`invalid_elevator_stop`) and a jointly-flagged stop group (`invalid_elevator_stop_group`,
    /// excess count/density) both resolve into this same shape — see GitHub issue #399.
    InvalidElevatorStop {
        nodes: HashMap<String, Vec<IssueRegionPayloadDto>>,
    },
    /// Keyed by source check id — each entry is one flagged deficit area: `Some(level_index)` for
    /// a floor-scoped deficit (`RepairArea::Level`, the index being the floor's `levels_ordered()`
    /// position — matches `NodeDto.level`), or `None` for a whole-maze deficit
    /// (`RepairArea::WholeMaze`) with no specific floor to highlight — same "no per-element
    /// highlight" precedent as `ExcessiveSccCount` above. Shared wire variant for
    /// `missing_vertical_passages`/`missing_teleports`/`missing_elevators`/
    /// `area_missing_elevator_stops` — see `maze_core`'s `IssuePayload::AreaDeficit`.
    AreaDeficit {
        areas: HashMap<String, Vec<Option<u32>>>,
    },
    /// Keyed by source check id — each entry is one flagged elevator's stop-count deficit: its live
    /// edge fan, the requested stop count, and available floor candidates as node ids. See GitHub
    /// issue #402. `missing_elevator_height`/`excessive_elevator_stop_gap` reuse `InvalidElevator`
    /// instead — both leave candidate-floor selection to their own repair strategy.
    MissingElevatorStopCount {
        groups: HashMap<String, Vec<IssueMissingElevatorStopsPayloadDto>>,
    },
    /// Keyed by source check id — each inner `Vec<CrossElementPayloadEntry>` is one flagged
    /// too-close pair (always two entries). Shared wire variant for
    /// `cross_element_geometric_proximity`/`cross_element_graph_proximity` — see GitHub issue #376
    /// and `maze_core`'s `IssuePayload::InvalidCrossElementGroup`.
    InvalidCrossElementGroup {
        groups: HashMap<String, Vec<Vec<CrossElementPayloadEntryDto>>>,
    },
}

#[derive(Serialize, Dto)]
pub struct IssueDto {
    #[dto(ts_type = "IssueKindId")]
    pub kind: String,
    pub payload: IssuePayloadDto,
    /// Opaque per-instance check id(s) that produced or contributed to this issue
    /// (`Issue::source_checks()`) — lets the web UI render one bubble per contributing check
    /// rather than one per `kind`, distinguishing e.g. two `min_region_count` instances' issues
    /// even though both share the `missing_regions` kind. Not a check **type** id by itself
    /// (see GitHub issue #60) — resolve the type id for i18n/label lookups via
    /// `source_check_types`.
    pub source_checks: Vec<String>,
    /// `source_checks` entry -> check type id (`available_checks()`'s `CheckDescriptor.id`) —
    /// needed because `source_checks` entries are opaque per-instance ids, not type ids, so the
    /// web UI's per-check-type `DETAIL_LABELS` lookup (`issueRegistry.ts`) can't key off them
    /// directly. Invariant: exactly one entry per `source_checks` entry, no extras (see
    /// `build_analytics_snapshot` in `analytics.rs`).
    pub source_check_types: HashMap<String, String>,
    /// Raw display values keyed by source check id then by detail key (`Issue::details()`),
    /// e.g. `{"max_loop_length": {"max_loop_length": "100"}}`. Values are never assembled
    /// messages — the web UI looks them up by key via its own i18n templates per check id.
    pub details: HashMap<String, HashMap<String, String>>,
}
