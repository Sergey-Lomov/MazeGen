mod dto;

use wasm_bindgen::prelude::*;
use maze_core::{
    ids::IdGenerator,
    graph::Graph,
    space::{SquareField, SquarePoint, SquareSize},
    generation::generate_maze,
    Field,
};
use dto::{EdgeDto, MazeSnapshot, NodeDto};

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

    let nodes: Vec<NodeDto> = graph
        .nodes()
        .filter_map(|n| {
            let id = u32::try_from(n.id).ok()?;
            field.point_of(n.id).map(|p| NodeDto { id, x: p.x, y: p.y })
        })
        .collect();

    let edges: Vec<EdgeDto> = graph
        .edges()
        .map(|e| -> Result<EdgeDto, JsValue> {
            Ok(EdgeDto {
                from: u32::try_from(e.from).map_err(|_| JsValue::from_str("edge endpoint overflow"))?,
                to: u32::try_from(e.to).map_err(|_| JsValue::from_str("edge endpoint overflow"))?,
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;

    let snapshot = MazeSnapshot { nodes, edges };
    serde_wasm_bindgen::to_value(&snapshot).map_err(|e| JsValue::from_str(&e.to_string()))
}
