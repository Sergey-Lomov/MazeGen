use std::collections::HashMap;
use serde::Deserialize;
use maze_core::{
    generation::{GenerationParams, EdgeBasedParams, ElementsConfig, GenerationConfig, GenerationAlgorithm, PresetConnection, PresetConnectionState, LockedNode, NodeLockKind},
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
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresetConnectionStateDto {
    Wall,
    Passage,
    OneWayForward,
    OneWayBackward,
}

#[derive(Deserialize)]
pub struct PresetConnectionDto {
    pub from: [i32; 2],
    pub to:   [i32; 2],
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
    pub point: [i32; 2],
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
    #[serde(default)]
    pub repair_max_iterations: Option<usize>,
    #[serde(default)]
    pub repair_time_budget_secs: Option<f64>,
    #[serde(default)]
    pub initial: InitialGenerationConfig,
    #[serde(default)]
    pub elements: ElementsConfigDto,
    #[serde(default)]
    pub preset_connections: Vec<PresetConnectionDto>,
    #[serde(default)]
    pub locked_nodes: Vec<LockedNodeDto>,
    pub preset_start: Option<[i32; 2]>,
    pub preset_finish: Option<[i32; 2]>,
    pub preset_gen_source: Option<[i32; 2]>,
    // Only consumed by `maze-wasm` (whether to capture the step-by-step generation trace for the
    // browser debug toolbar) — `maze-runner`'s own native repro tests never read it.
    #[serde(default)]
    pub debug: bool,
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
            repair_max_iterations: RepairLimits::default().max_iterations,
            repair_time_budget_secs: RepairLimits::default().time_budget_secs,
            initial: InitialGenerationConfig::default(),
            elements: ElementsConfigDto::default(),
            preset_connections: vec![],
            locked_nodes: vec![],
            preset_start: None,
            preset_finish: None,
            preset_gen_source: None,
            debug: false,
        }
    }
}

pub fn build_repair_limits(config: &GenerateConfig) -> RepairLimits {
    RepairLimits {
        max_iterations: config.repair_max_iterations,
        time_budget_secs: config.repair_time_budget_secs,
    }
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
        from: (dto.from[0], dto.from[1]),
        to:   (dto.to[0],   dto.to[1]),
        state: match dto.state {
            PresetConnectionStateDto::Wall          => PresetConnectionState::Wall,
            PresetConnectionStateDto::Passage       => PresetConnectionState::Passage,
            PresetConnectionStateDto::OneWayForward  => PresetConnectionState::OneWayForward,
            PresetConnectionStateDto::OneWayBackward => PresetConnectionState::OneWayBackward,
        },
    }).collect();
    let locked_nodes = config.locked_nodes.iter().map(|dto| LockedNode {
        point: (dto.point[0], dto.point[1]),
        kind: match dto.kind {
            NodeLockKindDto::In   => NodeLockKind::In,
            NodeLockKindDto::Out  => NodeLockKind::Out,
            NodeLockKindDto::Both => NodeLockKind::Both,
        },
    }).collect();
    GenerationConfig { algorithm, elements, preset_connections, locked_nodes }
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
    e
}
