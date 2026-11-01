use crate::ids::IdGenerator;
use crate::space::{
    Field, FoldClass, FoldId, SquareFace, SquarePoint, SquareTessellation, Tessellation,
    TessellationFingerprint, Topology,
};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

fn fp() -> TessellationFingerprint {
    TessellationFingerprint::new("square{}")
}

/// Box sizes `(width, height, depth)`: a cube, boxes with every pair of sides different and thin
/// ones.
const BOXES: [(u32, u32, u32); 6] = [
    (1, 1, 1),
    (2, 2, 2),
    (3, 2, 4),
    (4, 1, 2),
    (1, 3, 1),
    (2, 5, 3),
];

/// Every combination of net shape (cross, T, compact) and mode (net, by faces). The compact
/// layout is always by faces, whatever the mode says.
const VARIANTS: [(u32, u32); 6] = [(0, 0), (0, 1), (1, 0), (1, 1), (2, 0), (2, 1)];

fn params(size: (u32, u32, u32), net: u32, mode: u32) -> Vec<(&'static str, u32)> {
    vec![
        ("width", size.0),
        ("height", size.1),
        ("depth", size.2),
        ("net", net),
        ("mode", mode),
        ("aspect", 100),
    ]
}

fn cells_of(size: (u32, u32, u32), net: u32, mode: u32) -> Vec<SquarePoint> {
    SquareTessellation
        .build_preset("box", &params(size, net, mode))
        .unwrap()
}

fn box_field(size: (u32, u32, u32), net: u32, mode: u32) -> Field<SquareTessellation> {
    let tessellation = SquareTessellation;
    let p = params(size, net, mode);
    let cells = tessellation.build_preset("box", &p).unwrap();
    let groups = tessellation.build_preset_folds("box", &p).unwrap();
    let mut field = Field::new(Arc::new(tessellation), cells, &mut IdGenerator::new()).unwrap();
    field
        .set_topology(Topology::from_groups(fp(), groups), &fp())
        .unwrap();
    field
}

fn area((w, h, d): (u32, u32, u32)) -> usize {
    2 * (w * h + h * d + w * d) as usize
}

/// Connected components of the cells under the ordinary tessellation adjacency (no folds).
fn components(cells: &[SquarePoint]) -> HashMap<SquarePoint, usize> {
    let tessellation = SquareTessellation;
    let all: HashSet<SquarePoint> = cells.iter().copied().collect();
    let mut id_of = HashMap::new();
    let mut count = 0;
    for &start in cells {
        if id_of.contains_key(&start) {
            continue;
        }
        id_of.insert(start, count);
        let mut stack = vec![start];
        while let Some(cell) = stack.pop() {
            for &face in tessellation.faces_of(cell) {
                let Some((next, _)) = tessellation.neighbor(cell, face) else {
                    continue;
                };
                if all.contains(&next) && !id_of.contains_key(&next) {
                    id_of.insert(next, count);
                    stack.push(next);
                }
            }
        }
        count += 1;
    }
    id_of
}

fn component_count(cells: &[SquarePoint]) -> usize {
    components(cells).values().collect::<HashSet<_>>().len()
}

#[test]
fn box_has_the_cells_of_its_six_faces_in_every_variant() {
    for size in BOXES {
        for (net, mode) in VARIANTS {
            let cells = cells_of(size, net, mode);
            assert_eq!(cells.len(), area(size), "{size:?} net {net} mode {mode}");
            assert!(cells.windows(2).all(|w| w[0] < w[1]));
        }
    }
}

#[test]
fn net_mode_is_one_piece_and_by_faces_mode_is_six_separate_rectangles() {
    for size in BOXES {
        for net in [0, 1] {
            assert_eq!(component_count(&cells_of(size, net, 0)), 1, "{size:?} net {net}");
            assert_eq!(component_count(&cells_of(size, net, 1)), 6, "{size:?} net {net}");
        }
        for mode in [0, 1] {
            assert_eq!(component_count(&cells_of(size, 2, mode)), 6, "{size:?} compact");
        }
    }
}

#[test]
fn a_net_glues_seven_edges_and_separate_faces_glue_all_twelve() {
    for size in BOXES {
        let folds = |net, mode| {
            SquareTessellation
                .build_preset_folds("box", &params(size, net, mode))
                .unwrap()
        };
        let edges_total = (4 * (size.0 + size.1 + size.2)) as usize;
        for (net, mode) in VARIANTS {
            let groups = folds(net, mode);
            let by_faces = mode == 1 || net == 2;
            assert_eq!(groups.len(), if by_faces { 12 } else { 7 }, "{size:?} net {net}");
            assert!(groups.iter().flatten().all(|fold| !fold.twist));
            let total: usize = groups.iter().map(Vec::len).sum();
            if by_faces {
                assert_eq!(total, edges_total, "{size:?} net {net} mode {mode}");
            } else {
                assert!(total < edges_total);
            }
        }
    }
}

/// Faces keep their sizes in every layout: the sides of a group's two runs have equal length and
/// every group pairs sides of the box's own edge lengths (`width`, `height` or `depth`).
#[test]
fn every_group_runs_along_one_edge_of_the_box() {
    for size in BOXES {
        let lengths: HashSet<usize> = [size.0, size.1, size.2].map(|v| v as usize).into();
        for (net, mode) in VARIANTS {
            let groups = SquareTessellation
                .build_preset_folds("box", &params(size, net, mode))
                .unwrap();
            assert!(groups.iter().all(|g| lengths.contains(&g.len())));
            if mode == 1 || net == 2 {
                for edge in [size.0, size.1, size.2] {
                    let count = groups.iter().filter(|g| g.len() == edge as usize).count();
                    assert!(count >= 4, "{size:?}: four edges of length {edge}");
                }
            }
        }
    }
}

#[test]
fn the_nets_differ() {
    let size = (2, 3, 4);
    let cross = cells_of(size, 0, 0);
    let t = cells_of(size, 1, 0);
    let compact = cells_of(size, 2, 1);
    assert_ne!(cross, t);
    assert_ne!(cross, compact);
    assert_ne!(t, compact);
}

/// The T lies on its side: it is wider than it is tall for a cube.
#[test]
fn the_t_lies_on_its_side() {
    let cells = cells_of((3, 3, 3), 1, 0);
    let span = |axis: fn(&SquarePoint) -> i32| {
        axis(cells.iter().max_by_key(|c| axis(c)).unwrap())
            - axis(cells.iter().min_by_key(|c| axis(c)).unwrap())
            + 1
    };
    assert_eq!((span(|c| c.x), span(|c| c.y)), (12, 9));
}

/// The compact layout keeps the faces far apart, so connectors drawn across the gaps fit, and is
/// no wider or taller than the plain two rows of three faces.
#[test]
fn compact_layout_keeps_faces_apart_and_fits_the_two_rows_square() {
    for size in BOXES {
        let cells = cells_of(size, 2, 0);
        let comp = components(&cells);
        for (i, a) in cells.iter().enumerate() {
            for b in &cells[i + 1..] {
                if comp[a] != comp[b] {
                    let apart = (a.x - b.x).abs().max((a.y - b.y).abs());
                    assert!(apart >= 5, "{size:?}: {a:?} and {b:?} are {apart} apart");
                }
            }
        }
        let span = |axis: fn(&SquarePoint) -> i32| {
            axis(cells.iter().max_by_key(|c| axis(c)).unwrap())
                - axis(cells.iter().min_by_key(|c| axis(c)).unwrap())
                + 1
        };
        let (w, h, d) = (size.0 as i32, size.1 as i32, size.2 as i32);
        let gap = 4;
        // Left, front, right above back, top, bottom.
        let rows_w = (2 * d + w + 2 * gap).max(3 * w + 2 * gap);
        let rows_h = h + gap + h.max(d);
        assert!(
            span(|c| c.x).max(span(|c| c.y)) <= rows_w.max(rows_h),
            "{size:?}: compact is larger than two rows"
        );
    }
}

/// Six equal faces pack into a 3 by 2 grid.
#[test]
fn compact_layout_of_a_cube_is_a_grid_of_three_by_two() {
    let cells = cells_of((3, 3, 3), 2, 1);
    let span = |axis: fn(&SquarePoint) -> i32| {
        axis(cells.iter().max_by_key(|c| axis(c)).unwrap())
            - axis(cells.iter().min_by_key(|c| axis(c)).unwrap())
            + 1
    };
    let (a, b) = (span(|c| c.x), span(|c| c.y));
    assert_eq!((a.max(b), a.min(b)), (17, 10));
}

#[test]
fn shape_presets_define_no_folds() {
    let folds = SquareTessellation
        .build_preset_folds("rect", &[("cols", 3), ("rows", 2)])
        .unwrap();
    assert!(folds.is_empty());
}

#[test]
fn box_rejects_oversized_and_unknown_parameters() {
    let tessellation = SquareTessellation;
    let cube = |side| params((side, side, side), 0, 0);
    assert!(tessellation.build_preset("box", &cube(0)).is_err());
    assert!(tessellation.build_preset("box", &cube(409)).is_err());
    assert!(tessellation.build_preset_folds("box", &cube(409)).is_err());
    assert!(tessellation.build_preset("box", &cube(408)).is_ok());
    assert!(
        tessellation
            .build_preset("box", &params((408, 1, 409), 0, 0))
            .is_err()
    );
    assert!(tessellation.build_preset("box", &params((2, 2, 2), 0, 2)).is_err());
    assert!(tessellation.build_preset("box", &params((2, 2, 2), 3, 0)).is_err());
    assert!(tessellation.build_preset("box", &[("width", 2)]).is_err());
    assert!(tessellation.build_preset("box", &[("size", 2)]).is_err());
    for side in ["width", "height", "depth"] {
        assert_eq!(tessellation.preset_param_max("box", side), Some(408));
    }
    assert_eq!(tessellation.preset_param_max("box", "mode"), Some(1));
    assert_eq!(tessellation.preset_param_max("box", "net"), Some(2));
    assert_eq!(tessellation.preset_param_max("box", "aspect"), Some(1000));
    let mut wide = params((2, 2, 2), 2, 1);
    wide.last_mut().unwrap().1 = 1001;
    assert!(tessellation.build_preset("box", &wide).is_err());
}

#[test]
fn every_fold_of_the_box_is_active_and_isometric() {
    for size in BOXES {
        for (net, mode) in VARIANTS {
            let field = box_field(size, net, mode);
            let topology = field.topology().unwrap();
            assert!(field.fold_activity().iter().all(|a| a.is_active()));
            for id in 0..topology.folds().len() {
                assert!(
                    matches!(
                        field.fold_class(FoldId(id)),
                        Some(FoldClass::Isometric { .. })
                    ),
                    "{size:?} net {net} mode {mode}: fold {id} is not isometric"
                );
            }
        }
    }
}

#[test]
fn every_box_cell_has_four_reciprocal_neighbours() {
    for size in BOXES {
        for (net, mode) in VARIANTS {
            let field = box_field(size, net, mode);
            let tessellation = SquareTessellation;
            for &cell in &cells_of(size, net, mode) {
                for &face in tessellation.faces_of(cell) {
                    let crossing = field
                        .neighbor_via(cell, face)
                        .unwrap_or_else(|| panic!("{size:?}: {cell:?} {face:?} has no neighbour"));
                    assert!(field.contains(crossing.cell));
                    let back = field.neighbor_via(crossing.cell, crossing.face).unwrap();
                    assert_eq!((back.cell, back.face), (cell, face), "{size:?} net {net}");
                }
            }
        }
    }
}

/// Walks straight (out through the face opposite the arrival face) and counts the steps until the
/// start cell and heading repeat.
fn straight_loop_length(
    field: &Field<SquareTessellation>,
    start: SquarePoint,
    face: SquareFace,
) -> usize {
    let (mut cell, mut out) = (start, face);
    for steps in 1..=10_000 {
        let crossing = field.neighbor_via(cell, out).unwrap();
        cell = crossing.cell;
        out = crossing.face.opposite();
        if cell == start && out == face {
            return steps;
        }
    }
    panic!("no loop");
}

/// A straight line around a box closes after the perimeter of its cross-section: `2 * (a + b)`
/// for two of the box's sides. A wrongly glued edge breaks the loop or its length.
#[test]
fn straight_lines_close_after_a_cross_section_perimeter() {
    for size in BOXES {
        let (w, h, d) = (size.0 as usize, size.1 as usize, size.2 as usize);
        let perimeters: HashSet<usize> = [2 * (w + h), 2 * (h + d), 2 * (w + d)].into();
        for (net, mode) in VARIANTS {
            let field = box_field(size, net, mode);
            let tessellation = SquareTessellation;
            for &cell in &cells_of(size, net, mode) {
                for &face in tessellation.faces_of(cell) {
                    let length = straight_loop_length(&field, cell, face);
                    assert!(
                        perimeters.contains(&length),
                        "{size:?} net {net} mode {mode}: {cell:?} {face:?} loops after {length}"
                    );
                }
            }
        }
    }
}

/// On a cube every loop is `4 * size` long; the same cube folded from any layout agrees.
#[test]
fn cube_loops_are_four_sides_long() {
    for side in 1..=4u32 {
        for (net, mode) in VARIANTS {
            let field = box_field((side, side, side), net, mode);
            let tessellation = SquareTessellation;
            for &cell in &cells_of((side, side, side), net, mode) {
                for &face in tessellation.faces_of(cell) {
                    assert_eq!(
                        straight_loop_length(&field, cell, face),
                        4 * side as usize,
                        "side {side} net {net} mode {mode}: {cell:?} {face:?}"
                    );
                }
            }
        }
    }
}

/// Every layout of one box glues the same pairs of cube cells (the layouts differ only in where
/// the faces lie), so the loops through corresponding cells agree: the multiset of loop lengths
/// over all cells and headings is the same for every variant.
#[test]
fn every_layout_of_a_box_has_the_same_loops() {
    for size in BOXES {
        let spectrum = |net, mode| {
            let field = box_field(size, net, mode);
            let tessellation = SquareTessellation;
            let mut lengths: Vec<usize> = cells_of(size, net, mode)
                .iter()
                .flat_map(|&cell| {
                    tessellation
                        .faces_of(cell)
                        .iter()
                        .map(|&face| straight_loop_length(&field, cell, face))
                        .collect::<Vec<_>>()
                })
                .collect();
            lengths.sort_unstable();
            lengths
        };
        let reference = spectrum(0, 1);
        for (net, mode) in VARIANTS {
            assert_eq!(spectrum(net, mode), reference, "{size:?} net {net} mode {mode}");
        }
    }
}


/// The compact layout follows the aspect of the sheet it is packed for: six equal faces lie
/// three by two for a landscape sheet and two by three for a portrait one.
#[test]
fn compact_layout_follows_the_requested_aspect() {
    let span = |cells: &[SquarePoint], axis: fn(&SquarePoint) -> i32| {
        axis(cells.iter().max_by_key(|c| axis(c)).unwrap())
            - axis(cells.iter().min_by_key(|c| axis(c)).unwrap())
            + 1
    };
    let with_aspect = |aspect| {
        let mut p = params((10, 10, 10), 2, 1);
        p.last_mut().unwrap().1 = aspect;
        SquareTessellation.build_preset("box", &p).unwrap()
    };
    let landscape = with_aspect(141);
    let portrait = with_aspect(71);
    assert!(span(&landscape, |c| c.x) > span(&landscape, |c| c.y));
    assert!(span(&portrait, |c| c.x) < span(&portrait, |c| c.y));
}

fn crease_length([a, b]: [crate::space::Point; 2]) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

/// The net joins five of the box edges; each gets one crease as long as the edge, in the net mode.
/// By faces (the compact layout included) every face works on its own: no creases.
#[test]
fn creases_follow_the_edges_the_net_joins() {
    for size in BOXES {
        let (w, h, d) = (f64::from(size.0), f64::from(size.1), f64::from(size.2));
        for (net, total) in [(0, 3.0 * h + 2.0 * w), (1, 3.0 * h + 2.0 * d)] {
            let creases = SquareTessellation
                .build_preset_creases("box", &params(size, net, 0))
                .unwrap();
            assert_eq!(creases.len(), 5, "{size:?} net {net}");
            let length: f64 = creases.iter().copied().map(crease_length).sum();
            assert!((length - total).abs() < 1e-9, "{size:?} net {net}");
        }
        for (net, mode) in [(0, 1), (1, 1), (2, 0), (2, 1)] {
            let by_faces = SquareTessellation
                .build_preset_creases("box", &params(size, net, mode))
                .unwrap();
            assert!(by_faces.is_empty(), "{size:?} net {net} mode {mode}");
        }
    }
}

/// A crease lies on the shared edge of two touching cells: axis-aligned between cell corners, with
/// the cells on both sides of it neighbours across that edge.
#[test]
fn creases_lie_on_edges_between_neighbouring_cells() {
    let tessellation = SquareTessellation;
    let cells: HashSet<SquarePoint> = cells_of((3, 2, 4), 0, 0).into_iter().collect();
    let creases = tessellation
        .build_preset_creases("box", &params((3, 2, 4), 0, 0))
        .unwrap();
    for [a, b] in creases {
        assert_eq!(a.x.fract(), 0.0);
        assert_eq!(a.y.fract(), 0.0);
        assert!(a.x == b.x || a.y == b.y, "axis-aligned");
        // The cells on both sides of the first unit of the segment.
        let (x, y) = (a.x.min(b.x) as i32, a.y.min(b.y) as i32);
        let sides = if a.x == b.x { [(x - 1, y), (x, y)] } else { [(x, y - 1), (x, y)] };
        for (cx, cy) in sides {
            assert!(cells.contains(&SquarePoint { x: cx, y: cy }), "({cx}, {cy}) beside {a:?}-{b:?}");
        }
    }
}

#[test]
fn shapes_without_folds_have_no_creases() {
    let tessellation = SquareTessellation;
    assert!(
        tessellation
            .build_preset_creases("rect", &[("cols", 3), ("rows", 2)])
            .unwrap()
            .is_empty()
    );
    assert!(
        tessellation
            .build_preset_creases("cylinder", &[("cols", 4), ("rows", 3), ("axis", 0)])
            .unwrap()
            .is_empty()
    );
    assert!(tessellation.build_preset_creases("box", &[]).is_err());
}
