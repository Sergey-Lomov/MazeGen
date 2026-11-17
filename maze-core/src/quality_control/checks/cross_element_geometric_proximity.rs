use super::elevator_core::elevator_groups;
use super::proximity_scan_core::pairwise_surface_scan;
use crate::Maze;
use crate::ids::NodeId;
use crate::quality_control::check::Check;
use crate::quality_control::cross_element::{
    CrossElement, CrossElementSet, cross_element_occurrences, cross_element_route_protected,
};
use crate::quality_control::issue_kinds::CrossElementCloseNodes;
use crate::quality_control::{GeometricFloorMode, InvalidCrossElementGroupIssue};
use crate::space::{DistancePolicy, FloorMetrics, Tessellation};
use rand::RngCore;
use std::collections::{HashMap, HashSet};

pub const CROSS_ELEMENT_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT: f64 = 1.0;
pub const CROSS_ELEMENT_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE: GeometricFloorMode =
    GeometricFloorMode::SameFloorOnly;

// Defaults: every relocatable element type on, start and finish off (see GitHub issue #376's D7)
// -- repair can never remove start/finish, so a pair drawn from them is dead weight by default.
// One enabled type is a valid same-type scan; zero types is the only silent no-op.
pub const CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_TELEPORT: bool = true;
pub const CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_ONE_WAY: bool = true;
pub const CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_VERTICAL_PASSAGE: bool = true;
pub const CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_ELEVATOR_STOP: bool = true;
pub const CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_SPLIT: bool = true;
pub const CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_START: bool = false;
pub const CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_FINISH: bool = false;

/// Canonical unordered key for one logical pair of cross-elements — the two elements sorted, so
/// `(a, b)` and `(b, a)` from opposite scan directions collapse to a single group. Mirrors
/// `InvalidGroupIssue`'s own `canonical_group_key`.
pub(super) fn pair_key(a: &CrossElement, b: &CrossElement) -> (CrossElement, CrossElement) {
    if a <= b {
        (a.clone(), b.clone())
    } else {
        (b.clone(), a.clone())
    }
}

/// The distinct elements among `occurrences` that are protected by the current start->finish
/// route (`cross_element_route_protected`). Empty when `protect_route` is off. Precomputed once so
/// the scan's `pair_excluded` closure is a pair of `HashSet` lookups rather than re-running the
/// route test (which, for an elevator, re-derives the elevator groups) on every pair.
pub(super) fn route_protected_elements<T: Tessellation>(
    maze: &Maze<T>,
    occurrences: &[crate::quality_control::cross_element::CrossElementOccurrence<T>],
    protect_route: bool,
) -> HashSet<CrossElement> {
    if !protect_route {
        return HashSet::new();
    }
    let mut seen: HashSet<CrossElement> = HashSet::new();
    let mut protected: HashSet<CrossElement> = HashSet::new();
    for occ in occurrences {
        if !seen.insert(occ.element.clone()) {
            continue;
        }
        if cross_element_route_protected(maze, &occ.element) {
            protected.insert(occ.element.clone());
        }
    }
    protected
}

/// Maps each elevator stop node to an opaque per-elevator id, so the scan can exclude a pair of
/// stops belonging to the *same* elevator (connected by design, never a proximity pair — mirrors
/// `ElevatorStopGroupGeometricProximityCheck`'s own same-elevator exclusion) with a `HashMap`
/// lookup instead of re-deriving the elevator groups per pair. Empty when no `ElevatorStop` is in
/// the scan.
pub(super) fn elevator_of_stop<T: Tessellation>(
    maze: &Maze<T>,
    occurrences: &[crate::quality_control::cross_element::CrossElementOccurrence<T>],
) -> HashMap<NodeId, usize> {
    if !occurrences
        .iter()
        .any(|o| matches!(o.element, CrossElement::ElevatorStop(_)))
    {
        return HashMap::new();
    }
    let mut map = HashMap::new();
    for (idx, elevator) in elevator_groups(maze).into_iter().enumerate() {
        for stop in elevator.stops {
            map.insert(stop, idx);
        }
    }
    map
}

/// Whether `a` and `b` are two `ElevatorStop`s of the same elevator, per the `elevator_of_stop`
/// map — the pair-exclusion predicate shared by both cross-element proximity checks.
pub(super) fn same_elevator_pair(
    elevator_of_stop: &HashMap<NodeId, usize>,
    a: &CrossElement,
    b: &CrossElement,
) -> bool {
    match (a, b) {
        (CrossElement::ElevatorStop(sa), CrossElement::ElevatorStop(sb)) => {
            matches!(
                (elevator_of_stop.get(sa), elevator_of_stop.get(sb)),
                (Some(ia), Some(ib)) if ia == ib
            )
        }
        _ => false,
    }
}

/// One raw close pair from an occurrence-level scan — the two elements plus the specific
/// occurrence node of each that was within the threshold (GitHub issue #376's follow-up: highlight
/// only the problematic markers). `aggregate_pairs` folds these into one group per logical pair,
/// accumulating every close occurrence node per element.
pub(super) struct RawClosePair {
    pub own_element: CrossElement,
    pub own_node: NodeId,
    pub other_element: CrossElement,
    pub other_node: NodeId,
}

/// Aggregates the raw per-occurrence-pair scan output into one group per logical
/// `(CrossElement, CrossElement)` pair — a teleport with two ends near a split tile would
/// otherwise be flagged once per end. `to_remove` is always 1 (removing either element of the
/// pair clears the proximity). Alongside the groups it returns, per canonical group key, the set
/// of occurrence nodes of each element that were actually within range — the payload resolver
/// narrows each element's highlight to just those.
pub(super) fn aggregate_pairs(
    raw: Vec<RawClosePair>,
) -> (Vec<(Vec<CrossElement>, u32)>, CrossElementCloseNodes) {
    let mut seen: HashSet<(CrossElement, CrossElement)> = HashSet::new();
    let mut out = Vec::new();
    let mut close_nodes: CrossElementCloseNodes = HashMap::new();

    let mut record = |element: &CrossElement, node: NodeId, key: &[CrossElement]| {
        let slot = close_nodes
            .entry(key.to_vec())
            .or_default()
            .entry(element.clone())
            .or_default();
        if !slot.contains(&node) {
            slot.push(node);
        }
    };

    for pair in raw {
        let key_tuple = pair_key(&pair.own_element, &pair.other_element);
        let canonical = vec![key_tuple.0.clone(), key_tuple.1.clone()];
        record(&pair.own_element, pair.own_node, &canonical);
        record(&pair.other_element, pair.other_node, &canonical);
        if seen.insert(key_tuple.clone()) {
            out.push((vec![key_tuple.0, key_tuple.1], 1));
        }
    }
    (out, close_nodes)
}

/// Flags two special maze elements of a user-selected type set placed closer than a configured
/// minimum distance in geometric (Euclidean) space — see GitHub issue #376. The set is a
/// complete graph over the enabled types: same-type pairs (two teleports, when `include_teleport`
/// is on) are flagged too, not only strictly cross-type ones.
///
/// Distance is measured occurrence-to-occurrence via each occurrence's `xy` (its
/// `CrossElementOccurrence::xy`, not the raw tile `point`) — a multi-location element (teleport,
/// vertical passage, elevator) contributes one occurrence per physical endpoint / floor-stop, and
/// a pair is flagged if any two of their occurrences are closer than the threshold. A one-way's
/// two occurrences both carry its edge's own `T::edge_position` as `xy` rather than either
/// endpoint's own position, matching `OneWayGroupGeometricProximityCheck`'s own metric (a one-way
/// renders on the tile border it crosses, not at either endpoint node) — see GitHub issue #376's
/// follow-up. Every other element type's `xy` is `Tessellation::cartesian(point)`, its endpoint node's own
/// position.
///
/// Zero enabled types is a silent no-op (D7): the check stays a valid instance in the UI, it
/// simply produces nothing. A single enabled type is a valid same-type scan — two distinct
/// elements of that one type close to each other — which subsumes the per-type
/// `*_group_geometric_proximity` checks. Start and Finish are ordinary element types here; a
/// `[Start, Finish]` pair is flagged normally, and the repair strategy then reports `Failed` for
/// it since neither endpoint is removable.
///
/// `protect_route` (rule-level, GitHub issue #376 follow-up): when set, a pair whose *both*
/// elements are on the current start->finish route (`cross_element_route_protected` — an
/// edge-owning element with an underlying route edge, or `Start` / `Finish` themselves) is not
/// flagged, mirroring `OneWayGroupGeometricProximityCheck`'s own "exclude only when both sides
/// are route-protected" rule. A pair with one protected and one free element is still flagged.
pub struct CrossElementGeometricProximityCheck {
    pub instance_id: String,
    pub distance: f64,
    pub set: CrossElementSet,
    pub floor_mode: GeometricFloorMode,
    /// Measure pairs on a topological-only fold by the planar distance instead of leaving them
    /// indeterminate (`DistancePolicy::Approximate`, GitHub issue #838).
    pub approximate_topology: bool,
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, InvalidCrossElementGroupIssue>
    for CrossElementGeometricProximityCheck
{
    fn check_type_id(&self) -> &'static str {
        "cross_element_geometric_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidCrossElementGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        if self.set.enabled_count() < 1 {
            return;
        }
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let occurrences = cross_element_occurrences(maze, &self.set, &nav);
        if occurrences.len() < 2 {
            return;
        }

        let route_protected = route_protected_elements(maze, &occurrences, self.protect_route);
        let elevator_of_stop = elevator_of_stop(maze, &occurrences);

        let metrics = FloorMetrics::new(
            &maze.field,
            DistancePolicy::from_approximate(self.approximate_topology),
        );
        // Undecidable pairs (`scan.indeterminate`) are neither flagged nor cleared.
        let raw = pairwise_surface_scan(
            &occurrences,
            self.distance,
            |own, other| {
                own.element == other.element
                    || (self.floor_mode == GeometricFloorMode::SameFloorOnly
                        && own.level_index != other.level_index)
                    || (route_protected.contains(&own.element)
                        && route_protected.contains(&other.element))
                    || same_elevator_pair(&elevator_of_stop, &own.element, &other.element)
            },
            |own, other| {
                metrics.distance(
                    own.level_index,
                    own.xy,
                    other.level_index,
                    other.xy,
                    self.floor_mode.include_height(),
                )
            },
            |own, other| {
                (
                    vec![RawClosePair {
                        own_element: own.element.clone(),
                        own_node: own.node,
                        other_element: other.element.clone(),
                        other_node: other.node,
                    }],
                    1,
                )
            },
            |own, other| Some((own.node, other.node)),
        )
        .into_groups(&maze.distance_diagnostics);

        let (groups, close_nodes) = aggregate_pairs(raw.into_iter().flat_map(|(v, _)| v).collect());
        if groups.is_empty() {
            return;
        }
        let issue =
            InvalidCrossElementGroupIssue::new_from_check(&self.instance_id, groups, close_nodes)
                .with_detail(&self.instance_id, "distance", self.distance.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "cross_element_geometric_proximity_tests.rs"]
mod tests;
