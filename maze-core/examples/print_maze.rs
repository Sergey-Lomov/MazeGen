use std::collections::HashMap;
use maze_core::{IdGenerator, Graph};
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{generate_maze, GenerationConfig, PresetState, pipeline::build_maze};
use maze_core::validation::is_connected;
use maze_core::io::render_ascii;
use maze_core::quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MISSING_ENDPOINTS};
use maze_core::repair::{QcRule, CheckId, RepairEngine, RepairRuleConfig, FarthestEndpointsStrategy};

fn main() {
    let seed = 3u64;
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(10, 10), &mut ids).unwrap();
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    generate_maze(&mut graph, &field, seed, start, GenerationConfig::default(), &PresetState::empty());
    assert!(is_connected(&graph, start));

    let qc_engine = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck),
        Box::new(UnreachableFinishCheck),
    ]);
    let rule = QcRule { id: "g".to_string(), kind: MISSING_ENDPOINTS, checks: vec![CheckId::MissingEndpoints] };
    let repair_engine = RepairEngine::new(
        vec![RepairRuleConfig {
            rule: QcRule { id: "g".to_string(), kind: MISSING_ENDPOINTS, checks: vec![CheckId::MissingEndpoints] },
            strategy: Box::new(FarthestEndpointsStrategy),
            param_overrides: HashMap::new(),
        }],
        vec![rule],
    );

    let (maze, warnings) = build_maze(field, graph, seed, qc_engine, repair_engine, &PresetState::empty());
    if !warnings.is_empty() {
        eprintln!("warnings: {:?}", warnings.iter().map(|i| i.kind).collect::<Vec<_>>());
    }

    println!("{}", render_ascii(&maze));
    println!("start:  {:?}", maze.meta.start);
    println!("finish: {:?}", maze.meta.finish);
}
