use super::square::{cell_range, grid_candidates};
use super::{CellShape, Point, Segment, ShapeDescriptor, Tessellation};
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

    /// Geometric semantics: the contact points of two faces are never collinear with the
    /// pentagon's centroid, so no pass through a Cairo cell is straight.
    fn is_straight(&self, cell: CairoPoint, _in_face: CairoFace, _out_face: CairoFace) -> bool {
        debug_assert!(
            Self::is_valid_cell(cell),
            "is_straight: invalid Cairo cell {cell:?}"
        );
        false
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

    /// Area centroid of the cell's pentagon.
    fn center(&self, cell: CairoPoint) -> Point {
        let vertices = cairo_vertices(cell);
        let (mut cx, mut cy, mut doubled_area) = (0.0, 0.0, 0.0);
        for k in 0..5 {
            let (a, b) = (vertices[k], vertices[(k + 1) % 5]);
            let cross = a.cross(b);
            doubled_area += cross;
            cx += (a.x + b.x) * cross;
            cy += (a.y + b.y) * cross;
        }
        Point::new(cx / (3.0 * doubled_area), cy / (3.0 * doubled_area))
    }

    fn face_segments(&self, cell: CairoPoint, face: CairoFace) -> Vec<Segment> {
        let Some(kind) = Self::tile_kind(cell) else {
            return Vec::new();
        };
        let vertices = cairo_vertices(cell);
        let edge = CAIRO_FACE_EDGES[kind_index(kind)][face as usize];
        vec![Segment::line(vertices[edge], vertices[(edge + 1) % 5])]
    }

    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<CairoPoint>> {
        let (lo, hi) = (
            Point::new(min.x.min(max.x), min.y.min(max.y)),
            Point::new(min.x.max(max.x), min.y.max(max.y)),
        );
        // Vertices lie within `CAIRO_REACH` lattice units of `3 · (x, y)`.
        let span = |lo: f64, hi: f64| {
            cell_range(
                (lo / CAIRO_UNIT - CAIRO_REACH) / 3.0,
                (hi / CAIRO_UNIT + CAIRO_REACH) / 3.0 + 1.0,
            )
        };
        let cells = grid_candidates(span(lo.x, hi.x), span(lo.y, hi.y), limit, CairoPoint::new)?;
        Some(
            cells
                .into_iter()
                .filter(|&cell| Self::is_valid_cell(cell))
                .collect(),
        )
    }

    fn area(&self, _cell: CairoPoint) -> f64 {
        1.0
    }
}

/// World length of one Cairo lattice unit. The lattice is the integer grid of the classic
/// pentagon model: a cell's vertices are `3 · (x, y)` plus its rotated base pentagon plus an
/// orientation offset, all integers, so every shared vertex is identical from each side. The base
/// pentagon has lattice area 72; `72 · CAIRO_UNIT² = 1`.
const CAIRO_UNIT: f64 = std::f64::consts::SQRT_2 / 12.0;

/// Upper bound of a vertex's lattice distance (per axis) from `3 · (x, y)`.
const CAIRO_REACH: f64 = 11.0;

/// Base pentagon, counter-clockwise, long side (`Twin`) last: `(-4, 0) -> (4, 0)`.
const CAIRO_BASE: [(i64, i64); 5] = [(4, 0), (6, 6), (0, 8), (-6, 6), (-4, 0)];

fn kind_index(kind: CairoTileKind) -> usize {
    match kind {
        CairoTileKind::U => 0,
        CairoTileKind::L => 1,
        CairoTileKind::D => 2,
        CairoTileKind::R => 3,
    }
}

/// The cell's pentagon, counter-clockwise: the base pentagon turned by `kind_index` quarter turns
/// counter-clockwise, shifted by the orientation offset (3 lattice units away from the long side).
fn cairo_vertices(cell: CairoPoint) -> [Point; 5] {
    let kind = CairoTessellation::tile_kind(cell).expect("cairo_vertices: invalid Cairo cell");
    let turns = kind_index(kind);
    let (ox, oy) = match kind {
        CairoTileKind::U => (0, -3),
        CairoTileKind::L => (3, 0),
        CairoTileKind::D => (0, 3),
        CairoTileKind::R => (-3, 0),
    };
    let (ax, ay) = (3 * cell.x as i64 + ox, 3 * cell.y as i64 + oy);
    CAIRO_BASE.map(|(mut x, mut y)| {
        for _ in 0..turns {
            (x, y) = (-y, x);
        }
        Point::new(CAIRO_UNIT * (ax + x) as f64, CAIRO_UNIT * (ay + y) as f64)
    })
}

/// A representative cell per orientation (`kind_index` order).
const CAIRO_REPRESENTATIVES: [CairoPoint; 4] = [
    CairoPoint::new(2, 3),
    CairoPoint::new(5, 2),
    CairoPoint::new(2, 1),
    CairoPoint::new(7, 2),
];

/// Per orientation and face (discriminant order), the index `k` of the pentagon edge
/// `vertices[k] -> vertices[k + 1]` the face is: the edge whose endpoints are both vertices of
/// the face's neighbor.
static CAIRO_FACE_EDGES: LazyLock<[[usize; 5]; 4]> = LazyLock::new(|| {
    CAIRO_REPRESENTATIVES.map(|cell| {
        let vertices = cairo_vertices(cell);
        let mut edges = [0; 5];
        for (face, transition) in CairoTessellation::offsets(cell).unwrap().iter().enumerate() {
            let other =
                cairo_vertices(CairoTessellation::offset_point(cell, transition.1).unwrap());
            edges[face] = (0..5)
                .find(|&k| other.contains(&vertices[k]) && other.contains(&vertices[(k + 1) % 5]))
                .expect("every Cairo face shares an edge with its neighbor");
        }
        edges
    })
});

pub fn cairo_rect(cols: usize, rows: usize) -> Vec<CairoPoint> {
    CairoTessellation::rect(cols, rows)
}
