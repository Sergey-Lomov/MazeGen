use super::Tessellation;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct HexPoint {
    pub q: i32,
    pub r: i32,
}

#[derive(Copy, Clone, PartialEq)]
pub enum HexFace {
    E,
    NE,
    NW,
    W,
    SW,
    SE,
}

pub struct HexTessellation;

impl Tessellation for HexTessellation {
    type Point = HexPoint;
    type Face = HexFace;

    fn step(point: HexPoint, face: HexFace) -> HexPoint {
        match face {
            HexFace::E  => HexPoint { q: point.q + 1, r: point.r },
            HexFace::NE => HexPoint { q: point.q + 1, r: point.r - 1 },
            HexFace::NW => HexPoint { q: point.q,     r: point.r - 1 },
            HexFace::W  => HexPoint { q: point.q - 1, r: point.r },
            HexFace::SW => HexPoint { q: point.q - 1, r: point.r + 1 },
            HexFace::SE => HexPoint { q: point.q,     r: point.r + 1 },
        }
    }

    fn faces() -> &'static [HexFace] {
        &[HexFace::E, HexFace::NE, HexFace::NW, HexFace::W, HexFace::SW, HexFace::SE]
    }

    fn face_between(from: HexPoint, to: HexPoint) -> Option<HexFace> {
        match (to.q - from.q, to.r - from.r) {
            (1, 0)   => Some(HexFace::E),
            (1, -1)  => Some(HexFace::NE),
            (0, -1)  => Some(HexFace::NW),
            (-1, 0)  => Some(HexFace::W),
            (-1, 1)  => Some(HexFace::SW),
            (0, 1)   => Some(HexFace::SE),
            _        => None,
        }
    }

    /// Canonical (flat_top-equivalent) projection, unit tile scale. `INRADIUS` = sqrt(3)/2 at
    /// unit tile size — same formula as `maze-web`'s `hexCenter` (flat_top branch), minus the
    /// `TILE_SIZE` pixel scale and any orientation rotation (both display-only, web-side concerns
    /// — see `Tessellation::cartesian`'s doc comment).
    fn cartesian(point: HexPoint) -> (f64, f64) {
        let inradius = 3f64.sqrt() / 2.0;
        let (q, r) = (point.q as f64, point.r as f64);
        (q * 1.5, -(r * inradius * 2.0 + q * inradius))
    }
}

pub fn hex_parallelogram(cols: usize, rows: usize) -> Vec<HexPoint> {
    (0..rows)
        .flat_map(|r| (0..cols).map(move |q| HexPoint { q: q as i32, r: r as i32 }))
        .collect()
}

pub fn hex_hexagon(radius: usize) -> Vec<HexPoint> {
    let n = radius as i32;
    (-n..=n)
        .flat_map(move |q| ((-n).max(-q - n)..=n.min(-q + n)).map(move |r| HexPoint { q, r }))
        .collect()
}
