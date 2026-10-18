//! End-to-end runs of the 4.8.8 tessellation through the full pipeline (GitHub issue #784).

use maze_runner::run_fixture;

const FIXTURE: &str = "tests/fixtures/square-octagon.json";

/// The fixture is a 4x3 octagon rectangle with the 6 squares between them: 18 nodes, a spanning
/// tree reachable through the face graph, and no issue left after QC/repair.
#[test]
fn full_pipeline_spans_the_octagon_rectangle() {
    for seed in 0..20 {
        let result = run_fixture(FIXTURE, seed);
        assert_eq!(result.graph.node_count(), 18, "seed {seed}");
        assert!(result.graph.edges().count() >= 34, "seed {seed}");
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
        serde_json::from_str(r#"{ "kind": "square_octagon", "params": {} }"#).unwrap();
    assert_eq!(cfg.kind, TessellationKind::SquareOctagon);
    let back: TessellationConfig =
        serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
    assert_eq!(back, cfg);
}

/// A mixed-parity point is not a tile and is rejected instead of becoming a phantom cell.
#[test]
fn non_tile_cell_is_rejected() {
    let json = std::fs::read_to_string(FIXTURE)
        .unwrap()
        .replace("[1,1]", "[1,0]");
    let config = serde_json::from_str(&json).unwrap();
    assert!(maze_runner::run_from_config(0, &config).is_err());
}
