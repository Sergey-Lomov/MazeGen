use std::collections::HashMap;
use maze_core::{IdGenerator, Graph};
use maze_core::space::{Field, SquarePoint, square_rect};
use maze_core::generation::{generate_maze, GenerationConfig, PresetState, pipeline::{build_maze, RepairLimits}};
use maze_core::validation::is_connected;
use maze_core::io::render_ascii;
use maze_core::quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MISSING_ENDPOINTS};
use maze_core::repair::{QcRule, RepairEngine, RepairRuleConfig, RepairStage, FarthestEndpointsStrategy};

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
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
        Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() }),
    ]);
    let rule = QcRule { id: "g".to_string(), kind: MISSING_ENDPOINTS, checks: vec!["missing_endpoints".to_string()] };
    let repair_engine = RepairEngine::new(
        vec![RepairRuleConfig {
            rule: QcRule { id: "g".to_string(), kind: MISSING_ENDPOINTS, checks: vec!["missing_endpoints".to_string()] },
            strategy: Box::new(FarthestEndpointsStrategy),
            param_overrides: HashMap::new(),
        }],
        vec![rule],
        vec![RepairStage { id: "stage_1".to_string(), name: "Stage 1".to_string(), rule_ids: vec!["g".to_string()] }],
    );

    let (maze, warnings, _timing) = build_maze(field, graph, seed, qc_engine, repair_engine, &PresetState::empty(), RepairLimits::default());
    if !warnings.is_empty() {
        eprintln!("warnings: {:?}", warnings.iter().map(|i| i.kind).collect::<Vec<_>>());
    }

    println!("{}", render_ascii(&maze));
    println!("start:  {:?}", maze.meta.start);
    println!("finish: {:?}", maze.meta.finish);
}
