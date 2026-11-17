//! End-to-end runs of folded floors through the full pipeline (GitHub issue #836). Each fixture
//! is a 6x5 square field whose `topology` key glues the left and right edges (cylinder), both
//! edge pairs (torus) or the left and right edges with a twist (Moebius strip). Generation
//! parameters come from the fixtures.

use maze_core::graph::Graph;
use maze_runner::config::GenerateConfig;
use maze_runner::run_fixture;
use maze_runner::topology_wire::TopologyDto;
use std::collections::{HashSet, VecDeque};

const NODES: usize = 6 * 5;

/// Nodes reachable from `start` along passages.
fn reachable(graph: &Graph, start: maze_core::ids::NodeId) -> usize {
    let mut seen = HashSet::from([start]);
    let mut queue = VecDeque::from([start]);
    while let Some(node) = queue.pop_front() {
        for next in graph.outgoing_neighbors(node) {
            if seen.insert(next) {
                queue.push_back(next);
            }
        }
    }
    seen.len()
}

fn assert_spans_folded_field(fixture: &str, min_edges: usize) {
    for seed in 0..10 {
        let result = run_fixture(fixture, seed);
        assert_eq!(result.graph.node_count(), NODES, "{fixture} seed {seed}");
        assert!(
            result.graph.edges().count() >= min_edges,
            "{fixture} seed {seed}"
        );
        let kinds: Vec<&str> = result
            .remaining_issues
            .iter()
            .map(|i| i.kind().as_str())
            .collect();
        assert!(kinds.is_empty(), "{fixture} seed {seed}: {kinds:?}");
        let start = result.start.expect("start");
        assert!(result.finish.is_some(), "{fixture} seed {seed}");
        assert_eq!(
            reachable(&result.graph, start),
            NODES,
            "{fixture} seed {seed}"
        );
    }
}

#[test]
fn cylinder_spans_the_field() {
    assert_spans_folded_field("tests/fixtures/topology-cylinder.json", 2 * (NODES - 1));
}

#[test]
fn torus_spans_the_field() {
    assert_spans_folded_field("tests/fixtures/topology-torus.json", 2 * (NODES - 1));
}

#[test]
fn mobius_spans_the_field() {
    assert_spans_folded_field("tests/fixtures/topology-mobius.json", 2 * (NODES - 1));
}

#[test]
fn fixture_topology_wire_form_round_trips() {
    for name in ["cylinder", "torus", "mobius"] {
        let json = std::fs::read_to_string(format!("tests/fixtures/topology-{name}.json")).unwrap();
        let config: GenerateConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config.topology.len(), 1, "{name}");
        let dto = config.topology[0].as_ref().unwrap();
        let back: TopologyDto = serde_json::from_str(&serde_json::to_string(dto).unwrap()).unwrap();
        assert_eq!(&back, dto, "{name}");
    }
}

#[test]
fn mismatched_fingerprint_is_rejected_with_a_clear_error() {
    let json = std::fs::read_to_string("tests/fixtures/topology-cylinder.json").unwrap();
    let mut config: GenerateConfig = serde_json::from_str(&json).unwrap();
    config.topology[0].as_mut().unwrap().fingerprint = "hex{}".to_string();
    let error = maze_runner::run_from_config(0, &config)
        .map(|_| ())
        .unwrap_err();
    assert!(
        error.contains("topology[0]") && error.contains("hex{}") && error.contains("square{}"),
        "{error}"
    );
}
