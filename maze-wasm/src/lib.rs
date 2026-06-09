mod dto;

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use maze_core::{
    ids::IdGenerator,
    graph::Graph,
    space::{
        SquareField, SquarePoint, SquareRect, ShapedField,
        HexField, HexPoint, HexParallelogram, HexHexagon,
        TriField, TriPoint, TriRect, TriTriangle, TriHexagon,
        Field, Tessellation,
    },
    generation::{generate_maze, generate_maze_steps, GenerationParams, ElementsConfig, GenerationConfig, GenerationAlgorithm, pipeline::build_maze},
    quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MISSING_ENDPOINTS, UNREACHABLE_FINISH},
    repair::{RepairEngine, RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy},
};
use dto::{EdgeDto, HexOrientationDto, TriangleOrientationDto, MazeSnapshot, NavEdgeDto, NavNodeDto, NodeDto, GenerationStepDto, GenerationStepsSnapshot};

#[derive(Deserialize)]
struct StrategyConfig {
    id: String,
    #[serde(default)]
    params: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TessellationConfig {
    Square { width: u32, height: u32 },
    HexParallelogram {
        cols: u32,
        rows: u32,
        // Accepted for deserialization; rendering orientation is handled client-side.
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
}

impl Default for TessellationConfig {
    fn default() -> Self {
        TessellationConfig::Square { width: 10, height: 10 }
    }
}


#[derive(Deserialize, Default)]
struct GenerationParamsConfig {
    depth_first:     Option<f64>,
    corridor_chance: Option<f64>,
    branching:       Option<f64>,
    directionality:  Option<f64>,
}

#[derive(Deserialize, Default)]
struct ElementsConfigDto {
    one_way_chance: Option<f64>,
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
enum InitialGenerationConfig {
    CustomVertexBased(GenerationParamsConfig),
    RecursiveBacktracker,
}

impl Default for InitialGenerationConfig {
    fn default() -> Self {
        InitialGenerationConfig::CustomVertexBased(GenerationParamsConfig::default())
    }
}

#[derive(Deserialize)]
struct GenerateConfig {
    #[serde(default)]
    tessellation: TessellationConfig,
    #[serde(default)]
    checks: Vec<String>,
    #[serde(default)]
    strategies: HashMap<String, StrategyConfig>,
    #[serde(default)]
    initial: InitialGenerationConfig,
    #[serde(default)]
    elements: ElementsConfigDto,
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

#[derive(Serialize)]
struct ParamDescriptor {
    id: &'static str,
    label: &'static str,
    kind: ParamKindDto,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ParamKindDto {
    Float { default: f64, min: f64, max: f64 },
    Bool { default: bool },
    Enum { options: Vec<&'static str>, default: &'static str },
}

#[derive(Serialize)]
struct CheckDescriptor {
    id: &'static str,
    issue_kinds: Vec<&'static str>,
}

#[derive(Serialize)]
struct StrategyDescriptor {
    id: &'static str,
    handles: &'static str,
    params: Vec<ParamDescriptor>,
}

fn param_kind_dto(kind: &maze_core::repair::StrategyParamKind) -> ParamKindDto {
    match kind {
        maze_core::repair::StrategyParamKind::Float { default, min, max } =>
            ParamKindDto::Float { default: *default, min: *min, max: *max },
        maze_core::repair::StrategyParamKind::Bool { default } =>
            ParamKindDto::Bool { default: *default },
        maze_core::repair::StrategyParamKind::Enum { options, default } =>
            ParamKindDto::Enum { options: options.to_vec(), default },
    }
}

fn strategy_params_dto(params: &[maze_core::repair::StrategyParam]) -> Vec<ParamDescriptor> {
    params.iter().map(|p| ParamDescriptor {
        id: p.id,
        label: p.label,
        kind: param_kind_dto(&p.kind),
    }).collect()
}

#[wasm_bindgen]
pub fn available_checks() -> JsValue {
    let checks = vec![
        CheckDescriptor { id: MISSING_ENDPOINTS, issue_kinds: vec![MISSING_ENDPOINTS] },
        CheckDescriptor { id: UNREACHABLE_FINISH, issue_kinds: vec![UNREACHABLE_FINISH] },
    ];
    serde_wasm_bindgen::to_value(&checks).unwrap()
}

#[wasm_bindgen]
pub fn available_strategies() -> JsValue {
    let strategies: Vec<StrategyDescriptor> = vec![
        StrategyDescriptor {
            id: "random_endpoints",
            handles: MISSING_ENDPOINTS,
            params: strategy_params_dto(<RandomEndpointsStrategy as RepairStrategy<SquareField>>::params(&RandomEndpointsStrategy)),
        },
        StrategyDescriptor {
            id: "farthest_endpoints",
            handles: MISSING_ENDPOINTS,
            params: strategy_params_dto(<FarthestEndpointsStrategy as RepairStrategy<SquareField>>::params(&FarthestEndpointsStrategy)),
        },
        StrategyDescriptor {
            id: "scored_endpoints",
            handles: MISSING_ENDPOINTS,
            params: strategy_params_dto(<ScoredEndpointsStrategy as RepairStrategy<SquareField>>::params(&ScoredEndpointsStrategy)),
        },
    ];
    serde_wasm_bindgen::to_value(&strategies).unwrap()
}

fn build_qc_and_repair<F: Field>(
    config: &GenerateConfig,
) -> Result<(QualityControlEngine<F>, RepairEngine<F>), JsValue> {
    let mut checks: Vec<Box<dyn maze_core::quality_control::Check<F>>> = Vec::new();
    for id in &config.checks {
        match id.as_str() {
            MISSING_ENDPOINTS => checks.push(Box::new(MissingEndpointsCheck)),
            UNREACHABLE_FINISH => checks.push(Box::new(UnreachableFinishCheck)),
            other => return Err(JsValue::from_str(&format!("unknown check: {other}"))),
        }
    }
    let qc_engine = QualityControlEngine::new(checks);

    let mut strategies: HashMap<_, Box<dyn RepairStrategy<F>>> = HashMap::new();
    let mut param_overrides: HashMap<&'static str, HashMap<String, String>> = HashMap::new();

    for (issue_kind, strategy_cfg) in &config.strategies {
        let kind: &'static str = match issue_kind.as_str() {
            MISSING_ENDPOINTS => MISSING_ENDPOINTS,
            UNREACHABLE_FINISH => UNREACHABLE_FINISH,
            other => return Err(JsValue::from_str(&format!("unknown issue kind: {other}"))),
        };
        let strategy: Box<dyn RepairStrategy<F>> = match strategy_cfg.id.as_str() {
            "random_endpoints" => Box::new(RandomEndpointsStrategy),
            "farthest_endpoints" => Box::new(FarthestEndpointsStrategy),
            "scored_endpoints" => Box::new(ScoredEndpointsStrategy),
            other => return Err(JsValue::from_str(&format!("unknown strategy: {other}"))),
        };
        strategies.insert(kind, strategy);
        if !strategy_cfg.params.is_empty() {
            param_overrides.insert(kind, strategy_cfg.params.clone());
        }
    }
    let repair_engine = RepairEngine::new(strategies, param_overrides);

    Ok((qc_engine, repair_engine))
}

fn build_generation_config(config: &GenerateConfig) -> GenerationConfig {
    let algorithm = match &config.initial {
        InitialGenerationConfig::CustomVertexBased(p) => {
            GenerationAlgorithm::CustomVertexBased(build_gen_params(p))
        }
        InitialGenerationConfig::RecursiveBacktracker => {
            GenerationAlgorithm::RecursiveBacktracker
        }
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

fn build_elements_config(dto: &ElementsConfigDto) -> ElementsConfig {
    let mut e = ElementsConfig::default();
    if let Some(v) = dto.one_way_chance { e.one_way_chance = v.clamp(0.0, 1.0); }
    e
}

fn run_generate<F: Field>(
    seed: u64,
    field: F,
    start: <F::T as Tessellation>::Point,
    config: &GenerateConfig,
    point_to_xy: impl Fn(<F::T as Tessellation>::Point) -> (i32, i32),
) -> Result<JsValue, JsValue> {
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    let start_id = field
        .node_at(start)
        .ok_or_else(|| JsValue::from_str("start node not found"))?;

    let gen_config = build_generation_config(config);
    generate_maze(&mut graph, &field, seed, start_id, gen_config);

    let (qc_engine, repair_engine) = build_qc_and_repair::<F>(config)?;

    let (mut maze, issues) = build_maze(field, graph, seed, qc_engine, repair_engine);
    let warnings: Vec<String> = issues.iter().map(|i| i.kind.to_string()).collect();

    let nodes: Vec<NodeDto> = maze.graph
        .nodes()
        .filter_map(|n| {
            let id = u32::try_from(n.id).ok()?;
            maze.field.point_of(n.id).map(|p| {
                let (x, y) = point_to_xy(p);
                NodeDto { id, x, y }
            })
        })
        .collect();

    let edges: Vec<EdgeDto> = maze.graph
        .edges()
        .map(|e| -> Result<EdgeDto, JsValue> {
            Ok(EdgeDto {
                from: u32::try_from(e.from).map_err(|_| JsValue::from_str("edge endpoint overflow"))?,
                to: u32::try_from(e.to).map_err(|_| JsValue::from_str("edge endpoint overflow"))?,
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;

    let meta_start = maze.meta.start.and_then(|id| u32::try_from(id).ok());
    let meta_finish = maze.meta.finish.and_then(|id| u32::try_from(id).ok());

    let nav = maze.analysis.nav_graph(&maze.graph);

    let nav_nodes: Vec<NavNodeDto> = nav.nodes.iter()
        .filter_map(|n| {
            let node_id = u32::try_from(n.node_id).ok()?;
            Some(NavNodeDto { node_id })
        })
        .collect();

    let nav_edges: Vec<NavEdgeDto> = nav.edges()
        .filter_map(|e| {
            let from = u32::try_from(e.from).ok()?;
            let to = u32::try_from(e.to).ok()?;
            let path: Option<Vec<u32>> = e.path.iter()
                .map(|&nid| u32::try_from(nid).ok())
                .collect();
            Some(NavEdgeDto { from, to, path: path? })
        })
        .collect();

    let scc = maze.analysis.scc(&maze.graph);
    let components: Vec<Vec<u32>> = scc.components.iter()
        .map(|comp| comp.iter().filter_map(|&id| u32::try_from(id).ok()).collect())
        .collect();

    let snapshot = MazeSnapshot {
        nodes,
        edges,
        start: meta_start,
        finish: meta_finish,
        warnings,
        nav_nodes,
        nav_edges,
        components,
    };
    serde_wasm_bindgen::to_value(&snapshot).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn run_generate_steps<F: Field>(
    seed: u64,
    field: F,
    start: <F::T as Tessellation>::Point,
    config: &GenerateConfig,
    point_to_xy: impl Fn(<F::T as Tessellation>::Point) -> (i32, i32),
) -> Result<JsValue, JsValue> {
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    let nodes: Vec<NodeDto> = graph.nodes()
        .filter_map(|n| {
            let id = u32::try_from(n.id).ok()?;
            field.point_of(n.id).map(|p| {
                let (x, y) = point_to_xy(p);
                NodeDto { id, x, y }
            })
        })
        .collect();

    let start_id = field
        .node_at(start)
        .ok_or_else(|| JsValue::from_str("start node not found"))?;

    let gen_config = build_generation_config(config);
    let raw_steps = generate_maze_steps(&mut graph, &field, seed, start_id, gen_config);

    let steps: Vec<GenerationStepDto> = raw_steps.into_iter().map(|s| {
        let edges = s.edges.into_iter().filter_map(|e| {
            Some(EdgeDto {
                from: u32::try_from(e.from).ok()?,
                to:   u32::try_from(e.to).ok()?,
            })
        }).collect();
        GenerationStepDto { edges }
    }).collect();

    let snapshot = GenerationStepsSnapshot { nodes, steps };
    serde_wasm_bindgen::to_value(&snapshot).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn generate(seed: u64, config: JsValue) -> Result<JsValue, JsValue> {
    let config: GenerateConfig = if config.is_null() || config.is_undefined() {
        GenerateConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?
    };

    let mut ids = IdGenerator::new();

    match &config.tessellation {
        TessellationConfig::Square { width, height } => {
            if *width == 0 || *height == 0 {
                return Err(JsValue::from_str("width and height must be > 0"));
            }
            let field: SquareField = ShapedField::new(
                SquareRect { width: *width as usize, height: *height as usize },
                &mut ids,
            );
            run_generate(seed, field, SquarePoint { x: 0, y: 0 }, &config,
                |p: SquarePoint| (p.x, p.y))
        }
        TessellationConfig::HexParallelogram { cols, rows, .. } => {
            if *cols == 0 || *rows == 0 {
                return Err(JsValue::from_str("cols and rows must be > 0"));
            }
            let field: HexField<HexParallelogram> = ShapedField::new(
                HexParallelogram { cols: *cols as usize, rows: *rows as usize },
                &mut ids,
            );
            run_generate(seed, field, HexPoint { q: 0, r: 0 }, &config,
                |p: HexPoint| (p.q, p.r))
        }
        TessellationConfig::HexHexagon { radius, .. } => {
            if *radius == 0 {
                return Err(JsValue::from_str("radius must be > 0"));
            }
            let field: HexField<HexHexagon> = ShapedField::new(
                HexHexagon { radius: *radius as usize },
                &mut ids,
            );
            run_generate(seed, field, HexPoint { q: 0, r: 0 }, &config,
                |p: HexPoint| (p.q, p.r))
        }
        TessellationConfig::TriangleRect { cols, rows, .. } => {
            if *cols == 0 || *rows == 0 {
                return Err(JsValue::from_str("cols and rows must be > 0"));
            }
            let field: TriField<TriRect> = ShapedField::new(
                TriRect { cols: *cols as usize, rows: *rows as usize },
                &mut ids,
            );
            run_generate(seed, field, TriPoint { col: 0, row: 0 }, &config,
                |p: TriPoint| (p.col, p.row))
        }
        TessellationConfig::TriangleTriangle { side, .. } => {
            if *side == 0 {
                return Err(JsValue::from_str("side must be > 0"));
            }
            // Apex is at (N-1, 0) with the centered equilateral layout.
            let n = *side as i32;
            let field: TriField<TriTriangle> = ShapedField::new(
                TriTriangle { side: *side as usize },
                &mut ids,
            );
            run_generate(seed, field, TriPoint { col: n - 1, row: 0 }, &config,
                |p: TriPoint| (p.col, p.row))
        }
        TessellationConfig::TriangleHexagon { radius, .. } => {
            if *radius == 0 {
                return Err(JsValue::from_str("radius must be > 0"));
            }
            // Start at first (pointing-down) triangle in top row: col = odd_base = indent(0).
            let r = *radius as i32;
            let odd_base = if r % 2 == 0 { r - 1 } else { r };
            let field: TriField<TriHexagon> = ShapedField::new(
                TriHexagon { radius: *radius as usize },
                &mut ids,
            );
            run_generate(seed, field, TriPoint { col: odd_base, row: 0 }, &config,
                |p: TriPoint| (p.col, p.row))
        }
    }
}

#[wasm_bindgen]
pub fn generate_steps(seed: u64, config: JsValue) -> Result<JsValue, JsValue> {
    let config: GenerateConfig = if config.is_null() || config.is_undefined() {
        GenerateConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?
    };

    let mut ids = IdGenerator::new();

    match &config.tessellation {
        TessellationConfig::Square { width, height } => {
            if *width == 0 || *height == 0 {
                return Err(JsValue::from_str("width and height must be > 0"));
            }
            let field: SquareField = ShapedField::new(
                SquareRect { width: *width as usize, height: *height as usize },
                &mut ids,
            );
            run_generate_steps(seed, field, SquarePoint { x: 0, y: 0 }, &config,
                |p: SquarePoint| (p.x, p.y))
        }
        TessellationConfig::HexParallelogram { cols, rows, .. } => {
            if *cols == 0 || *rows == 0 {
                return Err(JsValue::from_str("cols and rows must be > 0"));
            }
            let field: HexField<HexParallelogram> = ShapedField::new(
                HexParallelogram { cols: *cols as usize, rows: *rows as usize },
                &mut ids,
            );
            run_generate_steps(seed, field, HexPoint { q: 0, r: 0 }, &config,
                |p: HexPoint| (p.q, p.r))
        }
        TessellationConfig::HexHexagon { radius, .. } => {
            if *radius == 0 {
                return Err(JsValue::from_str("radius must be > 0"));
            }
            let field: HexField<HexHexagon> = ShapedField::new(
                HexHexagon { radius: *radius as usize },
                &mut ids,
            );
            run_generate_steps(seed, field, HexPoint { q: 0, r: 0 }, &config,
                |p: HexPoint| (p.q, p.r))
        }
        TessellationConfig::TriangleRect { cols, rows, .. } => {
            if *cols == 0 || *rows == 0 {
                return Err(JsValue::from_str("cols and rows must be > 0"));
            }
            let field: TriField<TriRect> = ShapedField::new(
                TriRect { cols: *cols as usize, rows: *rows as usize },
                &mut ids,
            );
            run_generate_steps(seed, field, TriPoint { col: 0, row: 0 }, &config,
                |p: TriPoint| (p.col, p.row))
        }
        TessellationConfig::TriangleTriangle { side, .. } => {
            if *side == 0 {
                return Err(JsValue::from_str("side must be > 0"));
            }
            let n = *side as i32;
            let field: TriField<TriTriangle> = ShapedField::new(
                TriTriangle { side: *side as usize },
                &mut ids,
            );
            run_generate_steps(seed, field, TriPoint { col: n - 1, row: 0 }, &config,
                |p: TriPoint| (p.col, p.row))
        }
        TessellationConfig::TriangleHexagon { radius, .. } => {
            if *radius == 0 {
                return Err(JsValue::from_str("radius must be > 0"));
            }
            let r = *radius as i32;
            let odd_base = if r % 2 == 0 { r - 1 } else { r };
            let field: TriField<TriHexagon> = ShapedField::new(
                TriHexagon { radius: *radius as usize },
                &mut ids,
            );
            run_generate_steps(seed, field, TriPoint { col: odd_base, row: 0 }, &config,
                |p: TriPoint| (p.col, p.row))
        }
    }
}

