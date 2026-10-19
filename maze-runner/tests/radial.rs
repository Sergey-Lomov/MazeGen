//! End-to-end runs of the radial tessellation through the full pipeline (GitHub issue #804).
//! Generation parameters come from the fixture, which is a center plus rings 1-4 of a
//! smooth `first_ring_cells = 9` tessellation (rings of 9, 12, 18 and 27 cells).

use maze_runner::run_fixture;

const FIXTURE: &str = "tests/fixtures/radial.json";
const NODES: usize = 1 + 9 + 12 + 18 + 27;

/// A spanning tree reachable through the face graph, and no issue left after QC/repair.
#[test]
fn full_pipeline_spans_the_rings() {
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
    let json =
        r#"{ "kind": "radial", "params": { "first_ring_cells": 9, "ring_layout": "smooth", "max_cells": 3000 } }"#;
    let cfg: TessellationConfig = serde_json::from_str(json).unwrap();
    assert_eq!(cfg.kind, TessellationKind::Radial);
    assert_eq!(cfg.params["first_ring_cells"], 9);
    assert_eq!(cfg.params["ring_layout"], "smooth");
    let back: TessellationConfig =
        serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
    assert_eq!(back, cfg);
}
