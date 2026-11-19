//! Zones: named sets of cells with a stable id. See `Specs/zones.md`.

use std::collections::{BTreeSet, HashMap, HashSet};

/// Stable id of a zone within one `ZoneSet`. Minted by the set, never reused, never renumbered
/// when other zones are added or removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ZoneId(u32);

impl ZoneId {
    pub const fn new(raw: u32) -> Self {
        Self(raw)
    }

    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// Where a zone came from: derived by the application (`Auto`) or drawn by the user (`Manual`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ZoneKind {
    Auto,
    Manual,
}

/// A cell of a zone: the floor (its position in `MultiLevelField::levels_ordered`, the web client's
/// `floors` index) and the tessellation cell on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ZoneCell<C> {
    pub floor: usize,
    pub cell: C,
}

impl<C> ZoneCell<C> {
    pub const fn new(floor: usize, cell: C) -> Self {
        Self { floor, cell }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Zone<C: Ord> {
    id: ZoneId,
    pub name: String,
    pub kind: ZoneKind,
    cells: BTreeSet<ZoneCell<C>>,
}

impl<C: Ord + Copy> Zone<C> {
    pub fn id(&self) -> ZoneId {
        self.id
    }

    /// The zone's cells in `(floor, cell)` order.
    pub fn cells(&self) -> impl Iterator<Item = ZoneCell<C>> + '_ {
        self.cells.iter().copied()
    }

    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    pub fn contains(&self, floor: usize, cell: C) -> bool {
        self.cells.contains(&ZoneCell::new(floor, cell))
    }
}

/// An ordered collection of zones with stable ids. Zones may overlap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZoneSet<C: Ord> {
    zones: Vec<Zone<C>>,
    next_id: u32,
}

impl<C: Ord> Default for ZoneSet<C> {
    fn default() -> Self {
        Self {
            zones: Vec::new(),
            next_id: 0,
        }
    }
}

impl<C: Ord + Copy> ZoneSet<C> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuilds a set from zones that already carry ids (a client snapshot). Fails on a duplicate
    /// id; later `add` calls mint ids above every given one.
    pub fn from_zones(
        entries: impl IntoIterator<Item = (ZoneId, String, ZoneKind, Vec<ZoneCell<C>>)>,
    ) -> Result<Self, String> {
        let mut set = Self::new();
        let mut seen = HashSet::new();
        for (id, name, kind, cells) in entries {
            if !seen.insert(id) {
                return Err(format!("duplicate zone id {}", id.raw()));
            }
            set.next_id = set.next_id.max(id.raw().saturating_add(1));
            set.zones.push(Zone {
                id,
                name,
                kind,
                cells: cells.into_iter().collect(),
            });
        }
        Ok(set)
    }

    /// Appends a zone and returns its freshly minted id.
    pub fn add(
        &mut self,
        name: impl Into<String>,
        kind: ZoneKind,
        cells: impl IntoIterator<Item = ZoneCell<C>>,
    ) -> ZoneId {
        let id = ZoneId(self.next_id);
        self.next_id += 1;
        self.zones.push(Zone {
            id,
            name: name.into(),
            kind,
            cells: cells.into_iter().collect(),
        });
        id
    }

    pub fn remove(&mut self, id: ZoneId) -> Option<Zone<C>> {
        let index = self.zones.iter().position(|z| z.id == id)?;
        Some(self.zones.remove(index))
    }

    pub fn get(&self, id: ZoneId) -> Option<&Zone<C>> {
        self.zones.iter().find(|z| z.id == id)
    }

    /// Zones in insertion order.
    pub fn zones(&self) -> &[Zone<C>] {
        &self.zones
    }

    pub fn len(&self) -> usize {
        self.zones.len()
    }

    pub fn is_empty(&self) -> bool {
        self.zones.is_empty()
    }

    /// Ids of the zones containing the cell, in zone order. Scans every zone: build a
    /// `ZoneIndex` for repeated queries.
    pub fn zones_of(&self, floor: usize, cell: C) -> Vec<ZoneId> {
        self.zones
            .iter()
            .filter(|z| z.contains(floor, cell))
            .map(|z| z.id)
            .collect()
    }
}

/// Cell-to-zones lookup over a snapshot of a `ZoneSet`, for hover tooltips and per-cell
/// consumers (QC rules, export).
#[derive(Debug, Clone)]
pub struct ZoneIndex<C: Ord + std::hash::Hash> {
    by_cell: HashMap<ZoneCell<C>, Vec<ZoneId>>,
}

impl<C: Ord + Copy + std::hash::Hash> ZoneIndex<C> {
    pub fn build(set: &ZoneSet<C>) -> Self {
        let mut by_cell: HashMap<ZoneCell<C>, Vec<ZoneId>> = HashMap::new();
        for zone in set.zones() {
            for cell in zone.cells() {
                by_cell.entry(cell).or_default().push(zone.id());
            }
        }
        Self { by_cell }
    }

    /// Ids of the zones containing the cell, in zone order; empty for a cell in no zone.
    pub fn zones_of(&self, floor: usize, cell: C) -> &[ZoneId] {
        self.by_cell
            .get(&ZoneCell::new(floor, cell))
            .map_or(&[], Vec::as_slice)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(items: &[(usize, i32)]) -> Vec<ZoneCell<i32>> {
        items.iter().map(|&(f, c)| ZoneCell::new(f, c)).collect()
    }

    #[test]
    fn ids_are_minted_and_never_reused() {
        let mut set = ZoneSet::new();
        let a = set.add("a", ZoneKind::Manual, cells(&[(0, 1)]));
        let b = set.add("b", ZoneKind::Auto, cells(&[(0, 2)]));
        assert_ne!(a, b);
        set.remove(b);
        let c = set.add("c", ZoneKind::Manual, cells(&[]));
        assert_ne!(c, a);
        assert_ne!(c, b);
        assert_eq!(set.get(a).unwrap().name, "a");
        assert!(set.get(b).is_none());
    }

    #[test]
    fn from_zones_keeps_ids_and_mints_above_them() {
        let mut set = ZoneSet::from_zones([
            (ZoneId::new(7), "x".to_string(), ZoneKind::Auto, cells(&[(0, 1)])),
            (ZoneId::new(2), "y".to_string(), ZoneKind::Manual, cells(&[(1, 1)])),
        ])
        .unwrap();
        assert_eq!(set.get(ZoneId::new(2)).unwrap().name, "y");
        assert_eq!(set.add("z", ZoneKind::Manual, cells(&[])), ZoneId::new(8));
    }

    #[test]
    fn from_zones_rejects_duplicate_ids() {
        let result = ZoneSet::from_zones([
            (ZoneId::new(1), "x".to_string(), ZoneKind::Auto, cells(&[])),
            (ZoneId::new(1), "y".to_string(), ZoneKind::Auto, cells(&[])),
        ]);
        assert_eq!(result, Err("duplicate zone id 1".to_string()));
    }

    #[test]
    fn duplicate_cells_collapse_and_cells_are_sorted() {
        let mut set = ZoneSet::new();
        let id = set.add("a", ZoneKind::Manual, cells(&[(1, 5), (0, 9), (1, 5), (0, 3)]));
        let got: Vec<_> = set.get(id).unwrap().cells().collect();
        assert_eq!(got, cells(&[(0, 3), (0, 9), (1, 5)]));
    }

    #[test]
    fn cell_lookup_lists_overlapping_zones_in_zone_order_per_floor() {
        let mut set = ZoneSet::new();
        let a = set.add("a", ZoneKind::Manual, cells(&[(0, 1), (0, 2)]));
        let b = set.add("b", ZoneKind::Auto, cells(&[(0, 2), (1, 2)]));
        let index = ZoneIndex::build(&set);
        assert_eq!(index.zones_of(0, 1), &[a]);
        assert_eq!(index.zones_of(0, 2), &[a, b]);
        assert_eq!(index.zones_of(1, 2), &[b]);
        assert!(index.zones_of(1, 1).is_empty());
        assert_eq!(set.zones_of(0, 2), vec![a, b]);
    }
}
