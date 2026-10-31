//! The `box` preset of the square grid (GitHub issue #858): the six faces of a
//! `width x height x depth` box laid out as a cross, a T-shaped or a compact net, and the gluings
//! that fold them into the box. See `Specs/topology.md`, "Topology presets".
//!
//! The gluings are derived, not tabulated: the net is rolled up into the box (`Frame`s map each
//! face's net plane into 3D, in cells), and the two face sides that land on the same box edge
//! are glued, cell by cell, by the 3D position of their midpoints.

use super::field_ops::{PresetDescriptor, PresetParam, param};
use super::square::SquarePoint;
use super::{FieldOpError, FoldEnd, NewFold, PresetParams, validate_preset};
use std::collections::HashMap;
use std::rc::Rc;

const fn size_param(name: &'static str) -> PresetParam {
    PresetParam { name, min: 1 }
}

/// The box sizes along x, y (the vertical axis of the ring of side faces) and z, in cells.
pub(super) const WIDTH: PresetParam = size_param("width");
pub(super) const HEIGHT: PresetParam = size_param("height");
pub(super) const DEPTH: PresetParam = size_param("depth");
/// `0` = cross net, `1` = T-shaped net, `2` = compact print layout (two rows of three separate
/// faces; it implies `mode` = by faces).
pub(super) const NET: PresetParam = PresetParam {
    name: "net",
    min: 0,
};
/// `0` = net (the faces stay joined as unfolded, only the net's outer edges are glued), `1` = by
/// faces (six separate rectangles, a gluing for each of the twelve box edges).
pub(super) const MODE: PresetParam = PresetParam {
    name: "mode",
    min: 0,
};

/// Width to height of the area the compact layout is packed for, in percent (`100` = square;
/// A4 portrait is about `71`). Only the compact layout reads it.
pub(super) const ASPECT: PresetParam = PresetParam {
    name: "aspect",
    min: 1,
};

pub(super) const BOX_PRESET: PresetDescriptor = PresetDescriptor {
    key: "box",
    params: &[WIDTH, HEIGHT, DEPTH, NET, MODE, ASPECT],
};

/// Largest box side: the total of `2 * (w*h + h*d + w*d)` cells then stays within
/// `MAX_PRESET_SIZE` for any combination of sides.
pub(super) const MAX_BOX_SIDE: u32 = 408;

/// Largest `aspect`: ten times wider than tall.
const MAX_ASPECT: u32 = 1000;

/// Cells between separate faces in the cross and T layouts.
const GAP: i32 = 1;
/// Cells between any two faces of the compact layout: wide enough for connectors drawn across it.
const COMPACT_GAP: i32 = 4;

/// Upper bound of a `box` parameter: the sides are limited by the preset size, `mode` and `net`
/// are small enums.
pub(super) fn box_param_max(name: &str) -> Option<u32> {
    match name {
        "width" | "height" | "depth" => Some(MAX_BOX_SIDE),
        "mode" => Some(1),
        "net" => Some(2),
        "aspect" => Some(MAX_ASPECT),
        _ => None,
    }
}

// `faces_of` of a square cell is `[E, N, W, S]`.
const SIDES: [Side; 4] = [Side::E, Side::N, Side::W, Side::S];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Side {
    E,
    N,
    W,
    S,
}

impl Side {
    fn face_idx(self) -> usize {
        self as usize
    }

    /// Cell `k` along the side (in counter-clockwise order) of a face of `w x h` cells.
    fn cell(self, w: i32, h: i32, k: i32) -> (i32, i32) {
        match self {
            Side::E => (w - 1, k),
            Side::N => (w - 1 - k, h - 1),
            Side::W => (0, h - 1 - k),
            Side::S => (k, 0),
        }
    }
}

/// A face of the net: its lower-left corner and size, in cells, in the net plane.
#[derive(Clone, Copy)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl Rect {
    /// Start corner, counter-clockwise direction and length of `side` of this face.
    fn side(self, side: Side) -> ((i32, i32), (i32, i32), i32) {
        match side {
            Side::E => ((self.x + self.w, self.y), (0, 1), self.h),
            Side::N => ((self.x + self.w, self.y + self.h), (-1, 0), self.w),
            Side::W => ((self.x, self.y + self.h), (0, -1), self.h),
            Side::S => ((self.x, self.y), (1, 0), self.w),
        }
    }

    /// Whether `other` lies across `side` of this face and shares the whole edge.
    fn joins(self, side: Side, other: Rect) -> bool {
        match side {
            Side::E => other.x == self.x + self.w && other.y == self.y && other.h == self.h,
            Side::W => other.x + other.w == self.x && other.y == self.y && other.h == self.h,
            Side::N => other.y == self.y + self.h && other.x == self.x && other.w == self.w,
            Side::S => other.y + other.h == self.y && other.x == self.x && other.w == self.w,
        }
    }
}

const fn rect(x: i32, y: i32, w: i32, h: i32) -> Rect {
    Rect { x, y, w, h }
}

/// Faces of the net that is folded into the box, in the order left, front, right, back, top,
/// bottom. The four side faces form a row (widths `d, w, d, w`, all `h` high); the cross puts
/// the top and bottom above and below the front face, the T (`net == 1`, lying on its side) puts
/// both on the left face.
fn fold_net(net: u32, w: i32, h: i32, d: i32) -> [Rect; 6] {
    if net == 1 {
        [
            rect(0, w, d, h),
            rect(d, w, w, h),
            rect(d + w, w, d, h),
            rect(2 * d + w, w, w, h),
            rect(0, w + h, d, w),
            rect(0, 0, d, w),
        ]
    } else {
        [
            rect(0, d, d, h),
            rect(d, d, w, h),
            rect(d + w, d, d, h),
            rect(2 * d + w, d, w, h),
            rect(d, d + h, w, d),
            rect(d, 0, w, d),
        ]
    }
}

/// Where a face lies in the field: its lower-left corner, the number of counter-clockwise quarter
/// turns it is rotated by, and its size once turned.
#[derive(Clone, Copy)]
struct Placed {
    x: i32,
    y: i32,
    turns: u8,
    w: i32,
    h: i32,
}

struct Options {
    by_faces: bool,
    /// Faces of the net that is folded into the box (3D frames).
    fold: [Rect; 6],
    place: [Placed; 6],
    /// Shift that puts the origin cell at `(width / 2, height / 2)` of the bounding box of all
    /// faces, as for a centered rectangle.
    offset: (i32, i32),
}

/// Face positions with `gap` empty cells between every two neighbouring rows and columns of the
/// net; faces that share a column or a row stay aligned.
fn spread(fold: &[Rect; 6], gap: i32) -> [Placed; 6] {
    let ranks = |value: fn(&Rect) -> i32| {
        let mut all: Vec<i32> = fold.iter().map(value).collect();
        all.sort_unstable();
        all.dedup();
        move |v: i32| gap * all.iter().filter(|&&o| o < v).count() as i32
    };
    let (rx, ry) = (ranks(|r| r.x), ranks(|r| r.y));
    fold.map(|r| Placed {
        x: r.x + rx(r.x),
        y: r.y + ry(r.y),
        turns: 0,
        w: r.w,
        h: r.h,
    })
}

/// A packing of some faces: either one face (turned or not) or two packings side by side
/// (`beside`) or one above the other.
#[derive(Clone)]
enum Packing {
    Face { face: usize, turns: u8 },
    Pair { beside: bool, a: Rc<Sized>, b: Rc<Sized> },
}

#[derive(Clone)]
struct Sized {
    w: i32,
    h: i32,
    packing: Packing,
}

impl Sized {
    /// Stores the faces of this packing with their lower-left corner at `(x, y)`.
    fn place(&self, (x, y): (i32, i32), out: &mut [Option<Placed>; 6]) {
        match &self.packing {
            Packing::Face { face, turns } => {
                out[*face] = Some(Placed {
                    x,
                    y,
                    turns: *turns,
                    w: self.w,
                    h: self.h,
                });
            }
            Packing::Pair { beside, a, b } => {
                a.place((x, y), out);
                if *beside {
                    b.place((x + a.w + COMPACT_GAP, y), out);
                } else {
                    b.place((x, y + a.h + COMPACT_GAP), out);
                }
            }
        }
    }
}

/// The compact print layout: the six faces, each possibly turned a quarter, packed into the
/// smallest area of the given `aspect` (width to height in percent) with `COMPACT_GAP` empty
/// cells between any two of them (room for the connectors of the gluings). Packings are built by splitting the faces into two groups placed
/// side by side or one above the other, trying every split; for each group only the packings
/// that are not larger in both directions than another are kept.
fn compact(fold: &[Rect; 6], aspect: i64) -> [Placed; 6] {
    let mut best: Vec<Vec<Sized>> = vec![Vec::new(); 1 << 6];
    for (face, rect) in fold.iter().enumerate() {
        let mut options = vec![Sized {
            w: rect.w,
            h: rect.h,
            packing: Packing::Face { face, turns: 0 },
        }];
        if rect.w != rect.h {
            options.push(Sized {
                w: rect.h,
                h: rect.w,
                packing: Packing::Face { face, turns: 1 },
            });
        }
        best[1 << face] = options;
    }
    for set in 1usize..(1 << 6) {
        if set.count_ones() < 2 {
            continue;
        }
        // Each split once: the first group holds the lowest face of the set.
        let lowest = set & set.wrapping_neg();
        let mut candidates = Vec::new();
        let mut first = (set - 1) & set;
        while first > 0 {
            if first & lowest != 0 {
                let second = set ^ first;
                for a in &best[first] {
                    for b in &best[second] {
                        candidates.push(Sized {
                            w: a.w + COMPACT_GAP + b.w,
                            h: a.h.max(b.h),
                            packing: Packing::Pair {
                                beside: true,
                                a: Rc::new(a.clone()),
                                b: Rc::new(b.clone()),
                            },
                        });
                        candidates.push(Sized {
                            w: a.w.max(b.w),
                            h: a.h + COMPACT_GAP + b.h,
                            packing: Packing::Pair {
                                beside: false,
                                a: Rc::new(a.clone()),
                                b: Rc::new(b.clone()),
                            },
                        });
                    }
                }
            }
            first = (first - 1) & set;
        }
        candidates.sort_by_key(|c| (c.w, c.h));
        let mut kept: Vec<Sized> = Vec::new();
        for c in candidates {
            if kept.last().is_none_or(|last| c.h < last.h) {
                kept.push(c);
            }
        }
        best[set] = kept;
    }
    // The smallest area of the requested aspect that holds the layout (a long strip wastes a
    // sheet however small its own area), then the least empty space, then the outline closest to
    // that aspect.
    let (w100, h100) = (|c: &Sized| i64::from(c.w) * 100, |c: &Sized| i64::from(c.h) * aspect);
    let chosen = best[(1 << 6) - 1]
        .iter()
        .min_by_key(|c| {
            (
                w100(c).max(h100(c)),
                i64::from(c.w) * i64::from(c.h),
                (w100(c) - h100(c)).abs(),
            )
        })
        .expect("six faces can always be packed");
    let mut out = [None; 6];
    chosen.place((0, 0), &mut out);
    out.map(|placed| placed.expect("every face is packed"))
}

fn options(params: PresetParams<'_>) -> Result<Options, FieldOpError> {
    validate_preset(&[BOX_PRESET], "box", params)?;
    let [w, h, d] = ["width", "height", "depth"].map(|name| param(params, name));
    if [w, h, d].iter().any(|&side| side > MAX_BOX_SIDE) {
        return Err(FieldOpError::InvalidPreset(
            "preset is too large".to_string(),
        ));
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
    let aspect = param(params, "aspect");
    if aspect > MAX_ASPECT {
        return Err(FieldOpError::InvalidPreset(format!(
            "\"aspect\" must be at most {MAX_ASPECT}"
        )));
    }
    let net = param(params, "net");
    if net > 2 {
        return Err(FieldOpError::InvalidPreset(
            "\"net\" must be at most 2".to_string(),
        ));
    }
    let fold = fold_net(net, w as i32, h as i32, d as i32);
    // The compact layout is always by faces, whatever `mode` says.
    let by_faces = by_faces || net == 2;
    let place = if net == 2 {
        compact(&fold, i64::from(aspect))
    } else {
        spread(&fold, if by_faces { GAP } else { 0 })
    };
    let offset = (
        place.iter().map(|p| p.x + p.w).max().unwrap() / 2,
        place.iter().map(|p| p.y + p.h).max().unwrap() / 2,
    );
    Ok(Options {
        by_faces,
        fold,
        place,
        offset,
    })
}

impl Options {
    /// Cell `(i, j)` of face `face`, as laid out in the field (the face may be turned).
    fn cell(&self, face: usize, i: i32, j: i32) -> SquarePoint {
        let placed = self.place[face];
        let Rect { w, h, .. } = self.fold[face];
        let (i, j) = match placed.turns {
            0 => (i, j),
            1 => (h - 1 - j, i),
            2 => (w - 1 - i, h - 1 - j),
            _ => (j, w - 1 - i),
        };
        SquarePoint {
            x: placed.x + i - self.offset.0,
            y: placed.y + j - self.offset.1,
        }
    }

    /// The `faces_of` index, in the field, of `side` of face `face`: a quarter turn carries east
    /// to north, north to west and so on.
    fn face_idx(&self, face: usize, side: Side) -> usize {
        (side.face_idx() + usize::from(self.place[face].turns)) % 4
    }
}

/// The cells of all six faces, sorted.
pub(super) fn box_cells(params: PresetParams<'_>) -> Result<Vec<SquarePoint>, FieldOpError> {
    let options = options(params)?;
    let mut cells = Vec::new();
    for (face, rect) in options.fold.iter().enumerate() {
        for j in 0..rect.h {
            for i in 0..rect.w {
                cells.push(options.cell(face, i, j));
            }
        }
    }
    cells.sort();
    Ok(cells)
}

/// Rigid map `p -> r * p + t` from a face's net plane (and its normal axis) to the box in 3D,
/// integer entries, in cells.
#[derive(Clone, Copy)]
struct Frame {
    r: [[i64; 3]; 3],
    t: [i64; 3],
}

impl Frame {
    /// `self` after `inner`.
    fn after(self, inner: Frame) -> Frame {
        let mut r = [[0; 3]; 3];
        for (i, row) in r.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                *cell = (0..3).map(|k| self.r[i][k] * inner.r[k][j]).sum();
            }
        }
        Frame {
            r,
            t: self.apply(inner.t, 1),
        }
    }

    /// The image of `p` given in `scale`-th parts of a cell; the result is in the same parts.
    fn apply(&self, p: [i64; 3], scale: i64) -> [i64; 3] {
        let mut out = [0; 3];
        for (i, value) in out.iter_mut().enumerate() {
            *value = (0..3).map(|j| self.r[i][j] * p[j]).sum::<i64>() + self.t[i] * scale;
        }
        out
    }
}

/// Fold of the face across `side` of `face` by 90 degrees about their shared edge, as a map of
/// the net space of `face` (the neighbour folds toward negative z).
fn fold_across(side: Side, face: Rect) -> Frame {
    let (left, right) = (i64::from(face.x), i64::from(face.x + face.w));
    let (bottom, top) = (i64::from(face.y), i64::from(face.y + face.h));
    match side {
        Side::E => Frame {
            r: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
            t: [right, 0, right],
        },
        Side::W => Frame {
            r: [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
            t: [left, 0, -left],
        },
        Side::N => Frame {
            r: [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
            t: [0, top, top],
        },
        Side::S => Frame {
            r: [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
            t: [0, bottom, -bottom],
        },
    }
}

/// The 3D frame of every face of the net, rolled up from the first face.
fn net_frames(faces: &[Rect; 6]) -> Vec<Frame> {
    let identity = Frame {
        r: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        t: [-i64::from(faces[0].x), -i64::from(faces[0].y), 0],
    };
    let mut frames: Vec<Option<Frame>> = vec![None; faces.len()];
    frames[0] = Some(identity);
    let mut queue = vec![0];
    while let Some(from) = queue.pop() {
        let base = frames[from].unwrap();
        for side in SIDES {
            let Some(to) = faces.iter().position(|&f| faces[from].joins(side, f)) else {
                continue;
            };
            if frames[to].is_none() {
                frames[to] = Some(base.after(fold_across(side, faces[from])));
                queue.push(to);
            }
        }
    }
    frames
        .into_iter()
        .map(|f| f.expect("a net is connected"))
        .collect()
}

/// One side of one face, with its cells' midpoints placed on the box.
struct EdgeSide {
    face: usize,
    side: Side,
    /// 3D midpoint of each cell's face (in half cells) and its fold end.
    cells: Vec<([i64; 3], FoldEnd<SquarePoint>)>,
}

/// One group of untwisted folds per glued box edge (one fold per cell along it): all twelve when
/// the faces are separate, otherwise the seven that the net does not already join.
pub(super) fn box_folds(
    params: PresetParams<'_>,
) -> Result<Vec<Vec<NewFold<SquarePoint>>>, FieldOpError> {
    let options = options(params)?;
    let frames = net_frames(&options.fold);

    // Both sides of each box edge, in order of first appearance.
    let mut order: Vec<[[i64; 3]; 2]> = Vec::new();
    let mut by_edge: HashMap<[[i64; 3]; 2], Vec<EdgeSide>> = HashMap::new();
    for (index, rect) in options.fold.iter().enumerate() {
        for side in SIDES {
            let (start, dir, len) = rect.side(side);
            let end = (start.0 + dir.0 * len, start.1 + dir.1 * len);
            let corner = |c: (i32, i32)| frames[index].apply([i64::from(c.0), i64::from(c.1), 0], 1);
            let (a, b) = (corner(start), corner(end));
            let key = if a <= b { [a, b] } else { [b, a] };
            let cells = (0..len)
                .map(|k| {
                    let mid = [
                        i64::from(start.0) * 2 + i64::from(dir.0) * i64::from(2 * k + 1),
                        i64::from(start.1) * 2 + i64::from(dir.1) * i64::from(2 * k + 1),
                        0,
                    ];
                    let (i, j) = side.cell(rect.w, rect.h, k);
                    let end = FoldEnd {
                        cell: options.cell(index, i, j),
                        face_idx: options.face_idx(index, side),
                    };
                    (frames[index].apply(mid, 2), end)
                })
                .collect();
            if !by_edge.contains_key(&key) {
                order.push(key);
            }
            by_edge.entry(key).or_default().push(EdgeSide {
                face: index,
                side,
                cells,
            });
        }
    }

    let mut groups = Vec::new();
    for key in order {
        let sides = &by_edge[&key];
        let [first, second] = sides.as_slice() else {
            unreachable!("every box edge lies on exactly two faces");
        };
        // The net already joins faces that are neighbours across this edge.
        if !options.by_faces
            && options.fold[first.face].joins(first.side, options.fold[second.face])
        {
            continue;
        }
        let at: HashMap<[i64; 3], FoldEnd<SquarePoint>> =
            second.cells.iter().copied().collect();
        groups.push(
            first
                .cells
                .iter()
                .map(|(mid, a)| NewFold {
                    a: *a,
                    b: at[mid],
                    twist: false,
                })
                .collect(),
        );
    }
    Ok(groups)
}
