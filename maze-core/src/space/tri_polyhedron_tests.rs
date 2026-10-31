use crate::ids::IdGenerator;
use crate::space::{
    Field, FoldClass, FoldId, Tessellation, TessellationFingerprint, Topology, TriFace, TriPoint,
    TriTessellation,
};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

fn fp() -> TessellationFingerprint {
    TessellationFingerprint::new("tri{}")
}

/// `(key, faces, edges, nets)`; the compact layout is net `nets`.
const POLYHEDRA: [(&str, usize, usize, u32); 3] = [
    ("tetrahedron", 4, 6, 2),
    ("octahedron", 8, 12, 2),
    ("icosahedron", 20, 30, 1),
];

const SIDES: [u32; 4] = [1, 2, 3, 5];

/// Every combination of net and mode of one polyhedron; the compact layout is always by faces.
fn variants(nets: u32) -> Vec<(u32, u32)> {
    (0..=nets).flat_map(|net| [(net, 0), (net, 1)]).collect()
}

fn params(side: u32, net: u32, mode: u32, aspect: u32) -> Vec<(&'static str, u32)> {
    vec![("side", side), ("net", net), ("mode", mode), ("aspect", aspect)]
}

fn cells_of(key: &str, side: u32, net: u32, mode: u32) -> Vec<TriPoint> {
    TriTessellation
        .build_preset(key, &params(side, net, mode, 100))
        .unwrap()
}

fn field_of(key: &str, side: u32, net: u32, mode: u32) -> Field<TriTessellation> {
    let tessellation = TriTessellation;
    let p = params(side, net, mode, 100);
    let cells = tessellation.build_preset(key, &p).unwrap();
    let groups = tessellation.build_preset_folds(key, &p).unwrap();
    let mut field = Field::new(Arc::new(tessellation), cells, &mut IdGenerator::new()).unwrap();
    field
        .set_topology(Topology::from_groups(fp(), groups), &fp())
        .unwrap();
    field
}

fn components(cells: &[TriPoint]) -> HashMap<TriPoint, usize> {
    let tessellation = TriTessellation;
    let all: HashSet<TriPoint> = cells.iter().copied().collect();
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

fn component_count(cells: &[TriPoint]) -> usize {
    components(cells).values().collect::<HashSet<_>>().len()
}

#[test]
fn polyhedra_have_the_cells_of_their_faces_in_every_variant() {
    for (key, faces, _, nets) in POLYHEDRA {
        for side in SIDES {
            for (net, mode) in variants(nets) {
                let cells = cells_of(key, side, net, mode);
                assert_eq!(
                    cells.len(),
                    faces * (side * side) as usize,
                    "{key} side {side} net {net} mode {mode}"
                );
                assert!(cells.windows(2).all(|w| w[0] < w[1]), "{key}: sorted, distinct");
            }
        }
    }
}

#[test]
fn a_net_is_one_piece_and_separate_faces_are_apart() {
    for (key, faces, _, nets) in POLYHEDRA {
        for side in SIDES {
            for net in 0..nets {
                assert_eq!(
                    component_count(&cells_of(key, side, net, 0)),
                    1,
                    "{key} side {side} net {net}"
                );
                assert_eq!(
                    component_count(&cells_of(key, side, net, 1)),
                    faces,
                    "{key} side {side} net {net} by faces"
                );
            }
            for mode in [0, 1] {
                assert_eq!(
                    component_count(&cells_of(key, side, nets, mode)),
                    faces,
                    "{key} side {side} compact"
                );
            }
        }
    }
}

#[test]
fn a_net_glues_the_edges_it_does_not_join_and_separate_faces_glue_all() {
    for (key, faces, edges, nets) in POLYHEDRA {
        for side in SIDES {
            for (net, mode) in variants(nets) {
                let groups = TriTessellation
                    .build_preset_folds(key, &params(side, net, mode, 100))
                    .unwrap();
                let by_faces = mode == 1 || net == nets;
                let expected = if by_faces { edges } else { edges - (faces - 1) };
                assert_eq!(groups.len(), expected, "{key} side {side} net {net} mode {mode}");
                assert!(groups.iter().all(|g| g.len() == side as usize));
                assert!(groups.iter().flatten().all(|fold| !fold.twist));
            }
        }
    }
}

#[test]
fn every_fold_is_active_and_isometric() {
    for (key, _, _, nets) in POLYHEDRA {
        for side in SIDES {
            for (net, mode) in variants(nets) {
                let field = field_of(key, side, net, mode);
                let topology = field.topology().unwrap();
                assert!(field.fold_activity().iter().all(|a| a.is_active()));
                for id in 0..topology.folds().len() {
                    assert!(
                        matches!(
                            field.fold_class(FoldId(id)),
                            Some(FoldClass::Isometric { .. })
                        ),
                        "{key} side {side} net {net} mode {mode}: fold {id} is not isometric"
                    );
                }
            }
        }
    }
}

#[test]
fn every_cell_has_three_reciprocal_neighbours() {
    for (key, _, _, nets) in POLYHEDRA {
        for side in SIDES {
            for (net, mode) in variants(nets) {
                let field = field_of(key, side, net, mode);
                for &cell in &cells_of(key, side, net, mode) {
                    for &face in TriTessellation.faces_of(cell) {
                        let crossing = field.neighbor_via(cell, face).unwrap_or_else(|| {
                            panic!("{key} side {side} net {net} mode {mode}: {cell:?} {face:?} is open")
                        });
                        assert!(field.contains(crossing.cell));
                        let back = field.neighbor_via(crossing.cell, crossing.face).unwrap();
                        assert_eq!(
                            (back.cell, back.face),
                            (cell, face),
                            "{key} side {side} net {net} mode {mode}"
                        );
                    }
                }
            }
        }
    }
}

/// Walks leaving each cell through the face after the arrival face (counter-clockwise) and counts
/// the steps until the start cell and heading repeat.
fn turning_loop_length(field: &Field<TriTessellation>, start: TriPoint, face: TriFace) -> usize {
    let (mut cell, mut out) = (start, face);
    for steps in 1..=100_000 {
        let crossing = field.neighbor_via(cell, out).unwrap();
        cell = crossing.cell;
        let faces = TriTessellation.faces_of(cell);
        let arrival = faces.iter().position(|&f| f == crossing.face).unwrap();
        out = faces[(arrival + 1) % 3];
        if cell == start && out == face {
            return steps;
        }
    }
    panic!("no loop");
}

/// Every layout of one polyhedron glues the same pairs of surface cells (the layouts differ only
/// in where the faces lie), so the loops of a walk that always turns the same way agree: the
/// multiset of loop lengths over all cells and headings is the same for every variant.
#[test]
fn every_layout_of_a_polyhedron_has_the_same_loops() {
    for (key, _, _, nets) in POLYHEDRA {
        for side in [1, 2, 3] {
            let spectrum = |net, mode| {
                let field = field_of(key, side, net, mode);
                let mut lengths: Vec<usize> = cells_of(key, side, net, mode)
                    .iter()
                    .flat_map(|&cell| {
                        TriTessellation
                            .faces_of(cell)
                            .iter()
                            .map(|&face| turning_loop_length(&field, cell, face))
                            .collect::<Vec<_>>()
                    })
                    .collect();
                lengths.sort_unstable();
                lengths
            };
            let reference = spectrum(0, 1);
            for (net, mode) in variants(nets) {
                assert_eq!(spectrum(net, mode), reference, "{key} side {side} net {net} mode {mode}");
            }
        }
    }
}

/// Around a vertex of the polyhedron the cells close up after the vertex degree: in the pure
/// spectrum, the shortest loops of the side-1 polyhedron are as long as the degree of its vertices
/// (3 for the tetrahedron, 4 for the octahedron, 5 for the icosahedron).
#[test]
fn the_shortest_loops_run_around_a_vertex() {
    for (key, nets, degree) in [("tetrahedron", 2, 3), ("octahedron", 2, 4), ("icosahedron", 1, 5)] {
        let field = field_of(key, 1, nets, 1);
        let shortest = cells_of(key, 1, nets, 1)
            .iter()
            .flat_map(|&cell| {
                TriTessellation
                    .faces_of(cell)
                    .iter()
                    .map(|&face| turning_loop_length(&field, cell, face))
                    .collect::<Vec<_>>()
            })
            .min()
            .unwrap();
        assert_eq!(shortest, degree, "{key}");
    }
}

#[test]
fn the_nets_differ() {
    for (key, _, _, nets) in POLYHEDRA {
        let all: Vec<Vec<TriPoint>> = (0..=nets).map(|net| cells_of(key, 3, net, 1)).collect();
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a, b, "{key}");
            }
        }
    }
}

/// The compact layout keeps the faces far apart, so connectors drawn across the gaps fit.
#[test]
fn compact_layout_keeps_faces_apart() {
    for (key, _, _, nets) in POLYHEDRA {
        let cells = cells_of(key, 3, nets, 1);
        let comp = components(&cells);
        let tessellation = TriTessellation;
        for (i, a) in cells.iter().enumerate() {
            let (pa, ca) = (tessellation.center(*a), comp[a]);
            for b in &cells[i + 1..] {
                if ca != comp[b] {
                    let pb = tessellation.center(*b);
                    let apart = ((pa.x - pb.x).powi(2) + (pa.y - pb.y).powi(2)).sqrt();
                    assert!(apart > 2.0, "{key}: {a:?} and {b:?} are {apart} apart");
                }
            }
        }
    }
}

/// The compact layout follows the aspect of the sheet it is packed for.
#[test]
fn compact_layout_follows_the_requested_aspect() {
    for (key, _, _, nets) in POLYHEDRA {
        let extent = |aspect| {
            let cells = TriTessellation
                .build_preset(key, &params(6, nets, 1, aspect))
                .unwrap();
            let centers: Vec<_> = cells.iter().map(|&c| TriTessellation.center(c)).collect();
            let span = |value: fn(&crate::space::Point) -> f64| {
                centers.iter().map(value).fold(f64::MIN, f64::max)
                    - centers.iter().map(value).fold(f64::MAX, f64::min)
            };
            span(|p| p.x) / span(|p| p.y)
        };
        assert!(extent(1000) > extent(10), "{key}");
    }
}

#[test]
fn shape_presets_define_no_folds() {
    let folds = TriTessellation
        .build_preset_folds("rect", &[("cols", 3), ("rows", 2)])
        .unwrap();
    assert!(folds.is_empty());
}

#[test]
fn polyhedra_reject_oversized_and_unknown_parameters() {
    let tessellation = TriTessellation;
    for (key, _, _, nets) in POLYHEDRA {
        assert!(tessellation.build_preset(key, &params(0, 0, 0, 100)).is_err());
        assert!(tessellation.build_preset(key, &params(201, 0, 0, 100)).is_err());
        assert!(tessellation.build_preset_folds(key, &params(201, 0, 0, 100)).is_err());
        assert!(tessellation.build_preset(key, &params(200, 0, 0, 100)).is_ok());
        assert!(tessellation.build_preset(key, &params(2, 0, 2, 100)).is_err());
        assert!(tessellation.build_preset(key, &params(2, nets + 1, 0, 100)).is_err());
        assert!(tessellation.build_preset(key, &params(2, nets, 1, 1001)).is_err());
        assert!(tessellation.build_preset(key, &[("side", 2)]).is_err());
        assert_eq!(tessellation.preset_param_max(key, "side"), Some(200));
        assert_eq!(tessellation.preset_param_max(key, "mode"), Some(1));
        assert_eq!(tessellation.preset_param_max(key, "net"), Some(nets));
        assert_eq!(tessellation.preset_param_max(key, "aspect"), Some(1000));
        assert_eq!(tessellation.preset_param_max(key, "radius"), None);
    }
}
