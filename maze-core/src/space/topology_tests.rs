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
