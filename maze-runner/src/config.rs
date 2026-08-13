use std::collections::HashMap;
use serde::Deserialize;
use maze_core::{
    generation::{GenerationParams, EdgeBasedParams, ElementsConfig, GenerationConfig, GenerationAlgorithm, PresetConnection, PresetConnectionState, PresetEndpoint, TeleportDirection, LockedNode, NodeLockKind, PresetVerticalPassage, PresetElevator, VerticalPassageDirection},
    quality_control::{MISSING_ENDPOINTS, UNREACHABLE_FINISH},
    RepairLimits,
};

#[derive(Deserialize)]
pub struct StrategyConfig {
    pub id: String,
    #[serde(default)]
    pub params: HashMap<String, String>,
    /// Which of the parent strategy's `expected_nested()` slots this fills. Required (`Some`)
    /// whenever this `StrategyConfig` appears inside another one's `nested`; must be `None` for
    /// the top-level entry in `QcRuleConfig.strategy`, which has no parent slot to fill.
    /// `Option`, not a plain `String` with `#[serde(default)]` — a missing/empty value must be
    /// a visible `None`, not silently coerced to `""` and only failing later inside
    /// `build_nested` (see `Specs/repair.md`'s nested-strategy pattern).
    #[serde(default)]
    pub slot_id: Option<String>,
    /// Nested strategy assignments, in configured order — empty for every strategy without
    /// nested slots. Recursive.
    #[serde(default)]
    pub nested: Vec<StrategyConfig>,
}

#[derive(Deserialize, Clone)]
pub struct CheckInstanceConfig {
    pub local_id: String,
    pub type_id: String,
    #[serde(default)]
    pub params: HashMap<String, String>,
}

#[derive(Deserialize)]
pub struct QcRuleConfig {
    pub id: String,
    pub checks: Vec<CheckInstanceConfig>,
    #[serde(default)]
    pub strategy: Option<StrategyConfig>,
    /// Rule-level parameters (GitHub issue #253) — a value configured once on the rule, shared by
    /// every check/strategy in it that has been migrated to consume it (e.g. `protect_route`).
    /// Resolved once via `resolve_rule_params` in `build_rule_for!`. Not a fallback/override
    /// layer: a migrated parameter has no per-check/per-strategy equivalent anymore.
    #[serde(default)]
    pub params: HashMap<String, String>,
}

/// A named, ordered group of rules — see `Specs/repair.md`'s "Stages" section and issue #65.
/// `id` is opaque, must be unique across every stage in a `GenerateConfig`. `rules` is this
/// stage's own rule list (not a separate id-reference list) — see plan's "Отдельное 'stages',
/// check_rules уходит" decision.
#[derive(Deserialize)]
pub struct StageConfig {
    pub id: String,
    pub name: String,
    pub rules: Vec<QcRuleConfig>,
}

#[derive(Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TessellationType {
    Square,
    Hex,
    Tri,
}

#[derive(Deserialize)]
pub struct TessellationConfig {
    pub tessellation_type: TessellationType,
}

impl Default for TessellationConfig {
    fn default() -> Self {
        TessellationConfig { tessellation_type: TessellationType::Square }
    }
}

/// Default single-level field points (10x10 square, centered) — used by `default_level_fields`
/// when `level_fields` is entirely absent, matching `TessellationConfig`'s old default shape.
fn default_level_fields() -> Vec<Vec<[i32; 2]>> {
    let w = 10i32;
    let h = 10i32;
    let ox = w / 2;
    let oy = h / 2;
    let points: Vec<[i32; 2]> = (0..w).flat_map(|x| (0..h).map(move |y| [x - ox, y - oy])).collect();
    vec![points]
}

#[derive(Deserialize, Default)]
pub struct GenerationParamsConfig {
    pub depth_first:     Option<f64>,
    pub corridor_chance: Option<f64>,
    pub branching:       Option<f64>,
    pub directionality:  Option<f64>,
    pub cyclicity:       Option<f64>,
}

#[derive(Deserialize, Default)]
pub struct EdgeBasedParamsConfig {
    pub corridor_length: Option<f64>,
    pub branching:       Option<f64>,
    pub depth_first:     Option<f64>,
    pub directionality:  Option<f64>,
    pub cyclicity:       Option<f64>,
}

#[derive(Deserialize, Default)]
pub struct ElementsConfigDto {
    pub one_way_chance: Option<f64>,
    pub teleport_chance: Option<f64>,
    pub teleport_one_way_chance: Option<f64>,
    pub split_chance: Option<f64>,
    pub cross_floor_teleport_balance: Option<f64>,
    pub vertical_chance: Option<f64>,
    pub vertical_passage_elevator_balance: Option<f64>,
    pub one_way_vertical_passage_chance: Option<f64>,
    pub vertical_up_down_balance: Option<f64>,
    pub elevator_span_min: Option<usize>,
    pub elevator_span_max: Option<usize>,
    pub elevator_branching: Option<f64>,
    pub allow_non_consecutive_elevator_floors: Option<bool>,
}

/// Wire shape for `maze_core::generation::SplitFaceRequirement` (GitHub issue #222).
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SplitFaceRequirementDto {
    Passage,
    OneWay { direction: OneWayDirectionDto },
    Wall,
    Unspecified,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OneWayDirectionDto {
    Forward,
    Backward,
}

/// Wire shape for `maze_core::generation::SplitPatternFace`. `face_index` is passed through
/// unvalidated here — this layer isn't generic over a concrete `T: Tessellation` yet, so the
/// degree-range check happens later, in `dispatch`/`run_generate_typed` (see
/// `Specs`/plan section 3.6).
#[derive(Deserialize)]
pub struct SplitPatternFaceDto {
    pub face_index: usize,
    pub requirement: SplitFaceRequirementDto,
    #[serde(default)]
    pub sibling_target: Option<usize>,
}

/// Wire shape for `maze_core::generation::SplitPattern`.
#[derive(Deserialize)]
pub struct SplitPatternDto {
    pub node_count: usize,
    pub faces: Vec<Vec<SplitPatternFaceDto>>,
    #[serde(default = "default_pattern_weight")]
    pub weight: f64,
}

fn default_pattern_weight() -> f64 { 1.0 }

/// Wire shape for `maze_core::generation::SplitGenerationConfig`.
#[derive(Deserialize, Default)]
pub struct SplitGenerationConfigDto {
    #[serde(default)]
    pub pattern_mode: bool,
    pub max_split_nodes: Option<u32>,
    #[serde(default)]
    pub patterns: Vec<SplitPatternDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresetConnectionStateDto {
    Wall,
    Passage,
    OneWayForward,
    OneWayBackward,
    TeleportForward,
    TeleportBackward,
    TeleportTwoWay,
}

/// Wire shape for a preset endpoint (GitHub issue #231) — a point plus an optional slot
/// addressing one of that point's declared extra ("split") nodes. `slot: None` means the point's
/// original node. `level` (GitHub issue #340) is the endpoint's 0-based `levels_ordered()` index;
/// `None` means level 0, backward-compatible with every pre-#340 config. Mirrors
/// `maze-core::generation::PresetEndpoint`.
#[derive(Deserialize)]
pub struct PresetEndpointDto {
    pub point: [i32; 2],
    #[serde(default)]
    pub slot: Option<u32>,
    #[serde(default)]
    pub level: Option<u32>,
}

#[derive(Deserialize)]
pub struct PresetConnectionDto {
    pub from: PresetEndpointDto,
    pub to:   PresetEndpointDto,
    pub state: PresetConnectionStateDto,
}

/// Wire shape for `maze_core::generation::VerticalPassageDirection`.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerticalPassageDirectionDto {
    Forward,
    Backward,
}

/// Wire shape for a preset `VerticalPassage` (GitHub issue #357) — see
/// `maze_core::generation::PresetVerticalPassage`'s own doc comment for why this is a separate
/// top-level config field rather than a `PresetConnectionStateDto` variant.
#[derive(Deserialize)]
pub struct PresetVerticalPassageDto {
    pub from: PresetEndpointDto,
    pub to:   PresetEndpointDto,
    #[serde(default)]
    pub one_way: Option<VerticalPassageDirectionDto>,
}

/// Wire shape for a preset `Elevator` (GitHub issue #357) — see
/// `maze_core::generation::PresetElevator`'s own doc comment.
#[derive(Deserialize)]
pub struct PresetElevatorDto {
    pub floors: Vec<PresetEndpointDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeLockKindDto {
    In,
    Out,
    Both,
}

#[derive(Deserialize)]
pub struct LockedNodeDto {
    pub point: PresetEndpointDto,
    pub kind:  NodeLockKindDto,
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum InitialGenerationConfig {
    CustomVertexBased(GenerationParamsConfig),
    CustomEdgeBased(EdgeBasedParamsConfig),
    RecursiveBacktracker,
    WilsonAlgorithm,
    KruskalAlgorithm,
}

impl Default for InitialGenerationConfig {
    fn default() -> Self {
        InitialGenerationConfig::CustomVertexBased(GenerationParamsConfig::default())
    }
}

#[derive(Deserialize)]
pub struct GenerateConfig {
    /// Tessellation kind/orientation — maze-wide, shared by every level (GitHub issue #338:
    /// kind is confirmed once, not per floor; see Specs/field-editor.md on the web side).
    #[serde(default)]
    pub tessellation: TessellationConfig,
    /// Each level's own field points (GitHub issue #338 — per-floor field shape). The number of
    /// levels to generate across (GitHub issue #337) is `level_fields.len()` — there is no
    /// separate count field on the wire, so the two can never disagree. Only `generate_maze`/the
    /// wasm dispatch consult this; everything downstream (QC/repair/routing/analytics/post-edit)
    /// still only ever sees the first level, via `MultiLevelField::single_level_id()` — see that
    /// method's doc comment. `#[serde(default)]` falls back to a single 10x10 square level so
    /// configs/fixtures predating this field still deserialize.
    #[serde(default = "default_level_fields")]
    pub level_fields: Vec<Vec<[i32; 2]>>,
    #[serde(default)]
    pub stages: Vec<StageConfig>,
    #[serde(default = "default_repair_max_iterations")]
    pub repair_max_iterations: Option<usize>,
    #[serde(default = "default_repair_time_budget_secs")]
    pub repair_time_budget_secs: Option<f64>,
    #[serde(default)]
    pub initial: InitialGenerationConfig,
    #[serde(default)]
    pub elements: ElementsConfigDto,
    #[serde(default)]
    pub preset_connections: Vec<PresetConnectionDto>,
    /// Preset `VerticalPassage` links (GitHub issue #357). `#[serde(default)]` so configs
    /// predating this field still deserialize.
    #[serde(default)]
    pub preset_vertical_passages: Vec<PresetVerticalPassageDto>,
    /// Preset `Elevator` links (GitHub issue #357). `#[serde(default)]` so configs predating this
    /// field still deserialize.
    #[serde(default)]
    pub preset_elevators: Vec<PresetElevatorDto>,
    #[serde(default)]
    pub locked_nodes: Vec<LockedNodeDto>,
    pub preset_start: Option<PresetEndpointDto>,
    pub preset_finish: Option<PresetEndpointDto>,
    pub preset_gen_source: Option<PresetEndpointDto>,
    /// Extra nodes to create at declared points before any preset above is resolved (GitHub
    /// issue #231) — `((x, y), slot_id, level)` triples; `level` added by GitHub issue #340
    /// (0-based `levels_ordered()` index). `#[serde(default)]` so configs predating this field
    /// still deserialize; a config predating the `level` element within each triple would fail to
    /// deserialize on the tuple arity mismatch, but no such config exists on disk (this field
    /// itself only shipped after #231, and every fixture using it is updated alongside this
    /// change).
    #[serde(default)]
    pub split_points: Vec<((i32, i32), u32, u32)>,
    /// `CustomVertexBased`-only automatic split-point assignment settings (GitHub issue #222).
    #[serde(default)]
    pub split_generation: SplitGenerationConfigDto,
    // Only consumed by `maze-wasm` (whether to build the narration-level debug event tree — see
    // GitHub issue #124) — `maze-runner`'s own native repro tests never read it.
    #[serde(default)]
    pub debug_events: bool,
    // Only consumed by `maze-wasm` (skips the generation algorithm entirely and runs QC/repair
    // directly on the preset-seeded graph) — `maze-runner`'s own native repro tests never read
    // it, same rationale as `debug_events`.
    #[serde(default)]
    pub qc_experiment: bool,
}

impl Default for GenerateConfig {
    fn default() -> Self {
        Self {
            tessellation: TessellationConfig::default(),
            level_fields: default_level_fields(),
            stages: vec![
                StageConfig {
                    id: "stage_1".to_string(),
                    name: "Stage 1".to_string(),
                    rules: vec![
                        QcRuleConfig {
                            id: "default_missing_endpoints".to_string(),
                            checks: vec![CheckInstanceConfig {
                                local_id: MISSING_ENDPOINTS.as_str().to_string(),
                                type_id: MISSING_ENDPOINTS.as_str().to_string(),
                                params: HashMap::new(),
                            }],
                            strategy: Some(StrategyConfig {
                                id: "farthest_endpoints".to_string(),
                                params: HashMap::new(),
                                slot_id: None,
                                nested: vec![],
                            }),
                            params: HashMap::new(),
                        },
                        QcRuleConfig {
                            id: "default_unreachable_finish".to_string(),
                            checks: vec![CheckInstanceConfig {
                                local_id: UNREACHABLE_FINISH.as_str().to_string(),
                                type_id: UNREACHABLE_FINISH.as_str().to_string(),
                                params: HashMap::new(),
                            }],
                            strategy: None,
                            params: HashMap::new(),
                        },
                    ],
                },
            ],
            repair_max_iterations: default_repair_max_iterations(),
            repair_time_budget_secs: default_repair_time_budget_secs(),
            initial: InitialGenerationConfig::default(),
            elements: ElementsConfigDto::default(),
            preset_connections: vec![],
            preset_vertical_passages: vec![],
            preset_elevators: vec![],
            locked_nodes: vec![],
            preset_start: None,
            preset_finish: None,
            preset_gen_source: None,
            split_points: vec![],
            split_generation: SplitGenerationConfigDto::default(),
            debug_events: false,
            qc_experiment: false,
        }
    }
}

/// `serde(default = ...)` for `GenerateConfig::repair_max_iterations` — a config predating this
/// field (e.g. an older browser export) omits the key entirely; falling back to `None` here would
/// silently combine with an omitted `repair_time_budget_secs` into an invalid "no cap at all"
/// `RepairLimits`, rejected by `RepairLimits::new` (see GitHub issue #170). Falls back to
/// `RepairLimits::default()`'s bound instead, matching `Default for GenerateConfig` below.
fn default_repair_max_iterations() -> Option<usize> {
    RepairLimits::default().max_iterations()
}

/// See `default_repair_max_iterations` above — same rationale for the time-budget bound.
fn default_repair_time_budget_secs() -> Option<f64> {
    RepairLimits::default().time_budget_secs()
}

pub fn build_repair_limits(config: &GenerateConfig) -> Result<RepairLimits, String> {
    RepairLimits::new(config.repair_max_iterations, config.repair_time_budget_secs)
}

pub fn build_generation_config(config: &GenerateConfig) -> GenerationConfig {
    let algorithm = match &config.initial {
        InitialGenerationConfig::CustomVertexBased(p) =>
            GenerationAlgorithm::CustomVertexBased(build_gen_params(p)),
        InitialGenerationConfig::CustomEdgeBased(p) =>
            GenerationAlgorithm::CustomEdgeBased(build_edge_params(p)),
        InitialGenerationConfig::RecursiveBacktracker =>
            GenerationAlgorithm::RecursiveBacktracker,
        InitialGenerationConfig::WilsonAlgorithm =>
            GenerationAlgorithm::WilsonAlgorithm,
        InitialGenerationConfig::KruskalAlgorithm =>
            GenerationAlgorithm::KruskalAlgorithm,
    };
    let elements = build_elements_config(&config.elements);
    let preset_connections = config.preset_connections.iter().map(|dto| PresetConnection {
        from: build_preset_endpoint(&dto.from),
        to:   build_preset_endpoint(&dto.to),
        state: match dto.state {
            PresetConnectionStateDto::Wall             => PresetConnectionState::Wall,
            PresetConnectionStateDto::Passage          => PresetConnectionState::Passage,
            PresetConnectionStateDto::OneWayForward     => PresetConnectionState::OneWayForward,
            PresetConnectionStateDto::OneWayBackward    => PresetConnectionState::OneWayBackward,
            PresetConnectionStateDto::TeleportForward   => PresetConnectionState::Teleport(TeleportDirection::Forward),
            PresetConnectionStateDto::TeleportBackward  => PresetConnectionState::Teleport(TeleportDirection::Backward),
            PresetConnectionStateDto::TeleportTwoWay    => PresetConnectionState::Teleport(TeleportDirection::TwoWay),
        },
    }).collect();
    let preset_vertical_passages = config.preset_vertical_passages.iter().map(|dto| PresetVerticalPassage {
        from: build_preset_endpoint(&dto.from),
        to:   build_preset_endpoint(&dto.to),
        one_way: dto.one_way.as_ref().map(|d| match d {
            VerticalPassageDirectionDto::Forward  => VerticalPassageDirection::Forward,
            VerticalPassageDirectionDto::Backward => VerticalPassageDirection::Backward,
        }),
    }).collect();
    let preset_elevators = config.preset_elevators.iter().map(|dto| PresetElevator {
        floors: dto.floors.iter().map(build_preset_endpoint).collect(),
    }).collect();
    let locked_nodes = config.locked_nodes.iter().map(|dto| LockedNode {
        point: build_preset_endpoint(&dto.point),
        kind: match dto.kind {
            NodeLockKindDto::In   => NodeLockKind::In,
            NodeLockKindDto::Out  => NodeLockKind::Out,
            NodeLockKindDto::Both => NodeLockKind::Both,
        },
    }).collect();
    let split_points = config.split_points.clone();
    let split_generation = build_split_generation_config(&config.split_generation);
    GenerationConfig { algorithm, elements, preset_connections, preset_vertical_passages, preset_elevators, locked_nodes, split_points, split_generation }
}

/// Builds `SplitGenerationConfig` from the wire DTO. `max_split_nodes` is clamped to `.max(1)` —
/// only `0` is rejected; `1` is a valid, deliberate no-op (see
/// `maze_core::generation::SplitGenerationConfig`'s doc comment). `face_index` is passed through
/// unvalidated here — this layer isn't generic over a concrete `T: Tessellation`, so the
/// degree-range check happens later, once `T` is known (`dispatch`/`run_generate_typed`).
pub(crate) fn build_split_generation_config(dto: &SplitGenerationConfigDto) -> maze_core::generation::SplitGenerationConfig {
    let max_split_nodes = dto.max_split_nodes.unwrap_or(2).max(1);
    let patterns = build_split_patterns(&dto.patterns);
    maze_core::generation::SplitGenerationConfig {
        pattern_mode: dto.pattern_mode,
        max_split_nodes,
        patterns,
    }
}

/// Converts a slice of wire-shape `SplitPatternDto` into `maze_core::generation::SplitPattern` —
/// shared by generation's own `split_generation` field and, via `parse_split_patterns_param`
/// (GitHub issue #247), any check/strategy param carrying its own independent pattern list
/// (`SplitCountCheck`/`SplitDensityCheck`/`AddSplitStrategy`).
pub(crate) fn build_split_patterns(dtos: &[SplitPatternDto]) -> Vec<maze_core::generation::SplitPattern> {
    use maze_core::generation::{SplitPattern, SplitPatternFace, SplitFaceRequirement, OneWayDirection};
    dtos.iter().map(|p| SplitPattern {
        node_count: p.node_count,
        faces: p.faces.iter().map(|node_faces| node_faces.iter().map(|f| SplitPatternFace {
            face_index: f.face_index,
            requirement: match &f.requirement {
                SplitFaceRequirementDto::Passage => SplitFaceRequirement::Passage,
                SplitFaceRequirementDto::OneWay { direction } => SplitFaceRequirement::OneWay(match direction {
                    OneWayDirectionDto::Forward => OneWayDirection::Forward,
                    OneWayDirectionDto::Backward => OneWayDirection::Backward,
                }),
                SplitFaceRequirementDto::Wall => SplitFaceRequirement::Wall,
                SplitFaceRequirementDto::Unspecified => SplitFaceRequirement::Unspecified,
            },
            sibling_target: f.sibling_target,
        }).collect()).collect(),
        weight: p.weight.max(0.0),
    }).collect()
}

/// Parses a `params["patterns"]`-style value (GitHub issue #247) — a JSON array of
/// `SplitPatternDto`, the same wire shape `SplitGenerationConfigDto.patterns` uses, serialized to
/// a string since `CheckInstanceConfig`/`StrategyConfig.params` is a flat `HashMap<String,
/// String>`, not structured JSON. Missing key or malformed JSON both fall back to an empty list
/// (the check's own "no filter"/the strategy's own "unconstrained" default) rather than erroring
/// the whole config — same "invalid falls back to documented default" contract every other
/// `params` value in this factory follows.
pub(crate) fn parse_split_patterns_param(param: Option<&String>) -> Vec<maze_core::generation::SplitPattern> {
    let Some(raw) = param else { return Vec::new(); };
    let Ok(dtos) = serde_json::from_str::<Vec<SplitPatternDto>>(raw) else { return Vec::new(); };
    build_split_patterns(&dtos)
}

/// Parses a `params["split_config"]`-style value (`AddSplitStrategy`'s own pattern-selection
/// config, GitHub issue #247) — the exact same wire shape `GenerateConfig.split_generation` uses
/// (`SplitGenerationConfigDto`), reused as-is rather than a bespoke parallel shape, since
/// `AddSplitStrategy::config` is itself a plain `generation::SplitGenerationConfig`. Missing key
/// or malformed JSON both fall back to the type's own `Default` (unconstrained mode,
/// `max_split_nodes: 2`, no patterns) — same "invalid falls back to documented default" contract
/// `parse_split_patterns_param` follows.
pub(crate) fn parse_split_config_param(param: Option<&String>) -> maze_core::generation::SplitGenerationConfig {
    let Some(raw) = param else { return Default::default(); };
    let Ok(dto) = serde_json::from_str::<SplitGenerationConfigDto>(raw) else { return Default::default(); };
    build_split_generation_config(&dto)
}

fn build_preset_endpoint(dto: &PresetEndpointDto) -> PresetEndpoint {
    PresetEndpoint { point: (dto.point[0], dto.point[1]), slot: dto.slot, level: dto.level }
}

fn build_gen_params(cfg: &GenerationParamsConfig) -> GenerationParams {
    let mut p = GenerationParams::default();
    if let Some(v) = cfg.depth_first     { p.depth_first     = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.corridor_chance { p.corridor_chance = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.branching       { p.branching       = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.directionality  { p.directionality  = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.cyclicity       { p.cyclicity       = v.clamp(0.0, 1.0); }
    p
}

fn build_edge_params(cfg: &EdgeBasedParamsConfig) -> EdgeBasedParams {
    let mut p = EdgeBasedParams::default();
    if let Some(v) = cfg.corridor_length { p.corridor_length = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.branching       { p.branching       = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.depth_first     { p.depth_first     = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.directionality  { p.directionality  = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.cyclicity       { p.cyclicity       = v.clamp(0.0, 1.0); }
    p
}

fn build_elements_config(dto: &ElementsConfigDto) -> ElementsConfig {
    let mut e = ElementsConfig::default();
    if let Some(v) = dto.one_way_chance { e.one_way_chance = v.clamp(0.0, 1.0); }
    if let Some(v) = dto.teleport_chance { e.teleport_chance = v.clamp(0.0, 1.0); }
    if let Some(v) = dto.teleport_one_way_chance { e.teleport_one_way_chance = v.clamp(0.0, 1.0); }
    if let Some(v) = dto.split_chance { e.split_chance = v.clamp(0.0, 1.0); }
    if let Some(v) = dto.cross_floor_teleport_balance { e.cross_floor_teleport_balance = v.clamp(0.0, 1.0); }
    if let Some(v) = dto.vertical_chance { e.vertical_chance = v.clamp(0.0, 1.0); }
    if let Some(v) = dto.vertical_passage_elevator_balance { e.vertical_passage_elevator_balance = v.clamp(0.0, 1.0); }
    if let Some(v) = dto.one_way_vertical_passage_chance { e.one_way_vertical_passage_chance = v.clamp(0.0, 1.0); }
    if let Some(v) = dto.vertical_up_down_balance { e.vertical_up_down_balance = v.clamp(0.0, 1.0); }
    if let Some(v) = dto.elevator_span_min { e.elevator_span_min = v.max(1); }
    if let Some(v) = dto.elevator_span_max { e.elevator_span_max = v.max(1); }
    if let Some(v) = dto.elevator_branching { e.elevator_branching = v.clamp(0.0, 1.0); }
    if let Some(v) = dto.allow_non_consecutive_elevator_floors { e.allow_non_consecutive_elevator_floors = v; }
    if e.elevator_span_max < e.elevator_span_min { e.elevator_span_max = e.elevator_span_min; }
    e
}
