use super::*;

fn square(x: i32, y: i32) -> SquarePoint {
    SquarePoint { x, y }
}

fn hex(q: i32, r: i32) -> HexPoint {
    HexPoint { q, r }
}

fn preset_keys<T: Tessellation>(tessellation: &T) -> Vec<&'static str> {
    tessellation.presets().iter().map(|p| p.key).collect()
}

/// Sample parameters for every param of `descriptor`, all set to `value`.
fn params_of(descriptor: &PresetDescriptor, value: u32) -> Vec<(&'static str, u32)> {
    descriptor.params.iter().map(|p| (p.name, value)).collect()
}

fn check_presets_build_valid_connected_sorted_cells<T: Tessellation>(tessellation: &T) {
    for descriptor in tessellation.presets() {
        for size in [1, 2, 3, 5] {
            let params = params_of(descriptor, size);
            let cells = match tessellation.build_preset(descriptor.key, &params) {
                Ok(cells) => cells,
                // A shape too small to hold any cell center is refused, never returned empty.
                Err(FieldOpError::InvalidPreset(reason)) if reason.contains("no cells") => continue,
                Err(e) => panic!("{} {params:?}: {e}", descriptor.key),
            };
            assert!(!cells.is_empty(), "{} {params:?} is empty", descriptor.key);
            assert!(cells.iter().all(|&c| tessellation.is_valid_cell(c)));
            assert!(
                cells.windows(2).all(|w| w[0] < w[1]),
                "{} {params:?} is not sorted without duplicates",
                descriptor.key
            );
            assert!(
                is_connected(tessellation, &cells),
                "{} {params:?} is disconnected",
                descriptor.key
            );
        }
    }
}

#[test]
fn every_builtin_preset_builds_valid_connected_sorted_cells() {
    check_presets_build_valid_connected_sorted_cells(&SquareTessellation);
    check_presets_build_valid_connected_sorted_cells(&HexTessellation);
    check_presets_build_valid_connected_sorted_cells(&TriTessellation);
    check_presets_build_valid_connected_sorted_cells(&CairoTessellation);
    check_presets_build_valid_connected_sorted_cells(&SquareOctagonTessellation);
}

#[test]
fn presets_per_kind_match_the_spec_table() {
    assert_eq!(
        preset_keys(&SquareTessellation),
        ["rect", "circle", "triangle"]
    );
    assert_eq!(
        preset_keys(&HexTessellation),
        ["rect", "parallelogram", "hexagon", "circle", "triangle"]
    );
    assert_eq!(
        preset_keys(&TriTessellation),
        ["rect", "triangle", "hexagon", "circle"]
    );
    assert_eq!(
        preset_keys(&CairoTessellation),
        ["rect", "circle", "triangle", "hexagon"]
    );
    assert_eq!(
        preset_keys(&SquareOctagonTessellation),
        ["rect", "circle", "triangle"]
    );
}

#[test]
fn preset_sizes_match_the_closed_forms() {
    let rect = SquareTessellation
        .build_preset("rect", &[("cols", 4), ("rows", 3)])
        .unwrap();
    assert_eq!(rect.len(), 12);
    assert!(rect.contains(&square(0, 0)));

    let hexagon = HexTessellation
        .build_preset("hexagon", &[("radius", 3)])
        .unwrap();
    assert_eq!(hexagon.len(), 37);
    assert!(hexagon.contains(&hex(0, 0)));

    let hex_rect = HexTessellation
        .build_preset("rect", &[("cols", 5), ("rows", 4)])
        .unwrap();
    assert_eq!(hex_rect.len(), 20);

    let tri_rect = TriTessellation
        .build_preset("rect", &[("cols", 3), ("rows", 2)])
        .unwrap();
    assert_eq!(tri_rect.len(), 12);

    let cairo_rect = CairoTessellation
        .build_preset("rect", &[("cols", 3), ("rows", 2)])
        .unwrap();
    assert_eq!(cairo_rect.len(), 12);
}

#[test]
fn hex_rect_has_screen_aligned_sides() {
    let cells = HexTessellation
        .build_preset("rect", &[("cols", 6), ("rows", 5)])
        .unwrap();
    let ys: Vec<f64> = cells.iter().map(|&c| HexTessellation.center(c).y).collect();
    let (min, max) = ys
        .iter()
        .fold((f64::MAX, f64::MIN), |(lo, hi), &y| (lo.min(y), hi.max(y)));
    // Five rows, with odd columns shifted by half a row: the span is 4.5 rows, not a slanted 7+.
    let row_height = HexTessellation
        .center(hex(0, 0))
        .distance(HexTessellation.center(hex(0, 1)));
    assert!(
        (max - min - 4.5 * row_height).abs() < 1e-9,
        "span {}",
        max - min
    );
}

#[test]
fn circle_preset_is_centered_and_symmetric() {
    let cells = SquareTessellation
        .build_preset("circle", &[("radius", 3)])
        .unwrap();
    assert!(cells.contains(&square(0, 0)));
    for &SquarePoint { x, y } in &cells {
        assert!(cells.contains(&square(-x, -y)), "({x}, {y}) has no mirror");
    }
}

#[test]
fn unknown_preset_and_bad_params_are_rejected() {
    assert_eq!(
        SquareTessellation.build_preset("parallelogram", &[("cols", 1), ("rows", 1)]),
        Err(FieldOpError::Unavailable)
    );
    assert!(matches!(
        SquareTessellation.build_preset("rect", &[("cols", 3)]),
        Err(FieldOpError::InvalidPreset(_))
    ));
    assert!(matches!(
        SquareTessellation.build_preset("rect", &[("cols", 0), ("rows", 3)]),
        Err(FieldOpError::InvalidPreset(_))
    ));
    assert!(matches!(
        SquareTessellation.build_preset("rect", &[("cols", 3), ("rows", 3), ("depth", 1)]),
        Err(FieldOpError::InvalidPreset(_))
    ));
    // The size cap applies to the parameter product, so two individually valid values can exceed it.
    assert!(matches!(
        SquareTessellation.build_preset("rect", &[("cols", u32::MAX), ("rows", u32::MAX)]),
        Err(FieldOpError::InvalidPreset(_))
    ));
}

#[test]
fn translate_moves_cells_by_a_lattice_vector() {
    let cells = [square(0, 0), square(1, 0)];
    assert_eq!(
        SquareTessellation.translate_cells(&cells, Point::new(2.0, 1.0)),
        Ok(vec![square(2, 1), square(3, 1)])
    );
    let hex_cells = [hex(0, 0), hex(1, 0)];
    let vector = HexTessellation.center(hex(2, -1)) - HexTessellation.center(hex(0, 0));
    assert_eq!(
        HexTessellation.translate_cells(&hex_cells, vector),
        Ok(vec![hex(2, -1), hex(3, -1)])
    );
}

#[test]
fn translate_by_a_period_works_on_every_tessellation() {
    let tri = [TriPoint { col: 0, row: 0 }, TriPoint { col: 1, row: 0 }];
    let vector = TriTessellation.center(TriPoint { col: 2, row: 0 })
        - TriTessellation.center(TriPoint { col: 0, row: 0 });
    assert_eq!(
        TriTessellation.translate_cells(&tri, vector),
        Ok(vec![
            TriPoint { col: 2, row: 0 },
            TriPoint { col: 3, row: 0 }
        ])
    );

    let from = CairoPoint::new(2, 1);
    let cairo = [from];
    let vector = CairoTessellation.center(CairoPoint::new(6, 5)) - CairoTessellation.center(from);
    assert_eq!(
        CairoTessellation.translate_cells(&cairo, vector),
        Ok(vec![CairoPoint::new(6, 5)])
    );
}

#[test]
fn translate_by_a_non_symmetry_is_refused() {
    assert_eq!(
        SquareTessellation.translate_cells(&[square(0, 0)], Point::new(0.5, 0.0)),
        Err(FieldOpError::NotASymmetry)
    );
    assert_eq!(
        CairoTessellation.translate_cells(&[CairoPoint::new(2, 1)], Point::new(0.3, 0.0)),
        Err(FieldOpError::NotASymmetry)
    );
}

#[test]
fn translate_keeps_disconnected_cells_and_refuses_invalid_ones() {
    assert_eq!(
        SquareTessellation.translate_cells(&[square(0, 0), square(5, 0)], Point::new(1.0, 0.0)),
        Ok(vec![square(1, 0), square(6, 0)])
    );
    assert_eq!(
        CairoTessellation.translate_cells(&[CairoPoint::new(0, 0)], Point::new(0.0, 0.0)),
        Err(FieldOpError::OutsideTessellation)
    );
}

#[test]
fn reflect_mirrors_cells_across_a_symmetry_axis() {
    // Vertical axis x = 2 (the boundary between columns 1 and 2).
    let axis = (Point::new(2.0, 0.0), Point::new(2.0, 1.0));
    assert_eq!(
        SquareTessellation.reflect_cells(&[square(0, 0), square(1, 0)], axis),
        Ok(vec![square(2, 0), square(3, 0)])
    );
    // The diagonal y = x.
    let diagonal = (Point::new(0.0, 0.0), Point::new(1.0, 1.0));
    assert_eq!(
        SquareTessellation.reflect_cells(&[square(0, 0), square(1, 0)], diagonal),
        Ok(vec![square(0, 0), square(0, 1)])
    );
    // A horizontal axis through hex origin center.
    let horizontal = (Point::new(0.0, 0.0), Point::new(1.0, 0.0));
    let mirrored = HexTessellation
        .reflect_cells(&[hex(0, 0), hex(1, 0)], horizontal)
        .unwrap();
    assert_eq!(mirrored.len(), 2);
    assert!(mirrored.contains(&hex(0, 0)));
}

#[test]
fn reflect_across_a_non_symmetry_is_refused() {
    let skew = (Point::new(0.0, 0.0), Point::new(3.0, 1.0));
    assert_eq!(
        SquareTessellation.reflect_cells(&[square(0, 0)], skew),
        Err(FieldOpError::NotASymmetry)
    );
    let degenerate = (Point::new(1.0, 1.0), Point::new(1.0, 1.0));
    assert_eq!(
        SquareTessellation.reflect_cells(&[square(0, 0)], degenerate),
        Err(FieldOpError::NotASymmetry)
    );
}

#[test]
fn empty_input_maps_to_empty_output() {
    assert_eq!(
        SquareTessellation.translate_cells(&[], Point::new(1.0, 0.0)),
        Ok(vec![])
    );
}

#[test]
fn a_tessellation_can_withhold_operations() {
    struct NoOps;
    impl Tessellation for NoOps {
        type CellId = SquarePoint;
        type Face = SquareFace;
        fn is_valid_cell(&self, c: SquarePoint) -> bool {
            SquareTessellation.is_valid_cell(c)
        }
        fn faces_of(&self, c: SquarePoint) -> &[SquareFace] {
            SquareTessellation.faces_of(c)
        }
        fn neighbor(&self, c: SquarePoint, f: SquareFace) -> Option<(SquarePoint, SquareFace)> {
            SquareTessellation.neighbor(c, f)
        }
        fn is_straight(&self, c: SquarePoint, a: SquareFace, b: SquareFace) -> bool {
            SquareTessellation.is_straight(c, a, b)
        }
        fn shape_descriptors(&self) -> &[ShapeDescriptor] {
            SquareTessellation.shape_descriptors()
        }
        fn shape_of(&self, c: SquarePoint) -> Option<CellShape<'_>> {
            SquareTessellation.shape_of(c)
        }
        fn center(&self, c: SquarePoint) -> Point {
            SquareTessellation.center(c)
        }
        fn face_segments(&self, c: SquarePoint, f: SquareFace) -> Vec<Segment> {
            SquareTessellation.face_segments(c, f)
        }
        fn candidate_cells(
            &self,
            min: Point,
            max: Point,
            limit: usize,
        ) -> Option<Vec<SquarePoint>> {
            SquareTessellation.candidate_cells(min, max, limit)
        }
        fn field_operations(&self) -> &[FieldOperation] {
            &[FieldOperation::Reflect]
        }
    }
    assert_eq!(
        NoOps.translate_cells(&[square(0, 0)], Point::new(1.0, 0.0)),
        Err(FieldOpError::Unavailable)
    );
    assert_eq!(
        NoOps.build_preset("rect", &[]),
        Err(FieldOpError::Unavailable)
    );
}
