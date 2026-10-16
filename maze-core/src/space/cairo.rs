use super::{CellShape, ShapeDescriptor, Tessellation};
use std::sync::LazyLock;

/// Integer coordinate of a Cairo pentagonal tile.
///
/// The coordinates are the tile-centre coordinates of the standard 4-fold
/// pentille model.  Only four residue/orientation classes are occupied; use
/// [`CairoTessellation::is_valid_cell`] when accepting user-provided cells.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
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

static CAIRO_SHAPES: LazyLock<[ShapeDescriptor; 1]> =
    LazyLock::new(|| [ShapeDescriptor::cairo_pentagon()]);

// `faces_of` per orientation: the canonical counter-clockwise order starting at `Twin` (the long
// side) — the face slots are not in the same circular order on every orientation.
const R_FACES: [CairoFace; 5] = [
    CairoFace::Twin,
    CairoFace::NorthWest,
    CairoFace::SouthEast,
    CairoFace::NorthEast,
    CairoFace::SouthWest,
];
const U_FACES: [CairoFace; 5] = [
    CairoFace::Twin,
    CairoFace::SouthEast,
    CairoFace::NorthEast,
    CairoFace::SouthWest,
    CairoFace::NorthWest,
];
const L_FACES: [CairoFace; 5] = [
    CairoFace::Twin,
    CairoFace::SouthEast,
    CairoFace::SouthWest,
    CairoFace::NorthWest,
    CairoFace::NorthEast,
];
const D_FACES: [CairoFace; 5] = [
    CairoFace::Twin,
    CairoFace::NorthWest,
    CairoFace::SouthWest,
    CairoFace::NorthEast,
    CairoFace::SouthEast,
];

/// `faces_of` is the canonical order on every orientation.
const CAIRO_LOCAL_TO_CANONICAL: [usize; 5] = [0, 1, 2, 3, 4];

#[derive(Debug, Default, Clone, Copy)]
pub struct CairoTessellation;

/// One direct transition: the face, its integer coordinate offset, and the
/// destination cell's face on the same boundary piece.
type Transition = (CairoFace, (i32, i32), CairoFace);

// These are the direct coordinate transitions of the standard Cairo model,
// in `CairoFace` discriminant order (so a face's discriminant indexes its entry).
// They are deliberately tables, rather than a geometric search: every entry
// is an integer offset and every reverse transition appears in the table of
// the destination orientation, as the entry's back face.
const R_OFFSETS: [Transition; 5] = [
    (CairoFace::Twin, (-2, 0), CairoFace::Twin),
    (CairoFace::NorthWest, (-1, -3), CairoFace::NorthEast),
    (CairoFace::NorthEast, (3, 1), CairoFace::NorthWest),
    (CairoFace::SouthEast, (3, -1), CairoFace::NorthWest),
    (CairoFace::SouthWest, (-1, 3), CairoFace::NorthEast),
];
const U_OFFSETS: [Transition; 5] = [
    (CairoFace::Twin, (0, -2), CairoFace::Twin),
    (CairoFace::NorthWest, (-3, -1), CairoFace::NorthEast),
    (CairoFace::NorthEast, (1, 3), CairoFace::NorthWest),
    (CairoFace::SouthEast, (3, -1), CairoFace::SouthWest),
    (CairoFace::SouthWest, (-1, 3), CairoFace::NorthEast),
];
const L_OFFSETS: [Transition; 5] = [
    (CairoFace::Twin, (2, 0), CairoFace::Twin),
    (CairoFace::NorthWest, (-3, -1), CairoFace::SouthEast),
    (CairoFace::NorthEast, (1, -3), CairoFace::SouthWest),
    (CairoFace::SouthEast, (1, 3), CairoFace::SouthWest),
    (CairoFace::SouthWest, (-3, 1), CairoFace::SouthEast),
];
const D_OFFSETS: [Transition; 5] = [
    (CairoFace::Twin, (0, 2), CairoFace::Twin),
    (CairoFace::NorthWest, (-3, 1), CairoFace::SouthEast),
    (CairoFace::NorthEast, (1, -3), CairoFace::SouthWest),
    (CairoFace::SouthEast, (3, 1), CairoFace::NorthWest),
    (CairoFace::SouthWest, (-1, -3), CairoFace::SouthEast),
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
    fn offsets(cell: CairoPoint) -> Option<&'static [Transition; 5]> {
        match Self::tile_kind(cell)? {
            CairoTileKind::R => Some(&R_OFFSETS),
            CairoTileKind::U => Some(&U_OFFSETS),
            CairoTileKind::L => Some(&L_OFFSETS),
            CairoTileKind::D => Some(&D_OFFSETS),
        }
    }

    fn transition(cell: CairoPoint, face: CairoFace) -> Option<Transition> {
        let transition = Self::offsets(cell)?[face as usize];
        debug_assert!(
            transition.0 == face,
            "Cairo transition tables must follow CairoFace discriminant order"
        );
        Some(transition)
    }

    fn offset_point(cell: CairoPoint, (dx, dy): (i32, i32)) -> Option<CairoPoint> {
        Some(CairoPoint {
            x: cell.x.checked_add(dx)?,
            y: cell.y.checked_add(dy)?,
        })
    }

    /// Returns the occupied orientation class for `cell`, or `None` for one
    /// of the unused coordinate pairs in the enclosing integer grid.
    pub fn tile_kind(cell: CairoPoint) -> Option<CairoTileKind> {
        // `div_euclid`/`rem_euclid` are important here: Rust's truncating
        // division would classify cells left/below the origin differently.
        let cell_x = cell.x.div_euclid(4) as i64;
        let cell_y = cell.y.div_euclid(4) as i64;
        let x = cell.x.rem_euclid(4);
        let y = cell.y.rem_euclid(4);

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

    pub fn is_valid_cell(cell: CairoPoint) -> bool {
        Self::tile_kind(cell).is_some()
    }

    /// A rectangular collection of Cairo cells made from `cols * rows`
    /// fundamental 4-by-4 squares.  Each square contributes its two tiles;
    /// callers wanting an arbitrary shape can pass any subset of the same
    /// integer cells directly to `Field::new`.
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
    type CellId = CairoPoint;
    type Face = CairoFace;

    fn is_valid_cell(&self, cell: CairoPoint) -> bool {
        CairoTessellation::is_valid_cell(cell)
    }

    fn faces_of(&self, cell: CairoPoint) -> &[CairoFace] {
        debug_assert!(
            Self::is_valid_cell(cell),
            "faces_of: invalid Cairo cell {cell:?}"
        );
        match Self::tile_kind(cell) {
            Some(CairoTileKind::R) => &R_FACES,
            Some(CairoTileKind::U) => &U_FACES,
            Some(CairoTileKind::L) => &L_FACES,
            Some(CairoTileKind::D) => &D_FACES,
            None => &[],
        }
    }

    fn neighbor(&self, cell: CairoPoint, face: CairoFace) -> Option<(CairoPoint, CairoFace)> {
        debug_assert!(
            Self::is_valid_cell(cell),
            "neighbor: invalid Cairo cell {cell:?}"
        );
        let (_, offset, back_face) = Self::transition(cell, face)?;
        Some((Self::offset_point(cell, offset)?, back_face))
    }

    /// Face-identity semantics: a pass is straight when the face it leaves by has the same slot
    /// as the face of the previous cell it entered through.
    fn is_straight(&self, cell: CairoPoint, in_face: CairoFace, out_face: CairoFace) -> bool {
        debug_assert!(
            Self::is_valid_cell(cell),
            "is_straight: invalid Cairo cell {cell:?}"
        );
        Self::transition(cell, in_face)
            .is_some_and(|(_, _, previous_face)| previous_face == out_face)
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*CAIRO_SHAPES
    }

    fn shape_of(&self, cell: CairoPoint) -> Option<CellShape<'_>> {
        debug_assert!(
            Self::is_valid_cell(cell),
            "shape_of: invalid Cairo cell {cell:?}"
        );
        Self::tile_kind(cell)?;
        Some(CellShape::full(&CAIRO_SHAPES[0], &CAIRO_LOCAL_TO_CANONICAL))
    }

    /// Canonical unit-scale projection of the integer tile-centre coordinate.
    /// The coordinate model is intentionally affine: translation and
    /// reflection are left to the rendering layer, as with the other core
    /// tessellations.
    fn cartesian(&self, cell: CairoPoint) -> (f64, f64) {
        (cell.x as f64, cell.y as f64)
    }
}

pub fn cairo_rect(cols: usize, rows: usize) -> Vec<CairoPoint> {
    CairoTessellation::rect(cols, rows)
}
