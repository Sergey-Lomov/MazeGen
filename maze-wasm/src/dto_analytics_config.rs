use std::collections::HashMap;
use serde::Deserialize;
use maze_core_macros::Dto;
use crate::generation_config::TessellationConfig;

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
    pub nodes: Vec<crate::dto::NodeDto>,
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
    /// The project's `preset_start` marker, if the user pinned the start explicitly (GitHub issue
    /// #376 follow-up). Resolved fresh against the rebuilt field into `PresetState.preset_start` so
    /// a `start` element of a flagged cross-element group is flagged `preset_locked` on this
    /// post-edit path too. `#[serde(default)]` — a caller/fixture omitting it (or a project with a
    /// generator-chosen start) sends nothing and the start is treated as movable.
    #[serde(default)]
    #[dto(ts_type = "{ point: [number, number]; slot?: number; level?: number }")]
    pub preset_start: Option<crate::generation_config::PresetEndpointDto>,
    /// The project's `preset_finish` marker — see `preset_start`.
    #[serde(default)]
    #[dto(ts_type = "{ point: [number, number]; slot?: number; level?: number }")]
    pub preset_finish: Option<crate::generation_config::PresetEndpointDto>,
}
