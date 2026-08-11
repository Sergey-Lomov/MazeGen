use std::collections::HashMap;
use maze_core::{IdGenerator, Graph};
use maze_core::space::{MultiLevelField, SquarePoint, square_rect};
use maze_core::generation::{generate_maze, GenerationConfig, PresetState, pipeline::{build_maze, RepairLimits}};
use maze_core::validation::is_connected;
use maze_core::io::render_ascii;
use maze_core::quality_control::{QualityControlEngine, Rule, RuleTrait, Stage, MissingEndpointsCheck, UnreachableFinishCheck};
use maze_core::repair::FarthestEndpointsStrategy;

fn main() {
    let seed = 3u64;
    let mut ids = IdGenerator::new();
    let mut field = MultiLevelField::single_level(square_rect(10, 10), &mut ids).unwrap();
    let level = field.single_level_id();
    let start = field.nodes_at(level, SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    generate_maze(&mut graph, &mut field, &mut ids, seed, start, GenerationConfig::default(), &PresetState::empty());
    assert!(is_connected(&graph, start));

    let missing_endpoints_rule = Rule::new(
        "g".to_string(),
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g:missing_endpoints".to_string() }))],
        Some(Box::new(FarthestEndpointsStrategy)),
        HashMap::new(),
        vec![],
    );
    let unreachable_finish_rule = Rule::new(
        "u".to_string(),
        vec![("unreachable_finish".to_string(), Box::new(UnreachableFinishCheck { instance_id: "u:unreachable_finish".to_string() }))],
        None,
        HashMap::new(),
        vec![],
    );
    let qc_engine = QualityControlEngine::new(vec![
        Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![
            Box::new(missing_endpoints_rule) as Box<dyn RuleTrait<_>>,
            Box::new(unreachable_finish_rule) as Box<dyn RuleTrait<_>>,
        ]),
    ]);

    let (maze, warnings, _timing) = build_maze(field, graph, seed, qc_engine, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    if !warnings.is_empty() {
        eprintln!("warnings: {:?}", warnings.iter().map(|i| i.kind()).collect::<Vec<_>>());
    }

    println!("{}", render_ascii(&maze));
    println!("start:  {:?}", maze.meta.start);
    println!("finish: {:?}", maze.meta.finish);
}
