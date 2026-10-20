//! End-to-end runs of the jittered Voronoi tessellation through the full pipeline (GitHub issue
//! #817). Generation parameters come from the fixture, which is the 37 cells within lattice
//! distance 3 of the origin of a `jitter = 0.15`, `seed = 7` tessellation.

use maze_runner::run_fixture;

const FIXTURE: &str = "tests/fixtures/voronoi.json";
const NODES: usize = 37;

/// A spanning tree reachable through the face graph, and no issue left after QC/repair.
#[test]
fn full_pipeline_spans_the_cells() {
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
        r#"{ "kind": "voronoi", "params": { "jitter": 0.15, "seed": 7, "max_cells": 3000 } }"#;
    let cfg: TessellationConfig = serde_json::from_str(json).unwrap();
    assert_eq!(cfg.kind, TessellationKind::Voronoi);
    assert_eq!(cfg.params["jitter"], 0.15);
    assert_eq!(cfg.params["seed"], 7);
    let back: TessellationConfig =
        serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
    assert_eq!(back, cfg);
}
