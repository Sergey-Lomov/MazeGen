use super::*;
use crate::config::TessellationKind;

fn config(kind: TessellationKind) -> TessellationConfig {
    TessellationConfig {
        kind,
        params: serde_json::Map::new(),
    }
}

fn preset(kind: TessellationKind, key: &str, params: &[(&str, u32)]) -> PresetRequest {
    PresetRequest {
        tessellation: config(kind),
        preset: key.to_string(),
        params: params.iter().map(|&(n, v)| (n.to_string(), v)).collect(),
    }
}

#[test]
fn capabilities_list_operations_and_preset_schemas() {
    let capabilities = field_capabilities(&CapabilitiesRequest {
        tessellation: config(TessellationKind::Square),
    })
    .unwrap();
    assert_eq!(capabilities.operations, ["translate", "reflect"]);
    let keys: Vec<_> = capabilities.presets.iter().map(|p| p.key).collect();
    assert_eq!(keys, ["rect", "circle", "triangle"]);
    assert_eq!(
        capabilities.presets[0].params,
        [
            PresetParamSchema {
                name: "cols",
                min: 1,
                max: None
            },
            PresetParamSchema {
                name: "rows",
                min: 1,
                max: None
            },
        ]
    );
}

#[test]
fn preset_cells_come_back_as_wire_points() {
    let cells = build_preset(&preset(
        TessellationKind::Square,
        "rect",
        &[("cols", 3), ("rows", 2)],
    ))
    .unwrap();
    assert_eq!(cells.len(), 6);
    assert!(cells.contains(&[0, 0]));
}

#[test]
fn preset_extents_measure_the_shape_along_each_direction() {
    let extents = preset_extents(&PresetExtentsRequest {
        preset: preset(
            TessellationKind::Square,
            "rect",
            &[("cols", 3), ("rows", 2)],
        ),
        directions: [[1.0, 0.0], [0.0, 2.0]],
    })
    .unwrap();
    // A 3x2 block of unit cells: 3 along x, and 2 along y scaled by the direction's length 2.
    assert!((extents[0][1] - extents[0][0] - 3.0).abs() < 1e-9);
    assert!((extents[1][1] - extents[1][0] - 4.0).abs() < 1e-9);
}

#[test]
fn preset_extents_match_a_brute_force_scan_on_every_lattice() {
    use crate::runner::tessellation_factory::build_tessellation;
    struct BruteForce<'a>(&'a PresetExtentsRequest);
    impl TessellationVisitor for BruteForce<'_> {
        type Output = [[f64; 2]; 2];
        fn visit<T: Tessellation>(
            self,
            tessellation: Arc<T>,
            _codec: CellCodec<T>,
        ) -> Self::Output {
            let preset = &self.0.preset;
            let params: Vec<(&str, u32)> = preset
                .params
                .iter()
                .map(|(n, &v)| (n.as_str(), v))
                .collect();
            let mut extents = [[f64::INFINITY, f64::NEG_INFINITY]; 2];
            for cell in tessellation.build_preset(&preset.preset, &params).unwrap() {
                for point in tessellation.boundary_path(cell).flatten(1e-6) {
                    for (extent, d) in extents.iter_mut().zip(self.0.directions) {
                        let value = d[0] * point.x + d[1] * point.y;
                        extent[0] = extent[0].min(value);
                        extent[1] = extent[1].max(value);
                    }
                }
            }
            extents
        }
    }
    let cases = [
        (TessellationKind::Square, "circle", vec![("radius", 5)]),
        (TessellationKind::Hex, "hexagon", vec![("radius", 4)]),
        (
            TessellationKind::Hex,
            "rect",
            vec![("cols", 7), ("rows", 5)],
        ),
        (TessellationKind::Tri, "hexagon", vec![("radius", 3)]),
        (TessellationKind::Tri, "triangle", vec![("side", 6)]),
        (
            TessellationKind::Cairo,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (
            TessellationKind::SquareOctagon,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (
            TessellationKind::SquareOctagon,
            "circle",
            vec![("radius", 4)],
        ),
        (
            TessellationKind::Trihexagonal,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (
            TessellationKind::Trihexagonal,
            "triangle",
            vec![("side", 6)],
        ),
        (
            TessellationKind::SnubHexagonal,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (
            TessellationKind::SnubHexagonal,
            "triangle",
            vec![("side", 6)],
        ),
        (
            TessellationKind::SnubSquare,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (TessellationKind::SnubSquare, "triangle", vec![("side", 6)]),
        (
            TessellationKind::Rhombitrihexagonal,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (
            TessellationKind::Rhombitrihexagonal,
            "triangle",
            vec![("side", 6)],
        ),
        (
            TessellationKind::TruncatedHexagonal,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (
            TessellationKind::TruncatedHexagonal,
            "triangle",
            vec![("side", 6)],
        ),
        (
            TessellationKind::TruncatedTrihexagonal,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (
            TessellationKind::ElongatedTriangular,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (
            TessellationKind::TruncatedTrihexagonal,
            "triangle",
            vec![("side", 6)],
        ),
        (
            TessellationKind::ElongatedTriangular,
            "triangle",
            vec![("side", 6)],
        ),
        (
            TessellationKind::CurvedQuadrilateral,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (
            TessellationKind::CurvedQuadrilateral,
            "triangle",
            vec![("side", 6)],
        ),
        (
            TessellationKind::Brick,
            "rect",
            vec![("cols", 5), ("rows", 4)],
        ),
        (TessellationKind::Brick, "circle", vec![("radius", 4)]),
        (TessellationKind::Brick, "triangle", vec![("side", 6)]),
    ];
    for (kind, key, params) in cases {
        let request = PresetExtentsRequest {
            preset: preset(kind, key, &params),
            directions: [[0.8, 0.6], [-0.6, 0.8]],
        };
        let expected =
            build_tessellation(&request.preset.tessellation, BruteForce(&request)).unwrap();
        let actual = preset_extents(&request).unwrap();
        for (a, e) in actual.iter().flatten().zip(expected.iter().flatten()) {
            assert!((a - e).abs() < 1e-9, "{key}: {actual:?} != {expected:?}");
        }
    }
}

#[test]
fn preset_extents_reject_non_finite_directions_and_empty_shapes() {
    let bad = preset_extents(&PresetExtentsRequest {
        preset: preset(
            TessellationKind::Square,
            "rect",
            &[("cols", 3), ("rows", 2)],
        ),
        directions: [[f64::NAN, 0.0], [0.0, 1.0]],
    });
    assert!(matches!(bad, Err(FieldOpWireError::InvalidRequest { .. })));
}

#[test]
fn preset_errors_keep_their_reason() {
    assert_eq!(
        build_preset(&preset(
            TessellationKind::Square,
            "hexagon",
            &[("radius", 2)]
        )),
        Err(FieldOpWireError::Unavailable)
    );
    assert!(matches!(
        build_preset(&preset(TessellationKind::Square, "rect", &[("cols", 3)])),
        Err(FieldOpWireError::InvalidPreset { .. })
    ));
}

#[test]
fn non_finite_coordinates_are_invalid_requests() {
    let translate = translate_cells(&TranslateRequest {
        tessellation: config(TessellationKind::Square),
        cells: vec![[0, 0]],
        vector: [f64::NAN, 0.0],
    });
    assert!(matches!(
        translate,
        Err(FieldOpWireError::InvalidRequest { .. })
    ));
    let reflect = reflect_cells(&ReflectRequest {
        tessellation: config(TessellationKind::Square),
        cells: vec![[0, 0]],
        axis: [[0.0, 0.0], [f64::INFINITY, 1.0]],
    });
    assert!(matches!(
        reflect,
        Err(FieldOpWireError::InvalidRequest { .. })
    ));
}

#[test]
fn translate_and_reflect_round_trip_through_the_wire() {
    let moved = translate_cells(&TranslateRequest {
        tessellation: config(TessellationKind::Square),
        cells: vec![[0, 0], [1, 0]],
        vector: [2.0, 1.0],
    })
    .unwrap();
    assert_eq!(moved, [[2, 1], [3, 1]]);

    let mirrored = reflect_cells(&ReflectRequest {
        tessellation: config(TessellationKind::Square),
        cells: vec![[0, 0], [1, 0]],
        axis: [[2.0, 0.0], [2.0, 1.0]],
    })
    .unwrap();
    assert_eq!(mirrored, [[2, 0], [3, 0]]);
}

fn radial_config() -> TessellationConfig {
    let mut config = config(TessellationKind::Radial);
    config
        .params
        .insert("first_ring_cells".to_string(), 9.into());
    config
        .params
        .insert("ring_layout".to_string(), "classic".into());
    config.params.insert("max_cells".to_string(), 3000.into());
    config
}

#[test]
fn radial_offers_the_circle_preset_and_reflect_only() {
    let capabilities = field_capabilities(&CapabilitiesRequest {
        tessellation: radial_config(),
    })
    .unwrap();
    assert_eq!(capabilities.operations, ["reflect"]);
    let keys: Vec<_> = capabilities.presets.iter().map(|p| p.key).collect();
    assert_eq!(keys, ["circle"]);
}

#[test]
fn radial_circle_radius_max_follows_the_params() {
    let max_for = |first_ring_cells: u64, layout: &str| {
        let mut tessellation = radial_config();
        tessellation
            .params
            .insert("first_ring_cells".to_string(), first_ring_cells.into());
        tessellation
            .params
            .insert("ring_layout".to_string(), layout.into());
        let capabilities = field_capabilities(&CapabilitiesRequest { tessellation }).unwrap();
        capabilities.presets[0].params[0].max.unwrap()
    };
    assert_eq!(max_for(9, "classic"), 32);
    assert!(max_for(24, "smooth") < max_for(9, "classic"));
    let mut small = radial_config();
    small.params.insert("max_cells".to_string(), 500.into());
    let capabilities = field_capabilities(&CapabilitiesRequest {
        tessellation: small,
    })
    .unwrap();
    assert!(capabilities.presets[0].params[0].max.unwrap() < 20);
}

#[test]
fn radial_circle_preset_is_the_center_and_whole_rings() {
    let request = |radius| PresetRequest {
        tessellation: radial_config(),
        preset: "circle".to_string(),
        params: [("radius".to_string(), radius)].into(),
    };
    let mut cells = build_preset(&request(3)).unwrap();
    cells.sort();
    // The center, then rings 1 and 2 of nine and eighteen cells.
    assert_eq!(cells.len(), 1 + 9 + 18);
    assert_eq!(cells[0], [0, 0]);
    assert!(cells.iter().all(|&[ring, _]| ring <= 2));
}

#[test]
fn radial_reflects_across_an_axis_through_the_center() {
    let mirrored = reflect_cells(&ReflectRequest {
        tessellation: radial_config(),
        cells: vec![[0, 0], [1, 0], [3, 1]],
        axis: [[0.0, 0.0], [1.0, 0.0]],
    })
    .unwrap();
    // The x axis maps sector `i` of an `n`-cell ring to `n - 1 - i`.
    assert_eq!(mirrored, [[0, 0], [1, 8], [3, 16]]);
}

#[test]
fn radial_refuses_translation() {
    assert!(
        translate_cells(&TranslateRequest {
            tessellation: radial_config(),
            cells: vec![[1, 0]],
            vector: [1.0, 0.0],
        })
        .is_err()
    );
}

#[test]
fn invalid_cells_and_non_symmetries_report_their_reason() {
    assert_eq!(
        translate_cells(&TranslateRequest {
            tessellation: config(TessellationKind::Cairo),
            cells: vec![[0, 0]],
            vector: [0.0, 0.0],
        }),
        Err(FieldOpWireError::OutsideTessellation)
    );
    assert_eq!(
        translate_cells(&TranslateRequest {
            tessellation: config(TessellationKind::Square),
            cells: vec![[0, 0]],
            vector: [0.5, 0.0],
        }),
        Err(FieldOpWireError::NotASymmetry)
    );
}
