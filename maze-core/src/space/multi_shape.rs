//! Scaffolding shared by the multi-shape tessellations built on an anchor lattice: a cell id is an
//! anchor `(q, r)` plus a kind, every cell is a regular polygon of side 1, and the cells of one
//! kind share a [`ShapeDescriptor`]. Covers the cell id and face types, the wire encoding, shape
//! lookup, candidate enumeration and the preset field shapes.

use super::field_ops::{
    CIRCLE_PRESET, Inclusion, RECT_PRESET, TRIANGLE_PRESET, circle_cells, convex_cells, param,
    triangle_cells,
};
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, ShapeDescriptor, Tessellation,
    validate_preset,
};
use std::collections::HashSet;
use std::fmt::Debug;
use std::hash::Hash;
use std::ops::RangeInclusive;

pub(super) const SQRT_3: f64 = 1.732_050_807_568_877_2;

/// What kinds of cell a tessellation anchors at one lattice point; implemented by the kind enums.
pub trait CellKind: Copy + Eq + Ord + Hash + Debug + 'static {
    /// Every kind, in wire order.
    fn all() -> &'static [Self];

    /// Position in the wire encoding.
    fn index(self) -> usize;
}

/// Implements [`CellKind`] for a kind enum with an inherent `ALL` array and `index`.
macro_rules! impl_cell_kind {
    ($kind:ty) => {
        impl $crate::space::multi_shape::CellKind for $kind {
            fn all() -> &'static [Self] {
                &Self::ALL
            }

            fn index(self) -> usize {
                <$kind>::index(self)
            }
        }
    };
}
pub(super) use impl_cell_kind;

/// A cell: the anchor lattice point `(q, r)` and the kind of cell anchored there.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct AnchoredPoint<K> {
    pub q: i32,
    pub r: i32,
    pub kind: K,
}

impl<K: CellKind> AnchoredPoint<K> {
    pub const fn new(q: i32, r: i32, kind: K) -> Self {
        Self { q, r, kind }
    }

    /// Wire encoding as an integer pair: `x = k·q + kind index` with `k` the number of kinds,
    /// `y = r`. Every pair decodes to a cell. Coordinates beyond `±i32::MAX / k` in `q` do not fit
    /// the wire and wrap.
    pub fn to_xy(self) -> (i32, i32) {
        (
            self.q
                .wrapping_mul(K::all().len() as i32)
                .wrapping_add(self.kind.index() as i32),
            self.r,
        )
    }

    /// Inverse of [`to_xy`](Self::to_xy).
    pub fn from_xy(x: i32, y: i32) -> Self {
        let kinds = K::all().len() as i32;
        Self {
            q: x.div_euclid(kinds),
            r: y,
            kind: K::all()[x.rem_euclid(kinds) as usize],
        }
    }
}

/// A side of a cell: its position in `faces_of`, counter-clockwise from the cell's first vertex.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct CellFace(u8);

impl CellFace {
    pub const fn new(index: u8) -> Self {
        Self(index)
    }

    pub fn index(self) -> usize {
        self.0 as usize
    }
}

/// Most faces any supported cell has.
const MAX_FACES: usize = 12;

static FACES: [CellFace; MAX_FACES] = {
    let mut faces = [CellFace(0); MAX_FACES];
    let mut i = 0;
    while i < MAX_FACES {
        faces[i] = CellFace(i as u8);
        i += 1;
    }
    faces
};

static IDENTITY: [usize; MAX_FACES] = {
    let mut identity = [0; MAX_FACES];
    let mut i = 0;
    while i < MAX_FACES {
        identity[i] = i;
        i += 1;
    }
    identity
};

/// The faces `0..n` of a polygon cell, counter-clockwise.
pub(super) fn polygon_faces(n: usize) -> &'static [CellFace] {
    &FACES[..n]
}

/// One regular-polygon template per side count in `sides`.
pub(super) fn regular_shapes<const N: usize>(sides: [usize; N]) -> [ShapeDescriptor; N] {
    sides.map(ShapeDescriptor::regular_polygon)
}

/// The shape of a regular polygon cell with `n` faces, among `shapes` (distinct side counts).
/// `faces_of` is already the canonical counter-clockwise order, so the local-to-canonical map is
/// the identity.
pub(super) fn regular_cell_shape(shapes: &[ShapeDescriptor], n: usize) -> CellShape<'_> {
    let descriptor = shapes
        .iter()
        .find(|descriptor| descriptor.face_count() == n)
        .expect("every cell kind has a shape template");
    CellShape::full(descriptor, &IDENTITY[..n])
}

/// Area of a regular `n`-gon of side 1.
pub(super) fn regular_polygon_area(n: usize) -> f64 {
    let n = n as f64;
    n / (4.0 * (std::f64::consts::PI / n).tan())
}

/// Whether `out_face` is the face opposite `in_face` of a polygon with `count` faces.
pub(super) fn is_opposite_face(count: usize, in_face: usize, out_face: usize) -> bool {
    out_face == (in_face + count / 2) % count
}

/// The query box `min`–`max` grown by `reach` on every side, ordered. `reach` is the farthest a
/// vertex of any cell lies from its anchor, plus a margin so a cell touching the box only at a
/// vertex is still a candidate.
pub(super) fn expanded_box(min: Point, max: Point, reach: f64) -> (Point, Point) {
    (
        Point::new(min.x.min(max.x) - reach, min.y.min(max.y) - reach),
        Point::new(min.x.max(max.x) + reach, min.y.max(max.y) + reach),
    )
}

/// All `kinds` kinds of every anchor `(outer, inner)`, `inner` ranging over `inner_range(outer)`;
/// `None` when that would exceed `limit` cells. `make` builds a cell id from the outer coordinate,
/// the inner coordinate and the kind index.
pub(super) fn anchor_cells<T>(
    outer: RangeInclusive<i32>,
    inner_range: impl Fn(i32) -> RangeInclusive<i32>,
    kinds: usize,
    limit: usize,
    make: impl Fn(i32, i32, usize) -> T,
) -> Option<Vec<T>> {
    let count: i64 = outer
        .clone()
        .map(|o| {
            let inner = inner_range(o);
            kinds as i64 * (*inner.end() as i64 - *inner.start() as i64 + 1).max(0)
        })
        .sum();
    if count > i64::try_from(limit).unwrap_or(i64::MAX) {
        return None;
    }
    let make = &make;
    let inner_range = &inner_range;
    Some(
        outer
            .flat_map(|o| {
                inner_range(o).flat_map(move |i| (0..kinds).map(move |kind| make(o, i, kind)))
            })
            .collect(),
    )
}

/// Preset field shapes, in UI order.
pub(super) const PRESETS: [PresetDescriptor; 3] = [RECT_PRESET, CIRCLE_PRESET, TRIANGLE_PRESET];

/// Cells of the `rect`, `circle` or `triangle` preset around `origin`; `rect` builds its own
/// cells, `triangle` uses `triangle_inclusion`.
pub(super) fn preset_cells<T: Tessellation>(
    tessellation: &T,
    key: &str,
    params: PresetParams<'_>,
    origin: Point,
    triangle_inclusion: Inclusion,
    rect: impl FnOnce() -> Result<Vec<T::CellId>, FieldOpError>,
) -> Result<Vec<T::CellId>, FieldOpError> {
    validate_preset(&PRESETS, key, params)?;
    match key {
        "rect" => rect(),
        "circle" => circle_cells(
            tessellation,
            origin,
            param(params, "radius"),
            Inclusion::Center,
        ),
        "triangle" => triangle_cells(
            tessellation,
            origin,
            param(params, "side"),
            triangle_inclusion,
        ),
        _ => Err(FieldOpError::Unavailable),
    }
}

/// The whole cells inside `cols × rows` anchor pitches (`pitch.x` and `pitch.y` wide), centered
/// on `origin`.
pub(super) fn lattice_rect_cells<T: Tessellation>(
    tessellation: &T,
    params: PresetParams<'_>,
    origin: Point,
    pitch: Point,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let half = Point::new(
        param(params, "cols") as f64 * pitch.x / 2.0,
        param(params, "rows") as f64 * pitch.y / 2.0,
    );
    let corners = [
        origin + Point::new(-half.x, -half.y),
        origin + Point::new(half.x, -half.y),
        origin + half,
        origin + Point::new(-half.x, half.y),
    ];
    convex_cells(
        tessellation,
        origin,
        &corners,
        half.x.hypot(half.y),
        Inclusion::WholeCell,
    )
}

/// Keeps the anchor cells and every other cell bordering a kept anchor cell: one cut off from all
/// anchor cells of the shape would not be reachable from the rest of the field. Errors when
/// nothing is left.
pub(super) fn retain_attached<T: Tessellation>(
    tessellation: &T,
    cells: &mut Vec<T::CellId>,
    is_anchor_cell: impl Fn(T::CellId) -> bool,
) -> Result<(), FieldOpError> {
    let kept: HashSet<_> = cells
        .iter()
        .copied()
        .filter(|&c| is_anchor_cell(c))
        .collect();
    cells.retain(|&c| {
        is_anchor_cell(c)
            || tessellation.faces_of(c).iter().any(|&f| {
                tessellation
                    .neighbor(c, f)
                    .is_some_and(|(n, _)| kept.contains(&n))
            })
    });
    if cells.is_empty() {
        return Err(FieldOpError::InvalidPreset(
            "the shape contains no cells".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{
        RhombitrihexagonalKind, SnubHexagonalKind, SnubSquareKind, TrihexagonalKind,
        TruncatedHexagonalKind, TruncatedTrihexagonalKind,
    };

    /// Wire round trip over a window of anchors, negative ones included, for every kind of `K`.
    fn assert_wire_round_trip<K: CellKind>() {
        for q in -4..=4 {
            for r in -4..=4 {
                for &kind in K::all() {
                    let cell = AnchoredPoint::new(q, r, kind);
                    let (x, y) = cell.to_xy();
                    assert_eq!(AnchoredPoint::<K>::from_xy(x, y), cell);
                }
            }
        }
        // Every wire pair decodes to a cell: `-1` is the last kind of anchor `-1`.
        let last = *K::all().last().unwrap();
        assert_eq!(
            AnchoredPoint::<K>::from_xy(-1, 4),
            AnchoredPoint::new(-1, 4, last)
        );
    }

    /// `to_xy` wraps `q` beyond `±i32::MAX / kinds` instead of panicking, and no longer round
    /// trips there.
    fn assert_wire_wraps<K: CellKind>() {
        let kinds = K::all().len() as i32;
        let first = K::all()[0];
        let inside = AnchoredPoint::new(i32::MAX / kinds, 0, first);
        let (x, y) = inside.to_xy();
        assert_eq!(AnchoredPoint::<K>::from_xy(x, y), inside);
        let outside = AnchoredPoint::new(i32::MAX / kinds + 1, 0, first);
        let (x, y) = outside.to_xy();
        assert_ne!(AnchoredPoint::<K>::from_xy(x, y), outside);
    }

    /// `all()` lists the kinds in discriminant order, so `index` is the position in `all()`.
    fn assert_index_follows_all<K: CellKind>() {
        for (position, &kind) in K::all().iter().enumerate() {
            assert_eq!(kind.index(), position);
        }
    }

    #[test]
    fn wire_encoding_holds_for_every_kind_set() {
        assert_wire_round_trip::<TrihexagonalKind>();
        assert_wire_round_trip::<SnubHexagonalKind>();
        assert_wire_round_trip::<SnubSquareKind>();
        assert_wire_round_trip::<RhombitrihexagonalKind>();
        assert_wire_round_trip::<TruncatedHexagonalKind>();
        assert_wire_round_trip::<TruncatedTrihexagonalKind>();
        assert_wire_wraps::<TrihexagonalKind>();
        assert_wire_wraps::<SnubHexagonalKind>();
        assert_wire_wraps::<SnubSquareKind>();
        assert_wire_wraps::<RhombitrihexagonalKind>();
        assert_wire_wraps::<TruncatedHexagonalKind>();
        assert_wire_wraps::<TruncatedTrihexagonalKind>();
        assert_index_follows_all::<TrihexagonalKind>();
        assert_index_follows_all::<SnubHexagonalKind>();
        assert_index_follows_all::<SnubSquareKind>();
        assert_index_follows_all::<RhombitrihexagonalKind>();
        assert_index_follows_all::<TruncatedHexagonalKind>();
        assert_index_follows_all::<TruncatedTrihexagonalKind>();
    }

    #[test]
    fn regular_polygon_area_matches_the_closed_forms() {
        let close = |a: f64, b: f64| (a - b).abs() < 1e-12;
        assert!(close(regular_polygon_area(3), SQRT_3 / 4.0));
        assert!(close(regular_polygon_area(4), 1.0));
        assert!(close(regular_polygon_area(6), 3.0 * SQRT_3 / 2.0));
        assert!(close(regular_polygon_area(12), 3.0 * (2.0 + SQRT_3)));
    }

    #[test]
    fn polygon_faces_and_shapes_follow_the_face_count() {
        let shapes = regular_shapes([6, 4, 3]);
        for (n, shape) in [(6, 0), (4, 1), (3, 2)] {
            let indices: Vec<usize> = polygon_faces(n).iter().map(|f| f.index()).collect();
            assert_eq!(indices, (0..n).collect::<Vec<_>>());
            let cell_shape = regular_cell_shape(&shapes, n);
            assert_eq!(cell_shape.descriptor(), &shapes[shape]);
            assert_eq!(cell_shape.local_to_canonical(), indices.as_slice());
        }
    }

    #[test]
    fn opposite_face_is_half_a_turn_ahead() {
        assert!(is_opposite_face(6, 1, 4));
        assert!(is_opposite_face(4, 3, 1));
        assert!(is_opposite_face(12, 7, 1));
        assert!(!is_opposite_face(6, 1, 3));
    }

    #[test]
    fn expanded_box_orders_corners_and_grows_by_reach() {
        let (lo, hi) = expanded_box(Point::new(3.0, -1.0), Point::new(-2.0, 5.0), 0.5);
        assert_eq!((lo.x, lo.y, hi.x, hi.y), (-2.5, -1.5, 3.5, 5.5));
    }

    #[test]
    fn anchor_cells_enumerates_outer_then_inner_then_kind() {
        let cells = anchor_cells(0..=1, |o| o..=o + 1, 2, 100, |o, i, k| (o, i, k)).unwrap();
        assert_eq!(
            cells,
            vec![
                (0, 0, 0),
                (0, 0, 1),
                (0, 1, 0),
                (0, 1, 1),
                (1, 1, 0),
                (1, 1, 1),
                (1, 2, 0),
                (1, 2, 1),
            ]
        );
    }

    #[test]
    fn anchor_cells_respects_the_limit_and_empty_ranges() {
        let make = |o, i, k| (o, i, k);
        assert!(anchor_cells(0..=1, |_| 0..=1, 2, 7, make).is_none());
        assert_eq!(anchor_cells(0..=1, |_| 0..=1, 2, 8, make).unwrap().len(), 8);
        // An empty inner range (end before start) holds no anchors and counts as zero.
        assert_eq!(anchor_cells(0..=1, |_| 1..=0, 2, 0, make), Some(vec![]));
    }

    #[test]
    fn retain_attached_drops_cells_cut_off_from_every_anchor_cell() {
        use crate::space::{
            TruncatedHexagonalKind as K, TruncatedHexagonalPoint as P,
            TruncatedHexagonalTessellation,
        };
        let t = TruncatedHexagonalTessellation;
        let beside = P::new(0, 0, K::TriangleUp);
        let far = P::new(9, 9, K::TriangleUp);
        let mut cells = vec![P::dodecagon(0, 0), beside, far];
        retain_attached(&t, &mut cells, |c| c.is_dodecagon()).unwrap();
        assert_eq!(cells, vec![P::dodecagon(0, 0), beside]);

        let mut lonely = vec![far];
        assert!(retain_attached(&t, &mut lonely, |c| c.is_dodecagon()).is_err());
    }
}
