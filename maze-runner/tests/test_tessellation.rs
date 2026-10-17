//! End-to-end runs of the finite dev tessellation (GitHub issue #765) through the full pipeline.
#![cfg(feature = "test-tessellation")]

use maze_runner::run_fixture;

/// Every cell of the test layout becomes a node, the maze is spanned (every cell reachable
/// through the face graph, including both triangles behind E's split side and the arc pair), and
/// QC/repair leave no issue.
#[test]
fn full_pipeline_spans_every_cell_of_the_test_layout() {
    for seed in 0..20 {
        let result = run_fixture("tests/fixtures/test-tessellation.json", seed);
        assert_eq!(result.graph.node_count(), 9, "seed {seed}");
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

/// A cell id outside the layout is rejected instead of becoming a phantom cell.
#[test]
fn config_wire_form_round_trips() {
    use maze_runner::config::{TessellationConfig, TessellationKind};
    let cfg: TessellationConfig =
        serde_json::from_str(r#"{ "kind": "test", "params": {} }"#).unwrap();
    assert_eq!(cfg.kind, TessellationKind::Test);
    let back: TessellationConfig =
        serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
    assert_eq!(back, cfg);
}

#[test]
fn invalid_cell_id_is_rejected() {
    let json = std::fs::read_to_string("tests/fixtures/test-tessellation.json")
        .unwrap()
        .replace("[8,0]", "[9,0]");
    let config = serde_json::from_str(&json).unwrap();
    assert!(maze_runner::run_from_config(0, &config).is_err());
}

/// A spanning tree over 9 cells: 8 undirected passages = 16 directed edges, at least.
#[test]
fn pipeline_connects_all_cells() {
    for seed in 0..20 {
        let result = run_fixture("tests/fixtures/test-tessellation.json", seed);
        assert!(result.graph.edges().count() >= 16, "seed {seed}");
    }
}

/// Pattern-mode splits apply to templated cells (squares, triangles, the five-face square) while
/// the template-less cell is never split.
#[test]
fn split_patterns_apply_to_templated_cells() {
    let mut max_nodes = 0;
    for seed in 0..20 {
        let result = run_fixture("tests/fixtures/test-tessellation-split.json", seed);
        max_nodes = max_nodes.max(result.graph.node_count());
    }
    assert!(max_nodes > 9, "no cell was ever split");
}

/// Geometry snapshot over the whole layout: the wire carries the arc, the shape keys, the missing
/// template and the split side's two faces, identically from both sides of the arc.
#[test]
fn geometry_snapshot_describes_the_layout() {
    use maze_runner::runner::geometry::{
        BoundaryDto, BoundaryRequest, GeometrySnapshotRequest, PathCommandDto, SegmentDto,
        geometry_snapshot,
    };
    let request = GeometrySnapshotRequest {
        tessellation: serde_json::from_str(r#"{ "kind": "test", "params": {} }"#).unwrap(),
        cells: (0..9).map(|id| [id, 0]).collect(),
        boundary: BoundaryRequest::Path,
        field_version: 1,
    };
    let snapshot = geometry_snapshot(&request).unwrap();
    let shapes: Vec<Option<&str>> = snapshot.cells.iter().map(|c| c.shape.as_deref()).collect();
    assert_eq!(shapes[2], Some("regular:4"));
    assert_eq!(shapes[3], Some("test:split_square"));
    assert_eq!(shapes[4], None);
    assert_eq!(snapshot.cells[3].faces.len(), 5);
    assert_eq!(snapshot.cells[3].faces[1].neighbor, Some([8, 0]));
    assert_eq!(snapshot.cells[3].faces[2].neighbor, Some([7, 0]));
    let arc_of = |cell: usize, face: usize| match &snapshot.cells[cell].faces[face].segments[0] {
        SegmentDto::Arc {
            from, to, sweep, ..
        } => (*from, *to, *sweep),
        other => panic!("expected an arc, got {other:?}"),
    };
    let (g_from, g_to, g_sweep) = arc_of(5, 0);
    let (h_from, h_to, h_sweep) = arc_of(6, 2);
    assert_eq!((g_from, g_to, g_sweep), (h_to, h_from, -h_sweep));
    assert_eq!(
        snapshot.cells[5].faces[0].contact_point,
        snapshot.cells[6].faces[2].contact_point
    );
    let BoundaryDto::Path { commands } = &snapshot.cells[5].boundary else {
        panic!("expected a path boundary");
    };
    assert!(
        commands
            .iter()
            .any(|c| matches!(c, PathCommandDto::ArcTo { .. }))
    );
}

/// Hit-testing through the wire from both sides of the arc and on it.
#[test]
fn cell_at_resolves_both_sides_of_the_arc() {
    use maze_runner::runner::geometry::{CellAtRequest, cell_at};
    let at = |x: f64, y: f64| {
        cell_at(&CellAtRequest {
            tessellation: serde_json::from_str(r#"{ "kind": "test", "params": {} }"#).unwrap(),
            point: [x, y],
            scope: None,
        })
        .unwrap()
    };
    assert_eq!(at(3.05, 0.5), Some([5, 0]));
    assert_eq!(at(3.2, 0.5), Some([6, 0]));
    assert_eq!(at(2.0 + 1.25_f64.sqrt(), 0.5), Some([5, 0]));
    assert_eq!(at(9.0, 9.0), None);
}
