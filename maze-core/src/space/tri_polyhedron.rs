//! The `tetrahedron`, `octahedron` and `icosahedron` presets of the triangle grid (GitHub issue
//! #892): the faces of a regular polyhedron with edge `side` (in cells) laid out as a net or as
//! separate triangles, and the gluings that fold them into the polyhedron. See
//! `Specs/topology.md`, "Topology presets".
//!
//! The gluings are derived, not tabulated: the polyhedron is only a list of faces (vertex
//! triples), the neighbours across every edge follow from it, and the net is a tree of unfoldings
//! across edges. The edges of the polyhedron the net does not join are glued cell by cell, the
//! counter-clockwise run of one side against the reversed run of the other.
//!
//! Faces are macro triangles of the cell lattice, in axial lattice coordinates `(p, q)` (`p` along
//! the horizontal edge direction, `q` along the one 60 degrees up). A cell `(col, row)` has the
//! vertices of `triangle::tri_vertices`, whose `(i, j)` map to `(p, q) = ((i - 2j - 3) / 4, j)`.

use super::field_ops::{PresetDescriptor, PresetParam, param};
use super::triangle::TriPoint;
use super::{FieldOpError, FoldEnd, NewFold, PresetParams, validate_preset};
use std::collections::{HashMap, HashSet};

/// The polyhedron edge length, in cells.
const SIDE: PresetParam = PresetParam {
    name: "side",
    min: 1,
};
/// `0..` = a net of the polyhedron (see `Polyhedron::nets`), the last value = compact print layout
/// (separate triangles packed in rows; it implies `mode` = by faces).
const NET: PresetParam = PresetParam {
    name: "net",
    min: 0,
};
/// `0` = net (the faces stay joined as unfolded, only the edges the net does not join are glued),
/// `1` = by faces (separate triangles, every edge of the polyhedron is glued).
const MODE: PresetParam = PresetParam {
    name: "mode",
    min: 0,
};
/// Width to height of the area the compact layout is packed for, in percent (`100` = square).
/// Only the compact layout reads it.
const ASPECT: PresetParam = PresetParam {
    name: "aspect",
    min: 1,
};

const PARAMS: &[PresetParam] = &[SIDE, NET, MODE, ASPECT];

pub(super) const TETRAHEDRON_PRESET: PresetDescriptor = PresetDescriptor {
    key: "tetrahedron",
    params: PARAMS,
};
pub(super) const OCTAHEDRON_PRESET: PresetDescriptor = PresetDescriptor {
    key: "octahedron",
    params: PARAMS,
};
pub(super) const ICOSAHEDRON_PRESET: PresetDescriptor = PresetDescriptor {
    key: "icosahedron",
    params: PARAMS,
};

/// Largest edge: `20 * side^2` cells of the icosahedron stay within `MAX_PRESET_SIZE`.
const MAX_SIDE: u32 = 200;
/// Largest `aspect`: ten times wider than tall.
const MAX_ASPECT: u32 = 1000;

/// Extra translation (in sums of the unit net's vertices) that spreads the faces of the by-faces
/// layout: neighbours across a net edge end up three rows apart.
const SPREAD: i64 = 1;
/// Horizontal shift between neighbours in a row of the compact layout: their slanted edges are
/// `5 * sqrt(3) / 2` (about 4.3) cell edges apart, room for connectors across the gap.
const COMPACT_STEP: i64 = 5;
/// Rows of the compact layout are at least this many cell rows apart.
const COMPACT_ROW_GAP: i64 = 4;

/// Whether `key` is one of the polyhedron presets.
pub(super) fn is_polyhedron(key: &str) -> bool {
    polyhedron(key).is_some()
}

/// Upper bound of a polyhedron parameter, `None` for another preset or parameter.
pub(super) fn polyhedron_param_max(key: &str, name: &str) -> Option<u32> {
    let polyhedron = polyhedron(key)?;
    match name {
        "side" => Some(MAX_SIDE),
        "mode" => Some(1),
        "net" => Some(polyhedron.nets.len() as u32),
        "aspect" => Some(MAX_ASPECT),
        _ => None,
    }
}

type Axial = (i64, i64);

/// One step of a net: unfold the face placed at index `parent` across its plane edge `edge`
/// (`0..3`, counter-clockwise from the placed triangle's first vertex).
type Step = (usize, usize);

struct Polyhedron {
    /// Vertex triples of the faces, counter-clockwise seen from outside; face `0` is the root of
    /// every net.
    faces: &'static [[usize; 3]],
    nets: &'static [&'static [Step]],
}

// Tetrahedron: vertices 0..4.
const TETRAHEDRON_FACES: [[usize; 3]; 4] = [[0, 1, 2], [0, 3, 1], [1, 3, 2], [0, 2, 3]];

// Octahedron as a triangular antiprism: the top ring 0..=2, the bottom ring 3..=5 (`b_i` lies
// between `a_i` and `a_{i+1}`). Face 0 is the root of every net: a face of the lower band, whose
// edge 0 joins the bottom cap.
const OCTAHEDRON_FACES: [[usize; 3]; 8] = [
    [3, 4, 1],
    [4, 5, 2],
    [5, 3, 0],
    [0, 3, 1],
    [1, 4, 2],
    [2, 5, 0],
    [0, 1, 2],
    [3, 5, 4],
];

// Icosahedron: 0 on top, the upper ring 1..=5, the lower ring 6..=10 (`b_i` lies between `a_i`
// and `a_{i+1}`), 11 at the bottom. Faces `0..5` are the lower band, `[b_i, b_{i+1}, a_{i+1}]`,
// the first of them the root of every net: its edge 0 joins the bottom cap.
const ICOSAHEDRON_FACES: [[usize; 3]; 20] = icosahedron_faces();

const fn icosahedron_faces() -> [[usize; 3]; 20] {
    let mut faces = [[0; 3]; 20];
    let mut i = 0;
    while i < 5 {
        let (a, a_next) = (1 + i, 1 + (i + 1) % 5);
        let (b, b_next) = (6 + i, 6 + (i + 1) % 5);
        faces[i] = [b, b_next, a_next]; // lower band
        faces[5 + i] = [a, b, a_next]; // upper band
        faces[10 + i] = [0, a, a_next]; // top cap
        faces[15 + i] = [11, b_next, b]; // bottom cap
        i += 1;
    }
    faces
}

/// A straight strip of triangles from the root (pointing up) going right: the root crosses its
/// edge `1`, then a down triangle crosses `1` and an up triangle `2`.
const fn strip<const N: usize>() -> [Step; N] {
    let mut steps = [(0, 0); N];
    let mut i = 0;
    while i < N {
        steps[i] = (i, if i == 0 || i % 2 == 1 { 1 } else { 2 });
        i += 1;
    }
    steps
}

const STRIP_3: [Step; 3] = strip();
const STRIP_5: [Step; 5] = strip();
const STRIP_9: [Step; 9] = strip();

const fn concat<const A: usize, const B: usize, const N: usize>(a: [Step; A], b: [Step; B]) -> [Step; N] {
    let mut steps = [(0, 0); N];
    let mut i = 0;
    while i < A {
        steps[i] = a[i];
        i += 1;
    }
    while i < N {
        steps[i] = b[i - A];
        i += 1;
    }
    steps
}

// Placed triangle `k` of a strip is at index `k`; the strip of `N` steps has `N + 1` triangles.
// Odd ones point down (their top is edge `2`), even ones point up (their bottom is edge `0` for
// the root and `1` for the others).
const TETRAHEDRON_STAR: [Step; 3] = [(0, 0), (0, 1), (0, 2)];
const OCTAHEDRON_WIDE: [Step; 7] = concat(STRIP_5, [(1, 2), (4, 1)]);
const OCTAHEDRON_CLOSE: [Step; 7] = concat(STRIP_5, [(1, 2), (2, 1)]);
// The band of ten with a cap over each down triangle and under each up triangle.
const ICOSAHEDRON_BAND: [Step; 19] = concat(
    STRIP_9,
    [
        (1, 2),
        (3, 2),
        (5, 2),
        (7, 2),
        (9, 2),
        (0, 0),
        (2, 1),
        (4, 1),
        (6, 1),
        (8, 1),
    ],
);

const TETRAHEDRON: Polyhedron = Polyhedron {
    faces: &TETRAHEDRON_FACES,
    nets: &[&TETRAHEDRON_STAR, &STRIP_3],
};
const OCTAHEDRON: Polyhedron = Polyhedron {
    faces: &OCTAHEDRON_FACES,
    nets: &[&OCTAHEDRON_WIDE, &OCTAHEDRON_CLOSE],
};
const ICOSAHEDRON: Polyhedron = Polyhedron {
    faces: &ICOSAHEDRON_FACES,
    nets: &[&ICOSAHEDRON_BAND],
};

fn polyhedron(key: &str) -> Option<&'static Polyhedron> {
    match key {
        "tetrahedron" => Some(&TETRAHEDRON),
        "octahedron" => Some(&OCTAHEDRON),
        "icosahedron" => Some(&ICOSAHEDRON),
        _ => None,
    }
}

impl Polyhedron {
    /// The face and its edge across edge `edge` of `face`: the one whose edge runs the other way.
    fn neighbour(&self, face: usize, edge: usize) -> (usize, usize) {
        let from = self.faces[face][edge];
        let to = self.faces[face][(edge + 1) % 3];
        for (other, vertices) in self.faces.iter().enumerate() {
            for e in 0..3 {
                if vertices[e] == to && vertices[(e + 1) % 3] == from {
                    return (other, e);
                }
            }
        }
        unreachable!("every edge of a polyhedron lies on two faces");
    }
}

/// A face placed in the plane: the lattice vertices of its macro triangle, counter-clockwise, and
/// `rot`: plane edge `k` is edge `(k + rot) % 3` of the polyhedron face.
#[derive(Clone, Copy)]
struct Placed {
    face: usize,
    vertices: [Axial; 3],
    rot: usize,
}

struct Layout {
    placed: Vec<Placed>,
    /// `(face, edge)` pairs of both sides of every edge the net joins.
    joined: HashSet<(usize, usize)>,
    by_faces: bool,
}

/// Unit triangles of the net with edge 1 (plane vertices `u`), each then scaled to `side` and
/// moved apart by `spread` sums of its unit vertices.
fn unfold(polyhedron: &Polyhedron, net: &[Step], side: i64, by_faces: bool) -> Layout {
    let spread = if by_faces { SPREAD } else { 0 };
    let mut unit: Vec<(usize, [Axial; 3], usize)> = vec![(0, [(0, 0), (1, 0), (0, 1)], 0)];
    let mut joined = HashSet::new();
    for &(parent, edge) in net {
        let (face, vertices, rot) = unit[parent];
        let (a, b, c) = (vertices[edge], vertices[(edge + 1) % 3], vertices[(edge + 2) % 3]);
        let apex = (a.0 + b.0 - c.0, a.1 + b.1 - c.1);
        let (other, other_edge) = polyhedron.neighbour(face, (edge + rot) % 3);
        joined.insert((face, (edge + rot) % 3));
        joined.insert((other, other_edge));
        unit.push((other, [b, a, apex], other_edge));
    }
    let placed = unit
        .into_iter()
        .map(|(face, u, rot)| {
            let sum = (u[0].0 + u[1].0 + u[2].0, u[0].1 + u[1].1 + u[2].1);
            Placed {
                face,
                vertices: u.map(|v| (v.0 * side + sum.0 * spread, v.1 * side + sum.1 * spread)),
                rot,
            }
        })
        .collect();
    Layout {
        placed,
        joined,
        by_faces,
    }
}

/// `(i, j)` of the lattice point `(p, q)` in the coordinates of `triangle::tri_vertices`.
fn to_ij((p, q): Axial) -> (i64, i64) {
    (4 * p + 2 * q + 3, q)
}

fn from_ij((i, j): (i64, i64)) -> Axial {
    ((i - 2 * j - 3) / 4, j)
}

/// The vertices `(i, j)` of a cell counter-clockwise from the start of its `Base` (the order of
/// `triangle::tri_vertices` and `faces_of`).
fn cell_vertices(cell: TriPoint) -> [(i64, i64); 3] {
    let (i, top, bottom) = (
        2 * i64::from(cell.col) + 1,
        -i64::from(cell.row),
        -i64::from(cell.row) - 1,
    );
    if (cell.col + cell.row).rem_euclid(2) == 0 {
        [(i + 2, top), (i - 2, top), (i, bottom)]
    } else {
        [(i - 2, bottom), (i + 2, bottom), (i, top)]
    }
}

/// The cell whose vertices are `vertices` (any order).
fn cell_of(vertices: [Axial; 3]) -> TriPoint {
    let ij = vertices.map(to_ij);
    let apex_index = (0..3)
        .find(|&k| ij[(k + 1) % 3].1 == ij[(k + 2) % 3].1 && ij[k].1 != ij[(k + 1) % 3].1)
        .expect("a lattice triangle has a horizontal side");
    let (apex, base) = (ij[apex_index], ij[(apex_index + 1) % 3]);
    let row = if base.1 > apex.1 { -base.1 } else { -apex.1 };
    TriPoint {
        col: ((apex.0 - 1) / 2) as i32,
        row: row as i32,
    }
}

fn cross(a: Axial, b: Axial, c: Axial) -> i64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// The cells of a macro triangle: those with all three vertices on or inside its sides.
fn face_cells(vertices: [Axial; 3]) -> Vec<TriPoint> {
    let ij = vertices.map(to_ij);
    let (imin, imax) = (ij.iter().map(|v| v.0).min().unwrap(), ij.iter().map(|v| v.0).max().unwrap());
    let (jmin, jmax) = (ij.iter().map(|v| v.1).min().unwrap(), ij.iter().map(|v| v.1).max().unwrap());
    let mut cells = Vec::new();
    for row in -jmax..=-jmin {
        for col in (imin - 1).div_euclid(2) - 1..=(imax - 1).div_euclid(2) + 1 {
            let cell = TriPoint {
                col: col as i32,
                row: row as i32,
            };
            let inside = cell_vertices(cell).iter().all(|&v| {
                let v = from_ij(v);
                (0..3).all(|k| cross(vertices[k], vertices[(k + 1) % 3], v) >= 0)
            });
            if inside {
                cells.push(cell);
            }
        }
    }
    cells
}

/// Triangles of the compact layout: rows of alternating up and down triangles, shifted apart,
/// `per_row` in a row. Face `k` takes the `k`-th place.
fn rows(faces: usize, per_row: usize, side: i64) -> Vec<Placed> {
    let pitch = {
        let pitch = side + COMPACT_ROW_GAP;
        pitch + pitch % 2
    };
    (0..faces)
        .map(|face| {
            let (row, m) = ((face / per_row) as i64, (face % per_row) as i64);
            let t = m / 2;
            let unit: [Axial; 3] = if m % 2 == 0 {
                [(t, 0), (t + 1, 0), (t, 1)]
            } else {
                [(t, 1), (t + 1, 0), (t + 1, 1)]
            };
            let shift = (COMPACT_STEP * m - row * pitch / 2, row * pitch);
            Placed {
                face,
                vertices: unit.map(|v| (v.0 * side + shift.0, v.1 * side + shift.1)),
                rot: 0,
            }
        })
        .collect()
}

/// Width and height of the extent of `placed`, in cell edges.
fn extent(placed: &[Placed]) -> (f64, f64) {
    let ij: Vec<(i64, i64)> = placed.iter().flat_map(|p| p.vertices.map(to_ij)).collect();
    let span = |value: fn(&(i64, i64)) -> i64| {
        (ij.iter().map(value).max().unwrap() - ij.iter().map(value).min().unwrap()) as f64
    };
    (span(|v| v.0) / 4.0, span(|v| v.1) * 3f64.sqrt() / 2.0)
}

/// The compact print layout: rows of triangles, the number of rows chosen so the extent fits the
/// smallest area of the requested `aspect` (width to height in percent), then the least empty
/// space, then the outline closest to that aspect.
fn compact(faces: usize, side: i64, aspect: i64) -> Layout {
    let aspect = aspect as f64;
    let key = |layout: &[Placed]| {
        let (w, h) = extent(layout);
        let (w100, h100) = (w * 100.0, h * aspect);
        (w100.max(h100), w * h, (w100 - h100).abs())
    };
    // One layout per number of rows (the rows are filled evenly from the top).
    let per_row_options: std::collections::BTreeSet<usize> =
        (1..=faces).map(|row_count| faces.div_ceil(row_count)).collect();
    let placed = per_row_options
        .into_iter()
        .map(|per_row| rows(faces, per_row, side))
        .min_by(|a, b| key(a).partial_cmp(&key(b)).unwrap())
        .expect("at least one layout");
    Layout {
        placed,
        joined: HashSet::new(),
        by_faces: true,
    }
}

struct Options {
    polyhedron: &'static Polyhedron,
    side: i64,
    layout: Layout,
    /// The cells of all faces before the shift.
    cells: Vec<TriPoint>,
    /// Shift that centres the cells, keeping the parity of `col + row`.
    offset: (i32, i32),
}

fn options(key: &str, params: PresetParams<'_>) -> Result<Options, FieldOpError> {
    let polyhedron = polyhedron(key).ok_or(FieldOpError::Unavailable)?;
    validate_preset(&[TETRAHEDRON_PRESET, OCTAHEDRON_PRESET, ICOSAHEDRON_PRESET], key, params)?;
    let side = param(params, "side");
    if side > MAX_SIDE {
        return Err(FieldOpError::InvalidPreset("preset is too large".to_string()));
    }
    let aspect = param(params, "aspect");
    if aspect > MAX_ASPECT {
        return Err(FieldOpError::InvalidPreset(format!(
            "\"aspect\" must be at most {MAX_ASPECT}"
        )));
    }
    let by_faces = match param(params, "mode") {
        0 => false,
        1 => true,
        _ => {
            return Err(FieldOpError::InvalidPreset(
                "\"mode\" must be at most 1".to_string(),
            ));
        }
    };
    let net = param(params, "net") as usize;
    if net > polyhedron.nets.len() {
        return Err(FieldOpError::InvalidPreset(format!(
            "\"net\" must be at most {}",
            polyhedron.nets.len()
        )));
    }
    let side = i64::from(side);
    let layout = if net == polyhedron.nets.len() {
        compact(polyhedron.faces.len(), side, i64::from(aspect))
    } else {
        unfold(polyhedron, polyhedron.nets[net], side, by_faces)
    };
    let cells: Vec<TriPoint> = layout
        .placed
        .iter()
        .flat_map(|p| face_cells(p.vertices))
        .collect();
    let offset = lattice_center_offset(&cells);
    Ok(Options {
        polyhedron,
        side,
        layout,
        cells,
        offset,
    })
}

/// The shift that puts the middle of the bounding box of `cells` at the origin, keeping the
/// parity of `col + row` (which decides a triangle's orientation).
fn lattice_center_offset(cells: &[TriPoint]) -> (i32, i32) {
    let bounds = |f: fn(&TriPoint) -> i32| {
        (
            cells.iter().map(f).min().unwrap_or(0),
            cells.iter().map(f).max().unwrap_or(0),
        )
    };
    let ((min_col, max_col), (min_row, max_row)) = (bounds(|p| p.col), bounds(|p| p.row));
    let ox = (min_col + max_col + 1).div_euclid(2);
    let mut oy = (min_row + max_row + 1).div_euclid(2);
    if (ox + oy).rem_euclid(2) != 0 {
        oy -= 1;
    }
    (ox, oy)
}

impl Options {
    fn shift(&self, cell: TriPoint) -> TriPoint {
        TriPoint {
            col: cell.col - self.offset.0,
            row: cell.row - self.offset.1,
        }
    }
}

/// The cells of all faces, sorted.
pub(super) fn polyhedron_cells(
    key: &str,
    params: PresetParams<'_>,
) -> Result<Vec<TriPoint>, FieldOpError> {
    let options = options(key, params)?;
    let mut cells: Vec<TriPoint> = options.cells.iter().map(|&cell| options.shift(cell)).collect();
    cells.sort();
    Ok(cells)
}

/// The end of a fold at cell `k` (counter-clockwise) along plane edge `edge` of `placed`.
fn fold_end(options: &Options, placed: &Placed, edge: usize, k: i64) -> FoldEnd<TriPoint> {
    let (from, to) = (placed.vertices[edge], placed.vertices[(edge + 1) % 3]);
    let step = ((to.0 - from.0) / options.side, (to.1 - from.1) / options.side);
    let start = (from.0 + step.0 * k, from.1 + step.1 * k);
    let end = (start.0 + step.0, start.1 + step.1);
    // The third vertex of the cell inside (to the left of) the directed side: the step turned
    // by 60 degrees.
    let rotated = (-step.1, step.0 + step.1);
    let apex = (start.0 + rotated.0, start.1 + rotated.1);
    let cell = cell_of([start, end, apex]);
    let vertices = cell_vertices(cell).map(from_ij);
    let face_idx = (0..3)
        .find(|&e| vertices[e] == start && vertices[(e + 1) % 3] == end)
        .expect("the cell has the unit side");
    FoldEnd {
        cell: options.shift(cell),
        face_idx,
    }
}

/// One group of untwisted folds per glued edge of the polyhedron (one fold per cell along it): all
/// of them when the faces are separate, otherwise the ones the net does not already join.
pub(super) fn polyhedron_folds(
    key: &str,
    params: PresetParams<'_>,
) -> Result<Vec<Vec<NewFold<TriPoint>>>, FieldOpError> {
    let options = options(key, params)?;
    let polyhedron = options.polyhedron;
    let by_face: HashMap<usize, &Placed> = options.layout.placed.iter().map(|p| (p.face, p)).collect();
    let plane_edge = |face: usize, edge: usize| (edge + 3 - by_face[&face].rot) % 3;
    let mut groups = Vec::new();
    for face in 0..polyhedron.faces.len() {
        for edge in 0..3 {
            let (other, other_edge) = polyhedron.neighbour(face, edge);
            if (face, edge) > (other, other_edge) {
                continue;
            }
            if !options.layout.by_faces && options.layout.joined.contains(&(face, edge)) {
                continue;
            }
            let a = (by_face[&face], plane_edge(face, edge));
            let b = (by_face[&other], plane_edge(other, other_edge));
            groups.push(
                (0..options.side)
                    .map(|k| NewFold {
                        a: fold_end(&options, a.0, a.1, k),
                        b: fold_end(&options, b.0, b.1, options.side - 1 - k),
                        twist: false,
                    })
                    .collect(),
            );
        }
    }
    Ok(groups)
}
