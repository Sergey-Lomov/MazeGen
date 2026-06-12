use std::collections::HashMap;
use serde::Deserialize;
use maze_core::{
    generation::{GenerationParams, EdgeBasedParams, ElementsConfig, GenerationConfig, GenerationAlgorithm, PresetConnection, PresetConnectionState, LockedNode, NodeLockKind},
    quality_control::{MISSING_ENDPOINTS, UNREACHABLE_FINISH},
};

#[derive(Deserialize)]
pub struct StrategyConfig {
    pub id: String,
    #[serde(default)]
    pub params: HashMap<String, String>,
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
        let points: Vec<[i32; 2]> = {
            let w = 10i32;
            let h = 10i32;
            let ox = w / 2;
            let oy = h / 2;
            (0..w).flat_map(|x| (0..h).map(move |y| [x - ox, y - oy])).collect()
        };
        TessellationConfig { tessellation_type: TessellationType::Square, points }
    }
}

#[derive(Deserialize, Default)]
pub struct GenerationParamsConfig {
    pub depth_first:     Option<f64>,
    pub corridor_chance: Option<f64>,
    pub branching:       Option<f64>,
    pub directionality:  Option<f64>,
}

#[derive(Deserialize, Default)]
pub struct EdgeBasedParamsConfig {
    pub corridor_length: Option<f64>,
    pub branching:       Option<f64>,
    pub depth_first:     Option<f64>,
    pub directionality:  Option<f64>,
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
    pub checks: Vec<String>,
    #[serde(default)]
    pub strategies: HashMap<String, StrategyConfig>,
    #[serde(default)]
    pub check_params: HashMap<String, HashMap<String, String>>,
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
    #[serde(default)]
    pub debug: bool,
}

impl Default for GenerateConfig {
    fn default() -> Self {
        Self {
            tessellation: TessellationConfig::default(),
            checks: vec![
                MISSING_ENDPOINTS.as_str().to_string(),
                UNREACHABLE_FINISH.as_str().to_string(),
            ],
            strategies: {
                let mut m = HashMap::new();
                m.insert(MISSING_ENDPOINTS.as_str().to_string(), StrategyConfig {
                    id: "farthest_endpoints".to_string(),
                    params: HashMap::new(),
                });
                m
            },
            check_params: HashMap::new(),
            initial: InitialGenerationConfig::default(),
            elements: ElementsConfigDto::default(),
            preset_connections: vec![],
            locked_nodes: vec![],
            preset_start: None,
            preset_finish: None,
            debug: false,
        }
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
    p
}

fn build_edge_params(cfg: &EdgeBasedParamsConfig) -> EdgeBasedParams {
    let mut p = EdgeBasedParams::default();
    if let Some(v) = cfg.corridor_length { p.corridor_length = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.branching       { p.branching       = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.depth_first     { p.depth_first     = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.directionality  { p.directionality  = v.clamp(0.0, 1.0); }
    p
}

fn build_elements_config(dto: &ElementsConfigDto) -> ElementsConfig {
    let mut e = ElementsConfig::default();
    if let Some(v) = dto.one_way_chance { e.one_way_chance = v.clamp(0.0, 1.0); }
    e
}
