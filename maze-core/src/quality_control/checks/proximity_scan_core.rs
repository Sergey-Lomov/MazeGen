use crate::graph::distance_map::{DistanceDirection, compute_distance_map_filtered_bounded};
use crate::graph::nav::{NavEdge, NavGraph, NavNodeId};
use crate::ids::NodeId;
use std::collections::HashSet;

/// Shared pairwise proximity scan for topological (nav-graph, own-hop-excluded) QC checks — see
/// GitHub issue #413. Mirrors `ElevatorStopGroupGraphProximityCheck`'s and
/// `VerticalPassageGroupGraphProximityCheck`'s identical shape: for each `own` candidate, compute
/// one bounded forward distance map excluding hops through `own_hop_pairs` (or any other pair in
/// the same exclusion set — the set isn't scoped per-candidate), then scan every `other`
/// candidate for the first one within `distance`, same "stop at first close, break" shape
/// `pairwise_geometric_scan` uses. `distance` is a raw tile-hop count (`u32`), not `f64` — every
/// current caller's own threshold is `u32` (no fractional-offset variant like
/// `OneWayGroupGraphProximityCheck`'s `+1`, which stays a bespoke check rather than joining this
/// helper).
pub fn pairwise_graph_proximity_scan<C, K>(
    nav: &NavGraph,
    candidates: &[C],
    distance: u32,
    hop_pairs: &HashSet<(NodeId, NodeId)>,
    own_nav_node: impl Fn(&C) -> NavNodeId,
    mut pair_excluded: impl FnMut(&C, &C) -> bool,
    mut on_close: impl FnMut(&C, &C) -> (Vec<K>, u32),
) -> Vec<(Vec<K>, u32)> {
    let is_not_a_hop = |edge: &NavEdge| {
        !(edge.path.len() == 2 && hop_pairs.contains(&(edge.path[0], edge.path[1])))
    };
    let max_dist = distance as usize;
    let mut groups = Vec::new();

    for own in candidates {
        let dist_map = compute_distance_map_filtered_bounded(
            nav,
            own_nav_node(own),
            DistanceDirection::Forward,
            is_not_a_hop,
            max_dist,
        );
        for other in candidates {
            if pair_excluded(own, other) {
                continue;
            }
            if dist_map
                .get(&own_nav_node(other))
                .is_some_and(|&d| (d as u32) < distance)
            {
                groups.push(on_close(own, other));
                break;
            }
        }
    }
    groups
}

/// Shared pairwise proximity scan for geometric-distance QC checks — see GitHub issue #413.
///
/// `candidates` is scanned as an own/other double loop: for each `own` candidate, every `other`
/// candidate is tried in order until `pair_excluded` skips it or `distance` reports it closer
/// than `threshold`, at which point `own`'s scan stops (mirrors every geometric proximity check's
/// own "first close pair wins, no need to enumerate every pair for the same candidate" shape).
/// `on_close` builds the group entry (a two-element `Vec<K>` plus `to_remove`, though the closure
/// decides both) recorded for that pair.
///
/// `pair_excluded` covers a check's own extra exclusion rule (same-elevator stops, same tile
/// point, same edge id, `same_type_only`/route protection, ...) on top of the identity check
/// every caller already needs (`own`/`other` being literally the same slot is the caller's
/// responsibility to encode into `pair_excluded` too, since "same slot" differs per candidate
/// shape — an index, an id, ...).
pub fn pairwise_geometric_scan<C, K>(
    candidates: &[C],
    threshold: f64,
    mut pair_excluded: impl FnMut(&C, &C) -> bool,
    mut distance: impl FnMut(&C, &C) -> f64,
    mut on_close: impl FnMut(&C, &C) -> (Vec<K>, u32),
) -> Vec<(Vec<K>, u32)> {
    let mut groups = Vec::new();
    for own in candidates {
        for other in candidates {
            if pair_excluded(own, other) {
                continue;
            }
            if distance(own, other) < threshold {
                groups.push(on_close(own, other));
                break;
            }
        }
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_for_every_pair_closer_than_threshold() {
        let candidates: Vec<f64> = vec![0.0, 1.0, 10.0];
        let groups = pairwise_geometric_scan(
            &candidates,
            5.0,
            |a, b| a == b,
            |a, b| (a - b).abs(),
            |a, b| (vec![*a as i64, *b as i64], 1),
        );
        assert_eq!(
            groups.len(),
            2,
            "0.0 and 1.0 both find each other close (dist 1.0 < 5.0); 10.0 finds nothing"
        );
    }

    #[test]
    fn stops_at_first_close_pair_per_candidate() {
        let candidates: Vec<f64> = vec![0.0, 1.0, 2.0];
        let mut visits = 0;
        let groups = pairwise_geometric_scan(
            &candidates,
            5.0,
            |a, b| a == b,
            |a, b| {
                visits += 1;
                (a - b).abs()
            },
            |a, b| (vec![*a as i64, *b as i64], 1),
        );
        assert_eq!(groups.len(), 3, "every candidate finds a close partner");
        assert_eq!(
            visits,
            1 + 1 + 1,
            "each own candidate stops scanning right after its first close other, never visiting the remaining candidates"
        );
    }

    #[test]
    fn pair_excluded_skips_without_counting_as_a_scan_stop() {
        let candidates: Vec<f64> = vec![0.0, 0.5, 1.0];
        let groups = pairwise_geometric_scan(
            &candidates,
            5.0,
            |a, b| a == b || (*a == 0.0 && *b == 0.5),
            |a, b| (a - b).abs(),
            |a, b| (vec![*a as i64, *b as i64], 1),
        );
        // own=0.0: other=0.5 excluded, other=1.0 close -> records (0.0, 1.0)
        assert!(groups.iter().any(|(g, _)| g == &vec![0i64, 1i64]));
    }

    #[test]
    fn empty_candidates_produce_no_groups() {
        let candidates: Vec<f64> = Vec::new();
        let groups = pairwise_geometric_scan(
            &candidates,
            5.0,
            |_, _| false,
            |a, b| (a - b).abs(),
            |a, b| (vec![*a as i64, *b as i64], 1),
        );
        assert!(groups.is_empty());
    }
}
