use super::*;
use crate::config::TessellationKind;
use crate::runner::field_ops::{PresetRequest, build_preset};
use std::collections::BTreeMap;

fn config(kind: TessellationKind) -> TessellationConfig {
    TessellationConfig {
        kind,
        params: serde_json::Map::new(),
    }
}

fn rect_cells(kind: TessellationKind, cols: u32, rows: u32) -> Vec<[i32; 2]> {
    build_preset(&PresetRequest {
        tessellation: config(kind),
        preset: "rect".to_string(),
        params: BTreeMap::from([("cols".to_string(), cols), ("rows".to_string(), rows)]),
    })
    .unwrap()
}

fn sizes(kind: TessellationKind, cells: Vec<[i32; 2]>) -> Vec<CellTypeSizes> {
    cell_sizes(&CellSizesRequest {
        tessellation: config(kind),
        presets: vec![],
        cells,
    })
    .unwrap()
    .types
}

#[test]
fn square_cells_have_one_type_with_equal_sides() {
    let result = sizes(TessellationKind::Square, rect_cells(TessellationKind::Square, 3, 2));
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].count, 6);
    assert!(result[0].regular);
    assert_eq!(result[0].sides.len(), 1);
    assert!((result[0].sides[0] - 1.0).abs() < 1e-9);
    assert!((result[0].diameter - 2f64.sqrt()).abs() < 1e-9);
}

#[test]
fn counts_of_all_types_add_up_to_the_cells() {
    for kind in [
        TessellationKind::Trihexagonal,
        TessellationKind::SquareOctagon,
        TessellationKind::SnubSquare,
        TessellationKind::Cairo,
    ] {
        let cells = rect_cells(kind, 4, 4);
        let total = cells.len();
        let result = sizes(kind, cells);
        assert_eq!(result.iter().map(|t| t.count).sum::<usize>(), total, "{kind:?}");
        assert!(result.iter().all(|t| t.regular), "{kind:?}");
    }
}

#[test]
fn mixed_tessellation_reports_each_type_with_its_own_size() {
    let result = sizes(
        TessellationKind::Trihexagonal,
        rect_cells(TessellationKind::Trihexagonal, 4, 4),
    );
    assert_eq!(result.len(), 2);
    assert!(result[0].diameter != result[1].diameter);
}

#[test]
fn irregular_type_has_no_size() {
    let tessellation = TessellationConfig {
        kind: TessellationKind::Voronoi,
        params: serde_json::json!({ "jitter": 0.15, "seed": 3, "max_cells": 3000 })
            .as_object()
            .unwrap()
            .clone(),
    };
    let cells = (0..4).flat_map(|x| (0..4).map(move |y| [x, y])).collect();
    let result = cell_sizes(&CellSizesRequest { tessellation, presets: vec![], cells })
        .unwrap()
        .types;
    assert_eq!(result.len(), 1);
    assert!(!result[0].regular);
    assert!(result[0].sides.is_empty());
    assert_eq!(result[0].diameter, 0.0);
}

#[test]
fn cell_with_unequal_sides_lists_each_length_longest_first() {
    let result = sizes(TessellationKind::Brick, rect_cells(TessellationKind::Brick, 3, 3));
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].sides.len(), 2);
    assert!(result[0].sides[0] > result[0].sides[1]);
}

#[test]
fn radial_cells_are_irregular() {
    let tessellation = TessellationConfig {
        kind: TessellationKind::Radial,
        params: serde_json::json!({ "first_ring_cells": 9, "ring_layout": "classic", "max_cells": 3000 })
            .as_object()
            .unwrap()
            .clone(),
    };
    let cells = build_preset(&PresetRequest {
        tessellation: tessellation.clone(),
        preset: "circle".to_string(),
        params: BTreeMap::from([("radius".to_string(), 4)]),
    })
    .unwrap();
    let result = cell_sizes(&CellSizesRequest { tessellation, presets: vec![], cells })
        .unwrap()
        .types;
    assert!(result.iter().all(|t| !t.regular));
}

#[test]
fn point_outside_the_tessellation_is_refused() {
    let tessellation = TessellationConfig {
        kind: TessellationKind::Radial,
        params: serde_json::json!({ "first_ring_cells": 9, "ring_layout": "classic", "max_cells": 100 })
            .as_object()
            .unwrap()
            .clone(),
    };
    let result = cell_sizes(&CellSizesRequest {
        tessellation,
        presets: vec![],
        cells: vec![[0, 0], [500, 0]],
    });
    assert!(matches!(result, Err(FieldOpWireError::InvalidRequest { .. })));
}

#[test]
fn preset_sources_measure_the_same_as_their_cells() {
    let kind = TessellationKind::Trihexagonal;
    let by_cells = sizes(kind, rect_cells(kind, 4, 4));
    let by_preset = cell_sizes(&CellSizesRequest {
        tessellation: config(kind),
        presets: vec![PresetSource {
            preset: "rect".to_string(),
            params: BTreeMap::from([("cols".to_string(), 4), ("rows".to_string(), 4)]),
            times: 1,
        }],
        cells: vec![],
    })
    .unwrap();
    assert_eq!(by_preset.types, by_cells);
    assert_eq!(by_preset.preset_counts, vec![rect_cells(kind, 4, 4).len()]);
}

#[test]
fn presets_and_custom_cells_add_up() {
    let kind = TessellationKind::Square;
    let result = cell_sizes(&CellSizesRequest {
        tessellation: config(kind),
        presets: vec![PresetSource {
            preset: "rect".to_string(),
            params: BTreeMap::from([("cols".to_string(), 2), ("rows".to_string(), 2)]),
            times: 2,
        }],
        cells: vec![[0, 0]],
    })
    .unwrap();
    assert_eq!(result.types[0].count, 9);
    assert_eq!(result.preset_counts, vec![4]);
}

#[test]
fn refused_preset_is_an_empty_field() {
    let kind = TessellationKind::Square;
    let result = cell_sizes(&CellSizesRequest {
        tessellation: config(kind),
        presets: vec![PresetSource {
            preset: "rect".to_string(),
            params: BTreeMap::from([("cols".to_string(), 0), ("rows".to_string(), 0)]),
            times: 1,
        }],
        cells: vec![],
    })
    .unwrap();
    assert!(result.types.is_empty());
    assert_eq!(result.preset_counts, vec![0]);
}
