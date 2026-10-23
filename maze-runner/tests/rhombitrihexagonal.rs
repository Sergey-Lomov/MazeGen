//! End-to-end runs of the 3.4.6.4 tessellation through the full pipeline (GitHub issue #795).

use maze_runner::run_fixture;

const FIXTURE: &str = "tests/fixtures/rhombitrihexagonal.json";
const NODES: usize = 43;

/// The fixture is a 3x3-pitch rectangle of hexagons, squares and triangles: a spanning tree
/// reachable through the face graph, and no issue left after QC/repair.
#[test]
fn full_pipeline_spans_the_hexagon_rectangle() {
    for seed in 0..20 {
        let result = run_fixture(FIXTURE, seed);
        assert_eq!(result.graph.node_count(), NODES, "seed {seed}");
        assert!(
            result.graph.edges().count() >= 2 * (NODES - 1),
            "seed {seed}"
        );
        let kinds: Vec<&str> = result
            .remaining_issues
            .iter()
            .map(|i| i.kind().as_str())
            .collect();
        assert!(kinds.is_empty(), "seed {seed}: {kinds:?}");
        assert!(
            result.start.is_some() && result.finish.is_some(),
            "seed {seed}"
        );
    }
}

#[test]
fn config_wire_form_round_trips() {
    use maze_runner::config::{TessellationConfig, TessellationKind};
    let cfg: TessellationConfig =
        serde_json::from_str(r#"{ "kind": "rhombitrihexagonal", "params": {} }"#).unwrap();
    assert_eq!(cfg.kind, TessellationKind::Rhombitrihexagonal);
    let back: TessellationConfig =
        serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
    assert_eq!(back, cfg);
}
