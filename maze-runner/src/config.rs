use std::collections::HashMap;
use serde::Deserialize;
use maze_core::{
    generation::{GenerationParams, EdgeBasedParams, ElementsConfig, GenerationConfig, GenerationAlgorithm, PresetConnection, PresetConnectionState, PresetEndpoint, TeleportDirection, LockedNode, NodeLockKind},
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
    pub points: Vec<[i32; 2]>,
}

impl Default for TessellationConfig {
    fn default() -> Self {
        let w = 10i32;
        let h = 10i32;
        let ox = w / 2;
        let oy = h / 2;
        let points = (0..w).flat_map(|x| (0..h).map(move |y| [x - ox, y - oy])).collect();
        TessellationConfig { tessellation_type: TessellationType::Square, points }
    }
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
/// original node. Mirrors `maze-core::generation::PresetEndpoint`.
#[derive(Deserialize)]
pub struct PresetEndpointDto {
    pub point: [i32; 2],
    #[serde(default)]
    pub slot: Option<u32>,
}

#[derive(Deserialize)]
pub struct PresetConnectionDto {
    pub from: PresetEndpointDto,
    pub to:   PresetEndpointDto,
    pub state: PresetConnectionStateDto,
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
    #[serde(default)]
    pub tessellation: TessellationConfig,
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
    #[serde(default)]
    pub locked_nodes: Vec<LockedNodeDto>,
    pub preset_start: Option<PresetEndpointDto>,
    pub preset_finish: Option<PresetEndpointDto>,
    pub preset_gen_source: Option<PresetEndpointDto>,
    /// Extra nodes to create at declared points before any preset above is resolved (GitHub
    /// issue #231) — `((x, y), slot_id)` pairs. `#[serde(default)]` so configs predating this
    /// field still deserialize.
    #[serde(default)]
    pub split_points: Vec<((i32, i32), u32)>,
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
                        },
                        QcRuleConfig {
                            id: "default_unreachable_finish".to_string(),
                            checks: vec![CheckInstanceConfig {
                                local_id: UNREACHABLE_FINISH.as_str().to_string(),
                                type_id: UNREACHABLE_FINISH.as_str().to_string(),
                                params: HashMap::new(),
                            }],
                            strategy: None,
                        },
                    ],
                },
            ],
            repair_max_iterations: default_repair_max_iterations(),
            repair_time_budget_secs: default_repair_time_budget_secs(),
            initial: InitialGenerationConfig::default(),
            elements: ElementsConfigDto::default(),
            preset_connections: vec![],
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
    GenerationConfig { algorithm, elements, preset_connections, locked_nodes, split_points, split_generation }
}

/// Builds `SplitGenerationConfig` from the wire DTO. `max_split_nodes` is clamped to `.max(1)` —
/// only `0` is rejected; `1` is a valid, deliberate no-op (see
/// `maze_core::generation::SplitGenerationConfig`'s doc comment). `face_index` is passed through
/// unvalidated here — this layer isn't generic over a concrete `T: Tessellation`, so the
/// degree-range check happens later, once `T` is known (`dispatch`/`run_generate_typed`).
fn build_split_generation_config(dto: &SplitGenerationConfigDto) -> maze_core::generation::SplitGenerationConfig {
    use maze_core::generation::{SplitPattern, SplitPatternFace, SplitFaceRequirement, OneWayDirection};
    let max_split_nodes = dto.max_split_nodes.unwrap_or(2).max(1);
    let patterns = dto.patterns.iter().map(|p| SplitPattern {
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
    }).collect();
    maze_core::generation::SplitGenerationConfig {
        pattern_mode: dto.pattern_mode,
        max_split_nodes,
        patterns,
    }
}

fn build_preset_endpoint(dto: &PresetEndpointDto) -> PresetEndpoint {
    PresetEndpoint { point: (dto.point[0], dto.point[1]), slot: dto.slot }
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
    e
}
