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

/// The fixture plus a `cross_element_cell_type` rule over start/finish forbidding `forbidden`
/// (GitHub issue #824). The rule has no strategy: the violation must stay reported.
fn fixture_with_cell_type_rule(forbidden: &[&str]) -> maze_runner::config::GenerateConfig {
    let mut value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let mut params = serde_json::json!({
        "include_start": "true",
        "include_finish": "true",
    });
    for key in forbidden {
        params[format!("forbid_cell_type_{key}")] = "true".into();
    }
    // An explicit `false` forbids nothing.
    params["forbid_cell_type_dodecagon"] = "false".into();
    value["stages"][0]["rules"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": "rule_cell_type",
            "checks": [{
                "local_id": "0",
                "type_id": "cross_element_cell_type",
                "params": params,
            }],
            "strategy": null,
        }));
    serde_json::from_value(value).unwrap()
}

fn remaining_kinds(result: &maze_runner::MazeRunResult) -> Vec<&str> {
    result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect()
}

#[test]
fn forbidding_every_cell_type_flags_start_and_finish() {
    let config = fixture_with_cell_type_rule(&["octagon", "square"]);
    let result = maze_runner::run_from_config(0, &config).unwrap();
    assert_eq!(remaining_kinds(&result), vec!["invalid_cross_element"]);
}

#[test]
fn empty_forbidden_list_reports_nothing() {
    let config = fixture_with_cell_type_rule(&[]);
    let result = maze_runner::run_from_config(0, &config).unwrap();
    assert!(remaining_kinds(&result).is_empty());
}

#[test]
fn unknown_cell_type_key_is_a_config_error() {
    let config = fixture_with_cell_type_rule(&["hexagon"]);
    let Err(err) = maze_runner::run_from_config(0, &config) else {
        panic!("unknown cell type key must be rejected");
    };
    assert!(err.contains("unknown cell type `hexagon`"), "{err}");
}
