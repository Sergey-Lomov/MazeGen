mod dto;

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use maze_core::{
    ids::IdGenerator,
    graph::Graph,
    space::{SquareField, SquarePoint, SquareSize},
    generation::{generate_maze, pipeline::build_maze},
    quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MISSING_ENDPOINTS, UNREACHABLE_FINISH},
    repair::{RepairEngine, RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy},
    Field,
};
use dto::{EdgeDto, MazeSnapshot, NavEdgeDto, NavNodeDto, NodeDto};

#[derive(Deserialize)]
struct GenerateConfig {
    checks: Vec<String>,
    strategies: HashMap<String, String>,
}

impl Default for GenerateConfig {
    fn default() -> Self {
        Self {
            checks: vec![
                MISSING_ENDPOINTS.to_string(),
                UNREACHABLE_FINISH.to_string(),
            ],
            strategies: {
                let mut m = HashMap::new();
                m.insert(MISSING_ENDPOINTS.to_string(), "farthest_endpoints".to_string());
                m
            },
        }
    }
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
    let strategies = vec![
        StrategyDescriptor { id: "random_endpoints", handles: MISSING_ENDPOINTS },
        StrategyDescriptor { id: "farthest_endpoints", handles: MISSING_ENDPOINTS },
    ];
    serde_wasm_bindgen::to_value(&strategies).unwrap()
}

#[wasm_bindgen]
pub fn generate(seed: u64, width: u32, height: u32, config: JsValue) -> Result<JsValue, JsValue> {
    if width == 0 || height == 0 {
        return Err(JsValue::from_str("width and height must be > 0"));
    }

    let config: GenerateConfig = if config.is_null() || config.is_undefined() {
        GenerateConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?
    };

    let mut ids = IdGenerator::new();
    let size = SquareSize {
        width: width as usize,
        height: height as usize,
    };
    let field = SquareField::new(size, &mut ids);

    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    let start = field
        .node_at(SquarePoint { x: 0, y: 0 })
        .ok_or_else(|| JsValue::from_str("start node not found"))?;

    generate_maze(&mut graph, &field, seed, start);

    let mut checks: Vec<Box<dyn maze_core::quality_control::Check<SquareField>>> = Vec::new();
    for id in &config.checks {
        match id.as_str() {
            MISSING_ENDPOINTS => checks.push(Box::new(MissingEndpointsCheck)),
            UNREACHABLE_FINISH => checks.push(Box::new(UnreachableFinishCheck)),
            other => return Err(JsValue::from_str(&format!("unknown check: {other}"))),
        }
    }
    let qc_engine = QualityControlEngine::new(checks);

    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareField>>> = HashMap::new();
    for (issue_kind, strategy_id) in &config.strategies {
        let strategy: Box<dyn RepairStrategy<SquareField>> = match strategy_id.as_str() {
            "random_endpoints" => Box::new(RandomEndpointsStrategy),
            "farthest_endpoints" => Box::new(FarthestEndpointsStrategy),
            other => return Err(JsValue::from_str(&format!("unknown strategy: {other}"))),
        };
        let kind: &'static str = match issue_kind.as_str() {
            MISSING_ENDPOINTS => MISSING_ENDPOINTS,
            UNREACHABLE_FINISH => UNREACHABLE_FINISH,
            other => return Err(JsValue::from_str(&format!("unknown issue kind: {other}"))),
        };
        strategies.insert(kind, strategy);
    }
    let repair_engine = RepairEngine::new(strategies);

    let (mut maze, issues) = build_maze(field, graph, seed, qc_engine, repair_engine);
    let warnings: Vec<String> = issues.iter().map(|i| i.kind.to_string()).collect();

    let nodes: Vec<NodeDto> = maze.graph
        .nodes()
        .filter_map(|n| {
            let id = u32::try_from(n.id).ok()?;
            maze.field.point_of(n.id).map(|p| NodeDto { id, x: p.x, y: p.y })
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

    let snapshot = MazeSnapshot { nodes, edges, start: meta_start, finish: meta_finish, warnings, nav_nodes, nav_edges, components };
    serde_wasm_bindgen::to_value(&snapshot).map_err(|e| JsValue::from_str(&e.to_string()))
}
