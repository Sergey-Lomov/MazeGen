//! The jittered Voronoi tessellation: the Voronoi diagram of a triangular lattice of sites, each
//! displaced by a seeded pseudo-random offset. At zero jitter it is the regular hexagonal grid.
//!
//! Sites sit at lattice coordinates `(q, r)`: `d · (q + r / 2, r · √3 / 2)` plus the displacement,
//! `d` being the distance between neighboring lattice points (chosen so a regular hexagon has area
//! 1). The displacement of a site is a function of `(seed, q, r)` alone, uniform in the disc of
//! radius `d · jitter`. The space is the hexagonal disc of lattice points around the origin that
//! holds at most `max_cells` cells; the Voronoi cell of a space site is clipped by every other site
//! within lattice distance `CLIP_REACH` (sites outside the space included, so the cells on the
//! boundary are exact and their faces toward outside sites have no neighbor).
//!
//! A cell's faces are its Voronoi neighbors, a face being the lattice offset `(dq, dr)` of the
//! neighbor; the opposite face is the negated offset. Vertices are circumcenters of site triples,
//! computed from the triple in sorted order, so a vertex shared by several cells is bit-identical
//! from each. An edge shorter than `MIN_EDGE` (in units of `d`) is collapsed to its midpoint for all
//! cells at once: the two cells it separated stop being neighbors, and the cells stay gap-free.

use super::field_ops::{CIRCLE_PRESET, Inclusion, circle_cells, param, validate_preset};
use super::{
    CellShape, FieldOpError, FieldOperation, Point, PresetDescriptor, PresetParams, Segment,
    ShapeDescriptor, Tessellation, is_straight_geometric,
};
use std::collections::HashMap;
use std::f64::consts::TAU;

pub const MAX_JITTER: f64 = 0.4;
pub const DEFAULT_JITTER: f64 = 0.15;
/// Range of `max_cells`, the cell count of the hexagonal disc of lattice points.
pub const MIN_CELL_LIMIT: u32 = 100;
pub const MAX_CELL_LIMIT: u32 = 10_000;
pub const DEFAULT_CELL_LIMIT: u32 = 3000;

/// Sites within this lattice distance of a cell clip its Voronoi region. The separation step can
/// move a site a little beyond `MAX_JITTER · d`; `build` rejects a region that the clipping leaves
/// unbounded, and `every_seed_builds_at_maximum_jitter` covers the margin.
const CLIP_REACH: i32 = 3;
/// Half-size of the square a Voronoi region starts from, in units of `d`.
const START_HALF_SIZE: f64 = 4.0;
/// Edges shorter than this, in units of `d`, are collapsed.
const MIN_EDGE: f64 = 0.2;
/// Displaced neighboring sites are pushed apart to at least this distance, in units of `d`.
const MIN_SEPARATION: f64 = 0.8;
/// Lattice offsets of the six nearest neighbors.
const NEIGHBOR_OFFSETS: [(i32, i32); 6] = [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)];
/// Slack (world units) widening the box of a candidate query beyond the cell centers.
const CANDIDATE_MARGIN: f64 = 2.0;

/// The jitter, seed and size of the tessellation.
#[derive(Debug, Copy, Clone, PartialEq)]
pub struct VoronoiParams {
    /// Site displacement in units of the lattice distance, `0..=MAX_JITTER`.
    pub jitter: f64,
    pub seed: u32,
    /// The space holds the largest hexagonal disc of cells with at most this many cells.
    pub max_cells: u32,
}

/// The lattice coordinates of a cell's site: `x = q + r / 2`, `y = r · √3 / 2` in units of `d`.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct VoronoiPoint {
    pub q: i32,
    pub r: i32,
}

/// A face is the lattice offset from a cell's site to its neighbor's site.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct VoronoiFace {
    pub dq: i8,
    pub dr: i8,
}

impl VoronoiFace {
    fn opposite(self) -> Self {
        Self {
            dq: -self.dq,
            dr: -self.dr,
        }
    }
}

#[derive(Debug, Clone)]
struct CellData {
    faces: Vec<VoronoiFace>,
    /// Vertex `i` is the start of face `i`.
    vertices: Vec<Point>,
    center: Point,
    area: f64,
}

#[derive(Debug, Clone)]
pub struct VoronoiTessellation {
    params: VoronoiParams,
    /// Lattice distance `d` of the disc's radius: the disc is `|q|, |r|, |q + r| <= radius`.
    radius: i32,
    /// Distance between neighboring lattice points, in world units.
    spacing: f64,
    /// Index into `cells` by `(q + radius) * (2 · radius + 1) + r + radius`; `u32::MAX` outside.
    slots: Vec<u32>,
    cells: Vec<CellData>,
    /// Sites of the lattice points within `radius + CLIP_REACH`, by `(q + reach) * width + r + reach`.
    sites: Vec<Point>,
}

type Key = [(i32, i32); 3];

impl VoronoiTessellation {
    /// Builds the tessellation, rejecting parameters outside their supported ranges.
    pub fn new(params: VoronoiParams) -> Result<Self, String> {
        if !(0.0..=MAX_JITTER).contains(&params.jitter) {
            return Err(format!(
                "jitter must be between 0 and {MAX_JITTER}, got {}",
                params.jitter
            ));
        }
        if !(MIN_CELL_LIMIT..=MAX_CELL_LIMIT).contains(&params.max_cells) {
            return Err(format!(
                "max_cells must be between {MIN_CELL_LIMIT} and {MAX_CELL_LIMIT}, got {}",
                params.max_cells
            ));
        }
        let mut radius = 0;
        while disc_size(radius + 1) <= params.max_cells {
            radius += 1;
        }
        let mut this = Self {
            params,
            radius,
            spacing: (2.0 / 3f64.sqrt()).sqrt(),
            slots: vec![u32::MAX; ((2 * radius + 1) * (2 * radius + 1)) as usize],
            cells: Vec::new(),
            sites: Vec::new(),
        };
        let reach = radius + CLIP_REACH;
        this.sites = (-reach..=reach)
            .flat_map(|q| (-reach..=reach).map(move |r| (q, r)))
            .map(|(q, r)| this.computed_site(q, r))
            .collect();
        this.build()?;
        Ok(this)
    }

    pub fn params(&self) -> VoronoiParams {
        self.params
    }

    /// Radius of the hexagonal disc of lattice points that holds the cells.
    pub fn radius(&self) -> i32 {
        self.radius
    }

    /// Distance between neighboring lattice points, in world units.
    pub fn spacing(&self) -> f64 {
        self.spacing
    }

    /// The site of lattice point `(q, r)`: the lattice point plus its seeded displacement.
    pub fn site(&self, q: i32, r: i32) -> Point {
        let reach = self.radius + CLIP_REACH;
        if q.abs() <= reach
            && r.abs() <= reach
            && let Some(&site) = self
                .sites
                .get(((q + reach) * (2 * reach + 1) + r + reach) as usize)
        {
            return site;
        }
        self.computed_site(q, r)
    }

    /// The seeded displacement of lattice point `(q, r)`, before the separation step.
    fn displaced(&self, q: i32, r: i32) -> Point {
        let lattice = self.lattice(q, r);
        let (u1, u2) = unit_pair(self.params.seed, q, r);
        lattice + Point::polar(self.spacing * self.params.jitter * u1.sqrt(), TAU * u2)
    }

    /// The displaced point pushed away from every lattice neighbor (also displaced) that is closer
    /// than `MIN_SEPARATION · d`; the neighbor pushes back, so a close pair is pulled apart by the
    /// whole deficit. Without it two close sites squeeze the cells between them into slivers.
    fn computed_site(&self, q: i32, r: i32) -> Point {
        if self.params.jitter == 0.0 {
            return self.lattice(q, r);
        }
        let own = self.displaced(q, r);
        let wanted = MIN_SEPARATION * self.spacing;
        NEIGHBOR_OFFSETS.into_iter().fold(own, |site, (dq, dr)| {
            let away = own - self.displaced(q + dq, r + dr);
            let distance = away.length();
            if distance < wanted && distance > 0.0 {
                site + away * ((wanted - distance) / (2.0 * distance))
            } else {
                site
            }
        })
    }

    fn lattice(&self, q: i32, r: i32) -> Point {
        Point::new(
            self.spacing * (f64::from(q) + f64::from(r) / 2.0),
            self.spacing * f64::from(r) * 3f64.sqrt() / 2.0,
        )
    }

    fn slot(&self, q: i32, r: i32) -> Option<usize> {
        if q.abs() > self.radius || r.abs() > self.radius || (q + r).abs() > self.radius {
            return None;
        }
        let width = 2 * self.radius + 1;
        Some(((q + self.radius) * width + r + self.radius) as usize)
    }

    fn data(&self, cell: VoronoiPoint) -> &CellData {
        let slot = self.slot(cell.q, cell.r).expect("valid cell");
        &self.cells[self.slots[slot] as usize]
    }

    fn build(&mut self) -> Result<(), String> {
        let lattice: Vec<(i32, i32)> = (-self.radius..=self.radius)
            .flat_map(|q| (-self.radius..=self.radius).map(move |r| (q, r)))
            .filter(|&(q, r)| self.slot(q, r).is_some())
            .collect();
        let regions: Vec<Vec<VoronoiFace>> = lattice
            .iter()
            .map(|&(q, r)| self.region(q, r))
            .collect::<Result<_, _>>()?;

        // Vertex ids by site triple, merged where an edge is too short.
        let mut ids: HashMap<Key, usize> = HashMap::new();
        let mut points: Vec<Point> = Vec::new();
        let mut parent: Vec<usize> = Vec::new();
        let mut keys: Vec<Vec<usize>> = Vec::with_capacity(regions.len());
        for (&(q, r), faces) in lattice.iter().zip(&regions) {
            let mut cell_keys = Vec::with_capacity(faces.len());
            for i in 0..faces.len() {
                let before = faces[(i + faces.len() - 1) % faces.len()];
                let key = sorted_key([(q, r), offset(q, r, before), offset(q, r, faces[i])]);
                let id = *ids.entry(key).or_insert_with(|| {
                    points.push(self.circumcenter(key));
                    parent.push(parent.len());
                    parent.len() - 1
                });
                cell_keys.push(id);
            }
            keys.push(cell_keys);
        }
        let threshold = MIN_EDGE * self.spacing;
        for cell_keys in &keys {
            for i in 0..cell_keys.len() {
                let (a, b) = (cell_keys[i], cell_keys[(i + 1) % cell_keys.len()]);
                if points[a].distance(points[b]) < threshold {
                    let (a, b) = (find(&mut parent, a), find(&mut parent, b));
                    parent[a.max(b)] = a.min(b);
                }
            }
        }
        // A merged vertex is the mean of its members.
        let mut sums = vec![(Point::default(), 0usize); points.len()];
        for (id, &point) in points.iter().enumerate() {
            let root = find(&mut parent, id);
            sums[root].0 = sums[root].0 + point;
            sums[root].1 += 1;
        }
        let merged: Vec<Point> = (0..points.len())
            .map(|id| {
                let (sum, count) = sums[find(&mut parent, id)];
                if count == 1 {
                    points[id]
                } else {
                    sum * (1.0 / count as f64)
                }
            })
            .collect();

        for ((&(q, r), faces), cell_keys) in lattice.iter().zip(&regions).zip(&keys) {
            let roots: Vec<usize> = cell_keys.iter().map(|&id| find(&mut parent, id)).collect();
            let count = faces.len();
            let kept: Vec<usize> = (0..count)
                .filter(|&i| roots[i] != roots[(i + 1) % count])
                .collect();
            if kept.len() < 3 {
                return Err(format!("cell ({q}, {r}) collapsed to {} faces", kept.len()));
            }
            // Start at the face toward the smallest lattice direction angle.
            let angle = |face: VoronoiFace| {
                let dq = f64::from(face.dq);
                let dr = f64::from(face.dr);
                (dr * 3f64.sqrt() / 2.0)
                    .atan2(dq + dr / 2.0)
                    .rem_euclid(TAU)
            };
            let first = (0..kept.len())
                .min_by(|&a, &b| angle(faces[kept[a]]).total_cmp(&angle(faces[kept[b]])))
                .expect("a cell has faces");
            let order: Vec<usize> = (0..kept.len())
                .map(|i| kept[(first + i) % kept.len()])
                .collect();
            let data = cell_data(
                order.iter().map(|&i| faces[i]).collect(),
                order.iter().map(|&i| merged[roots[i]]).collect(),
            );
            let slot = self.slot(q, r).expect("lattice point in the disc");
            self.slots[slot] = self.cells.len() as u32;
            self.cells.push(data);
        }
        Ok(())
    }

    /// The Voronoi region of site `(q, r)` as its neighbors in counter-clockwise edge order.
    fn region(&self, q: i32, r: i32) -> Result<Vec<VoronoiFace>, String> {
        let site = self.site(q, r);
        let half = START_HALF_SIZE * self.spacing;
        // Each vertex carries the label of the edge that starts there; `None` is the start square.
        let mut polygon: Vec<(Point, Option<VoronoiFace>)> =
            [(-half, -half), (half, -half), (half, half), (-half, half)]
                .into_iter()
                .map(|(x, y)| (site + Point::new(x, y), None))
                .collect();
        for dq in -CLIP_REACH..=CLIP_REACH {
            for dr in -CLIP_REACH..=CLIP_REACH {
                if (dq + dr).abs() > CLIP_REACH || (dq == 0 && dr == 0) {
                    continue;
                }
                let face = VoronoiFace {
                    dq: dq as i8,
                    dr: dr as i8,
                };
                let other = self.site(q + dq, r + dr);
                polygon = clip(&polygon, site, other, face);
            }
        }
        if polygon.len() < 3 || polygon.iter().any(|(_, label)| label.is_none()) {
            return Err(format!(
                "region of cell ({q}, {r}) is not bounded by its neighbors"
            ));
        }
        Ok(polygon.into_iter().filter_map(|(_, label)| label).collect())
    }

    fn circumcenter(&self, key: Key) -> Point {
        let [a, b, c] = key.map(|(q, r)| self.site(q, r));
        let (b, c) = (b - a, c - a);
        let d = 2.0 * b.cross(c);
        let (b2, c2) = (b.dot(b), c.dot(c));
        a + Point::new((c.y * b2 - b.y * c2) / d, (b.x * c2 - c.x * b2) / d)
    }
}

/// Cells of the hexagonal disc of the given radius.
fn disc_size(radius: i32) -> u32 {
    (3 * radius * (radius + 1) + 1) as u32
}

fn offset(q: i32, r: i32, face: VoronoiFace) -> (i32, i32) {
    (q + i32::from(face.dq), r + i32::from(face.dr))
}

fn sorted_key(mut key: Key) -> Key {
    key.sort_unstable();
    key
}

fn find(parent: &mut [usize], mut id: usize) -> usize {
    while parent[id] != id {
        parent[id] = parent[parent[id]];
        id = parent[id];
    }
    id
}

/// Two uniform values in `[0, 1)` determined by the seed and the lattice point alone.
fn unit_pair(seed: u32, q: i32, r: i32) -> (f64, f64) {
    let mut state = (u64::from(seed) << 32) ^ (u64::from(q as u32) << 16) ^ u64::from(r as u32);
    state = state
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(u64::from(r as u32));
    let mut next = || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64
    };
    (next(), next())
}

/// `polygon` (counter-clockwise, vertices labeled by the edge starting there) clipped to the
/// points closer to `site` than to `other`; the new edge is labeled `face`.
fn clip(
    polygon: &[(Point, Option<VoronoiFace>)],
    site: Point,
    other: Point,
    face: VoronoiFace,
) -> Vec<(Point, Option<VoronoiFace>)> {
    let normal = other - site;
    let middle = (site + other) * 0.5;
    let side = |p: Point| (p - middle).dot(normal);
    let mut result = Vec::with_capacity(polygon.len() + 1);
    for (i, &(from, label)) in polygon.iter().enumerate() {
        let to = polygon[(i + 1) % polygon.len()].0;
        let (a, b) = (side(from), side(to));
        let crossing = || from + (to - from) * (a / (a - b));
        match (a <= 0.0, b <= 0.0) {
            (true, true) => result.push((from, label)),
            (true, false) => {
                result.push((from, label));
                result.push((crossing(), Some(face)));
            }
            (false, true) => result.push((crossing(), label)),
            (false, false) => {}
        }
    }
    result
}

fn cell_data(faces: Vec<VoronoiFace>, vertices: Vec<Point>) -> CellData {
    let mut area = 0.0;
    let mut centroid = Point::default();
    for (i, &p) in vertices.iter().enumerate() {
        let q = vertices[(i + 1) % vertices.len()];
        let cross = p.cross(q);
        area += cross;
        centroid = centroid + (p + q) * cross;
    }
    area /= 2.0;
    CellData {
        faces,
        vertices,
        center: centroid * (1.0 / (6.0 * area)),
        area,
    }
}

impl Tessellation for VoronoiTessellation {
    type CellId = VoronoiPoint;
    type Face = VoronoiFace;

    fn is_valid_cell(&self, cell: VoronoiPoint) -> bool {
        self.slot(cell.q, cell.r).is_some()
    }

    fn faces_of(&self, cell: VoronoiPoint) -> &[VoronoiFace] {
        debug_assert!(self.is_valid_cell(cell), "invalid cell {cell:?}");
        &self.data(cell).faces
    }

    fn neighbor(
        &self,
        cell: VoronoiPoint,
        face: VoronoiFace,
    ) -> Option<(VoronoiPoint, VoronoiFace)> {
        debug_assert!(self.faces_of(cell).contains(&face), "{face:?} of {cell:?}");
        let (q, r) = offset(cell.q, cell.r, face);
        self.is_valid_cell(VoronoiPoint { q, r })
            .then_some((VoronoiPoint { q, r }, face.opposite()))
    }

    /// The geometric definition (`is_straight_geometric`) over the contact points and the center.
    fn is_straight(&self, cell: VoronoiPoint, in_face: VoronoiFace, out_face: VoronoiFace) -> bool {
        debug_assert!(self.faces_of(cell).contains(&in_face));
        debug_assert!(self.faces_of(cell).contains(&out_face));
        is_straight_geometric(self, cell, in_face, out_face)
    }

    /// Irregular cells have no shape templates, so split patterns never apply to them.
    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &[]
    }

    fn shape_of(&self, _cell: VoronoiPoint) -> Option<CellShape<'_>> {
        None
    }

    /// The centroid of the cell's polygon.
    fn center(&self, cell: VoronoiPoint) -> Point {
        self.data(cell).center
    }

    fn face_segments(&self, cell: VoronoiPoint, face: VoronoiFace) -> Vec<Segment> {
        let data = self.data(cell);
        let index = data
            .faces
            .iter()
            .position(|&f| f == face)
            .expect("face of the cell");
        vec![Segment::line(
            data.vertices[index],
            data.vertices[(index + 1) % data.vertices.len()],
        )]
    }

    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<VoronoiPoint>> {
        let (lo, hi) = (
            Point::new(min.x.min(max.x), min.y.min(max.y)),
            Point::new(min.x.max(max.x), min.y.max(max.y)),
        );
        // A cell lies within `1.5 d` of its lattice point; `CANDIDATE_MARGIN` covers that.
        let margin = CANDIDATE_MARGIN * self.spacing;
        let row_height = self.spacing * 3f64.sqrt() / 2.0;
        let rows = (((lo.y - margin) / row_height)
            .floor()
            .max(-f64::from(self.radius)) as i32)
            ..=(((hi.y + margin) / row_height)
                .ceil()
                .min(f64::from(self.radius)) as i32);
        let columns = |r: i32| {
            let shift = f64::from(r) / 2.0;
            let first = ((lo.x - margin) / self.spacing - shift).floor() as i64;
            let last = ((hi.x + margin) / self.spacing - shift).ceil() as i64;
            let q_min = i64::from((-self.radius).max(-self.radius - r));
            let q_max = i64::from(self.radius.min(self.radius - r));
            (first.max(q_min), last.min(q_max))
        };
        let mut total = 0usize;
        for r in rows.clone() {
            let (first, last) = columns(r);
            total = total.saturating_add((last - first + 1).max(0) as usize);
            if total > limit {
                return None;
            }
        }
        let mut cells = Vec::with_capacity(total);
        for r in rows {
            let (first, last) = columns(r);
            cells.extend((first..=last).map(|q| VoronoiPoint { q: q as i32, r }));
        }
        Some(cells)
    }

    /// No translation or reflection maps a jittered diagram onto itself.
    fn field_operations(&self) -> &[FieldOperation] {
        &[]
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn preset_param_max(&self, key: &str, name: &str) -> Option<u32> {
        (key == "circle" && name == "radius")
            .then(|| (f64::from(self.radius + 1) * self.spacing).ceil() as u32)
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<VoronoiPoint>, FieldOpError> {
        validate_preset(&PRESETS, key, params)?;
        match key {
            "circle" => {
                let radius = param(params, "radius");
                let limit = self.preset_param_max(key, "radius").unwrap_or(u32::MAX);
                if radius > limit {
                    return Err(FieldOpError::InvalidPreset(format!(
                        "radius must be at most {limit}: the tessellation ends at {} cells",
                        disc_size(self.radius)
                    )));
                }
                circle_cells(self, Point::default(), radius, Inclusion::Center)
            }
            _ => Err(FieldOpError::Unavailable),
        }
    }

    fn area(&self, cell: VoronoiPoint) -> f64 {
        self.data(cell).area
    }
}

/// Preset field shapes: the cells whose center lies within `radius` world units of the origin.
const PRESETS: [PresetDescriptor; 1] = [CIRCLE_PRESET];
