mod dto;

use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use maze_core::{
    ids::IdGenerator,
    graph::{Graph, nav::build_nav_graph},
    space::{SquareField, SquarePoint, SquareSize},
    generation::{generate_maze, pipeline::build_maze},
    quality_control::{QualityControlEngine, MissingStartCheck, MissingFinishCheck, UnreachableFinishCheck, MISSING_START, MISSING_FINISH},
    repair::{RepairEngine, RepairStrategy, CreateStartStrategy, CreateFinishStrategy},
    Field,
};
use dto::{EdgeDto, MazeSnapshot, NavEdgeDto, NavNodeDto, NodeDto};

#[wasm_bindgen]
pub fn generate(seed: u64, width: u32, height: u32) -> Result<JsValue, JsValue> {
    if width == 0 || height == 0 {
        return Err(JsValue::from_str("width and height must be > 0"));
    }

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

    let qc_engine = QualityControlEngine::new(vec![
        Box::new(MissingStartCheck),
        Box::new(MissingFinishCheck),
        Box::new(UnreachableFinishCheck),
    ]);
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareField>>> = HashMap::new();
    strategies.insert(MISSING_START, Box::new(CreateStartStrategy));
    strategies.insert(MISSING_FINISH, Box::new(CreateFinishStrategy));
    let repair_engine = RepairEngine::new(strategies);

    let (maze, issues) = build_maze(field, graph, seed, qc_engine, repair_engine);
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

    let nav = build_nav_graph(&maze.graph);

    let nav_nodes: Vec<NavNodeDto> = nav.nodes.iter()
        .filter_map(|n| {
            let id = u32::try_from(n.id).ok()?;
            let node_id = u32::try_from(n.node_id).ok()?;
            Some(NavNodeDto { id, node_id })
        })
        .collect();

    let nav_edges: Vec<NavEdgeDto> = nav.edges.iter()
        .filter_map(|e| {
            let from = u32::try_from(e.from).ok()?;
            let to = u32::try_from(e.to).ok()?;
            let path: Option<Vec<u32>> = e.path.iter()
                .map(|&nid| u32::try_from(nid).ok())
                .collect();
            Some(NavEdgeDto { from, to, path: path? })
        })
        .collect();

    let snapshot = MazeSnapshot { nodes, edges, start: meta_start, finish: meta_finish, warnings, nav_nodes, nav_edges };
    serde_wasm_bindgen::to_value(&snapshot).map_err(|e| JsValue::from_str(&e.to_string()))
}
