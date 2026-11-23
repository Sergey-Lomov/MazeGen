//! Automatic zones: zones derived from the field itself. See `Specs/zones.md`, "Automatic zones".

use super::Tessellation;
use super::geometry::{Point, TessellationGeometry};
use super::zone::ZoneCell;
use std::collections::HashSet;
use std::hash::{BuildHasherDefault, Hasher};

/// Multiply-rotate hasher (the one rustc uses) for the cell sets: a cell is a couple of small
/// integers, and the default SipHash costs several times more per lookup than the rest of the
/// walk over a large field. Not DoS-resistant, which a set of the user's own cells does not need.
#[derive(Default, Clone, Copy)]
struct FastHasher(u64);

impl FastHasher {
    const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(Self::SEED);
    }
}

impl Hasher for FastHasher {
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.add(u64::from_le_bytes(word));
        }
    }

    fn write_u8(&mut self, i: u8) {
        self.add(u64::from(i));
    }

    fn write_u32(&mut self, i: u32) {
        self.add(u64::from(i));
    }

    fn write_i32(&mut self, i: i32) {
        self.add(i as u32 as u64);
    }

    fn write_u64(&mut self, i: u64) {
        self.add(i);
    }

    fn write_usize(&mut self, i: usize) {
        self.add(i as u64);
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

type FastSet<C> = HashSet<C, BuildHasherDefault<FastHasher>>;

/// Tolerance of the "contact point lies on a crease" test. Crease ends come from the web as
/// floats the user drew or a preset produced, so it is looser than `GEOM_EPS`.
const CREASE_EPS: f64 = 1e-6;

/// What an automatic zone is, and the key that keeps its identity across recomputations: the
/// same key always names the same zone, whatever the cells. The index of a face or region is the
/// position of its smallest cell among the floor's components, so it is stable while the
/// components keep their smallest cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AutoZoneKey {
    /// Every cell of every floor.
    Maze,
    /// Every cell of one cell type on one floor; the index is the type's position in
    /// `Tessellation::cell_types`.
    CellType { floor: usize, index: usize },
    /// Every cell of one floor.
    Floor(usize),
    /// The cells of one floor with a geometric neighbor outside the field.
    FieldEdge(usize),
    /// One face of a folded floor that creases split into several: a component between creases.
    Face { floor: usize, index: usize },
    /// One of several components of a floor by geometric neighbors.
    Region { floor: usize, index: usize },
}

/// One floor's input: its field cells, the crease lines of its topology (world-unit segments) and
/// whether it has folds at all (a floor without folds is no polyhedron, so it has no faces).
#[derive(Debug, Clone)]
pub struct AutoZoneFloor<C> {
    pub cells: Vec<C>,
    pub creases: Vec<[Point; 2]>,
    pub folded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoZone<C> {
    pub key: AutoZoneKey,
    pub cells: Vec<ZoneCell<C>>,
}

/// Computes the automatic zones of a multi-floor field: the whole maze, then per floor in order
/// the floor (only on a multi-floor maze), its cell types (a regular tessellation of several types,
/// a floor holding cells of more than one of them), its edge, its faces (folded floors split into more
/// than one face only) and its regions (floors split into more than one region only). A zone with
/// no cells is not produced.
pub fn compute_auto_zones<T: Tessellation>(
    tessellation: &T,
    floors: &[AutoZoneFloor<T::CellId>],
) -> Vec<AutoZone<T::CellId>> {
    let mut zones = Vec::new();
    // Each floor's cells are sorted once, for the maze zone and for the floor's own zones.
    let sorted_floors: Vec<Vec<T::CellId>> = floors.iter().map(|f| sorted(&f.cells)).collect();
    let all: Vec<_> = sorted_floors
        .iter()
        .enumerate()
        .flat_map(|(floor, cells)| cells.iter().map(move |&c| ZoneCell::new(floor, c)))
        .collect();
    push(&mut zones, AutoZoneKey::Maze, all);
    for (floor, (data, cells)) in floors.iter().zip(&sorted_floors).enumerate() {
        let members: FastSet<T::CellId> = cells.iter().copied().collect();
        if floors.len() > 1 {
            push(
                &mut zones,
                AutoZoneKey::Floor(floor),
                on_floor(floor, cells),
            );
        }
        for (index, typed) in cells_by_type(tessellation, floor, cells)
            .into_iter()
            .enumerate()
        {
            push(&mut zones, AutoZoneKey::CellType { floor, index }, typed);
        }
        let edge: Vec<_> = cells
            .iter()
            .copied()
            .filter(|&c| has_outside_neighbor(tessellation, &members, c))
            .collect();
        push(
            &mut zones,
            AutoZoneKey::FieldEdge(floor),
            on_floor(floor, &edge),
        );
        if data.folded {
            let parts = components(tessellation, cells, &members, |c, face| {
                !on_crease(tessellation, &data.creases, c, face)
            });
            // One face is no polyhedron: the floor is that zone already.
            if parts.len() > 1 {
                for (index, part) in parts.into_iter().enumerate() {
                    push(
                        &mut zones,
                        AutoZoneKey::Face { floor, index },
                        on_floor(floor, &part),
                    );
                }
            }
        }
        let parts = components(tessellation, cells, &members, |_, _| true);
        // One region is the whole floor: the floor (or the maze) is that zone already.
        if parts.len() > 1 {
            for (index, part) in parts.into_iter().enumerate() {
                push(
                    &mut zones,
                    AutoZoneKey::Region { floor, index },
                    on_floor(floor, &part),
                );
            }
        }
    }
    zones
}

/// One floor's sorted cells per cell type (index = position in `cell_types`), or nothing when the
/// types do not split the floor: a tessellation of one type, an irregular one (`cells_vary_in_size`:
/// its cells of a type differ in size and shape, so the type says little), or a floor holding cells
/// of one type only (that zone would be the floor).
fn cells_by_type<T: Tessellation>(
    tessellation: &T,
    floor: usize,
    cells: &[T::CellId],
) -> Vec<Vec<ZoneCell<T::CellId>>> {
    let count = tessellation.cell_types().len();
    if count < 2 || tessellation.cells_vary_in_size() {
        return Vec::new();
    }
    let mut by_type: Vec<Vec<ZoneCell<T::CellId>>> = (0..count).map(|_| Vec::new()).collect();
    for &cell in cells {
        by_type[tessellation.cell_type_of(cell).index()].push(ZoneCell::new(floor, cell));
    }
    if by_type.iter().filter(|cells| !cells.is_empty()).count() < 2 {
        return Vec::new();
    }
    by_type
}

fn push<C>(zones: &mut Vec<AutoZone<C>>, key: AutoZoneKey, cells: Vec<ZoneCell<C>>) {
    if !cells.is_empty() {
        zones.push(AutoZone { key, cells });
    }
}

fn sorted<C: Ord + Copy>(cells: &[C]) -> Vec<C> {
    let mut cells = cells.to_vec();
    cells.sort();
    cells.dedup();
    cells
}

fn on_floor<C: Copy>(floor: usize, cells: &[C]) -> Vec<ZoneCell<C>> {
    cells.iter().map(|&c| ZoneCell::new(floor, c)).collect()
}

/// A face with no tessellation neighbor at all counts as outside: it is the rim of a finite
/// tessellation, which a user sees as the edge of the field.
fn has_outside_neighbor<T: Tessellation>(
    tessellation: &T,
    members: &FastSet<T::CellId>,
    cell: T::CellId,
) -> bool {
    tessellation
        .faces_of(cell)
        .iter()
        .any(|&face| match tessellation.neighbor(cell, face) {
            Some((other, _)) => !members.contains(&other),
            None => true,
        })
}

fn on_crease<T: Tessellation>(
    tessellation: &T,
    creases: &[[Point; 2]],
    cell: T::CellId,
    face: T::Face,
) -> bool {
    if creases.is_empty() {
        return false;
    }
    let contact = tessellation.contact_point(cell, face);
    creases
        .iter()
        .any(|&[a, b]| distance_to_segment(contact, a, b) <= CREASE_EPS)
}

fn distance_to_segment(p: Point, a: Point, b: Point) -> f64 {
    let ab = b - a;
    let len2 = ab.dot(ab);
    if len2 == 0.0 {
        return p.distance(a);
    }
    let t = ((p - a).dot(ab) / len2).clamp(0.0, 1.0);
    p.distance(a + ab * t)
}

/// Connected components of `cells` over tessellation neighbors inside `members`, crossing a face
/// only where `crosses(cell, face)` holds. Components are ordered by their smallest cell. When
/// there are several they also hold their cells in order; a lone component (the usual case, and
/// one the callers do not use) is left in walk order, so a large field is not sorted for nothing.
/// `cells` must be sorted.
fn components<T: Tessellation>(
    tessellation: &T,
    cells: &[T::CellId],
    members: &FastSet<T::CellId>,
    crosses: impl Fn(T::CellId, T::Face) -> bool,
) -> Vec<Vec<T::CellId>> {
    let mut seen: FastSet<T::CellId> =
        FastSet::with_capacity_and_hasher(cells.len(), Default::default());
    let mut parts = Vec::new();
    for &start in cells {
        if seen.contains(&start) {
            continue;
        }
        let mut part = vec![start];
        seen.insert(start);
        let mut next = 0;
        while next < part.len() {
            let cell = part[next];
            next += 1;
            for &face in tessellation.faces_of(cell) {
                let Some((other, _)) = tessellation.neighbor(cell, face) else {
                    continue;
                };
                if members.contains(&other) && !seen.contains(&other) && crosses(cell, face) {
                    seen.insert(other);
                    part.push(other);
                }
            }
        }
        parts.push(part);
    }
    if parts.len() > 1 {
        for part in &mut parts {
            part.sort();
        }
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{
        SquareOctagonPoint, SquareOctagonTessellation, SquarePoint, SquareTessellation,
    };

    fn rect(w: i32, h: i32) -> Vec<SquarePoint> {
        (0..h)
            .flat_map(|y| (0..w).map(move |x| SquarePoint { x: x, y: y }))
            .collect()
    }

    fn floor(cells: Vec<SquarePoint>) -> AutoZoneFloor<SquarePoint> {
        AutoZoneFloor {
            cells,
            creases: Vec::new(),
            folded: false,
        }
    }

    fn keys<C>(zones: &[AutoZone<C>]) -> Vec<AutoZoneKey> {
        zones.iter().map(|z| z.key).collect()
    }

    fn zone<C>(zones: &[AutoZone<C>], key: AutoZoneKey) -> &AutoZone<C> {
        zones.iter().find(|z| z.key == key).unwrap()
    }

    #[test]
    fn plain_single_floor_has_maze_and_edge_only() {
        let zones = compute_auto_zones(&SquareTessellation, &[floor(rect(3, 3))]);
        assert_eq!(
            keys(&zones),
            vec![AutoZoneKey::Maze, AutoZoneKey::FieldEdge(0),]
        );
        assert_eq!(zone(&zones, AutoZoneKey::Maze).cells.len(), 9);
        // Every cell of a 3x3 touches the outside except the center.
        assert_eq!(zone(&zones, AutoZoneKey::FieldEdge(0)).cells.len(), 8);
    }

    #[test]
    fn floor_zones_exist_only_on_a_multi_floor_maze() {
        let zones =
            compute_auto_zones(&SquareTessellation, &[floor(rect(2, 1)), floor(rect(1, 1))]);
        assert_eq!(zone(&zones, AutoZoneKey::Maze).cells.len(), 3);
        assert_eq!(zone(&zones, AutoZoneKey::Floor(1)).cells.len(), 1);
        assert!(zone(&zones, AutoZoneKey::Floor(0)).cells.len() == 2);
    }

    #[test]
    fn disconnected_pieces_are_separate_regions() {
        let cells = vec![
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 5, y: 5 },
        ];
        let zones = compute_auto_zones(&SquareTessellation, &[floor(cells)]);
        assert_eq!(
            zone(&zones, AutoZoneKey::Region { floor: 0, index: 0 })
                .cells
                .len(),
            2
        );
        assert_eq!(
            zone(&zones, AutoZoneKey::Region { floor: 0, index: 1 })
                .cells
                .len(),
            1
        );
    }

    #[test]
    fn a_single_region_makes_no_region_zone() {
        let zones = compute_auto_zones(&SquareTessellation, &[floor(rect(3, 3))]);
        assert!(
            !keys(&zones)
                .iter()
                .any(|k| matches!(k, AutoZoneKey::Region { .. }))
        );
    }

    #[test]
    fn faces_need_folds_and_are_split_by_creases() {
        let mut data = floor(rect(4, 1));
        let unfolded = compute_auto_zones(&SquareTessellation, &[data.clone()]);
        assert!(
            !keys(&unfolded)
                .iter()
                .any(|k| matches!(k, AutoZoneKey::Face { .. }))
        );

        data.folded = true;
        // A crease on the edge between x=1 and x=2 (unit cells, edge at x=2).
        data.creases = vec![[Point::new(2.0, 0.0), Point::new(2.0, 1.0)]];
        let zones = compute_auto_zones(&SquareTessellation, &[data]);
        let faces: Vec<_> = zones
            .iter()
            .filter(|z| matches!(z.key, AutoZoneKey::Face { .. }))
            .collect();
        assert_eq!(faces.len(), 2);
        assert!(faces.iter().all(|z| z.cells.len() == 2));
    }

    #[test]
    fn a_folded_floor_with_one_face_has_no_face_zone() {
        let mut data = floor(rect(3, 2));
        data.folded = true;
        let zones = compute_auto_zones(&SquareTessellation, &[data]);
        assert!(
            !keys(&zones)
                .iter()
                .any(|k| matches!(k, AutoZoneKey::Face { .. }))
        );
    }

    #[test]
    fn floors_without_folds_get_no_face_zones() {
        let zones =
            compute_auto_zones(&SquareTessellation, &[floor(rect(2, 1)), floor(rect(2, 1))]);
        assert!(
            !keys(&zones)
                .iter()
                .any(|k| matches!(k, AutoZoneKey::Face { .. }))
        );
    }

    fn octagon_field(points: &[(i32, i32)]) -> AutoZoneFloor<SquareOctagonPoint> {
        AutoZoneFloor {
            cells: points
                .iter()
                .map(|&(x, y)| SquareOctagonPoint { x, y })
                .collect(),
            creases: Vec::new(),
            folded: false,
        }
    }

    #[test]
    fn a_floor_is_split_by_cell_type_floor_by_floor() {
        // Floor 0 holds octagons and a square, floor 1 octagons only.
        let floors = [
            octagon_field(&[(0, 0), (1, 1), (2, 2)]),
            octagon_field(&[(0, 0), (2, 2)]),
        ];
        let zones = compute_auto_zones(&SquareOctagonTessellation, &floors);
        let key = |floor, index| AutoZoneKey::CellType { floor, index };
        assert_eq!(zone(&zones, key(0, 0)).cells.len(), 2);
        assert_eq!(
            zone(&zones, key(0, 1)).cells,
            vec![ZoneCell::new(0, SquareOctagonPoint { x: 1, y: 1 })]
        );
        // Octagons only: that zone would be the floor. No zone spans floors.
        assert!(
            !keys(&zones)
                .iter()
                .any(|k| matches!(k, AutoZoneKey::CellType { floor: 1, .. }))
        );
        assert_eq!(
            keys(&zones)
                .iter()
                .filter(|k| matches!(k, AutoZoneKey::CellType { .. }))
                .count(),
            2
        );
    }

    #[test]
    fn a_single_floor_maze_is_split_by_type_too() {
        let zones = compute_auto_zones(
            &SquareOctagonTessellation,
            &[octagon_field(&[(0, 0), (1, 1)])],
        );
        assert_eq!(
            keys(&zones)
                .iter()
                .filter(|k| matches!(k, AutoZoneKey::CellType { .. }))
                .count(),
            2
        );
    }

    #[test]
    fn a_floor_of_one_type_makes_no_type_zone() {
        let zones = compute_auto_zones(
            &SquareOctagonTessellation,
            &[octagon_field(&[(0, 0), (2, 2)])],
        );
        assert!(
            !zones
                .iter()
                .any(|z| matches!(z.key, AutoZoneKey::CellType { .. }))
        );
    }

    #[test]
    fn a_single_type_tessellation_makes_no_type_zone() {
        let zones = compute_auto_zones(&SquareTessellation, &[floor(rect(3, 3))]);
        assert!(
            !keys(&zones)
                .iter()
                .any(|k| matches!(k, AutoZoneKey::CellType { .. }))
        );
    }

    #[test]
    fn empty_floor_makes_no_zones() {
        assert!(compute_auto_zones(&SquareTessellation, &[floor(Vec::new())]).is_empty());
    }
}
