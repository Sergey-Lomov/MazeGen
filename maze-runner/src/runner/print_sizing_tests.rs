use super::*;
use crate::config::TessellationKind;
use crate::runner::field_ops::{PresetExtentsRequest, PresetRequest, preset_extents};

const SHEET: (f64, f64) = (45.0, 55.0);

fn config(kind: TessellationKind) -> TessellationConfig {
    TessellationConfig {
        kind,
        params: serde_json::Map::new(),
    }
}

fn params(entries: &[(&str, u32)]) -> ShapeParams {
    entries.iter().map(|&(n, v)| (n.to_string(), v)).collect()
}

fn request(
    kind: TessellationKind,
    preset: &str,
    shape: &[(&str, u32)],
    cell_side_mm: f64,
) -> PrintSizingRequest {
    PrintSizingRequest {
        tessellation: config(kind),
        preset: preset.to_string(),
        params: params(shape),
        directions: [[1.0, 0.0], [0.0, 1.0]],
        cell_side: 1.0,
        usable_width_mm: SHEET.0,
        usable_height_mm: SHEET.1,
        cell_side_mm,
        axis_aligned: false,
    }
}

/// Extent of a shape in cell sides, `None` for a shape core refuses.
fn measure(
    kind: TessellationKind,
    preset: &str,
    shape: &[(&str, u32)],
    request: &PrintSizingRequest,
) -> Option<Bounds> {
    let extents = preset_extents(&PresetExtentsRequest {
        preset: PresetRequest {
            tessellation: config(kind),
            preset: preset.to_string(),
            params: params(shape),
        },
        directions: request.directions,
    })
    .ok()?;
    Some(Bounds {
        width: (extents[0][1] - extents[0][0]) / request.cell_side,
        height: (extents[1][1] - extents[1][0]) / request.cell_side,
    })
}

fn fits_sheet(bounds: Bounds, request: &PrintSizingRequest) -> Option<f64> {
    let (w, h) = (
        bounds.width * request.cell_side_mm,
        bounds.height * request.cell_side_mm,
    );
    (w <= request.usable_width_mm + 1e-9 && h <= request.usable_height_mm + 1e-9)
        .then(|| w / request.usable_width_mm + h / request.usable_height_mm)
}

fn kinds_with_rect() -> impl Iterator<Item = TessellationKind> {
    TessellationKind::ALL
        .into_iter()
        .filter(|kind| !matches!(kind, TessellationKind::Radial | TessellationKind::Voronoi))
}

#[test]
fn rect_search_matches_a_full_scan_on_every_lattice() {
    for kind in kinds_with_rect() {
        for cell_side_mm in [4.0, 6.0] {
            let request = request(kind, "rect", &[("cols", 2), ("rows", 2)], cell_side_mm);
            let result = print_sizing(&request).unwrap().unwrap_or_else(|| {
                panic!("{kind:?} at {cell_side_mm} mm: nothing fits");
            });

            // Reference: every cols x rows pair, the most cells then the fullest sheet.
            let fit_of = |cols: u32, rows: u32| {
                let shape = [("cols", cols), ("rows", rows)];
                match measure(kind, "rect", &shape, &request) {
                    // Core refuses a block below the lattice's minimum.
                    None => Err(true),
                    Some(bounds) => fits_sheet(bounds, &request).ok_or(false),
                }
            };
            let (mut count, mut fill) = (0u32, f64::NEG_INFINITY);
            for cols in 1..=60u32 {
                let mut any_fits = false;
                for rows in 1..=60u32 {
                    match fit_of(cols, rows) {
                        Err(true) => continue,
                        Err(false) => break,
                        Ok(f) => {
                            any_fits = true;
                            if cols * rows > count || (cols * rows == count && f > fill) {
                                (count, fill) = (cols * rows, f);
                            }
                        }
                    }
                }
                if !any_fits && cols > 4 {
                    break;
                }
            }

            let (cols, rows) = (get(&result.params, "cols"), get(&result.params, "rows"));
            assert_eq!(cols * rows, count, "{kind:?} at {cell_side_mm} mm");
            let chosen = fit_of(cols, rows).unwrap();
            assert!((chosen - fill).abs() < 1e-9, "{kind:?} at {cell_side_mm} mm");
        }
    }
}

#[test]
fn radial_search_finds_the_largest_fitting_radius() {
    for kind in kinds_with_rect() {
        for (preset, name) in [("circle", "radius"), ("triangle", "side")] {
            let request = request(kind, preset, &[(name, 1)], 5.0);
            let shape_at = |size: u32| measure(kind, preset, &[(name, size)], &request);
            // Core refuses sizes below a shape's minimum; those are skipped, the first size that
            // does not fit ends the walk.
            let largest = (1..=60u32)
                .filter(|&size| shape_at(size).is_some())
                .take_while(|&size| shape_at(size).is_some_and(|b| fits_sheet(b, &request).is_some()))
                .last();
            let result = print_sizing(&request).unwrap();
            assert_eq!(
                result.map(|r| get(&r.params, name)),
                largest,
                "{kind:?} {preset}"
            );
        }
    }
}

#[test]
fn a_cylinder_and_a_torus_close_up_and_stay_on_the_sheet() {
    for kind in kinds_with_rect() {
        for preset in ["cylinder", "torus"] {
            let shape: &[(&str, u32)] = if preset == "cylinder" {
                &[("cols", 2), ("rows", 2), ("axis", 0)]
            } else {
                &[("cols", 2), ("rows", 2)]
            };
            let request = request(kind, preset, shape, 5.0);
            let Some(result) = print_sizing(&request).unwrap() else {
                continue;
            };
            let list: Vec<(&str, u32)> = result.params.iter().map(|(n, &v)| (n.as_str(), v)).collect();
            let measured = measure(kind, preset, &list, &request).unwrap();
            assert!(fits_sheet(measured, &request).is_some(), "{kind:?} {preset}");
            assert!((measured.width - result.width).abs() < 1e-9);
        }
    }
}

#[test]
fn an_axis_aligned_rect_is_sized_by_division() {
    let mut request = request(TessellationKind::Square, "rect", &[("cols", 1), ("rows", 1)], 5.0);
    request.axis_aligned = true;
    let result = print_sizing(&request).unwrap().unwrap();
    assert_eq!((get(&result.params, "cols"), get(&result.params, "rows")), (9, 11));
}

#[test]
fn a_result_on_the_search_cap_reports_it() {
    let tiny = request(TessellationKind::Hex, "rect", &[("cols", 1), ("rows", 1)], 0.01);
    let capped = print_sizing(&tiny).unwrap().unwrap();
    assert_eq!(capped.limit, Some(MAX_RECT_DIMENSION));

    let normal = request(TessellationKind::Hex, "rect", &[("cols", 1), ("rows", 1)], 5.0);
    assert_eq!(print_sizing(&normal).unwrap().unwrap().limit, None);

    // An axis-aligned rectangle is sized by division and has no cap.
    let mut divided = request(TessellationKind::Square, "rect", &[("cols", 1), ("rows", 1)], 0.01);
    divided.axis_aligned = true;
    assert_eq!(print_sizing(&divided).unwrap().unwrap().limit, None);
}

#[test]
fn nothing_fits_a_cell_larger_than_the_sheet() {
    let request = request(TessellationKind::Hex, "rect", &[("cols", 1), ("rows", 1)], 300.0);
    assert_eq!(print_sizing(&request).unwrap(), None);
}

#[test]
fn largest_fitting_finds_the_limit_from_any_hint() {
    for (limit, hint, min) in [
        (37u32, 1.0, 1u32),
        (37, 37.0, 1),
        (37, 500.0, 1),
        (1, 900.0, 1),
        (0, 5.0, 1),
        (1000, 1.0, 1),
        (5000, 10.0, 1),
        (4, 1.0, 3),
        (2, 9.0, 3),
    ] {
        let expected = if limit < min { 0 } else { limit.min(1000) };
        assert_eq!(
            largest_fitting(|value| value <= limit, hint, min, 1000),
            expected,
            "limit {limit} hint {hint} min {min}"
        );
    }
}

#[test]
fn a_radial_search_starts_from_the_smallest_size_core_accepts() {
    // A trihexagonal triangle is refused below side 3, yet a sheet fits much more than that.
    let request = request(TessellationKind::Trihexagonal, "triangle", &[("side", 1)], 10.0);
    let sized = print_sizing(&request).unwrap().expect("a triangle fits the sheet");
    let side = get(&sized.params, "side");
    assert!(side >= 3);
    let fits = |side: u32| {
        measure(TessellationKind::Trihexagonal, "triangle", &[("side", side)], &request)
            .is_some_and(|bounds| fits_sheet(bounds, &request).is_some())
    };
    assert!(fits(side));
    assert!(!fits(side + 1));
}

/// Compares the extents measured with the focus against those of the shape built in full.
struct FocusAgainstFull {
    kind: TessellationKind,
}

impl crate::runner::tessellation_factory::TessellationVisitor for FocusAgainstFull {
    type Output = usize;

    fn visit<T: maze_core::space::Tessellation>(
        self,
        tessellation: std::sync::Arc<T>,
        _codec: crate::runner::tessellation_factory::CellCodec<T>,
    ) -> usize {
        use crate::runner::field_ops::measure_extents_with;
        let directions = [
            [[1.0, 0.0], [0.0, 1.0]],
            [[0.5, 0.866_025_403_784_438_6], [-0.866_025_403_784_438_6, 0.5]],
            [[1.0, 0.3], [0.2, 1.0]],
            [[0.0, -1.0], [1.0, 0.0]],
        ];
        let shapes: Vec<(&str, Vec<(&str, u32)>)> = [1u32, 2, 3, 4, 6, 9, 14, 22, 35]
            .into_iter()
            .flat_map(|size| {
                [
                    ("circle", vec![("radius", size)]),
                    ("triangle", vec![("side", size)]),
                    ("hexagon", vec![("radius", size)]),
                    ("rect", vec![("cols", size), ("rows", size / 2 + 1)]),
                    ("rect", vec![("cols", size / 2 + 1), ("rows", size)]),
                ]
            })
            .collect();
        let mut compared = 0;
        for (key, params) in &shapes {
            for directions in directions {
                let full = measure_extents_with(&*tessellation, key, params, directions, false);
                let focused = measure_extents_with(&*tessellation, key, params, directions, true);
                match (&full, &focused) {
                    (Ok(a), Ok(b)) => {
                        for (a, b) in a.iter().flatten().zip(b.iter().flatten()) {
                            assert!(
                                (a - b).abs() < 1e-9,
                                "{:?} {key} {params:?} {directions:?}: {full:?} against {focused:?}",
                                self.kind
                            );
                        }
                    }
                    (Err(a), Err(b)) => assert_eq!(a, b, "{:?} {key} {params:?}", self.kind),
                    _ => panic!(
                        "{:?} {key} {params:?} {directions:?}: {full:?} against {focused:?}",
                        self.kind
                    ),
                }
                compared += 1;
            }
        }
        compared
    }
}

#[test]
fn extents_measured_with_the_focus_match_the_whole_shape() {
    for kind in kinds_with_rect() {
        let compared = crate::runner::tessellation_factory::build_tessellation(
            &config(kind),
            FocusAgainstFull { kind },
        )
        .unwrap();
        assert!(compared > 0);
    }
}

#[test]
fn a_found_size_is_one_core_can_build() {
    // GitHub issue #939: a size too large to be built must not be found, whatever the cell size.
    for kind in kinds_with_rect() {
        for (preset, shape) in [("rect", vec![("cols", 4), ("rows", 4)]), ("circle", vec![("radius", 1)]), ("triangle", vec![("side", 1)])] {
            let mut request = request(kind, preset, &shape, 3.0);
            request.usable_width_mm = 1100.0;
            request.usable_height_mm = 800.0;
            let Some(sized) = print_sizing(&request).unwrap() else { continue };
            let built = crate::runner::field_ops::build_preset(&PresetRequest {
                tessellation: config(kind),
                preset: preset.to_string(),
                params: sized.params.clone(),
            });
            assert!(built.is_ok(), "{kind:?} {preset} {:?}: {built:?}", sized.params);
        }
    }
}

#[test]
fn a_box_is_scaled_keeping_its_proportions_and_every_side_at_least_one() {
    let sides = params(&[("width", 4), ("height", 2), ("depth", 1)]);
    let scaled = scaled_box(&sides, 8);
    assert_eq!(
        (get(&scaled, "width"), get(&scaled, "height"), get(&scaled, "depth")),
        (8, 4, 2)
    );
    let thin = scaled_box(&sides, 1);
    assert_eq!(
        (get(&thin, "width"), get(&thin, "height"), get(&thin, "depth")),
        (1, 1, 1)
    );
    // A box with no sides yet still gets one cell per side to grow from.
    assert_eq!(get(&scaled_box(&ShapeParams::new(), 3), "width"), 1);
}

#[test]
fn the_limit_estimate_survives_a_flat_or_degenerate_size() {
    assert_eq!(estimate_limit(2.0, 6.0, 12.0), 5.0);
    // No growth (or shrinking) gives no estimate; the search verifies from the minimum.
    assert_eq!(estimate_limit(5.0, 5.0, 100.0), 0.0);
    assert_eq!(estimate_limit(5.0, 3.0, 100.0), 0.0);
    assert_eq!(estimate_limit(f64::NAN, 3.0, 100.0), 0.0);
}

#[test]
fn snapping_looks_only_at_sizes_at_or_below_within_the_range() {
    assert_eq!(around_size(20).collect::<Vec<_>>(), (4..=20).rev().collect::<Vec<_>>());
    assert_eq!(around_size(3).collect::<Vec<_>>(), vec![3, 2, 1]);
    assert_eq!(around_size(0).count(), 0);
    assert_eq!(around_size(MAX_RECT_DIMENSION + 10).next(), Some(MAX_RECT_DIMENSION));
}
