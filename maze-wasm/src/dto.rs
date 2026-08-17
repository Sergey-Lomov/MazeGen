use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use maze_core_macros::Dto;
use crate::generation_config::TessellationConfig;

/// `i` is a node's stable index among its point's nodes (GitHub issue #236) — `0` is always the
/// point's original node (the one that can never be removed by post-edit), `1, 2, ...` are extra
/// split-point slots in the order they were created. Unlike a position in a rebuilt list, `i`
/// never shifts when an earlier-created sibling at the same point is removed — a hole in the `i`
/// sequence is expected and does not get compacted. This is what lets `apply_split_points` address
/// a slot by its real `i` directly instead of reconstructing a mapping from array position, which
/// silently desyncs once a non-last split node is removed.
#[derive(Serialize, Deserialize, Clone, Copy, Dto)]
pub struct NodeDto {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub i: u32,
    /// The node's floor, as a 0-based index into `MultiLevelField::levels_ordered()` (GitHub issue
    /// #337) — matches the web client's `floors` array index, not the internal `LevelId`, which
    /// is never reused/renumbered and thus not stable across floor removal (`Specs/space.md`).
    /// Always `0` for a maze that never had more than one floor.
    #[dto(optional)]
    pub level: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKindDto {
    Basic,
    Teleport,
    VerticalPassage,
    Elevator,
}

/// One directed graph edge. Note: `(from, to)` is not unique in `MazeSnapshot.edges` — a
/// `Basic` and a `Teleport` edge can coexist in the same direction between the same pair (see
/// `maze_core::graph::Graph::add_edge`'s kind-aware dedup), each appearing as its own entry here.
#[derive(Serialize)]
pub struct EdgeDto {
    pub from: u32,
    pub to: u32,
    pub kind: EdgeKindDto,
}

#[derive(Serialize)]
pub struct NavNodeDto {
    pub node_id: u32,
}

#[derive(Serialize)]
pub struct NavEdgeDto {
    pub from: u32,
    pub to: u32,
    /// Maze NodeIds along this corridor, inclusive of both endpoints.
    pub path: Vec<u32>,
}

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

/// One node in the hierarchical timing tree — see GitHub issue #285. `id` is a stage id, rule id,
/// check type id, or strategy id depending on nesting depth; `children` is empty for a leaf
/// (check/strategy) node.
#[derive(Serialize)]
pub struct TimingNodeDto {
    pub id: String,
    pub total_ms: f64,
    pub calls: u32,
    pub children: Vec<TimingNodeDto>,
}

/// Hierarchical timing breakdown for one generation run — see GitHub issue #285. Only populated
/// by `run_generate` (the only path that runs the full generate→QC→repair pipeline);
/// analytics-only snapshots (post-edit, `compute_analytics`) have no generation pass to time, so
/// `MazeSnapshot.timing` is `None` there.
#[derive(Serialize)]
pub struct GenerationTimingDto {
    pub initial_build_ms: f64,
    /// One entry per stage that ran at least one rule — each stage node's `children` are its own
    /// rules, each rule node's `children` are its checks and (if dispatched) its strategy.
    pub qc: Vec<TimingNodeDto>,
}

#[derive(Serialize)]
pub struct JunctionBucket {
    pub degree: usize,
    pub count: usize,
}

/// Cell (maze-node) geometric shape breakdown — GitHub issue #364: `teleport_entries` moved out
/// to `ElementsStatsDto` (it's a cross-cutting "element" concept, not a cell shape), so this
/// struct's own fields always partition `FloorScoped<NodeStatsDto>`'s node count exactly.
#[derive(Serialize)]
pub struct NodeStatsDto {
    pub dead_ends: usize,
    pub straight: usize,
    pub turns: usize,
    pub junctions: Vec<JunctionBucket>,
}

/// Spatial adjacency-pair breakdown (walls vs. passages) — GitHub issue #364:
/// `one_way_passages` moved out to `ElementsStatsDto` alongside the other directional/special
/// edge kinds, so this struct only distinguishes "connected" from "not connected".
#[derive(Serialize)]
pub struct SpatialEdgeStatsDto {
    pub bidirectional: usize,
    pub walls: usize,
    /// Total adjacent tile-pair count — `bidirectional + walls`, computed directly from the
    /// adjacency count rather than summed here, so a future edge category doesn't need this
    /// field's producer updated to stay correct.
    pub total_pairs: usize,
}

/// GitHub issue #364: every count that isn't a plain cell-shape or wall/passage fact — one-way
/// passages, teleports, and split tiles/nodes/groups — grouped so the "Elements" report section
/// doesn't need to reassemble them from three different DTOs.
#[derive(Serialize)]
pub struct ElementsStatsDto {
    pub one_way_passages: usize,
    pub two_way_teleports: usize,
    pub one_way_teleports: usize,
    /// Number of field points with 2+ nodes.
    pub split_tile_count: usize,
    /// Sum, over every split point, of its full node count (including the original node).
    pub split_node_count: usize,
    /// Every distinct canonical topology found on the field, with how many tiles share it.
    pub split_groups: Vec<SplitGroupDto>,
}

/// Maze-wide-only `VerticalPassage`/`Elevator`/cross-floor-`Teleport` statistics (GitHub issue
/// #346) — like `GraphStatsDto`, never broken down `by_floor`: every one of these edge kinds spans
/// 2+ floors by construction, so there's no meaningful single-floor attribution.
#[derive(Serialize)]
pub struct VerticalStatsDto {
    pub bidirectional_passages: usize,
    pub one_way_passages_up: usize,
    pub one_way_passages_down: usize,
    /// Count of distinct `Elevator` groups — a connected component of `Elevator` edges (see
    /// `maze_core::graph::Graph::elevator_groups`), never grouped by shared x-y point: two
    /// elevators can occupy the same point without being connected (e.g. one spanning floors 1-3,
    /// a separate one spanning floors 4-6) and count as two groups.
    pub elevator_groups: usize,
    pub cross_floor_teleports: usize,
}

#[derive(Serialize)]
pub struct RouteInfoDto {
    pub path_length: usize,
    pub junction_count: usize,
    pub one_way_count: usize,
    pub split_count: usize,
    pub score: Option<f64>,
    pub path: Vec<u32>,
}

/// Maze-wide-only graph statistics (GitHub issue #364) — unlike `MazeStatisticsDto`'s other
/// blocks, this one is never broken down `by_floor`: SCC components and cycles can span multiple
/// floors (via teleport/vertical passage/elevator edges), so a per-floor version would either
/// double-count a spanning component/cycle on every floor it touches or need its own arbitrary
/// exclusion rule — neither was worth the complexity, see the issue's discussion.
#[derive(Serialize, Dto)]
pub struct GraphStatsDto {
    /// Number of floors (`MultiLevelField::level_count()`) — always `1` for a single-floor maze.
    pub floor_count: usize,
    pub node_count: usize,
    pub edge_count: usize,
    /// Number of base-graph SCCs (matches `node_component`'s id range — for RegionsRenderer).
    pub component_count: usize,
    /// Average out-degree over the real graph (not the nav-graph) — `2*E/V` treated as
    /// undirected, `0` for an empty graph.
    pub average_degree: f64,
    /// Number of independent cycles (E - V + C on the pure-cycle core).
    pub cycle_count: usize,
    /// Number of connected cyclic regions (WCC on the pure-cycle core).
    pub cycle_region_count: usize,
    /// Raw count of all simple cycles (composite-inclusive, GitHub issue #284) — see
    /// `GraphAnalytics::simple_cycle_count`. Always `>= cycle_count`.
    pub simple_cycle_count: usize,
    /// maze node id (as string — `json_compatible()` serialization requires string map keys)
    /// → component_id. Covers junction nodes and corridor nodes.
    pub node_component: HashMap<String, usize>,
    /// maze node ids in the pure-cycle core (real cycles only, no bridges).
    pub pure_cycle_node_ids: Vec<u32>,
    /// nav-edge pairs [from_maze_id, to_maze_id] in the pure-cycle core.
    pub pure_cycle_edge_pairs: Vec<[u32; 2]>,
    /// True if cycle enumeration aborted because the graph has too many simple cycles to
    /// analyze (see `GraphAnalytics::cycle_analysis_overflowed`) — when `true`, `cycle_count`,
    /// `cycle_region_count`, `simple_cycle_count`, `pure_cycle_node_ids`, and
    /// `pure_cycle_edge_pairs` are all empty/zero placeholders, not real results.
    pub cycle_analysis_overflowed: bool,
    /// SCC region class relative to `start`/`finish` — "path" | "alternative" | "unreachable" |
    /// "trap" — keyed by `component_id` (as string, same `json_compatible()` requirement as
    /// `node_component`). Empty when `start` or `finish` is unset (region classes are
    /// unavailable without both).
    #[dto(ts_type = "Record<string, RegionClass>")]
    pub region_classes: HashMap<String, String>,
}

/// Mirrors `maze_core::generation::SplitFaceRequirement` — one node's per-face-position
/// requirement, as reconstructed from the built graph (see `SplitGroupDto`'s doc comment).
#[derive(Serialize, Dto)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[dto(rename_ts = "SplitFaceRequirement")]
pub enum SplitFaceRequirementDto {
    Passage,
    OneWay { direction: OneWayDirectionDto },
    Wall,
    Unspecified,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OneWayDirectionDto {
    Forward,
    Backward,
}

/// One group of maze-wide split tiles sharing the same canonical topology
/// (`maze_core::graph::split_topology::canonical_split_topology`) — the same pattern applied at
/// any rotation/mirror, with node creation order ignored. `topology[i]` is one node's
/// per-face-position requirement list (length = tessellation degree); the outer list is sorted
/// (order-independent — see `SplitTopology`'s doc comment), so it also serves as a stable
/// dedup/lookup key on the web side (e.g. for a title registry keyed by serialized topology).
#[derive(Serialize)]
pub struct SplitGroupDto {
    pub topology: Vec<Vec<SplitFaceRequirementDto>>,
    pub count: usize,
}

/// One endpoint of a post-edit edge — either a plain existing `NodeId`, or a reference to one of
/// a split point's extra nodes by its stable `slot_id` (GitHub issue #221). The web side never
/// predicts a split node's `NodeId` (it doesn't exist yet until this same call creates it via
/// `apply_split_points`), so it addresses it by `(point, slot_id)` instead — resolved to a real
/// id in `resolve_post_edit_endpoint`. `Split`'s `level` (GitHub issue #359, 0-based `level_fields`
/// index, `#[serde(default)]` so a pre-#359 caller omitting it still deserializes as level `0`)
/// disambiguates a slot when two floors share the same `(point, slot_id)` — a `Node` endpoint
/// carries no `level` of its own, since its resolved `NodeId` already pins it to a real node
/// wherever that node happens to be (mirrors `PostEditEndpoint`'s own web-side shape).
#[derive(Debug, Deserialize, Dto)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[dto(rename_ts = "PostEditEndpointWasmDto")]
pub enum PostEditEndpointDto {
    Node { id: u32 },
    Split { point: [i32; 2], slot_id: u32, #[serde(default)] level: u32 },
}

#[derive(Deserialize, Dto)]
#[dto(rename_ts = "PostEditEdgeWasmDto")]
pub struct PostEditEdgeDto {
    pub from: PostEditEndpointDto,
    pub to: PostEditEndpointDto,
    /// "basic" | "one_way" | "teleport" — direction already normalized: from→to is the actual
    /// passage/teleport direction. See `build_graph_from_post_edit_edges` (lib.rs) for exactly
    /// how each kind is applied.
    #[dto(ts_type = "\"basic\" | \"one_way\" | \"teleport\"")]
    pub kind: String,
}

/// A `VerticalPassage`/`Elevator` edge, passed through verbatim across a post-edit confirm
/// (GitHub issue #358 follow-up) — post-edit never lets the user create, remove, or redirect
/// either kind (only generation/vertical-connection tooling does), so unlike `PostEditEdgeDto`
/// there is no tool-driven draft for these: the client simply resends what the previous confirmed
/// snapshot already returned (`state._generatedEdges`/`state.edges`, filtered to these two kinds),
/// by plain resolved `NodeId` — never a `Split` endpoint, since neither kind is ever wired to a
/// split slot. Without this, `run_compute_analytics` rebuilds the graph purely from `edges` (basic/
/// one_way/teleport) and these edges vanish on the very first post-edit confirm.
#[derive(Deserialize, Dto)]
pub struct VerticalEdgeDto {
    pub from: u32,
    pub to: u32,
    /// "vertical_passage" | "elevator".
    #[dto(ts_type = "\"vertical_passage\" | \"elevator\"")]
    pub kind: String,
}

/// One `QcRuleState`'s worth of active checks plus that rule's rule-level params (GitHub issue
/// #245) — `compute_analytics`'s analytics-only path has no strategy and never dispatches repair,
/// so this carries only what `resolve_rule_params`/the checks themselves actually consume, unlike
/// the real `QcRuleConfig` (no `id`/`strategy` field).
#[derive(Deserialize)]
pub struct AnalyticsRuleGroupConfig {
    pub checks: Vec<crate::generation_config::CheckInstanceConfig>,
    #[serde(default)]
    pub params: HashMap<String, String>,
}

#[derive(Deserialize, Dto)]
pub struct ComputeAnalyticsConfig {
    #[dto(ts_type = "WasmTessellationConfig")]
    pub tessellation: TessellationConfig,
    /// Each level's own field points, in `floors` order (GitHub issue #359) — mirrors
    /// `GenerateConfig.level_fields`. The number of levels this call resolves against is
    /// `level_fields.len()`; every `NodeDto.level`/split-point `level` indexes into this. Required
    /// (no `#[serde(default)]`) — every caller as of this issue sends it, one entry per floor.
    pub level_fields: Vec<Vec<[i32; 2]>>,
    /// The client's authoritative node list (real ids from the previous generation/confirm) —
    /// `Field`/`Graph` are rebuilt directly from these ids (`Field::from_id_points`) instead of
    /// re-minting them from `tessellation.points` order (GitHub issue #236). This is what makes a
    /// rebuild reproduce the exact same ids the client already holds, including auto-split nodes
    /// created by the generator (whose ids come from traversal order, not coordinate order). Each
    /// node's own `level` (GitHub issue #359) says which of `level_fields`' entries it resolves
    /// against.
    pub nodes: Vec<NodeDto>,
    /// Actual edges (passages only — walls are absence of edge).
    pub edges: Vec<PostEditEdgeDto>,
    /// `VerticalPassage`/`Elevator` edges, passed through unchanged (GitHub issue #358 follow-up)
    /// — see `VerticalEdgeDto`'s own doc comment. `#[serde(default)]` so a pre-existing
    /// caller/fixture omitting this field still deserializes (as "no vertical connections").
    #[serde(default)]
    pub vertical_edges: Vec<VerticalEdgeDto>,
    /// Extra nodes to add to split points before resolving edges — each entry is one
    /// `(point, slot_id)` pair. `slot_id` is the client's own numbering of a point's *extra* nodes
    /// only (`0, 1, 2, ...`, never the original) — it maps onto `NodeDto.i` as `slot_id + 1` (`i`
    /// includes the original node at `0`). A `(point, slot_id)` already present in `nodes` (i.e.
    /// `i = slot_id + 1` already exists for that point) resolves to that exact existing `NodeId`;
    /// only a genuinely new slot gets minted via `Maze::add_node_at` (GitHub issue #221/#236, see
    /// `apply_split_points`). `#[serde(default)]` so calls/fixtures predating this field still
    /// deserialize. `level` (GitHub issue #359, 0-based `level_fields` index, defaulting to `0` on
    /// each triple via `#[serde(default)]` at the tuple level is not possible in serde for a plain
    /// tuple — callers predating #359 instead fail to deserialize this field's *shape* entirely if
    /// they still send the old `[[i32;2], u32]` pair; `#[serde(default)]` on the whole `Vec` only
    /// covers the field being entirely absent, which remains true).
    #[serde(default)]
    pub split_points: Vec<([i32; 2], u32, u32)>,
    pub start: Option<u32>,
    pub finish: Option<u32>,
    /// Active checks for this analytics-only pass (no repair, no strategies), grouped by their
    /// originating rule — each group becomes its own synthetic singleton-checks rule when building
    /// the `QualityControlEngine` (see `analytics_only_stages` in `analytics/mod.rs`), purely so
    /// `build_qc_and_repair`'s rule-driven shape (GitHub issue #60) has something to iterate; the
    /// synthetic rule ids built from these are discarded immediately since this path never
    /// dispatches repair (`run_check_only`, GitHub issue #106). Grouped (not a flat check list, as
    /// before GitHub issue #245's teleport-route-protection bugfix) so each real rule's rule-level
    /// params (e.g. `protect_route`) survive onto its synthetic rule instead of silently resolving
    /// to their default every time on this path.
    #[serde(default)]
    pub rule_groups: Vec<AnalyticsRuleGroupConfig>,
    /// The project's current preset connections (GitHub issue #245) — post-edit rebuilds
    /// `Field`/`Graph` from `nodes`/`edges` alone, but a preset connection's *provenance* (that a
    /// given edge is a user-placed Passage/OneWay, not a repair/post-edit addition) isn't
    /// recoverable from the rebuilt graph itself. Sent alongside so `run_compute_analytics` can
    /// resolve each preset's endpoints against the rebuilt field and mark cycle/group elements
    /// `preset_locked` accordingly — same edges the generation path already protects, just
    /// resolved fresh here since post-edit's `Field`/ids don't share generation's `PresetState`.
    /// `#[serde(default)]` so calls/fixtures predating this field still deserialize.
    #[serde(default)]
    #[dto(ts_type = "PresetConnection[]")]
    pub preset_connections: Vec<crate::generation_config::PresetConnectionDto>,
    /// The project's current preset-declared split points (GitHub issue #245's split-node/route
    /// extension) — same shape as `split_points`, but sourced from the preset snapshot
    /// (`state.presetSplitPoints`) rather than every current split point (`split_points`/`nodes`
    /// carry all of them, preset-declared or not). Resolved fresh against the rebuilt field via
    /// `resolve_preset_nodes_for_post_edit` into `PresetState.preset_declared_nodes`, mirroring how
    /// `preset_connections` feeds `preset_edges`. An entry referencing a point/slot the rebuilt
    /// field/split map doesn't resolve is silently skipped, same contract as `preset_connections`.
    /// `#[serde(default)]` so calls/fixtures predating this field still deserialize. `level`
    /// (GitHub issue #359, 0-based `level_fields` index) added alongside `split_points`'s own.
    #[serde(default)]
    pub preset_split_points: Vec<([i32; 2], u32, u32)>,
}

/// One statistic computed both maze-wide (`total`) and per-floor (`by_floor`, keyed by 0-based
/// floor index — GitHub issue #364). `total` is an independent maze-wide computation, not the sum
/// of `by_floor`'s entries: a maze-wide teleport pair with ends on different floors, for example,
/// counts toward `total` but toward neither floor's own `by_floor` entry (see
/// `maze_core::graph::stats::compute_teleport_edge_stats_scoped`'s doc comment). `by_floor` always
/// has one entry per floor, even for a single-floor maze.
#[derive(Serialize, Dto)]
pub struct FloorScoped<T> {
    pub total: T,
    #[dto(ts_type = "Record<number, T>")]
    pub by_floor: HashMap<String, T>,
}

/// Every maze statistic surfaced in the Analytics panel (GitHub issue #364), replacing the
/// previously flat `node_stats`/`edge_stats`/`teleport_edge_stats`/`graph_analytics`/
/// `split_analytics` fields on `MazeSnapshot`. `graph_stats` is the only maze-wide-only member —
/// see its own doc comment for why it isn't `FloorScoped`.
#[derive(Serialize)]
pub struct MazeStatisticsDto {
    pub graph_stats: GraphStatsDto,
    /// Real geometric cell count per floor — `Field::all_points()` count, deduped by point (a
    /// split point counts once, not once per its extra node) — unlike `cell_stats`' node-shape
    /// breakdown, this is derived straight from field shape, not reconstructed by summing
    /// `cell_stats`' own counts (which would count a split point's every extra node separately).
    pub cell_count: FloorScoped<usize>,
    pub cell_stats: FloorScoped<NodeStatsDto>,
    pub passage_stats: FloorScoped<SpatialEdgeStatsDto>,
    pub elements_stats: FloorScoped<ElementsStatsDto>,
    pub vertical_stats: VerticalStatsDto,
}

#[derive(Serialize)]
pub struct MazeSnapshot {
    pub nodes: Vec<NodeDto>,
    pub edges: Vec<EdgeDto>,
    pub start: Option<u32>,
    pub finish: Option<u32>,
    pub issues: Vec<IssueDto>,
    pub nav_nodes: Vec<NavNodeDto>,
    pub nav_edges: Vec<NavEdgeDto>,
    pub route_info: Option<RouteInfoDto>,
    pub statistics: MazeStatisticsDto,
    /// `Some` only when this snapshot came from a generation run (`run_generate`) — see
    /// `GenerationTimingDto`'s doc comment.
    pub timing: Option<GenerationTimingDto>,
}
