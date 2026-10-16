use super::{CellShape, ShapeDescriptor, Tessellation};
use std::sync::LazyLock;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct HexPoint {
    pub q: i32,
    pub r: i32,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum HexFace {
    E,
    NE,
    NW,
    W,
    SW,
    SE,
}

impl HexFace {
    /// The face on the other side of the same edge — also the face a straight pass leaves by.
    pub fn opposite(self) -> Self {
        match self {
            HexFace::E => HexFace::W,
            HexFace::NE => HexFace::SW,
            HexFace::NW => HexFace::SE,
            HexFace::W => HexFace::E,
            HexFace::SW => HexFace::NE,
            HexFace::SE => HexFace::NW,
        }
    }
}

static HEX_SHAPES: LazyLock<[ShapeDescriptor; 1]> =
    LazyLock::new(|| [ShapeDescriptor::regular_polygon(6)]);

/// Local `[E, NE, NW, W, SW, SE]` is already counter-clockwise.
const HEX_LOCAL_TO_CANONICAL: [usize; 6] = [0, 1, 2, 3, 4, 5];

#[derive(Debug, Default, Clone, Copy)]
pub struct HexTessellation;

impl Tessellation for HexTessellation {
    type CellId = HexPoint;
    type Face = HexFace;

    fn is_valid_cell(&self, _cell: HexPoint) -> bool {
        true
    }

    fn faces_of(&self, _cell: HexPoint) -> &[HexFace] {
        &[
            HexFace::E,
            HexFace::NE,
            HexFace::NW,
            HexFace::W,
            HexFace::SW,
            HexFace::SE,
        ]
    }

    fn neighbor(&self, cell: HexPoint, face: HexFace) -> Option<(HexPoint, HexFace)> {
        let (dq, dr) = match face {
            HexFace::E => (1, 0),
            HexFace::NE => (1, -1),
            HexFace::NW => (0, -1),
            HexFace::W => (-1, 0),
            HexFace::SW => (-1, 1),
            HexFace::SE => (0, 1),
        };
        let neighbor = HexPoint {
            q: cell.q.checked_add(dq)?,
            r: cell.r.checked_add(dr)?,
        };
        Some((neighbor, face.opposite()))
    }

    fn is_straight(&self, _cell: HexPoint, in_face: HexFace, out_face: HexFace) -> bool {
        out_face == in_face.opposite()
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*HEX_SHAPES
    }

    fn shape_of(&self, _cell: HexPoint) -> Option<CellShape<'_>> {
        Some(CellShape::full(&HEX_SHAPES[0], &HEX_LOCAL_TO_CANONICAL))
    }

    /// Canonical (flat_top-equivalent) projection, unit tile scale. `INRADIUS` = sqrt(3)/2 at
    /// unit tile size — same formula as `maze-web`'s `hexCenter` (flat_top branch), minus the
    /// `TILE_SIZE` pixel scale and any orientation rotation (both display-only, web-side concerns
    /// — see `Tessellation::cartesian`'s doc comment).
    fn cartesian(&self, cell: HexPoint) -> (f64, f64) {
        let inradius = 3f64.sqrt() / 2.0;
        let (q, r) = (cell.q as f64, cell.r as f64);
        (q * 1.5, -(r * inradius * 2.0 + q * inradius))
    }
}

pub fn hex_parallelogram(cols: usize, rows: usize) -> Vec<HexPoint> {
    (0..rows)
        .flat_map(|r| {
            (0..cols).map(move |q| HexPoint {
                q: q as i32,
                r: r as i32,
            })
        })
        .collect()
}

pub fn hex_hexagon(radius: usize) -> Vec<HexPoint> {
    let n = radius as i32;
    (-n..=n)
        .flat_map(move |q| ((-n).max(-q - n)..=n.min(-q + n)).map(move |r| HexPoint { q, r }))
        .collect()
}
