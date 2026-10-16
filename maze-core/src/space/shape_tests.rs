use super::*;
use crate::space::{
    CairoPoint, CairoTessellation, HexPoint, HexTessellation, SquarePoint, SquareTessellation,
    Tessellation, TriFace, TriPoint, TriTessellation,
};

fn grid(radius: i32) -> impl Iterator<Item = (i32, i32)> {
    (-radius..=radius).flat_map(move |a| (-radius..=radius).map(move |b| (a, b)))
}

fn square_cells() -> Vec<SquarePoint> {
    grid(3).map(|(x, y)| SquarePoint { x, y }).collect()
}

fn hex_cells() -> Vec<HexPoint> {
    grid(3).map(|(q, r)| HexPoint { q, r }).collect()
}

fn tri_cells() -> Vec<TriPoint> {
    grid(3).map(|(col, row)| TriPoint { col, row }).collect()
}

fn cairo_cells() -> Vec<CairoPoint> {
    grid(12)
        .map(|(x, y)| CairoPoint::new(x, y))
        .filter(|&p| CairoTessellation::is_valid_cell(p))
        .collect()
}

fn assert_valid_group(descriptor: &ShapeDescriptor) {
    let n = descriptor.face_count();
    let group = descriptor.group();
    assert_eq!(group[0], (0..n).collect::<Vec<_>>(), "{}", descriptor.key());
    for (g, perm) in group.iter().enumerate() {
        assert!(is_permutation(perm, n), "{}: element {g}", descriptor.key());
        assert!(
            !group[..g].contains(perm),
            "{}: element {g} is a duplicate",
            descriptor.key()
        );
    }
    for a in group {
        for b in group {
            assert!(
                group.contains(&compose(a, b)),
                "{}: not closed under composition",
                descriptor.key()
            );
        }
    }
}

/// Every cell's shape is bound to one of the instance's descriptors, its local-to-canonical map
/// is a bijection over its faces, and its allowed transforms form a subgroup.
fn assert_shape_contract<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
    for descriptor in tessellation.shape_descriptors() {
        assert_valid_group(descriptor);
    }
    for &cell in cells {
        let shape = tessellation
            .shape_of(cell)
            .expect("built-in cells have a template");
        assert!(
            tessellation
                .shape_descriptors()
                .contains(shape.descriptor())
        );
        let n = shape.descriptor().face_count();
        assert_eq!(tessellation.faces_of(cell).len(), n, "{cell:?}");
        assert!(is_permutation(shape.local_to_canonical(), n), "{cell:?}");

        let group = shape.descriptor().group();
        assert!(shape.allowed_transforms().contains(&0), "{cell:?}");
        for &a in shape.allowed_transforms() {
            assert!(a < group.len(), "{cell:?}");
            for &b in shape.allowed_transforms() {
                let composed = compose(&group[a], &group[b]);
                let index = group.iter().position(|g| *g == composed).unwrap();
                assert!(shape.allowed_transforms().contains(&index), "{cell:?}");
            }
        }
    }
}

/// `local → canonical → transformed → local` is a bijection for every allowed transform, and
/// `canonical_of_transformed_local` inverts it.
fn assert_chain_invertible<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
    for &cell in cells {
        let shape = tessellation.shape_of(cell).unwrap();
        let n = shape.descriptor().face_count();
        for local in 0..n {
            assert_eq!(
                shape.local_of_canonical(shape.canonical_of_local(local)),
                local
            );
        }
        for &g in shape.allowed_transforms() {
            let image: Vec<usize> = (0..n).map(|k| shape.transformed_local(g, k)).collect();
            assert!(is_permutation(&image, n), "{cell:?}: transform {g}");
            for (k, &local) in image.iter().enumerate() {
                assert_eq!(shape.canonical_of_transformed_local(g, local), k);
            }
        }
    }
}

/// The canonical order is counter-clockwise: sorting the faces by the angle from the cell's
/// center to its neighbor's, starting at canonical face 0, yields `0..n`.
fn assert_canonical_order_is_counter_clockwise<T: Tessellation>(
    tessellation: &T,
    cells: &[T::CellId],
) {
    for &cell in cells {
        let shape = tessellation.shape_of(cell).unwrap();
        let c = tessellation.center(cell);
        let angle_of = |local: usize| {
            let face = tessellation.faces_of(cell)[local];
            let (other, _) = tessellation.neighbor(cell, face).unwrap();
            (tessellation.center(other) - c).angle()
        };
        let start = angle_of(shape.local_of_canonical(0));
        let mut canonical: Vec<usize> = (0..shape.descriptor().face_count()).collect();
        canonical.sort_by(|&a, &b| {
            let turn = |k: usize| {
                (angle_of(shape.local_of_canonical(k)) - start).rem_euclid(std::f64::consts::TAU)
            };
            turn(a).total_cmp(&turn(b))
        });
        assert_eq!(
            canonical,
            (0..shape.descriptor().face_count()).collect::<Vec<_>>(),
            "{cell:?}"
        );
    }
}

#[test]
fn regular_polygon_group_is_dihedral() {
    for n in 3..=8 {
        let descriptor = ShapeDescriptor::regular_polygon(n);
        assert_valid_group(&descriptor);
        assert_eq!(descriptor.group().len(), 2 * n);
        assert_eq!(descriptor.key(), format!("regular:{n}"));
    }
}

#[test]
fn cairo_pentagon_group_is_identity_and_long_side_reflection() {
    let descriptor = ShapeDescriptor::cairo_pentagon();
    assert_valid_group(&descriptor);
    assert_eq!(
        descriptor.group(),
        [vec![0, 1, 2, 3, 4], vec![0, 4, 3, 2, 1]]
    );
    assert_eq!(descriptor.key(), "cairo_pentagon");
}

#[test]
fn registered_template_group_is_the_closure_of_its_generators() {
    let descriptor = ShapeDescriptor::new(ShapeFamily::Registered {
        kind: "test",
        name: "pentagon_rotations",
        face_count: 5,
        generators: vec![vec![1, 2, 3, 4, 0]],
    });
    assert_valid_group(&descriptor);
    assert_eq!(descriptor.group().len(), 5);
    assert_eq!(descriptor.key(), "test:pentagon_rotations");
}

#[test]
#[should_panic(expected = "not a permutation")]
fn registered_template_rejects_a_non_permutation_generator() {
    ShapeDescriptor::new(ShapeFamily::Registered {
        kind: "test",
        name: "broken",
        face_count: 3,
        generators: vec![vec![0, 0, 1]],
    });
}

#[test]
fn identical_geometry_with_different_face_counts_gets_different_descriptors() {
    // A square whose one side is split into two faces is a 5-face template, not `regular:4`.
    let square = ShapeDescriptor::regular_polygon(4);
    let split_side_square = ShapeDescriptor::new(ShapeFamily::Registered {
        kind: "test",
        name: "square_split_side",
        face_count: 5,
        generators: vec![vec![0, 4, 3, 2, 1]],
    });
    assert_ne!(square, split_side_square);
    assert_eq!(split_side_square.face_count(), 5);
    assert_eq!(square, ShapeDescriptor::regular_polygon(4));
}

#[test]
fn shape_contract_holds_for_every_tessellation() {
    assert_shape_contract(&SquareTessellation, &square_cells());
    assert_shape_contract(&HexTessellation, &hex_cells());
    assert_shape_contract(&TriTessellation, &tri_cells());
    assert_shape_contract(&CairoTessellation, &cairo_cells());
}

#[test]
fn face_chain_is_invertible_for_every_tessellation() {
    assert_chain_invertible(&SquareTessellation, &square_cells());
    assert_chain_invertible(&HexTessellation, &hex_cells());
    assert_chain_invertible(&TriTessellation, &tri_cells());
    assert_chain_invertible(&CairoTessellation, &cairo_cells());
}

#[test]
fn canonical_order_is_counter_clockwise_for_every_tessellation() {
    assert_canonical_order_is_counter_clockwise(&SquareTessellation, &square_cells());
    assert_canonical_order_is_counter_clockwise(&HexTessellation, &hex_cells());
    assert_canonical_order_is_counter_clockwise(&TriTessellation, &tri_cells());
    assert_canonical_order_is_counter_clockwise(&CairoTessellation, &cairo_cells());
}

/// Built-in `faces_of` is the canonical circular order itself (GitHub issue #758), so local and
/// canonical face indices coincide.
#[test]
fn built_in_faces_of_is_the_canonical_order() {
    fn identity<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
        for &cell in cells {
            let shape = tessellation.shape_of(cell).unwrap();
            let n = shape.descriptor().face_count();
            assert_eq!(
                shape.local_to_canonical(),
                (0..n).collect::<Vec<_>>(),
                "{cell:?}"
            );
        }
    }
    identity(&SquareTessellation, &square_cells());
    identity(&HexTessellation, &hex_cells());
    identity(&TriTessellation, &tri_cells());
    identity(&CairoTessellation, &cairo_cells());
}

#[test]
fn every_built_in_cell_gets_its_full_group() {
    fn full<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
        for &cell in cells {
            let shape = tessellation.shape_of(cell).unwrap();
            assert_eq!(
                shape.allowed_transforms(),
                shape.descriptor().all_transforms()
            );
        }
    }
    full(&SquareTessellation, &square_cells());
    full(&HexTessellation, &hex_cells());
    full(&TriTessellation, &tri_cells());
    full(&CairoTessellation, &cairo_cells());
    assert_eq!(
        TriTessellation
            .shape_of(TriPoint { col: 0, row: 0 })
            .unwrap()
            .allowed_transforms()
            .len(),
        6
    );
}

#[test]
fn triangle_reflections_fix_one_side_and_swap_the_other_two() {
    // Both orientations: base above (`(0, 0)`) and base below (`(1, 0)`).
    for cell in [TriPoint { col: 0, row: 0 }, TriPoint { col: 1, row: 0 }] {
        let local = |face: TriFace| {
            TriTessellation
                .faces_of(cell)
                .iter()
                .position(|&f| f == face)
                .unwrap()
        };
        let shape = TriTessellation.shape_of(cell).unwrap();
        // Maps each local face through a transform: local → canonical → transformed → local.
        let apply = |g: usize, face: TriFace| {
            let canonical = shape.canonical_of_local(local(face));
            TriTessellation.faces_of(cell)[shape.transformed_local(g, canonical)]
        };
        let group = shape.descriptor().group();
        let reflections: Vec<usize> = (3..6).collect();
        for &g in &reflections {
            let fixed: Vec<TriFace> = [TriFace::Left, TriFace::Right, TriFace::Base]
                .into_iter()
                .filter(|&f| apply(g, f) == f)
                .collect();
            assert_eq!(fixed.len(), 1, "{cell:?}: reflection {:?}", group[g]);
            let others: Vec<TriFace> = [TriFace::Left, TriFace::Right, TriFace::Base]
                .into_iter()
                .filter(|f| *f != fixed[0])
                .collect();
            assert_eq!(apply(g, others[0]), others[1]);
            assert_eq!(apply(g, others[1]), others[0]);
        }
        // The reflection fixing the base swaps the two legs.
        let base_axis = reflections
            .iter()
            .copied()
            .find(|&g| apply(g, TriFace::Base) == TriFace::Base)
            .unwrap();
        assert_eq!(apply(base_axis, TriFace::Left), TriFace::Right);
        // Rotations fix no face.
        for g in 1..3 {
            for face in [TriFace::Left, TriFace::Right, TriFace::Base] {
                assert_ne!(apply(g, face), face, "{cell:?}: rotation {g}");
            }
        }
    }
}

#[test]
fn triangle_one_step_rotation_runs_counter_clockwise_on_both_orientations() {
    let rotate = |cell: TriPoint, face: TriFace| {
        let shape = TriTessellation.shape_of(cell).unwrap();
        let faces = TriTessellation.faces_of(cell);
        let local = faces.iter().position(|&f| f == face).unwrap();
        faces[shape.transformed_local(1, shape.canonical_of_local(local))]
    };
    // Base above: counter-clockwise order Base, Left, Right.
    let above = TriPoint { col: 0, row: 0 };
    assert_eq!(rotate(above, TriFace::Base), TriFace::Left);
    assert_eq!(rotate(above, TriFace::Left), TriFace::Right);
    // Base below: counter-clockwise order Base, Right, Left.
    let below = TriPoint { col: 1, row: 0 };
    assert_eq!(rotate(below, TriFace::Base), TriFace::Right);
    assert_eq!(rotate(below, TriFace::Right), TriFace::Left);
}

#[test]
#[should_panic(expected = "must not be `regular`")]
fn registered_template_cannot_take_the_regular_polygon_key_space() {
    ShapeDescriptor::new(ShapeFamily::Registered {
        kind: "regular",
        name: "4",
        face_count: 4,
        generators: vec![],
    });
}

#[test]
fn restricted_cell_shape_keeps_only_its_subgroup() {
    // Rotations only (transforms `0..4` of `regular:4`) form a subgroup of the dihedral group.
    let descriptor = ShapeDescriptor::regular_polygon(4);
    let local_to_canonical = [1, 3, 0, 2];
    let rotations = [0, 1, 2, 3];
    let shape = CellShape::restricted(&descriptor, &local_to_canonical, &rotations);
    assert_eq!(shape.allowed_transforms(), rotations);
    let group = descriptor.group();
    for &a in shape.allowed_transforms() {
        for &b in shape.allowed_transforms() {
            let composed = compose(&group[a], &group[b]);
            let index = group.iter().position(|g| *g == composed).unwrap();
            assert!(shape.allowed_transforms().contains(&index));
        }
        let image: Vec<usize> = (0..4).map(|k| shape.transformed_local(a, k)).collect();
        assert!(is_permutation(&image, 4));
        for (k, &local) in image.iter().enumerate() {
            assert_eq!(shape.canonical_of_transformed_local(a, local), k);
        }
    }
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "is not allowed for this cell")]
fn restricted_cell_shape_rejects_a_transform_outside_its_subgroup() {
    let descriptor = ShapeDescriptor::regular_polygon(4);
    let shape = CellShape::restricted(&descriptor, &[0, 1, 2, 3], &[0, 1, 2, 3]);
    shape.transformed_local(4, 0);
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "is not a permutation")]
fn cell_shape_rejects_a_non_bijective_local_to_canonical() {
    let descriptor = ShapeDescriptor::regular_polygon(4);
    CellShape::full(&descriptor, &[0, 0, 1, 2]);
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "must contain the identity")]
fn restricted_cell_shape_requires_the_identity() {
    let descriptor = ShapeDescriptor::regular_polygon(4);
    CellShape::restricted(&descriptor, &[0, 1, 2, 3], &[1, 2, 3]);
}
