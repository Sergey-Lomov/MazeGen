use rand::SeedableRng;
use rand::rngs::SmallRng;
use maze_core::{Graph, IdGenerator};
use maze_core::graph::EdgeKind;
use maze_core::rules::{MazeMeta, Rule, RuleEngine, AssignStartRule, AssignFinishRule, NoOpRule};

fn make_graph(n: usize) -> (Graph, Vec<u64>) {
    let mut ids = IdGenerator::new();
    let node_ids: Vec<u64> = (0..n).map(|_| ids.next_id()).collect();
    let mut graph = Graph::new();
    for &id in &node_ids {
        graph.add_node(id);
    }
    (graph, node_ids)
}

fn make_rng() -> SmallRng {
    SmallRng::seed_from_u64(42)
}

#[test]
fn assign_start_sets_start() {
    let (mut graph, node_ids) = make_graph(3);
    let mut meta = MazeMeta::empty();
    let mut rng = make_rng();
    AssignStartRule.apply(&mut graph, &mut meta, &mut rng);
    assert!(meta.start.is_some());
    assert!(node_ids.contains(&meta.start.unwrap()));
}

#[test]
fn assign_start_no_override() {
    let (mut graph, node_ids) = make_graph(3);
    let mut meta = MazeMeta::empty();
    meta.start = Some(node_ids[1]);
    let mut rng = make_rng();
    AssignStartRule.apply(&mut graph, &mut meta, &mut rng);
    assert_eq!(meta.start, Some(node_ids[1]));
}

#[test]
fn assign_start_empty_graph() {
    let mut graph = Graph::new();
    let mut meta = MazeMeta::empty();
    let mut rng = make_rng();
    AssignStartRule.apply(&mut graph, &mut meta, &mut rng);
    assert!(meta.start.is_none());
}

#[test]
fn assign_finish_sets_finish_not_equal_start() {
    let (mut graph, node_ids) = make_graph(3);
    graph.add_bidirectional_edge(node_ids[0], node_ids[1], EdgeKind::Basic);
    graph.add_bidirectional_edge(node_ids[1], node_ids[2], EdgeKind::Basic);
    let mut meta = MazeMeta::empty();
    meta.start = Some(node_ids[0]);
    let mut rng = make_rng();
    AssignFinishRule.apply(&mut graph, &mut meta, &mut rng);
    assert!(meta.finish.is_some());
    assert_ne!(meta.finish, meta.start);
}

#[test]
fn assign_finish_no_override() {
    let (mut graph, node_ids) = make_graph(3);
    let mut meta = MazeMeta::empty();
    meta.start = Some(node_ids[0]);
    meta.finish = Some(node_ids[2]);
    let mut rng = make_rng();
    AssignFinishRule.apply(&mut graph, &mut meta, &mut rng);
    assert_eq!(meta.finish, Some(node_ids[2]));
}

#[test]
fn assign_finish_single_node_stays_none() {
    let (mut graph, node_ids) = make_graph(1);
    let mut meta = MazeMeta::empty();
    meta.start = Some(node_ids[0]);
    let mut rng = make_rng();
    AssignFinishRule.apply(&mut graph, &mut meta, &mut rng);
    assert!(meta.finish.is_none());
}

#[test]
fn noop_rule_no_mutation() {
    let (mut graph, node_ids) = make_graph(2);
    let mut meta = MazeMeta::empty();
    meta.start = Some(node_ids[0]);
    let node_count_before = graph.node_count();
    let mut rng = make_rng();
    NoOpRule.apply(&mut graph, &mut meta, &mut rng);
    assert_eq!(graph.node_count(), node_count_before);
    assert_eq!(meta.start, Some(node_ids[0]));
    assert!(meta.finish.is_none());
}

#[test]
fn rules_deterministic() {
    let make_connected = || {
        let (mut g, ids) = make_graph(5);
        for i in 0..4 {
            g.add_bidirectional_edge(ids[i], ids[i + 1], EdgeKind::Basic);
        }
        g
    };

    let mut g1 = make_connected();
    let mut m1 = MazeMeta::empty();
    let mut rng1 = SmallRng::seed_from_u64(99);
    AssignStartRule.apply(&mut g1, &mut m1, &mut rng1);
    AssignFinishRule.apply(&mut g1, &mut m1, &mut rng1);

    let mut g2 = make_connected();
    let mut m2 = MazeMeta::empty();
    let mut rng2 = SmallRng::seed_from_u64(99);
    AssignStartRule.apply(&mut g2, &mut m2, &mut rng2);
    AssignFinishRule.apply(&mut g2, &mut m2, &mut rng2);

    assert_eq!(m1.start, m2.start);
    assert_eq!(m1.finish, m2.finish);
    assert!(m1.finish.is_some());
}

#[test]
fn rule_engine_runs_in_order() {
    let (mut graph, node_ids) = make_graph(5);
    for i in 0..4 {
        graph.add_bidirectional_edge(node_ids[i], node_ids[i + 1], EdgeKind::Basic);
    }
    let mut meta = MazeMeta::empty();
    let mut rng = make_rng();

    let engine = RuleEngine::new(vec![
        Box::new(AssignStartRule),
        Box::new(AssignFinishRule),
    ]);
    engine.run(&mut graph, &mut meta, &mut rng);

    assert!(meta.start.is_some());
    assert!(meta.finish.is_some());
    assert_ne!(meta.start, meta.finish);
}

#[test]
fn rule_engine_order_matters() {
    // AssignFinish before AssignStart: start is None when finish runs,
    // so finish picks from all nodes. Then start picks from all nodes too.
    // They may collide. Contrast with correct order where finish avoids start.
    let (mut graph, node_ids) = make_graph(2);
    graph.add_bidirectional_edge(node_ids[0], node_ids[1], EdgeKind::Basic);

    let mut meta_reversed = MazeMeta::empty();
    let mut rng = make_rng();
    let engine_reversed = RuleEngine::new(vec![
        Box::new(AssignFinishRule), // runs first, start is None → picks from all
        Box::new(AssignStartRule),
    ]);
    engine_reversed.run(&mut graph, &mut meta_reversed, &mut rng);

    // With correct order, start != finish is guaranteed for 2-node graph
    let (mut graph2, node_ids2) = make_graph(2);
    graph2.add_bidirectional_edge(node_ids2[0], node_ids2[1], EdgeKind::Basic);
    let mut meta_correct = MazeMeta::empty();
    let mut rng2 = make_rng();
    let engine_correct = RuleEngine::new(vec![
        Box::new(AssignStartRule),
        Box::new(AssignFinishRule),
    ]);
    engine_correct.run(&mut graph2, &mut meta_correct, &mut rng2);

    assert_ne!(meta_correct.start, meta_correct.finish);
}
