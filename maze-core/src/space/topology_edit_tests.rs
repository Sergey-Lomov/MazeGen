use super::*;
use crate::ids::IdGenerator;
use crate::space::{BrickPoint, BrickTessellation, SquarePoint, SquareTessellation, square_rect};
use std::sync::Arc;

fn fp() -> TessellationFingerprint {
    TessellationFingerprint::new("test{}")
}

fn square_field(w: usize, h: usize) -> Field<SquareTessellation> {
    Field::new(
        Arc::new(SquareTessellation),
        square_rect(w, h),
        &mut IdGenerator::new(),
    )
    .unwrap()
}

fn brick_field(w: i32, h: i32) -> Field<BrickTessellation> {
    let cells = (0..h).flat_map(|y| (0..w).map(move |x| BrickPoint { x, y }));
    Field::new(Arc::new(BrickTessellation), cells, &mut IdGenerator::new()).unwrap()
}

fn end(x: i32, y: i32, face_idx: usize) -> FoldEnd<SquarePoint> {
    FoldEnd {
        cell: SquarePoint { x, y },
        face_idx,
    }
}

type Shape<T> = Vec<(
    FoldEnd<<T as Tessellation>::CellId>,
    FoldEnd<<T as Tessellation>::CellId>,
    bool,
)>;

/// Faces of `topology` as `(a, b, twist)` for comparisons that ignore ids.
fn shape<T: Tessellation>(t: &Topology<T>) -> Shape<T> {
    t.folds().iter().map(|f| (f.a, f.b, f.twist)).collect()
}

fn installed<T: Tessellation>(field: &mut Field<T>, topology: Topology<T>) {
    field.set_topology(topology, &fp()).unwrap();
    assert!(field.fold_activity().iter().all(|a| a.is_active()));
}

#[test]
fn contour_of_a_rectangle_is_one_closed_chain() {
    let field = square_field(4, 3);
    let contours = boundary_contours(&field).unwrap();
    assert_eq!(contours.len(), 1);
    let faces = &contours[0].faces;
    assert_eq!(faces.len(), 2 * (4 + 3));
    let unique: HashSet<_> = faces.iter().map(|f| (f.cell, f.face_idx)).collect();
    assert_eq!(unique.len(), faces.len());
}

#[test]
fn contour_follows_the_boundary_in_order() {
    let field = square_field(3, 3);
    let faces = &boundary_contours(&field).unwrap()[0].faces;
    // Consecutive faces are either two faces of one cell or lie in adjacent cells.
    for i in 0..faces.len() {
        let (a, b) = (faces[i], faces[(i + 1) % faces.len()]);
        let dx = (a.cell.x - b.cell.x).abs();
        let dy = (a.cell.y - b.cell.y).abs();
        assert!(dx + dy <= 1, "{a:?} -> {b:?}");
    }
}

#[test]
fn field_with_a_hole_has_two_contours() {
    let cells: Vec<_> = square_rect(5, 5)
        .into_iter()
        .filter(|c| !(c.x == 2 && c.y == 2))
        .collect();
    let field = Field::new(Arc::new(SquareTessellation), cells, &mut IdGenerator::new()).unwrap();
    let contours = boundary_contours(&field).unwrap();
    assert_eq!(contours.len(), 2);
    let mut lens: Vec<_> = contours.iter().map(|c| c.faces.len()).collect();
    lens.sort();
    assert_eq!(lens, vec![4, 20]);
}

#[test]
fn run_wraps_around_the_contour() {
    let field = square_field(2, 2);
    let contour = &boundary_contours(&field).unwrap()[0];
    let n = contour.faces.len();
    let run = contour.run(n - 1, 3).unwrap();
    assert_eq!(run[0], contour.faces[n - 1]);
    assert_eq!(run[1], contour.faces[0]);
    assert!(contour.run(0, 0).is_none());
    assert!(contour.run(0, n + 1).is_none());
    assert!(contour.run(n, 1).is_none());
}

#[test]
fn square_presets_install_and_are_active() {
    for preset in TopologyPreset::ALL {
        let mut field = square_field(4, 4);
        let topology = preset.build(&field, &fp()).unwrap();
        let groups = if matches!(preset, TopologyPreset::Torus | TopologyPreset::Klein) {
            2
        } else {
            1
        };
        assert_eq!(topology.groups().len(), groups, "{preset:?}");
        assert_eq!(
            topology.folds().len(),
            4 * groups,
            "{preset:?}: one fold per boundary face pair"
        );
        installed(&mut field, topology);
    }
}

#[test]
fn square_cylinder_glues_rows_across() {
    let field = square_field(4, 3);
    let topology = TopologyPreset::Cylinder.build(&field, &fp()).unwrap();
    for fold in topology.folds() {
        assert_eq!(fold.a.cell.y, fold.b.cell.y);
        assert_eq!((fold.a.cell.x - fold.b.cell.x).abs(), 3);
        assert!(!fold.twist);
    }
}

#[test]
fn mobius_and_klein_twist_the_left_right_gluing() {
    let field = square_field(4, 4);
    let mobius = TopologyPreset::Mobius.build(&field, &fp()).unwrap();
    assert!(mobius.folds().iter().all(|f| f.twist));
    let klein = TopologyPreset::Klein.build(&field, &fp()).unwrap();
    let twisted = klein.folds().iter().filter(|f| f.twist).count();
    assert_eq!(twisted, 4);
    assert_eq!(klein.folds().len(), 8);
}

#[test]
fn preset_builds_on_a_non_square_tessellation() {
    let mut field = brick_field(4, 4);
    let cylinder = TopologyPreset::Cylinder.build(&field, &fp()).unwrap();
    assert_eq!(cylinder.groups().len(), 1);
    installed(&mut field, cylinder);

    // The staggered brick sides pair a cell with the same neighbour twice (v1 constraint) for the
    // other presets: they fail with the reason, never with a partial topology.
    let fresh = brick_field(4, 4);
    for preset in [
        TopologyPreset::Mobius,
        TopologyPreset::Torus,
        TopologyPreset::Klein,
    ] {
        let err = preset.build(&fresh, &fp()).unwrap_err();
        assert!(
            matches!(err, TopologyEditError::Inactive { .. }),
            "{preset:?}: {err}"
        );
    }
}

#[test]
fn preset_rejects_a_too_small_field() {
    // Width 2: the glued cells are neighbours already.
    let field = square_field(2, 4);
    let err = TopologyPreset::Cylinder.build(&field, &fp()).unwrap_err();
    assert!(matches!(err, TopologyEditError::TooSmall { .. }), "{err}");
    // Width 1: the glued faces belong to one cell.
    let field = square_field(1, 4);
    assert!(TopologyPreset::Cylinder.build(&field, &fp()).is_err());
    // 3x2 torus: vertical direction too small.
    let field = square_field(3, 2);
    assert!(TopologyPreset::Cylinder.build(&field, &fp()).is_ok());
    let err = TopologyPreset::Torus.build(&field, &fp()).unwrap_err();
    assert!(matches!(err, TopologyEditError::TooSmall { .. }), "{err}");
    assert!(
        TopologyPreset::Torus
            .build(&square_field(3, 3), &fp())
            .is_ok()
    );
}

#[test]
fn preset_rejects_a_non_rectangular_field() {
    let cells: Vec<_> = square_rect(5, 5)
        .into_iter()
        .filter(|c| !(c.x == 2 && c.y == 2))
        .collect();
    let field = Field::new(Arc::new(SquareTessellation), cells, &mut IdGenerator::new()).unwrap();
    let err = TopologyPreset::Cylinder.build(&field, &fp()).unwrap_err();
    assert!(matches!(err, TopologyEditError::NotRectangular(_)), "{err}");
}

fn buildable<T: Tessellation>(field: &Field<T>) -> Vec<TopologyPreset> {
    topology_preset_availability(field, &fp())
        .into_iter()
        .filter(|(_, r)| r.is_ok())
        .map(|(p, _)| p)
        .collect()
}

#[test]
fn availability_lists_what_builds_and_why_not() {
    assert_eq!(buildable(&square_field(4, 4)), TopologyPreset::ALL.to_vec());
    assert_eq!(
        buildable(&square_field(3, 2)),
        vec![TopologyPreset::Cylinder, TopologyPreset::Mobius]
    );
    assert!(buildable(&square_field(1, 1)).is_empty());
    let all = topology_preset_availability(&square_field(3, 2), &fp());
    assert_eq!(all.len(), TopologyPreset::ALL.len());
    assert!(matches!(all[1].1, Err(TopologyEditError::TooSmall { .. })));
}

#[test]
fn preset_fails_with_a_reason_on_a_cross_shaped_field() {
    let cells: Vec<_> = square_rect(5, 5)
        .into_iter()
        .filter(|c| (1..4).contains(&c.x) || (1..4).contains(&c.y))
        .collect();
    let field = Field::new(Arc::new(SquareTessellation), cells, &mut IdGenerator::new()).unwrap();
    let err = TopologyPreset::Cylinder.build(&field, &fp()).unwrap_err();
    assert!(!err.to_string().is_empty());
}

#[test]
fn contours_cover_every_boundary_face_on_a_hex_field() {
    let cells = crate::space::hex_parallelogram(4, 3);
    let field = Field::new(
        Arc::new(crate::space::HexTessellation),
        cells,
        &mut IdGenerator::new(),
    )
    .unwrap();
    let tess = field.tessellation();
    let expected = field
        .all_cells()
        .map(|c| {
            tess.faces_of(c)
                .iter()
                .filter(|&&f| tess.neighbor(c, f).is_none_or(|(n, _)| !field.contains(n)))
                .count()
        })
        .sum::<usize>();
    let contours = boundary_contours(&field).unwrap();
    assert_eq!(contours.len(), 1);
    assert_eq!(contours[0].faces.len(), expected);
    let unique: HashSet<_> = contours[0]
        .faces
        .iter()
        .map(|f| (f.cell, f.face_idx))
        .collect();
    assert_eq!(unique.len(), expected);
}

#[test]
fn an_inactive_fold_blocks_edits_of_other_groups_but_not_its_own_removal() {
    let field = square_field(4, 3);
    // Cell (9, 0) is valid for the tessellation but outside the field: the fold is inactive.
    let outside = NewFold {
        a: end(0, 0, 2),
        b: end(9, 0, 0),
        twist: false,
    };
    let mut topology = Topology::<SquareTessellation>::empty(fp());
    let ghost = topology
        .entries(&field, &fp())
        .map(|_| FoldGroupId(0))
        .unwrap();
    let candidate = topology
        .candidate(&field, &fp(), vec![(ghost, vec![outside])])
        .unwrap_err();
    assert!(matches!(
        candidate,
        TopologyEditError::Inactive {
            reason: InactiveReason::MissingCell,
            ..
        }
    ));
    // Install it structurally anyway, as a topology loaded from a file could be.
    topology = Topology::new(
        fp(),
        vec![Fold {
            a: end(0, 0, 2),
            b: end(9, 0, 0),
            twist: false,
            group: ghost,
        }],
        vec![FoldGroup {
            id: ghost,
            folds: vec![FoldId(0)],
        }],
    );
    let other = topology.glue(&field, &fp(), &[end(0, 1, 2)], &[end(3, 1, 0)], false);
    assert!(matches!(
        other,
        Err(TopologyEditError::Inactive {
            reason: InactiveReason::MissingCell,
            ..
        })
    ));
    topology.remove_group(&field, &fp(), ghost).unwrap();
    assert!(topology.is_empty());
}

#[test]
fn preset_keys_round_trip() {
    for preset in TopologyPreset::ALL {
        assert_eq!(TopologyPreset::from_key(preset.key()), Some(preset));
    }
    assert_eq!(TopologyPreset::from_key("sphere"), None);
}

#[test]
fn glue_pairs_untwisted_reversed_and_twisted_in_order() {
    let a = [end(0, 0, 2), end(0, 1, 2)];
    let b = [end(3, 0, 0), end(3, 1, 0)];
    let straight =
        Topology::<SquareTessellation>::glue_folds(&SquareTessellation, &a, &b, false).unwrap();
    assert_eq!(straight[0].b, b[1]);
    assert_eq!(straight[1].b, b[0]);
    let twisted =
        Topology::<SquareTessellation>::glue_folds(&SquareTessellation, &a, &b, true).unwrap();
    assert_eq!(twisted[0].b, b[0]);
    assert!(twisted.iter().all(|f| f.twist));
}

#[test]
fn glue_rejects_bad_runs() {
    let t = SquareTessellation;
    let a = [end(0, 0, 2)];
    let b = [end(3, 0, 0), end(3, 1, 0)];
    assert_eq!(
        Topology::<SquareTessellation>::glue_folds(&t, &a, &b, false),
        Err(TopologyEditError::RunLengthMismatch { a: 1, b: 2 })
    );
    assert_eq!(
        Topology::<SquareTessellation>::glue_folds(&t, &[], &[], false),
        Err(TopologyEditError::EmptyRun)
    );
}

#[test]
fn glue_adds_a_group_to_a_topology() {
    let field = square_field(4, 3);
    let mut topology = Topology::<SquareTessellation>::empty(fp());
    let left: Vec<_> = (0..3).map(|y| end(0, y, 2)).collect();
    let right: Vec<_> = (0..3).map(|y| end(3, y, 0)).collect();
    let id = topology.glue(&field, &fp(), &left, &right, false).unwrap();
    assert_eq!(topology.groups().len(), 1);
    assert_eq!(topology.group(id).unwrap().folds.len(), 3);
    assert!(topology.folds().iter().all(|f| f.group == id));
}

#[test]
fn failed_edits_leave_the_topology_unchanged() {
    let field = square_field(4, 3);
    let mut topology = TopologyPreset::Cylinder.build(&field, &fp()).unwrap();
    let before = topology.clone();
    let before_shape = shape(&topology);

    // Face already glued by the existing group.
    let again = topology.glue(&field, &fp(), &[end(0, 0, 2)], &[end(3, 0, 0)], false);
    assert!(matches!(
        again,
        Err(TopologyEditError::Invalid(
            TopologyError::FaceInMultipleFolds { .. }
        ))
    ));
    // Interior face: the fold would override an ordinary neighbour.
    let interior = topology.glue(&field, &fp(), &[end(1, 0, 0)], &[end(2, 2, 1)], false);
    assert!(matches!(
        interior,
        Err(TopologyEditError::Inactive {
            reason: InactiveReason::InteriorNeighbor,
            ..
        })
    ));
    // Unknown group.
    assert_eq!(
        topology.remove_group(&field, &fp(), FoldGroupId(9)),
        Err(TopologyEditError::UnknownGroup(FoldGroupId(9)))
    );
    assert_eq!(
        topology.replace_group(&field, &fp(), FoldGroupId(9), Vec::new()),
        Err(TopologyEditError::UnknownGroup(FoldGroupId(9)))
    );
    // Replacement that fails midway (second fold invalid) must not apply the first.
    let bad = vec![
        NewFold {
            a: end(0, 0, 2),
            b: end(3, 0, 0),
            twist: false,
        },
        NewFold {
            a: end(0, 1, 9),
            b: end(3, 1, 0),
            twist: false,
        },
    ];
    assert!(
        topology
            .replace_group(&field, &fp(), FoldGroupId(0), bad)
            .is_err()
    );
    // Wrong fingerprint.
    let other = TessellationFingerprint::new("other{}");
    assert!(
        topology
            .remove_group(&field, &other, FoldGroupId(0))
            .is_err()
    );

    assert_eq!(topology.folds(), before.folds());
    assert_eq!(topology.groups(), before.groups());
    assert_eq!(shape(&topology), before_shape);
}

#[test]
fn replace_group_swaps_all_its_folds_and_keeps_id_and_order() {
    let field = square_field(4, 4);
    let mut topology = TopologyPreset::Torus.build(&field, &fp()).unwrap();
    let first_before = topology.groups()[0].clone();
    let second_id = topology.groups()[1].id;

    let new_folds = TopologyPreset::Mobius
        .build(&field, &fp())
        .unwrap()
        .folds()
        .iter()
        .map(|f| NewFold {
            a: f.a,
            b: f.b,
            twist: f.twist,
        })
        .collect::<Vec<_>>();
    topology
        .replace_group(&field, &fp(), first_before.id, new_folds)
        .unwrap();

    assert_eq!(topology.groups().len(), 2);
    assert_eq!(topology.groups()[0].id, first_before.id);
    assert_eq!(topology.groups()[1].id, second_id);
    let first = topology.group(first_before.id).unwrap();
    assert!(first.folds.iter().all(|&f| topology.folds()[f.0].twist));
    let second = topology.group(second_id).unwrap();
    assert!(second.folds.iter().all(|&f| !topology.folds()[f.0].twist));
    assert_eq!(topology.validate(field.tessellation(), &fp()), Ok(()));
}

#[test]
fn remove_group_drops_the_whole_group_and_reindexes() {
    let field = square_field(4, 4);
    let mut topology = TopologyPreset::Torus.build(&field, &fp()).unwrap();
    let first = topology.groups()[0].id;
    let second = topology.groups()[1].id;
    topology.remove_group(&field, &fp(), first).unwrap();
    assert_eq!(topology.groups().len(), 1);
    assert_eq!(topology.groups()[0].id, second);
    assert_eq!(topology.folds().len(), 4);
    assert!(topology.folds().iter().all(|f| f.group == second));
    assert_eq!(topology.validate(field.tessellation(), &fp()), Ok(()));
    topology.remove_group(&field, &fp(), second).unwrap();
    assert!(topology.is_empty());
}

#[test]
fn added_group_ids_never_collide_after_removal() {
    let field = square_field(4, 4);
    let mut topology = TopologyPreset::Torus.build(&field, &fp()).unwrap();
    let first = topology.groups()[0].id;
    topology.remove_group(&field, &fp(), first).unwrap();
    let left: Vec<_> = (0..4).map(|y| end(0, y, 2)).collect();
    let right: Vec<_> = (0..4).map(|y| end(3, y, 0)).collect();
    let id = topology.glue(&field, &fp(), &left, &right, false).unwrap();
    assert!(topology.groups().iter().filter(|g| g.id == id).count() == 1);
}
