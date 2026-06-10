use std::collections::HashMap;
use serde::Deserialize;
use maze_core::{
    generation::{GenerationParams, EdgeBasedParams, ElementsConfig, GenerationConfig, GenerationAlgorithm},
    quality_control::{MISSING_ENDPOINTS, UNREACHABLE_FINISH},
};
use crate::dto::{HexOrientationDto, TriangleOrientationDto};

#[derive(Deserialize)]
pub struct StrategyConfig {
    pub id: String,
    #[serde(default)]
    pub params: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TessellationConfig {
    Square { width: u32, height: u32 },
    HexParallelogram {
        cols: u32,
        rows: u32,
        #[serde(default)]
        #[allow(dead_code)]
        orientation: HexOrientationDto,
    },
    HexHexagon {
        radius: u32,
        #[serde(default)]
        #[allow(dead_code)]
        orientation: HexOrientationDto,
    },
    TriangleRect {
        cols: u32,
        rows: u32,
        #[serde(default)]
        #[allow(dead_code)]
        orientation: TriangleOrientationDto,
    },
    TriangleTriangle {
        side: u32,
        #[serde(default)]
        #[allow(dead_code)]
        orientation: TriangleOrientationDto,
    },
    TriangleHexagon {
        radius: u32,
        #[serde(default)]
        #[allow(dead_code)]
        orientation: TriangleOrientationDto,
    },
    SquareCustom { points: Vec<[i32; 2]> },
    HexCustom    { points: Vec<[i32; 2]> },
    TriCustom    { points: Vec<[i32; 2]> },
}

impl Default for TessellationConfig {
    fn default() -> Self {
        TessellationConfig::Square { width: 10, height: 10 }
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
    pub locality:        Option<f64>,
    pub directionality:  Option<f64>,
}

#[derive(Deserialize, Default)]
pub struct ElementsConfigDto {
    pub one_way_chance: Option<f64>,
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
    pub initial: InitialGenerationConfig,
    #[serde(default)]
    pub elements: ElementsConfigDto,
}

impl Default for GenerateConfig {
    fn default() -> Self {
        Self {
            tessellation: TessellationConfig::default(),
            checks: vec![
                MISSING_ENDPOINTS.to_string(),
                UNREACHABLE_FINISH.to_string(),
            ],
            strategies: {
                let mut m = HashMap::new();
                m.insert(MISSING_ENDPOINTS.to_string(), StrategyConfig {
                    id: "farthest_endpoints".to_string(),
                    params: HashMap::new(),
                });
                m
            },
            initial: InitialGenerationConfig::default(),
            elements: ElementsConfigDto::default(),
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
    GenerationConfig { algorithm, elements }
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
    if let Some(v) = cfg.locality        { p.locality        = v.clamp(0.0, 1.0); }
    if let Some(v) = cfg.directionality  { p.directionality  = v.clamp(0.0, 1.0); }
    p
}

fn build_elements_config(dto: &ElementsConfigDto) -> ElementsConfig {
    let mut e = ElementsConfig::default();
    if let Some(v) = dto.one_way_chance { e.one_way_chance = v.clamp(0.0, 1.0); }
    e
}
