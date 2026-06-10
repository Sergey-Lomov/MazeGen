use super::Tessellation;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct TriPoint {
    pub col: i32,
    pub row: i32,
}

#[derive(Copy, Clone, PartialEq)]
pub enum TriFace {
    Left,
    Right,
    Base,
}

pub struct TriTessellation;

impl Tessellation for TriTessellation {
    type Point = TriPoint;
    type Face = TriFace;

    fn step(point: TriPoint, face: TriFace) -> TriPoint {
        let pointing_up = (point.col + point.row).rem_euclid(2) == 0;
        match face {
            TriFace::Left  => TriPoint { col: point.col - 1, row: point.row },
            TriFace::Right => TriPoint { col: point.col + 1, row: point.row },
            TriFace::Base  => if pointing_up {
                TriPoint { col: point.col, row: point.row - 1 }
            } else {
                TriPoint { col: point.col, row: point.row + 1 }
            },
        }
    }

    fn faces() -> &'static [TriFace] {
        &[TriFace::Left, TriFace::Right, TriFace::Base]
    }

    fn face_between(from: TriPoint, to: TriPoint) -> Option<TriFace> {
        let pointing_up = (from.col + from.row).rem_euclid(2) == 0;
        match (to.col - from.col, to.row - from.row) {
            (-1, 0) => Some(TriFace::Left),
            (1, 0)  => Some(TriFace::Right),
            (0, dy) if (pointing_up && dy == -1) || (!pointing_up && dy == 1) => Some(TriFace::Base),
            _ => None,
        }
    }

}

pub fn tri_rect(cols: usize, rows: usize) -> Vec<TriPoint> {
    (0..rows)
        .flat_map(|row| (0..cols).map(move |col| TriPoint { col: col as i32, row: row as i32 }))
        .collect()
}

pub fn tri_triangle(side: usize) -> Vec<TriPoint> {
    // Equilateral triangle: apex at row 0 (1 tile), base at row N-1 (2N-1 tiles).
    // indent = N - 1 - row + (N % 2) ensures the apex tile is pointing-down so it has
    // a Base neighbour in row 1 (pointing-down.Base = row+1). Without the parity shift,
    // an odd N produces a pointing-up apex with no downward neighbour, disconnecting the field.
    let n = side as i32;
    let shift = n % 2;
    (0..side)
        .flat_map(move |row| {
            let indent = n - 1 - row as i32 + shift;
            (indent..=indent + 2 * row as i32).map(move |col| TriPoint { col, row: row as i32 })
        })
        .collect()
}

pub fn tri_hexagon(radius: usize) -> Vec<TriPoint> {
    // Equilateral hexagonal boundary: all 6 sides have R triangle-edges.
    // Rows: 0..2R (total 2R rows). Top row starts with pointing-down → smooth top boundary.
    // Bottom row ends with pointing-up → smooth bottom boundary.
    // odd_base = R-1 if R even, R if R odd (top row indent is odd = pointing-down first).
    // Row r: k = min(r, 2R-1-r), indent = odd_base - k, width = 2*(k+R) + 1.
    let r = radius as i32;
    let odd_base = if r % 2 == 0 { r - 1 } else { r };
    (0..2 * r)
        .flat_map(move |row| {
            let k = row.min(2 * r - 1 - row);
            let indent = odd_base - k;
            let width = 2 * (k + r) + 1;
            (indent..indent + width).map(move |col| TriPoint { col, row })
        })
        .collect()
}
