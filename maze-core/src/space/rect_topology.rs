//! Cylinder and torus topologies of the `rect` preset (GitHub issue #894): opposite sides of the
//! rectangle are glued, so a path leaving through one side comes back through the opposite one.
//! See `Specs/topology.md`, "Topology presets".
//!
//! The gluing is generic: the rectangle is repeated by a lattice translation `v` along one world
//! axis, and a boundary face whose outside neighbour is a cell of the rectangle moved by `-v` (or
//! `+v`) is glued to that cell's face. It works for any tessellation with a translation lattice and
//! decides itself which sizes close up seamlessly (a hex grid needs an even number of columns for a
//! gluing along the rows, a triangle grid an even one along both, ...): any other size is refused.

use super::field_ops::{
    COLS, FieldOps, Inclusion, PresetDescriptor, PresetParam, ROWS, convex_cells, optional_param,
    param,
};
use super::{FieldOpError, FoldEnd, NewFold, Point, PresetParams, Tessellation};
use std::collections::{HashMap, HashSet};

/// Which pair of sides a cylinder glues: `0` = left and right, `1` = top and bottom.
pub(super) const AXIS: PresetParam = PresetParam {
    name: "axis",
    min: 0,
};

/// A rectangle whose left and right (`axis` 0) or top and bottom (`axis` 1) sides are glued.
pub(super) const CYLINDER_PRESET: PresetDescriptor = PresetDescriptor {
    key: "cylinder",
    params: &[COLS, ROWS, AXIS],
};
/// A rectangle whose opposite sides are glued in both directions.
pub(super) const TORUS_PRESET: PresetDescriptor = PresetDescriptor {
    key: "torus",
    params: &[COLS, ROWS],
};

/// Upper bound of the `axis` switch of `cylinder` when `presets` offer it: the default
/// `Tessellation::preset_param_max`.
pub(super) fn rect_param_max_of(
    presets: &[PresetDescriptor],
    key: &str,
    name: &str,
) -> Option<u32> {
    (key == "cylinder" && name == "axis" && presets.iter().any(|preset| preset.key == key))
        .then_some(1)
}

/// How far along the lattice translation to look for the period, in lattice steps past the
/// rectangle's own extent (a valid period is at most one step wider than the extent of the centers).
const PERIOD_SEARCH: i64 = 3;
/// Largest lattice coefficient tried when looking for the shortest lattice vector along a frame axis.
const BASIS_RANGE: i32 = 12;
/// Tolerance of "this lattice vector lies along a frame axis", in world units.
const AXIS_EPS: f64 = 1e-6;

/// The pair of sides a gluing runs between: across the rectangle (left-right) or up it.
#[derive(Clone, Copy, PartialEq)]
enum Axis {
    Horizontal,
    Vertical,
}

/// An `Axis` of a frame: the world axes, or for a lattice that has no lattice vector along them
/// (snub square) the axes of the lattice itself, so the rectangle is turned with it.
#[derive(Clone, Copy)]
struct Direction {
    axis: Axis,
    /// Unit vector of the frame's horizontal axis.
    frame: Point,
}

impl Direction {
    fn new(axis: Axis, frame: Point) -> Self {
        Self { axis, frame }
    }

    fn unit(self) -> Point {
        match self.axis {
            Axis::Horizontal => self.frame,
            Axis::Vertical => Point::new(-self.frame.y, self.frame.x),
        }
    }

    fn along(self, p: Point) -> f64 {
        p.dot(self.unit())
    }

    /// The coordinate along the other axis of the frame.
    fn across(self, p: Point) -> f64 {
        let other = match self.axis {
            Axis::Horizontal => Axis::Vertical,
            Axis::Vertical => Axis::Horizontal,
        };
        Self {
            axis: other,
            ..self
        }
        .along(p)
    }
}

/// The unit vector of the horizontal axis of the frame the rectangle lives in: the world x axis when
/// the lattice has lattice vectors along both world axes, otherwise the lattice vector closest to it.
pub(super) fn frame_of<T: Tessellation>(tessellation: &T) -> Result<Point, FieldOpError> {
    let basis = tessellation.translation_basis().ok_or_else(not_glueable)?;
    let world = Point::new(1.0, 0.0);
    let fits = |frame: Point| {
        [Axis::Horizontal, Axis::Vertical]
            .iter()
            .all(|&axis| shortest_vector(basis, Direction::new(axis, frame)).is_some())
    };
    if fits(world) {
        return Ok(world);
    }
    let mut best: Option<Point> = None;
    for a in -FRAME_RANGE..=FRAME_RANGE {
        for b in -FRAME_RANGE..=FRAME_RANGE {
            let v = basis[0] * f64::from(a) + basis[1] * f64::from(b);
            let len = v.length();
            if len < AXIS_EPS || v.x <= AXIS_EPS {
                continue;
            }
            // The shortest first, then the one nearest the x axis.
            let better = best.is_none_or(|best| {
                len < best.length() - AXIS_EPS
                    || (len < best.length() + AXIS_EPS && v.y.abs() < best.y.abs() - AXIS_EPS)
            });
            if better {
                best = Some(v);
            }
        }
    }
    let frame = best
        .map(|v| v * (1.0 / v.length()))
        .ok_or_else(not_glueable)?;
    if fits(frame) {
        Ok(frame)
    } else {
        Err(not_glueable())
    }
}

/// Largest lattice coefficient tried when looking for the lattice vector that gives the frame.
const FRAME_RANGE: i32 = 3;

/// Checks that the rectangle preset `key` can be glued as it asks over `cells`: a plain rectangle
/// is always valid, a cylinder or torus needs a size that glues seamlessly.
pub(super) fn validate_rect_topology<T: Tessellation>(
    tessellation: &T,
    cells: &[T::CellId],
    key: &str,
    params: PresetParams<'_>,
) -> Result<(), FieldOpError> {
    rect_folds(tessellation, cells, key, params).map(|_| ())
}

/// The fold groups of the rectangle preset `key` over `cells`: none for a plain rectangle, one for
/// a cylinder, two (left-right, then top-bottom) for a torus.
pub(super) fn rect_folds<T: Tessellation>(
    tessellation: &T,
    cells: &[T::CellId],
    key: &str,
    params: PresetParams<'_>,
) -> Result<Vec<Vec<NewFold<T::CellId>>>, FieldOpError> {
    let axes = directions_of(key, params)?;
    if axes.is_empty() {
        return Ok(Vec::new());
    }
    let frame = frame_of(tessellation)?;
    let directions: Vec<Direction> = axes
        .iter()
        .map(|&axis| Direction::new(axis, frame))
        .collect();
    let set: HashSet<T::CellId> = cells.iter().copied().collect();
    let mut glued: HashSet<(T::CellId, usize)> = HashSet::new();
    let mut groups = Vec::with_capacity(directions.len() + 1);
    let mut periods = Vec::with_capacity(directions.len());
    let mark = |glued: &mut HashSet<(T::CellId, usize)>, folds: &[NewFold<T::CellId>]| {
        glued.extend(folds.iter().flat_map(|fold| {
            [
                (fold.a.cell, fold.a.face_idx),
                (fold.b.cell, fold.b.face_idx),
            ]
        }));
    };
    for &direction in &directions {
        let (folds, period) = glue_direction(tessellation, cells, &set, direction, &glued)?;
        mark(&mut glued, &folds);
        periods.push(period);
        groups.push(folds);
    }
    // A staggered edge (bricks, an octagon-square net, ...) leaves faces at a corner of a torus
    // that meet each other only across both periods at once: a group of their own.
    if let [horizontal, vertical] = periods[..] {
        let shifts = [
            horizontal * -1.0 + vertical * -1.0,
            horizontal * -1.0 + vertical,
            horizontal + vertical * -1.0,
            horizontal + vertical,
        ];
        let corners = pair_faces(
            tessellation,
            cells,
            &set,
            Direction::new(Axis::Vertical, frame),
            &shifts,
            &glued,
            false,
        )
        .unwrap_or_default();
        if !corners.is_empty() {
            groups.push(corners);
        }
    }
    check_neighbors(tessellation, &set, &groups)?;
    Ok(groups)
}

/// The cells whose centers lie in a rectangle `cols × rows` lattice periods big: a whole number of
/// periods holds a whole number of lattice cells, so opposite sides line up wherever the rectangle
/// sits. For the tessellations whose plain `rect` is not made of whole periods. `phase` is where the
/// rectangle starts modulo the period (it decides how jagged the outline is), in the frame of the
/// lattice; the built cells are then moved by the lattice vector that puts their mean nearest `center`.
pub(super) fn period_rect_cells<T: Tessellation>(
    tessellation: &T,
    params: PresetParams<'_>,
    center: Point,
    phase: Point,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let frame = frame_of(tessellation)?;
    let (horizontal, vertical) = frame_periods(tessellation, frame)?;
    let right = Direction::new(Axis::Horizontal, frame).unit();
    let up = Direction::new(Axis::Vertical, frame).unit();
    let size = Point::new(
        horizontal * f64::from(param(params, "cols")),
        vertical * f64::from(param(params, "rows")),
    );
    let (at, period) = (
        Point::new(center.dot(right), center.dot(up)),
        Point::new(horizontal, vertical),
    );
    let laps = |phase: f64, size: f64, period: f64, at: f64| {
        -((phase + size / 2.0 - at) / period).round() * period
    };
    let low = Point::new(
        phase.x + laps(phase.x, size.x, period.x, at.x),
        phase.y + laps(phase.y, size.y, period.y, at.y),
    );
    // The high sides stay open: a center right on one belongs to the next period.
    let high = low + Point::new(size.x - OPEN_SIDE, size.y - OPEN_SIDE);
    let world = |x: f64, y: f64| right * x + up * y;
    let corners = [
        world(low.x, low.y),
        world(high.x, low.y),
        world(high.x, high.y),
        world(low.x, high.y),
    ];
    let reach = size.x + size.y + center.length();
    let cells = convex_cells(
        tessellation,
        Point::default(),
        &corners,
        reach,
        Inclusion::Center,
    )?;
    center_on(tessellation, &cells, center)
}

/// `cells` moved by the lattice vector that brings the mean of their centers nearest to `center`.
/// A translation keeps the shape of the outline and the way its sides line up.
fn center_on<T: Tessellation>(
    tessellation: &T,
    cells: &[T::CellId],
    center: Point,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let basis = tessellation.translation_basis().ok_or_else(not_glueable)?;
    let sum = cells.iter().fold(Point::default(), |sum, &cell| {
        sum + tessellation.center(cell)
    });
    let off = sum * (1.0 / cells.len().max(1) as f64) - center;
    let mut best: Option<Point> = None;
    for a in -BASIS_RANGE..=BASIS_RANGE {
        for b in -BASIS_RANGE..=BASIS_RANGE {
            let v = basis[0] * f64::from(a) + basis[1] * f64::from(b);
            if best.is_none_or(|best| (off - v).length() < (off - best).length() - AXIS_EPS) {
                best = Some(v);
            }
        }
    }
    let shift = best.unwrap_or_default() * -1.0;
    tessellation.translate_cells(cells, shift)
}

/// The shortest horizontal and vertical lattice periods of `tessellation` in the frame `frame`.
fn frame_periods<T: Tessellation>(
    tessellation: &T,
    frame: Point,
) -> Result<(f64, f64), FieldOpError> {
    let basis = tessellation.translation_basis().ok_or_else(not_glueable)?;
    let period = |axis| {
        let direction = Direction::new(axis, frame);
        shortest_vector(basis, direction)
            .map(|v| direction.along(v))
            .ok_or_else(not_glueable)
    };
    Ok((period(Axis::Horizontal)?, period(Axis::Vertical)?))
}

/// How far the high sides of `period_rect_cells` are pulled in, far past any tolerance of the
/// containment test and far below any distance between centers.
const OPEN_SIDE: f64 = 1e-4;

/// The sides a rectangle preset glues: `(left-right, top-bottom)`. A tessellation whose net needs
/// extra cells along a glued side (the squares of an octagon-square net) asks this when building.
pub(super) fn rect_wraps(
    key: &str,
    params: PresetParams<'_>,
) -> Result<(bool, bool), FieldOpError> {
    let directions = directions_of(key, params)?;
    Ok((
        directions.contains(&Axis::Horizontal),
        directions.contains(&Axis::Vertical),
    ))
}

fn directions_of(key: &str, params: PresetParams<'_>) -> Result<Vec<Axis>, FieldOpError> {
    match key {
        "cylinder" => match optional_param(params, "axis") {
            0 => Ok(vec![Axis::Horizontal]),
            1 => Ok(vec![Axis::Vertical]),
            _ => Err(FieldOpError::InvalidPreset(
                "\"axis\" is at most 1".to_string(),
            )),
        },
        "torus" => Ok(vec![Axis::Horizontal, Axis::Vertical]),
        _ => Ok(Vec::new()),
    }
}

fn not_glueable() -> FieldOpError {
    FieldOpError::InvalidPreset("the rectangle cannot be glued seamlessly at this size".to_string())
}

/// The folds gluing one direction, plus the step vector between the glued sides.
type DirectionGlue<T> = (Vec<NewFold<<T as Tessellation>::CellId>>, Point);

/// The folds that glue the two sides of `cells` across `direction`.
fn glue_direction<T: Tessellation>(
    tessellation: &T,
    cells: &[T::CellId],
    set: &HashSet<T::CellId>,
    direction: Direction,
    glued: &HashSet<(T::CellId, usize)>,
) -> Result<DirectionGlue<T>, FieldOpError> {
    let basis = tessellation.translation_basis().ok_or_else(not_glueable)?;
    let step = shortest_vector(basis, direction).ok_or_else(not_glueable)?;
    let step_len = direction.along(step);
    let (lo, hi) = cells
        .iter()
        .map(|&cell| direction.along(tessellation.center(cell)))
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| {
            (lo.min(x), hi.max(x))
        });
    if !lo.is_finite() {
        return Err(not_glueable());
    }
    let first = (((hi - lo) / step_len).floor() as i64).max(1);
    for count in first..first + PERIOD_SEARCH {
        let period = step * count as f64;
        if let Some(folds) = pair_faces(
            tessellation,
            cells,
            set,
            direction,
            &[period * -1.0, period],
            glued,
            true,
        ) && !folds.is_empty()
        {
            return Ok((folds, period));
        }
    }
    Err(not_glueable())
}

/// The shortest lattice vector along `direction` (positive, no component across it).
fn shortest_vector(basis: [Point; 2], direction: Direction) -> Option<Point> {
    let mut best: Option<Point> = None;
    for a in -BASIS_RANGE..=BASIS_RANGE {
        for b in -BASIS_RANGE..=BASIS_RANGE {
            let v = basis[0] * f64::from(a) + basis[1] * f64::from(b);
            if direction.along(v) > AXIS_EPS
                && direction.across(v).abs() < AXIS_EPS
                && best.is_none_or(|best| direction.along(v) < direction.along(best) - AXIS_EPS)
            {
                best = Some(v);
            }
        }
    }
    best
}

/// Glues every boundary face whose outside neighbour moved by one of `shifts` is a cell of the
/// rectangle. When `strict`, `None` for an inconsistent pairing (the partner face is not a free
/// boundary face), which means the shift is not the rectangle's period; otherwise such a face stays
/// open. `a` ends lie on the low side of `direction`, `b` ends on the high one.
fn pair_faces<T: Tessellation>(
    tessellation: &T,
    cells: &[T::CellId],
    set: &HashSet<T::CellId>,
    direction: Direction,
    shifts: &[Point],
    glued: &HashSet<(T::CellId, usize)>,
    strict: bool,
) -> Option<Vec<NewFold<T::CellId>>> {
    let mut used: HashSet<(T::CellId, usize)> = HashSet::new();
    let mut folds = Vec::new();
    for &cell in cells {
        for (index, &face) in tessellation.faces_of(cell).iter().enumerate() {
            let Some((outside, outside_face)) = tessellation.neighbor(cell, face) else {
                continue;
            };
            if set.contains(&outside)
                || glued.contains(&(cell, index))
                || used.contains(&(cell, index))
            {
                continue;
            }
            for &shift in shifts {
                let Ok(moved) = tessellation.translate_cells(&[outside], shift) else {
                    continue;
                };
                let Some(&partner) = moved.first().filter(|partner| set.contains(partner)) else {
                    continue;
                };
                let Some(partner_index) = tessellation
                    .faces_of(partner)
                    .iter()
                    .position(|&f| f == outside_face)
                else {
                    if strict {
                        return None;
                    }
                    continue;
                };
                let free = tessellation
                    .neighbor(partner, outside_face)
                    .is_none_or(|(next, _)| !set.contains(&next));
                let end = (partner, partner_index);
                if !free || end == (cell, index) || glued.contains(&end) || used.contains(&end) {
                    if strict {
                        return None;
                    }
                    continue;
                }
                used.insert((cell, index));
                used.insert(end);
                // `a` is always the side at the low end of the direction, so one group's `a` run
                // is one side of the rectangle and its `b` run the opposite one.
                let (low, high) = if direction.along(shift) < 0.0 {
                    ((partner, partner_index), (cell, index))
                } else {
                    ((cell, index), (partner, partner_index))
                };
                folds.push(NewFold {
                    a: FoldEnd {
                        cell: low.0,
                        face_idx: low.1,
                    },
                    b: FoldEnd {
                        cell: high.0,
                        face_idx: high.1,
                    },
                    twist: false,
                });
                break;
            }
        }
    }
    // Along the sides, so the runs of a group follow each side (a zigzag edge stays in order).
    let position = |end: &FoldEnd<T::CellId>| {
        let face = tessellation.faces_of(end.cell)[end.face_idx];
        let mid = tessellation
            .face_segments(end.cell, face)
            .first()
            .map_or_else(
                || tessellation.center(end.cell),
                |segment| segment.point(0.5),
            );
        (direction.across(mid), direction.along(mid))
    };
    folds.sort_by(|x, y| {
        let (px, py) = (position(&x.a), position(&y.a));
        px.0.total_cmp(&py.0).then(px.1.total_cmp(&py.1))
    });
    Some(folds)
}

/// Gluing must not make a cell neighbour itself or the same cell through two faces (the v1
/// constraint of `Specs/topology.md`): a rectangle only a cell or two wide cannot be closed up.
fn check_neighbors<T: Tessellation>(
    tessellation: &T,
    set: &HashSet<T::CellId>,
    groups: &[Vec<NewFold<T::CellId>>],
) -> Result<(), FieldOpError> {
    let mut partner: HashMap<(T::CellId, usize), T::CellId> = HashMap::new();
    for fold in groups.iter().flatten() {
        partner.insert((fold.a.cell, fold.a.face_idx), fold.b.cell);
        partner.insert((fold.b.cell, fold.b.face_idx), fold.a.cell);
    }
    let touched: HashSet<T::CellId> = partner.keys().map(|&(cell, _)| cell).collect();
    for cell in touched {
        let mut seen: HashSet<T::CellId> = HashSet::new();
        for (index, &face) in tessellation.faces_of(cell).iter().enumerate() {
            let next = match partner.get(&(cell, index)) {
                Some(&next) => Some(next),
                None => tessellation
                    .neighbor(cell, face)
                    .map(|(next, _)| next)
                    .filter(|next| set.contains(next)),
            };
            if let Some(next) = next
                && (next == cell || !seen.insert(next))
            {
                return Err(not_glueable());
            }
        }
    }
    Ok(())
}
