use super::{ElementsConfig, GenerationParams};
use crate::ids::NodeId;
use std::collections::HashMap;

/// Generation parameters a zone may override (GitHub issue #1038). `None` keeps the maze-wide
/// value. `depth_first` is deliberately absent: it picks the next cell to process, so it has no
/// meaning for the work done on one cell. The cell-type placement matrix and the split settings
/// stay maze-wide as well.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ParamOverrides {
    pub corridor_chance: Option<f64>,
    pub branching: Option<f64>,
    pub directionality: Option<f64>,
    pub cyclicity: Option<f64>,
    pub one_way_chance: Option<f64>,
    pub teleport_chance: Option<f64>,
    pub teleport_one_way_chance: Option<f64>,
    pub split_chance: Option<f64>,
    pub cross_floor_teleport_balance: Option<f64>,
    pub vertical_chance: Option<f64>,
    pub vertical_passage_elevator_balance: Option<f64>,
    pub one_way_vertical_passage_chance: Option<f64>,
    pub vertical_up_down_balance: Option<f64>,
    pub elevator_span_min: Option<usize>,
    pub elevator_span_max: Option<usize>,
    pub elevator_branching: Option<f64>,
    pub allow_non_consecutive_elevator_floors: Option<bool>,
}

impl ParamOverrides {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// Fills every parameter this set leaves unset from `lower`, so the result holds the value of
    /// `self` where it has one and of `lower` otherwise.
    fn or(self, lower: Self) -> Self {
        Self {
            corridor_chance: self.corridor_chance.or(lower.corridor_chance),
            branching: self.branching.or(lower.branching),
            directionality: self.directionality.or(lower.directionality),
            cyclicity: self.cyclicity.or(lower.cyclicity),
            one_way_chance: self.one_way_chance.or(lower.one_way_chance),
            teleport_chance: self.teleport_chance.or(lower.teleport_chance),
            teleport_one_way_chance: self
                .teleport_one_way_chance
                .or(lower.teleport_one_way_chance),
            split_chance: self.split_chance.or(lower.split_chance),
            cross_floor_teleport_balance: self
                .cross_floor_teleport_balance
                .or(lower.cross_floor_teleport_balance),
            vertical_chance: self.vertical_chance.or(lower.vertical_chance),
            vertical_passage_elevator_balance: self
                .vertical_passage_elevator_balance
                .or(lower.vertical_passage_elevator_balance),
            one_way_vertical_passage_chance: self
                .one_way_vertical_passage_chance
                .or(lower.one_way_vertical_passage_chance),
            vertical_up_down_balance: self
                .vertical_up_down_balance
                .or(lower.vertical_up_down_balance),
            elevator_span_min: self.elevator_span_min.or(lower.elevator_span_min),
            elevator_span_max: self.elevator_span_max.or(lower.elevator_span_max),
            elevator_branching: self.elevator_branching.or(lower.elevator_branching),
            allow_non_consecutive_elevator_floors: self
                .allow_non_consecutive_elevator_floors
                .or(lower.allow_non_consecutive_elevator_floors),
        }
    }

    /// The maze-wide `params` / `elements` with this set's values written over them.
    pub fn apply(&self, params: &GenerationParams, elements: &ElementsConfig) -> (GenerationParams, ElementsConfig) {
        let mut p = params.clone();
        let mut e = elements.clone();
        macro_rules! set {
            ($target:expr, $field:ident) => {
                if let Some(v) = self.$field {
                    $target.$field = v;
                }
            };
        }
        set!(p, corridor_chance);
        set!(p, branching);
        set!(p, directionality);
        set!(p, cyclicity);
        set!(e, one_way_chance);
        set!(e, teleport_chance);
        set!(e, teleport_one_way_chance);
        set!(e, split_chance);
        set!(e, cross_floor_teleport_balance);
        set!(e, vertical_chance);
        set!(e, vertical_passage_elevator_balance);
        set!(e, one_way_vertical_passage_chance);
        set!(e, vertical_up_down_balance);
        set!(e, elevator_span_min);
        set!(e, elevator_span_max);
        set!(e, elevator_branching);
        set!(e, allow_non_consecutive_elevator_floors);
        if e.elevator_span_max < e.elevator_span_min {
            e.elevator_span_max = e.elevator_span_min;
        }
        (p, e)
    }
}

/// One override of one zone: the parameters it sets and the nodes of the zone's cells.
#[derive(Debug, Clone)]
pub struct ZoneOverrideEntry {
    /// Id of the zone. Where several zones set the same parameter on one cell, the smallest id wins.
    pub zone_id: u32,
    pub overrides: ParamOverrides,
    pub nodes: Vec<NodeId>,
}

/// Per-node effective overrides, resolved once before generation. A node outside every zone, or
/// inside zones that set nothing, has no entry and generates with the maze-wide values.
#[derive(Debug, Clone, Default)]
pub struct ZoneOverrideTable {
    by_node: HashMap<NodeId, ParamOverrides>,
}

impl ZoneOverrideTable {
    /// Merges the entries per node, parameter by parameter: the smallest zone id wins, and between
    /// entries of one zone the earlier one does (the sort is stable).
    pub fn from_entries(mut entries: Vec<ZoneOverrideEntry>) -> Self {
        entries.sort_by_key(|e| e.zone_id);
        let mut by_node: HashMap<NodeId, ParamOverrides> = HashMap::new();
        for entry in entries {
            if entry.overrides.is_empty() {
                continue;
            }
            for node in entry.nodes {
                let slot = by_node.entry(node).or_default();
                *slot = slot.or(entry.overrides);
            }
        }
        Self { by_node }
    }

    pub fn is_empty(&self) -> bool {
        self.by_node.is_empty()
    }

    pub fn get(&self, node: NodeId) -> Option<&ParamOverrides> {
        self.by_node.get(&node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(i: u64) -> NodeId {
        i
    }

    fn corridor(v: f64) -> ParamOverrides {
        ParamOverrides {
            corridor_chance: Some(v),
            ..Default::default()
        }
    }

    #[test]
    fn smaller_zone_id_wins_on_the_same_parameter() {
        let table = ZoneOverrideTable::from_entries(vec![
            ZoneOverrideEntry {
                zone_id: 5,
                overrides: corridor(0.2),
                nodes: vec![n(1), n(2)],
            },
            ZoneOverrideEntry {
                zone_id: 3,
                overrides: corridor(0.9),
                nodes: vec![n(2)],
            },
        ]);
        assert_eq!(table.get(n(1)).unwrap().corridor_chance, Some(0.2));
        assert_eq!(table.get(n(2)).unwrap().corridor_chance, Some(0.9));
        assert!(table.get(n(3)).is_none());
    }

    #[test]
    fn different_parameters_of_overlapping_zones_combine() {
        let table = ZoneOverrideTable::from_entries(vec![
            ZoneOverrideEntry {
                zone_id: 1,
                overrides: corridor(0.1),
                nodes: vec![n(1)],
            },
            ZoneOverrideEntry {
                zone_id: 2,
                overrides: ParamOverrides {
                    cyclicity: Some(0.4),
                    ..Default::default()
                },
                nodes: vec![n(1)],
            },
        ]);
        let merged = table.get(n(1)).unwrap();
        assert_eq!(merged.corridor_chance, Some(0.1));
        assert_eq!(merged.cyclicity, Some(0.4));
    }

    #[test]
    fn apply_overwrites_only_set_values_and_keeps_span_ordered() {
        let o = ParamOverrides {
            teleport_chance: Some(0.5),
            elevator_span_min: Some(4),
            ..Default::default()
        };
        let (p, e) = o.apply(&GenerationParams::default(), &ElementsConfig::default());
        assert_eq!(p.corridor_chance, GenerationParams::default().corridor_chance);
        assert_eq!(e.teleport_chance, 0.5);
        assert_eq!(e.elevator_span_min, 4);
        assert_eq!(e.elevator_span_max, 4);
    }

    #[test]
    fn non_consecutive_floors_override_merges_by_smallest_zone_id_and_applies() {
        let on = ParamOverrides { allow_non_consecutive_elevator_floors: Some(true), ..Default::default() };
        let off = ParamOverrides { allow_non_consecutive_elevator_floors: Some(false), ..Default::default() };
        let table = ZoneOverrideTable::from_entries(vec![
            ZoneOverrideEntry { zone_id: 5, overrides: on, nodes: vec![n(1)] },
            ZoneOverrideEntry { zone_id: 2, overrides: off, nodes: vec![n(1)] },
        ]);
        let merged = *table.get(n(1)).unwrap();
        assert_eq!(merged.allow_non_consecutive_elevator_floors, Some(false));
        let base = ElementsConfig { allow_non_consecutive_elevator_floors: true, ..ElementsConfig::default() };
        let (_, e) = merged.apply(&GenerationParams::default(), &base);
        assert!(!e.allow_non_consecutive_elevator_floors);
        let (_, e) = ParamOverrides::default().apply(&GenerationParams::default(), &base);
        assert!(e.allow_non_consecutive_elevator_floors);
    }
}
