use super::*;
use crate::space::{CairoPoint, CairoTessellation, SquarePoint, SquareTessellation};

type SqTopology = Topology<SquareTessellation>;

const E: usize = 0;
const N: usize = 1;
const W: usize = 2;
const S: usize = 3;

fn fp() -> TessellationFingerprint {
    TessellationFingerprint::new("square{}")
}

fn p(x: i32, y: i32) -> SquarePoint {
    SquarePoint { x, y }
}

fn end(x: i32, y: i32, face_idx: usize) -> FoldEnd<SquarePoint> {
    FoldEnd {
        cell: p(x, y),
        face_idx,
    }
}

fn fold(
    a: FoldEnd<SquarePoint>,
    b: FoldEnd<SquarePoint>,
    twist: bool,
    group: u32,
) -> Fold<SquarePoint> {
    Fold {
        a,
        b,
        twist,
        group: FoldGroupId(group),
    }
}

fn group(id: u32, folds: &[usize]) -> FoldGroup {
    FoldGroup {
        id: FoldGroupId(id),
        folds: folds.iter().map(|&i| FoldId(i)).collect(),
    }
}

fn validate(t: &SqTopology) -> Result<(), TopologyError<SquarePoint>> {
    t.validate(&SquareTessellation, &fp())
}

/// East edge of a `w`-wide field glued to its west edge, one fold per row.
fn cylinder(w: i32, h: i32, twist: bool) -> SqTopology {
    let folds: Vec<_> = (0..h)
        .map(|y| fold(end(w - 1, y, E), end(0, y, W), twist, 0))
        .collect();
    let ids: Vec<usize> = (0..h as usize).collect();
    Topology::new(fp(), folds, vec![group(0, &ids)])
}

#[test]
fn empty_topology_is_valid() {
    let t = SqTopology::empty(fp());
    assert!(t.is_empty());
    assert_eq!(validate(&t), Ok(()));
}

#[test]
fn cylinder_like_is_valid() {
    let t = cylinder(4, 3, false);
    assert_eq!(validate(&t), Ok(()));
    assert_eq!(t.folds().len(), 3);
}

#[test]
fn torus_like_is_valid() {
    let (w, h) = (3, 3);
    let mut folds = Vec::new();
    for y in 0..h {
        folds.push(fold(end(w - 1, y, E), end(0, y, W), false, 0));
    }
    for x in 0..w {
        folds.push(fold(end(x, h - 1, N), end(x, 0, S), false, 1));
    }
    let t = Topology::new(
        fp(),
        folds,
        vec![group(0, &[0, 1, 2]), group(1, &[3, 4, 5])],
    );
    assert_eq!(validate(&t), Ok(()));
}

#[test]
fn twisted_is_valid_and_keeps_twist() {
    let t = cylinder(4, 2, true);
    assert_eq!(validate(&t), Ok(()));
    assert!(t.folds().iter().all(|f| f.twist));
}

#[test]
fn fold_of_finds_both_sides() {
    let t = cylinder(4, 2, false);
    let (f, side) = t.fold_of(p(3, 1), E).unwrap();
    assert_eq!(side, FoldSide::A);
    assert_eq!(f.b, end(0, 1, W));
    let (f, side) = t.fold_of(p(0, 1), W).unwrap();
    assert_eq!(side, FoldSide::B);
    assert_eq!(f.a, end(3, 1, E));
    assert!(t.fold_of(p(1, 1), E).is_none());
    assert!(t.fold_of(p(3, 1), N).is_none());
}

#[test]
fn group_lookup() {
    let t = cylinder(4, 2, false);
    assert_eq!(t.group(FoldGroupId(0)).unwrap().folds.len(), 2);
    assert!(t.group(FoldGroupId(7)).is_none());
}

#[test]
fn fingerprint_mismatch_is_rejected() {
    let t = cylinder(4, 2, false);
    let other = TessellationFingerprint::new("hex{}");
    let err = t.validate(&SquareTessellation, &other).unwrap_err();
    assert_eq!(
        err,
        TopologyError::FingerprintMismatch {
            expected: other,
            found: fp(),
        }
    );
    assert!(err.to_string().contains("hex{}"));
    assert!(t.check_fingerprint(&fp()).is_ok());
}

#[test]
fn face_out_of_range_is_rejected() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![fold(end(0, 0, 4), end(1, 0, W), false, 0)],
        vec![group(0, &[0])],
    );
    assert_eq!(
        validate(&t),
        Err(TopologyError::FaceOutOfRange {
            fold: FoldId(0),
            side: FoldSide::A,
            cell: p(0, 0),
            face_idx: 4,
            face_count: 4,
        })
    );
}

#[test]
fn invalid_cell_is_rejected() {
    let bad = CairoPoint { x: 4, y: 0 };
    assert!(!crate::space::Tessellation::is_valid_cell(
        &CairoTessellation,
        bad
    ));
    let good = (0..4)
        .flat_map(|x| (0..4).map(move |y| CairoPoint { x, y }))
        .find(|&c| crate::space::Tessellation::is_valid_cell(&CairoTessellation, c))
        .unwrap();
    let t = Topology::<CairoTessellation>::new(
        TessellationFingerprint::new("cairo{}"),
        vec![Fold {
            a: FoldEnd {
                cell: good,
                face_idx: 0,
            },
            b: FoldEnd {
                cell: bad,
                face_idx: 0,
            },
            twist: false,
            group: FoldGroupId(0),
        }],
        vec![group(0, &[0])],
    );
    let err = t
        .validate(&CairoTessellation, &TessellationFingerprint::new("cairo{}"))
        .unwrap_err();
    assert_eq!(
        err,
        TopologyError::InvalidCell {
            fold: FoldId(0),
            side: FoldSide::B,
            cell: bad,
        }
    );
}

#[test]
fn face_in_two_folds_is_rejected() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![
            fold(end(0, 0, E), end(1, 0, W), false, 0),
            fold(end(0, 0, E), end(5, 5, W), false, 0),
        ],
        vec![group(0, &[0, 1])],
    );
    assert_eq!(
        validate(&t),
        Err(TopologyError::FaceInMultipleFolds {
            fold: FoldId(1),
            other: FoldId(0),
            cell: p(0, 0),
            face_idx: E,
        })
    );
}

#[test]
fn face_in_two_folds_on_opposite_sides_is_rejected() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![
            fold(end(0, 0, E), end(1, 0, W), false, 0),
            fold(end(7, 7, E), end(1, 0, W), false, 0),
        ],
        vec![group(0, &[0, 1])],
    );
    assert!(matches!(
        validate(&t),
        Err(TopologyError::FaceInMultipleFolds {
            fold: FoldId(1),
            other: FoldId(0),
            ..
        })
    ));
}

#[test]
fn self_glued_is_rejected() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![fold(end(2, 2, N), end(2, 2, N), false, 0)],
        vec![group(0, &[0])],
    );
    assert_eq!(
        validate(&t),
        Err(TopologyError::SelfGlued { fold: FoldId(0) })
    );
}

#[test]
fn two_faces_of_one_cell_may_be_glued_together() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![fold(end(0, 0, E), end(0, 0, W), false, 0)],
        vec![group(0, &[0])],
    );
    assert_eq!(validate(&t), Ok(()));
}

#[test]
fn unknown_group_is_rejected() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![fold(end(0, 0, E), end(1, 0, W), false, 3)],
        vec![group(0, &[0])],
    );
    assert_eq!(
        validate(&t),
        Err(TopologyError::UnknownGroup {
            fold: FoldId(0),
            group: FoldGroupId(3),
        })
    );
}

#[test]
fn fold_without_group_is_rejected() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![fold(end(0, 0, E), end(1, 0, W), false, 0)],
        vec![group(0, &[])],
    );
    assert_eq!(
        validate(&t),
        Err(TopologyError::FoldWithoutGroup { fold: FoldId(0) })
    );
}

#[test]
fn fold_listed_by_other_group_is_rejected() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![fold(end(0, 0, E), end(1, 0, W), false, 0)],
        vec![group(0, &[]), group(1, &[0])],
    );
    assert_eq!(
        validate(&t),
        Err(TopologyError::FoldGroupMismatch {
            fold: FoldId(0),
            group: FoldGroupId(0),
        })
    );
}

#[test]
fn fold_in_two_groups_is_rejected() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![fold(end(0, 0, E), end(1, 0, W), false, 0)],
        vec![group(0, &[0]), group(1, &[0])],
    );
    assert_eq!(
        validate(&t),
        Err(TopologyError::FoldInMultipleGroups {
            fold: FoldId(0),
            group: FoldGroupId(0),
            other: FoldGroupId(1),
        })
    );
}

#[test]
fn group_with_unknown_fold_is_rejected() {
    let t = Topology::<SquareTessellation>::new(fp(), vec![], vec![group(0, &[2])]);
    assert_eq!(
        validate(&t),
        Err(TopologyError::GroupRefersUnknownFold {
            group: FoldGroupId(0),
            fold: FoldId(2),
        })
    );
}

#[test]
fn duplicate_group_id_is_rejected() {
    let t = Topology::<SquareTessellation>::new(fp(), vec![], vec![group(0, &[]), group(0, &[])]);
    assert_eq!(
        validate(&t),
        Err(TopologyError::DuplicateGroupId {
            group: FoldGroupId(0)
        })
    );
}

#[test]
fn error_message_names_the_fold() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![fold(end(2, 2, N), end(2, 2, N), false, 0)],
        vec![group(0, &[0])],
    );
    assert!(validate(&t).unwrap_err().to_string().contains("fold 0"));
}

#[test]
fn fold_listed_twice_by_one_group_is_rejected() {
    let t = Topology::<SquareTessellation>::new(
        fp(),
        vec![fold(end(0, 0, E), end(1, 0, W), false, 0)],
        vec![group(0, &[0, 0])],
    );
    assert_eq!(
        validate(&t),
        Err(TopologyError::FoldInMultipleGroups {
            fold: FoldId(0),
            group: FoldGroupId(0),
            other: FoldGroupId(0),
        })
    );
}

#[test]
fn clone_preserves_lookup() {
    let t = cylinder(4, 2, false);
    let c = t.clone();
    assert_eq!(c.folds(), t.folds());
    assert_eq!(c.groups(), t.groups());
    assert_eq!(c.fingerprint(), t.fingerprint());
    assert!(c.fold_of(p(3, 0), E).is_some());
}

mod field_resolution {
    use super::*;
    use crate::ids::IdGenerator;
    use crate::space::{Field, SquareFace, square_rect};
    use std::sync::Arc;

    fn field(w: i32, h: i32) -> Field<SquareTessellation> {
        Field::new(
            Arc::default(),
            square_rect(w as usize, h as usize),
            &mut IdGenerator::new(),
        )
        .unwrap()
    }

    fn with(
        mut field: Field<SquareTessellation>,
        topology: SqTopology,
    ) -> Field<SquareTessellation> {
        field.set_topology(topology, &fp()).unwrap();
        field
    }

    fn activity(field: &Field<SquareTessellation>) -> Vec<FoldActivity> {
        field.fold_activity().to_vec()
    }

    fn single(a: FoldEnd<SquarePoint>, b: FoldEnd<SquarePoint>, twist: bool) -> SqTopology {
        Topology::new(fp(), vec![fold(a, b, twist, 0)], vec![group(0, &[0])])
    }

    #[test]
    fn without_folds_neighbor_via_is_base_neighbor() {
        let f = field(3, 3);
        for cell in f.all_cells() {
            for &face in SquareTessellation.faces_of(cell) {
                let base = SquareTessellation.neighbor(cell, face);
                let via = f.neighbor_via(cell, face);
                assert_eq!(base, via.map(|c| (c.cell, c.face)));
                assert!(via.is_none_or(|c| !c.orientation.flips));
            }
        }
    }

    #[test]
    fn active_fold_is_reciprocal_and_changes_neighbors() {
        let f = with(field(4, 3), cylinder(4, 3, false));
        assert!(activity(&f).iter().all(|a| a.is_active()));
        let c = f.neighbor_via(p(3, 1), SquareFace::E).unwrap();
        assert_eq!((c.cell, c.face), (p(0, 1), SquareFace::W));
        let back = f.neighbor_via(c.cell, c.face).unwrap();
        assert_eq!((back.cell, back.face), (p(3, 1), SquareFace::E));
        let node = f.node_at(p(3, 1)).unwrap();
        assert!(f.neighbors(node).contains(&f.node_at(p(0, 1)).unwrap()));
        assert_eq!(f.face_index_toward(p(3, 1), p(0, 1)), Some(E));
    }

    #[test]
    fn twisted_fold_is_reciprocal() {
        let f = with(field(4, 3), single(end(3, 0, E), end(0, 2, W), true));
        let c = f.neighbor_via(p(3, 0), SquareFace::E).unwrap();
        assert_eq!((c.cell, c.face), (p(0, 2), SquareFace::W));
        assert!(c.orientation.flips);
        let back = f.neighbor_via(c.cell, c.face).unwrap();
        assert_eq!((back.cell, back.face), (p(3, 0), SquareFace::E));
        assert!(back.orientation.flips);
    }

    #[test]
    fn transfer_follows_offset_and_flip() {
        // Untwisted seam behaves like an ordinary neighbour: north maps to north. Twisted: north
        // maps to south.
        for (twist, expected) in [(false, SquareFace::N), (true, SquareFace::S)] {
            let f = with(field(4, 3), cylinder(4, 3, twist));
            let c = f.neighbor_via(p(3, 1), SquareFace::E).unwrap();
            assert_eq!(
                c.transfer(&SquareTessellation, p(3, 1), SquareFace::N),
                Some(expected)
            );
            assert_eq!(
                c.transfer(&SquareTessellation, p(3, 1), SquareFace::E),
                Some(SquareFace::W)
            );
        }
    }

    #[test]
    fn transfer_is_none_for_different_face_counts() {
        use crate::space::{SquareOctagonPoint, SquareOctagonTessellation};
        let t = SquareOctagonTessellation;
        let mut checked = false;
        for x in 0..4 {
            for y in 0..4 {
                let cell = SquareOctagonPoint { x, y };
                if !t.is_valid_cell(cell) {
                    continue;
                }
                for &face in t.faces_of(cell) {
                    let (other, back) = t.neighbor(cell, face).unwrap();
                    let c = Crossing {
                        cell: other,
                        face: back,
                        orientation: Orientation {
                            flips: false,
                            entry: face,
                        },
                    };
                    let same = t.faces_of(cell).len() == t.faces_of(other).len();
                    assert_eq!(c.transfer(&t, cell, face).is_some(), same);
                    checked |= !same;
                }
            }
        }
        assert!(checked, "expected a square/octagon crossing");
    }

    #[test]
    fn missing_cell_deactivates() {
        let f = with(field(4, 3), single(end(3, 0, E), end(9, 9, W), false));
        assert_eq!(
            activity(&f),
            vec![FoldActivity::Inactive(InactiveReason::MissingCell)]
        );
        assert_eq!(
            f.neighbor_via(p(3, 0), SquareFace::E).unwrap().cell,
            p(4, 0)
        );
    }

    #[test]
    fn interior_neighbor_deactivates() {
        // (1,0) E faces the in-field cell (2,0).
        let f = with(field(4, 3), single(end(1, 0, E), end(0, 2, W), false));
        assert_eq!(
            activity(&f),
            vec![FoldActivity::Inactive(InactiveReason::InteriorNeighbor)]
        );
        assert_eq!(
            f.neighbor_via(p(1, 0), SquareFace::E).unwrap().cell,
            p(2, 0)
        );
    }

    #[test]
    fn duplicate_neighbor_deactivates() {
        // In a 3x1 field, gluing N of (0,0) to S of (1,0) makes them neighbours twice.
        let f = with(field(3, 1), single(end(0, 0, N), end(1, 0, S), false));
        assert_eq!(
            activity(&f),
            vec![FoldActivity::Inactive(InactiveReason::DuplicateNeighbor)]
        );
    }

    #[test]
    fn activity_follows_field_cell_set() {
        let t = cylinder(4, 3, false);
        let narrow = with(field(3, 3), t.clone());
        assert!(
            activity(&narrow)
                .iter()
                .all(|a| *a == FoldActivity::Inactive(InactiveReason::MissingCell))
        );
        let wide = with(field(4, 3), t);
        assert!(activity(&wide).iter().all(|a| a.is_active()));
    }

    #[test]
    fn set_topology_rejects_fingerprint_mismatch() {
        let mut f = field(4, 3);
        let t = SqTopology::empty(TessellationFingerprint::new("hex{}"));
        assert!(f.set_topology(t, &fp()).is_err());
        assert!(f.topology().is_none());
    }

    #[test]
    fn is_straight_uses_fold_adjacency() {
        // Row of 4 cells glued into a ring: (2,0) -> (3,0) -> (0,0) is straight east-west.
        let f = with(field(4, 1), cylinder(4, 1, false));
        let n = |x| f.node_at(p(x, 0)).unwrap();
        assert!(f.is_straight(n(3), n(0), n(1)));
        assert!(f.is_straight(n(2), n(3), n(0)));
    }

    #[test]
    fn clone_keeps_topology_and_clear_removes_it() {
        let mut f = with(field(4, 3), cylinder(4, 3, false));
        let copy = f.clone();
        f.clear_topology();
        assert!(f.topology().is_none());
        assert!(f.fold_activity().is_empty());
        assert_eq!(
            f.neighbor_via(p(3, 1), SquareFace::E).unwrap().cell,
            p(4, 1)
        );
        assert_eq!(
            copy.neighbor_via(p(3, 1), SquareFace::E).unwrap().cell,
            p(0, 1)
        );
    }

    #[test]
    fn multi_level_forwards_fold_adjacency() {
        use crate::space::MultiLevelField;
        let mut ml = MultiLevelField::<SquareTessellation>::single_level(
            Arc::default(),
            square_rect(4, 3),
            &mut IdGenerator::new(),
        )
        .unwrap();
        let level = ml.single_level_id();
        ml.set_topology(level, cylinder(4, 3, false), &fp())
            .unwrap();
        let c = ml.neighbor_via(level, p(3, 1), SquareFace::E).unwrap();
        assert_eq!((c.cell, c.face), (p(0, 1), SquareFace::W));
        assert_eq!(ml.face_index_toward(level, p(3, 1), p(0, 1)), Some(E));
        let node = ml.node_at(level, p(3, 1)).unwrap();
        assert!(
            ml.neighbors(node)
                .contains(&ml.node_at(level, p(0, 1)).unwrap())
        );
    }

    #[test]
    fn self_glued_cell_faces_activate() {
        // Two faces of one cell glued together: the cell neighbours itself once.
        let f = with(field(3, 3), single(end(1, 1, E), end(1, 1, W), false));
        // (1,1) has in-field ordinary neighbours on E and W, so the gluing is interior.
        assert_eq!(
            activity(&f),
            vec![FoldActivity::Inactive(InactiveReason::InteriorNeighbor)]
        );
        let corner = with(field(1, 1), single(end(0, 0, E), end(0, 0, W), false));
        assert_eq!(activity(&corner), vec![FoldActivity::Active]);
        let c = corner.neighbor_via(p(0, 0), SquareFace::E).unwrap();
        assert_eq!((c.cell, c.face), (p(0, 0), SquareFace::W));
    }

    #[test]
    fn later_fold_losing_a_duplicate_is_inactive() {
        // Both folds would make (0,0) and (3,0) neighbours; only the first wins.
        let t = Topology::new(
            fp(),
            vec![
                fold(end(3, 0, E), end(0, 0, W), false, 0),
                fold(end(3, 0, N), end(0, 0, S), false, 0),
            ],
            vec![group(0, &[0, 1])],
        );
        let f = with(field(4, 1), t);
        assert_eq!(
            activity(&f),
            vec![
                FoldActivity::Active,
                FoldActivity::Inactive(InactiveReason::DuplicateNeighbor)
            ]
        );
    }

    #[test]
    fn ordinary_hex_crossing_transfer_mirrors_across_the_shared_side() {
        use crate::space::{HexFace, HexPoint, HexTessellation};
        let f = Field::new(
            Arc::new(HexTessellation),
            [HexPoint { q: 0, r: 0 }, HexPoint { q: 1, r: 0 }],
            &mut IdGenerator::new(),
        )
        .unwrap();
        let origin = HexPoint { q: 0, r: 0 };
        let c = f.neighbor_via(origin, HexFace::E).unwrap();
        assert_eq!(c.face, HexFace::W);
        // The NE neighbour of the origin is the NW neighbour of the cell to its east.
        assert_eq!(
            c.transfer(&HexTessellation, origin, HexFace::NE),
            Some(HexFace::NW)
        );
        assert_eq!(
            HexTessellation.neighbor(origin, HexFace::NE).unwrap().0,
            HexTessellation.neighbor(c.cell, HexFace::NW).unwrap().0
        );
    }
}
