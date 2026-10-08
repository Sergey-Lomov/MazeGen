use super::Tessellation;

/// Integer coordinate of a Cairo pentagonal tile.
///
/// The coordinates are the tile-centre coordinates of the standard 4-fold
/// pentille model.  Only four residue/orientation classes are occupied; use
/// [`CairoTessellation::is_valid_point`] when accepting user-provided points.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct CairoPoint {
    pub x: i32,
    pub y: i32,
}

/// The five sides of a Cairo pentagon.
///
/// `Twin` is the unique long-side neighbour.  The remaining four names are
/// stable face slots rather than global compass directions: their coordinate
/// offsets depend on the tile's one of four orientations.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum CairoFace {
    Twin,
    NorthWest,
    NorthEast,
    SouthEast,
    SouthWest,
}

impl CairoFace {
    /// Alias useful when describing the long edge geometrically.
    #[allow(non_upper_case_globals)]
    pub const Long: Self = Self::Twin;
}

/// One of the four orientations in the periodic Cairo tiling.
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum CairoTileKind {
    L,
    R,
    U,
    D,
}

pub struct CairoTessellation;

const FACES: [CairoFace; 5] = [
    CairoFace::Twin,
    CairoFace::NorthWest,
    CairoFace::NorthEast,
    CairoFace::SouthEast,
    CairoFace::SouthWest,
];

// These are the direct coordinate transitions of the standard Cairo model.
// They are deliberately tables, rather than a geometric search: every entry
// is an integer offset and every reverse transition appears in the table of
// the destination orientation.
const R_OFFSETS: [(CairoFace, (i32, i32)); 5] = [
    (CairoFace::Twin, (-2, 0)),
    (CairoFace::NorthWest, (-1, -3)),
    (CairoFace::NorthEast, (3, 1)),
    (CairoFace::SouthEast, (3, -1)),
    (CairoFace::SouthWest, (-1, 3)),
];
const U_OFFSETS: [(CairoFace, (i32, i32)); 5] = [
    (CairoFace::Twin, (0, -2)),
    (CairoFace::NorthWest, (-3, -1)),
    (CairoFace::NorthEast, (1, 3)),
    (CairoFace::SouthEast, (3, -1)),
    (CairoFace::SouthWest, (-1, 3)),
];
const L_OFFSETS: [(CairoFace, (i32, i32)); 5] = [
    (CairoFace::Twin, (2, 0)),
    (CairoFace::NorthWest, (-3, -1)),
    (CairoFace::NorthEast, (1, -3)),
    (CairoFace::SouthEast, (1, 3)),
    (CairoFace::SouthWest, (-3, 1)),
];
const D_OFFSETS: [(CairoFace, (i32, i32)); 5] = [
    (CairoFace::Twin, (0, 2)),
    (CairoFace::NorthWest, (-3, 1)),
    (CairoFace::NorthEast, (1, -3)),
    (CairoFace::SouthEast, (3, 1)),
    (CairoFace::SouthWest, (-1, -3)),
];

impl CairoPoint {
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    pub fn kind(self) -> Option<CairoTileKind> {
        CairoTessellation::tile_kind(self)
    }
}

impl CairoTessellation {
    fn offsets(point: CairoPoint) -> Option<&'static [(CairoFace, (i32, i32)); 5]> {
        match Self::tile_kind(point)? {
            CairoTileKind::R => Some(&R_OFFSETS),
            CairoTileKind::U => Some(&U_OFFSETS),
            CairoTileKind::L => Some(&L_OFFSETS),
            CairoTileKind::D => Some(&D_OFFSETS),
        }
    }

    fn offset_point(point: CairoPoint, (dx, dy): (i32, i32)) -> Option<CairoPoint> {
        Some(CairoPoint {
            x: point.x.checked_add(dx)?,
            y: point.y.checked_add(dy)?,
        })
    }

    /// Returns the occupied orientation class for `point`, or `None` for one
    /// of the unused coordinate pairs in the enclosing integer grid.
    pub fn tile_kind(point: CairoPoint) -> Option<CairoTileKind> {
        // `div_euclid`/`rem_euclid` are important here: Rust's truncating
        // division would classify points left/below the origin differently.
        let cell_x = point.x.div_euclid(4) as i64;
        let cell_y = point.y.div_euclid(4) as i64;
        let x = point.x.rem_euclid(4);
        let y = point.y.rem_euclid(4);

        if (cell_x + cell_y).rem_euclid(2) == 1 {
            match (x, y) {
                (1, 2) => Some(CairoTileKind::L),
                (3, 2) => Some(CairoTileKind::R),
                _ => None,
            }
        } else {
            match (x, y) {
                (2, 1) => Some(CairoTileKind::D),
                (2, 3) => Some(CairoTileKind::U),
                _ => None,
            }
        }
    }

    pub fn is_valid_point(point: CairoPoint) -> bool {
        Self::tile_kind(point).is_some()
    }

    /// The five direct transitions from `point`, in [`Tessellation::faces`]
    /// order.  This helper is useful to geometry/rendering code that needs the
    /// face alongside the destination point.
    pub fn face_neighbors(point: CairoPoint) -> Option<[(CairoFace, CairoPoint); 5]> {
        let offsets = Self::offsets(point)?;
        let mut neighbors = [(CairoFace::Twin, CairoPoint::new(0, 0)); 5];
        for (index, (face, offset)) in offsets.iter().copied().enumerate() {
            neighbors[index] = (face, Self::offset_point(point, offset)?);
        }
        Some(neighbors)
    }

    /// A rectangular collection of Cairo cells made from `cols * rows`
    /// fundamental 4-by-4 squares.  Each square contributes its two tiles;
    /// callers wanting an arbitrary shape can pass any subset of the same
    /// integer points directly to `Field::new`.
    pub fn rect(cols: usize, rows: usize) -> Vec<CairoPoint> {
        (0..rows)
            .flat_map(|cell_y| {
                (0..cols).flat_map(move |cell_x| {
                    let x = (cell_x as i32) * 4;
                    let y = (cell_y as i32) * 4;
                    if (cell_x + cell_y) % 2 == 1 {
                        vec![CairoPoint::new(x + 1, y + 2), CairoPoint::new(x + 3, y + 2)]
                    } else {
                        vec![CairoPoint::new(x + 2, y + 1), CairoPoint::new(x + 2, y + 3)]
                    }
                })
            })
            .collect()
    }
}

impl Tessellation for CairoTessellation {
    type Point = CairoPoint;
    type Face = CairoFace;

    fn step(point: CairoPoint, face: CairoFace) -> Option<CairoPoint> {
        let offsets = Self::offsets(point)?;
        let (_, offset) = offsets.iter().find(|(candidate, _)| *candidate == face)?;
        Self::offset_point(point, *offset)
    }

    fn is_valid_point(point: CairoPoint) -> bool {
        CairoTessellation::is_valid_point(point)
    }

    fn faces() -> &'static [CairoFace] {
        &FACES
    }

    fn face_between(from: CairoPoint, to: CairoPoint) -> Option<CairoFace> {
        let offsets = Self::offsets(from)?;
        if !Self::is_valid_point(to) {
            return None;
        }
        let delta = (to.x.checked_sub(from.x)?, to.y.checked_sub(from.y)?);
        offsets
            .iter()
            .find_map(|(face, offset)| (*offset == delta).then_some(*face))
    }

    /// The Cairo pentagon has no non-trivial rotational symmetry.  Its one
    /// reflection fixes the long side and swaps the two pairs of short sides.
    fn rotation_symmetries() -> &'static [&'static [usize]] {
        &[&[0, 1, 2, 3, 4]]
    }

    fn mirror_symmetries() -> &'static [&'static [usize]] {
        &[&[0, 4, 3, 2, 1]]
    }

    /// Canonical unit-scale projection of the integer tile-centre coordinate.
    /// The coordinate model is intentionally affine: translation and
    /// reflection are left to the rendering layer, as with the other core
    /// tessellations.
    fn cartesian(point: CairoPoint) -> (f64, f64) {
        (point.x as f64, point.y as f64)
    }
}

pub fn cairo_rect(cols: usize, rows: usize) -> Vec<CairoPoint> {
    CairoTessellation::rect(cols, rows)
}
