use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::distance_map::{compute_distance_map, DistanceDirection};
use crate::graph::nav::NavNodeId;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, TeleportGroupProximityIssue};

pub const TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;

/// Which end of a teleport edge a `TeleportGroupProximityCheck` instance measures — `own_edge`
/// picks the end of the teleport currently being scanned, `other_edge` picks the end of the
/// candidate teleport it's compared against. `own_edge`/`other_edge` are independently
/// configurable (e.g. "exit of one teleport vs. entry of another"). `EntryOrExit` considers both
/// ends of that side of the pair and takes the closest combination — same "min across every
/// relevant combination" reduction as `TeleportWaypointDistanceCheck`'s own `EntryOrExit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportProximityEdge {
    Entry,
    Exit,
    EntryOrExit,
}

/// Flags a pair of teleport edges placed topologically too close to each other — see GitHub
/// issue #75. Individual teleport checks (issue #74) only ever look at one teleport edge at a
/// time; this check instead catches problems that emerge from *pairs* of teleports being close
/// to each other, which no single-edge check can detect.
///
/// Distance is topological (tile-hops via the shared nav-graph distance map, same mechanism as
/// `TeleportWaypointDistanceCheck`), directed: for a given ordered pair (scanned teleport, other
/// teleport), distance is `min(forward, reverse)` between the scanned teleport's `own_edge`
/// endpoint and the other teleport's `other_edge` endpoint — the graph is directed-only, but a
/// close relationship in either direction is equally a proximity problem, so neither direction is
/// preferred over the other (same "worst-case/either-direction" rationale `LoopDistanceFromStartCheck`
/// and `TeleportWaypointDistanceCheck` use for their own reductions).
///
/// For each teleport edge, scans every other teleport edge for the first one whose relevant
/// endpoint is closer than `distance` — as soon as one problematic pair is found for a teleport,
/// it's recorded and the scan moves to the next teleport (no need to enumerate every pair a
/// teleport participates in). Each direction of a two-way teleport is its own independent element
/// of this scan, same as every other per-teleport check from issue #74.
///
/// Multiple instances may be active at once (`allow_multiple_instances: true`, see the WASM
/// Interface section in `Specs/quality_control.md`) — distinct `own_edge`/`other_edge`/`distance`
/// combinations are a legitimate simultaneous configuration, same rationale as
/// `TeleportWaypointDistanceCheck`.
pub struct TeleportGroupProximityCheck {
    pub instance_id: String,
    /// Tile-hop threshold — `f64` (not `u32`) so a fractional value (e.g. `1.5`) can cleanly
    /// separate an integer tile-hop count (`1` fails, `2` passes) without off-by-one ambiguity.
    pub distance: f64,
    pub own_edge: TeleportProximityEdge,
    pub other_edge: TeleportProximityEdge,
    /// GitHub issue #78, default `true`: a pair is only excluded when *both* teleports are
    /// route-critical (`is_teleport_route_protected`) — if only one side of the pair sits on the
    /// route, the pair is still recorded, since the non-route side remains a legitimate removal
    /// candidate for `TeleportGroupProximityStrategy` to act on.
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, TeleportGroupProximityIssue> for TeleportGroupProximityCheck {
    fn check_type_id(&self) -> &'static str { "teleport_group_proximity" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<TeleportGroupProximityIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let teleports: Vec<_> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .map(|e| (e.id, e.from, e.to))
            .collect();
        if teleports.len() < 2 {
            return;
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);

        // Per-teleport-endpoint distance maps are recomputed lazily and cached for the scan's
        // duration (a teleport's own_edge endpoint is queried once per teleport it's scanned
        // against, so without caching the same source would be re-run once per candidate). Cost
        // is O(distinct own endpoints × nav-graph Dijkstra) — linear in teleport count (at most
        // 2 endpoints per teleport with `EntryOrExit`, so bounded by 2 × teleport count), unlike
        // the cycle-enumeration checks (`find_all_simple_cycles`), whose cost can grow
        // exponentially in graph size and therefore need `MAX_SIMPLE_CYCLES`/`TooManyCycles` to
        // cap runaway work. No equivalent cap is needed here since growth stays linear regardless
        // of maze topology.
        let mut forward_cache: HashMap<NavNodeId, HashMap<NavNodeId, usize>> = HashMap::new();
        let mut reverse_cache: HashMap<NavNodeId, HashMap<NavNodeId, usize>> = HashMap::new();

        // Returns the endpoint(s) `edge` selects — one for `Entry`/`Exit`, both for `EntryOrExit`
        // (a smallvec-style inline array avoids allocating a `Vec` per lookup).
        let endpoints_of = |edge: TeleportProximityEdge, from: crate::ids::NodeId, to: crate::ids::NodeId| -> [Option<crate::ids::NodeId>; 2] {
            match edge {
                TeleportProximityEdge::Entry => [Some(from), None],
                TeleportProximityEdge::Exit => [Some(to), None],
                TeleportProximityEdge::EntryOrExit => [Some(from), Some(to)],
            }
        };

        // min(forward, reverse) tile-hop distance between two nav-nodes — the graph stays
        // directed-only throughout (each direction computed via its own Dijkstra pass), but a
        // pair close in *either* direction is equally a proximity problem.
        let mut min_directed_distance = |a: NavNodeId, b: NavNodeId| -> Option<usize> {
            if a == b {
                return Some(0);
            }
            let fwd = forward_cache.entry(a)
                .or_insert_with(|| compute_distance_map(&nav, a, DistanceDirection::Forward))
                .get(&b).copied();
            let rev = reverse_cache.entry(a)
                .or_insert_with(|| compute_distance_map(&nav, a, DistanceDirection::Reverse))
                .get(&b).copied();
            match (fwd, rev) {
                (Some(f), Some(r)) => Some(f.min(r)),
                (Some(f), None) => Some(f),
                (None, Some(r)) => Some(r),
                (None, None) => None,
            }
        };

        let mut pairs: Vec<(EdgeId, EdgeId)> = Vec::new();

        for &(own_id, own_from, own_to) in &teleports {
            let own_navs: Vec<NavNodeId> = endpoints_of(self.own_edge, own_from, own_to).into_iter()
                .flatten()
                .filter_map(|n| nav.nav_node_for(n))
                .collect();
            if own_navs.is_empty() {
                continue;
            }

            for &(other_id, other_from, other_to) in &teleports {
                if other_id == own_id {
                    continue;
                }
                let other_navs: Vec<NavNodeId> = endpoints_of(self.other_edge, other_from, other_to).into_iter()
                    .flatten()
                    .filter_map(|n| nav.nav_node_for(n))
                    .collect();
                if other_navs.is_empty() {
                    continue;
                }

                // Closest combination across every (own endpoint, other endpoint) pair this
                // instance's selectors expand to — same "min across every relevant combination"
                // reduction TeleportWaypointDistanceCheck's own EntryOrExit uses.
                let closest = own_navs.iter()
                    .flat_map(|&a| other_navs.iter().map(move |&b| (a, b)))
                    .filter_map(|(a, b)| min_directed_distance(a, b))
                    .min();

                if let Some(dist) = closest {
                    if (dist as f64) < self.distance {
                        let both_route_protected = self.protect_route
                            && is_teleport_route_protected(maze, own_id)
                            && is_teleport_route_protected(maze, other_id);
                        // A pair excluded because both sides are route-critical doesn't stop the
                        // scan for `own_id` — a farther, non-protected candidate may still exist
                        // and would otherwise never be recorded.
                        if !both_route_protected {
                            pairs.push((own_id, other_id));
                            break;
                        }
                    }
                }
            }
        }

        if pairs.is_empty() {
            return;
        }
        let issue = TeleportGroupProximityIssue::new_from_check(&self.instance_id, pairs)
            .with_detail(&self.instance_id, "distance", self.distance.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "teleport_group_proximity";

    fn check(distance: f64, own_edge: TeleportProximityEdge, other_edge: TeleportProximityEdge) -> TeleportGroupProximityCheck {
        TeleportGroupProximityCheck { instance_id: TEST_ID.to_string(), distance, own_edge, other_edge, protect_route: true }
    }

    #[test]
    fn silent_with_fewer_than_two_teleports() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(1000.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    /// Two teleports whose entries sit `entry_gap` nav-hops apart on a shared corridor:
    /// entry_a(0) -- ... -- entry_b(entry_gap), each teleporting off to its own far node.
    fn maze_with_two_teleport_entries_at_gap(entry_gap: usize) -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
        let mut ids = IdGenerator::new();
        let width = entry_gap + 3;
        let field: Field<SquareTessellation> = Field::new(square_rect(width, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        for x in 0..entry_gap as i32 {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        let far_a = p(width as i32 - 2);
        let far_b = p(width as i32 - 1);
        let entry_a = p(0);
        let entry_b = p(entry_gap as i32);
        let id_a = g.add_edge(entry_a, far_a, EdgeKind::Teleport);
        let id_b = g.add_edge(entry_b, far_b, EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        (maze, id_a, id_b)
    }

    #[test]
    fn fires_when_entries_closer_than_threshold() {
        let (maze, id_a, id_b) = maze_with_two_teleport_entries_at_gap(2);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = &issues[0].pairs;
        assert_eq!(pairs.len(), 2, "both directions of the scan (a->b and b->a) each record their own pair entry");
        for &(x, y) in pairs {
            assert!((x == id_a && y == id_b) || (x == id_b && y == id_a));
        }
    }

    #[test]
    fn silent_when_entries_farther_than_threshold() {
        let (maze, _, _) = maze_with_two_teleport_entries_at_gap(10);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_threshold_is_zero() {
        let (maze, _, _) = maze_with_two_teleport_entries_at_gap(0);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(0.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "a threshold of 0 should never flag any pair");
    }

    #[test]
    fn fractional_distance_cleanly_separates_integer_tile_hop_counts() {
        // distance=1.5 must fire for a gap of exactly 1 tile-hop (1 < 1.5) but stay silent for a
        // gap of exactly 2 (2 is not < 1.5) -- exercises that a fractional threshold isn't
        // silently truncated to an integer (the bug this test guards against: `distance=1.1`
        // must behave like 1.1, not fall back to 0 or truncate to 1).
        let (maze_close, _, _) = maze_with_two_teleport_entries_at_gap(1);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(1.5, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze_close, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "gap of 1 tile-hop must fire against threshold 1.5");

        let (maze_far, _, _) = maze_with_two_teleport_entries_at_gap(2);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(1.5, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze_far, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "gap of 2 tile-hops must stay silent against threshold 1.5");
    }

    #[test]
    fn records_a_fractional_distance_as_a_detail_without_truncation() {
        let (maze, _, _) = maze_with_two_teleport_entries_at_gap(1);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(1.5, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].details().get(TEST_ID).and_then(|kv| kv.get("distance")), Some(&"1.5".to_string()));
    }

    #[test]
    fn respects_directed_edges_reverse_still_counts_via_min() {
        // A one-way corridor a->b: forward distance a->b is 2, reverse (b->a) is unreachable.
        // min(forward, reverse) must still catch it via the forward side.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic); // one-way only
        g.add_edge(p(1), p(2), EdgeKind::Basic); // one-way only
        let id_a = g.add_edge(p(0), p(3), EdgeKind::Teleport);
        let id_b = g.add_edge(p(2), p(4), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = &issues[0].pairs;
        assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b), "forward a->b (distance 2) must be caught even though b->a is unreachable");
    }

    /// Two teleports whose four endpoints (entry_a, exit_a, entry_b, exit_b) sit on four
    /// mutually-disconnected corridors, each corridor far longer than the test's threshold —
    /// `entry_a`/`exit_a`/`entry_b`/`exit_b` are never connected to each other by anything except
    /// the two teleport edges themselves, and neither teleport is used as a shortcut between the
    /// two corridors under test (each corridor only touches one of the four endpoints). This
    /// isolates exactly one endpoint-to-endpoint distance per combination — `close_pair` picks
    /// which two corridors sit `close_gap` apart (the pair under test), every other combination's
    /// corridors sit far apart, so leaking through a route via either teleport itself does not
    /// create a false-positive shortcut for the *other* three combinations.
    #[derive(Clone, Copy)]
    enum ClosePair { EntryEntry, EntryExit, ExitEntry, ExitExit }

    fn maze_with_one_close_endpoint_pair(close: ClosePair) -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
        let mut ids = IdGenerator::new();
        // Four far-apart corridors (20 tiles each) plus a short bridge for the close pair,
        // arranged as four disjoint blocks: entry_a=[0..20], exit_a=[20..40], entry_b=[40..60],
        // exit_b=[60..80]. Every block is a straight bidirectional corridor with no cross-links,
        // so the only routes between blocks are the two teleport edges themselves.
        let width = 80;
        let field: Field<SquareTessellation> = Field::new(square_rect(width, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        for block_start in [0, 20, 40, 60] {
            for x in block_start..block_start + 19 {
                g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
            }
        }
        let entry_a = p(0);
        let exit_a = p(20);
        let entry_b = p(40);
        let exit_b = p(60);
        // The close pair gets a direct 1-tile bridge straight from the relevant endpoint itself
        // (not from the far end of its 19-tile corridor) -- everything else stays disconnected,
        // so only the endpoint pair under test is ever within the test's threshold (3).
        let _ = match close {
            ClosePair::EntryEntry => g.add_bidirectional_edge(entry_a, entry_b, EdgeKind::Basic),
            ClosePair::EntryExit => g.add_bidirectional_edge(entry_a, exit_b, EdgeKind::Basic),
            ClosePair::ExitEntry => g.add_bidirectional_edge(exit_a, entry_b, EdgeKind::Basic),
            ClosePair::ExitExit => g.add_bidirectional_edge(exit_a, exit_b, EdgeKind::Basic),
        };
        let id_a = g.add_edge(entry_a, exit_a, EdgeKind::Teleport);
        let id_b = g.add_edge(entry_b, exit_b, EdgeKind::Teleport);
        (Maze::new(field, g), id_a, id_b)
    }

    #[test]
    fn entry_vs_entry_selector_fires_only_on_the_close_pair() {
        let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::EntryEntry);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(3.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = &issues[0].pairs;
        assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
    }

    #[test]
    fn entry_vs_exit_selector_fires_only_on_the_close_pair() {
        let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::EntryExit);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(3.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Exit).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = &issues[0].pairs;
        assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
    }

    #[test]
    fn exit_vs_entry_selector_fires_only_on_the_close_pair() {
        let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::ExitEntry);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(3.0, TeleportProximityEdge::Exit, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = &issues[0].pairs;
        assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
    }

    #[test]
    fn exit_vs_exit_selector_fires_only_on_the_close_pair() {
        let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::ExitExit);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(3.0, TeleportProximityEdge::Exit, TeleportProximityEdge::Exit).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = &issues[0].pairs;
        assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
    }

    #[test]
    fn own_entry_or_exit_fires_regardless_of_which_own_end_is_close() {
        // own=EntryOrExit must catch the close pair whether the bridge lands on a's entry or
        // a's exit -- exercise all four ClosePair placements with own_edge fixed to EntryOrExit
        // and other_edge fixed to Entry (the close pair always has entry(b) on the other side).
        for close in [ClosePair::EntryEntry, ClosePair::ExitEntry] {
            let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(close);
            let mut issues = Vec::new();
            let mut rng = crate::random::MazeRng::seed_from_u64(0);
            check(3.0, TeleportProximityEdge::EntryOrExit, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
            assert_eq!(issues.len(), 1, "own=EntryOrExit must fire regardless of which own end is close");
            let pairs = &issues[0].pairs;
            assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
        }
    }

    #[test]
    fn other_entry_or_exit_fires_regardless_of_which_other_end_is_close() {
        // other=EntryOrExit must catch the close pair whether the bridge lands on b's entry or
        // b's exit -- own_edge fixed to Entry (the close pair always has entry(a) on this side).
        for close in [ClosePair::EntryEntry, ClosePair::EntryExit] {
            let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(close);
            let mut issues = Vec::new();
            let mut rng = crate::random::MazeRng::seed_from_u64(0);
            check(3.0, TeleportProximityEdge::Entry, TeleportProximityEdge::EntryOrExit).repair_check(&maze, &mut issues, &mut rng, ());
            assert_eq!(issues.len(), 1);
            let pairs = &issues[0].pairs;
            assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
        }
    }

    #[test]
    fn both_entry_or_exit_fires_for_any_close_combination() {
        for close in [ClosePair::EntryEntry, ClosePair::EntryExit, ClosePair::ExitEntry, ClosePair::ExitExit] {
            let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(close);
            let mut issues = Vec::new();
            let mut rng = crate::random::MazeRng::seed_from_u64(0);
            check(3.0, TeleportProximityEdge::EntryOrExit, TeleportProximityEdge::EntryOrExit).repair_check(&maze, &mut issues, &mut rng, ());
            assert_eq!(issues.len(), 1);
            let pairs = &issues[0].pairs;
            assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
        }
    }

    #[test]
    fn entry_or_exit_silent_when_nothing_is_close() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_edge(p(4), p(5), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(1000.0, TeleportProximityEdge::EntryOrExit, TeleportProximityEdge::EntryOrExit).repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "unreachable in every combination must not be treated as distance 0");
    }

    #[test]
    fn entry_vs_entry_selector_silent_when_the_close_pair_is_elsewhere() {
        // The bridge connects exit(a)/exit(b) (ExitExit) -- Entry/Entry must stay silent.
        // (ExitEntry/EntryExit bridges are unsuitable here: they land the bridge one hop from
        // one teleport's own entry, and that teleport is itself a 1-hop edge to its exit, so
        // Entry/Entry would pick up a short route *through the teleport itself* -- a real
        // topological path, not a check bug, but not what this test means to isolate.)
        let (maze, _, _) = maze_with_one_close_endpoint_pair(ClosePair::ExitExit);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(3.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn exit_vs_exit_selector_silent_when_the_close_pair_is_elsewhere() {
        let (maze, _, _) = maze_with_one_close_endpoint_pair(ClosePair::EntryEntry);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(3.0, TeleportProximityEdge::Exit, TeleportProximityEdge::Exit).repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn unreachable_pair_in_both_directions_is_never_flagged() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        // Two isolated teleport pairs, no path connects them at all.
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_edge(p(4), p(5), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(1000.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "unreachable in both directions must not be treated as distance 0");
    }

    #[test]
    fn protect_route_excludes_a_pair_where_both_teleports_are_route_critical() {
        // start=entry_a(0), finish=exit_b(3): the only route is entry_a->exit_a(teleport a),
        // then exit_a--entry_b via a short corridor, then entry_b->exit_b(teleport b) -- both
        // teleports are route-critical. Their entries sit 1 nav-hop apart (well within the
        // check's threshold), so without protect_route this pair would fire.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        let entry_a = p(0);
        let exit_a = p(1);
        let entry_b = p(2);
        let exit_b = p(3);
        g.add_edge(entry_a, exit_a, EdgeKind::Teleport);
        g.add_bidirectional_edge(exit_a, entry_b, EdgeKind::Basic);
        g.add_edge(entry_b, exit_b, EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(entry_a);
        maze.meta.finish = Some(exit_b);

        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "a pair where both teleports are route-critical must not be recorded");
    }

    #[test]
    fn protect_route_still_records_a_pair_where_only_one_side_is_route_critical() {
        // Same topology, but finish is set to exit_a instead -- only teleport a is route-critical
        // (entry_a -> exit_a is the whole route); teleport b is unrelated and still a legitimate
        // removal candidate, so the pair must still be recorded.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        let entry_a = p(0);
        let exit_a = p(1);
        let entry_b = p(2);
        let exit_b = p(3);
        g.add_edge(entry_a, exit_a, EdgeKind::Teleport);
        g.add_bidirectional_edge(exit_a, entry_b, EdgeKind::Basic);
        g.add_edge(entry_b, exit_b, EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(entry_a);
        maze.meta.finish = Some(exit_a);

        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "a pair with only one route-critical side must still be recorded");
    }

    #[test]
    fn protect_route_skips_a_fully_protected_pair_and_still_finds_a_farther_unprotected_one() {
        // a's first-scanned candidate (b) is close AND both route-critical -- excluded, but the
        // scan for `a` must not stop there: a second candidate (c), also close but NOT
        // route-critical, must still be found and recorded. This exercises that skipping a
        // fully-protected pair doesn't `break` (unlike a normal hit), so a route-critical
        // teleport doesn't silently "use up" its scan slot on an unresolvable pair.
        //
        // Layout: entry_a(0) -> exit_a(1) [teleport a, route-critical]
        //         exit_a --- entry_b(2)   [basic corridor, 1 hop]
        //         entry_b(2) -> exit_b(3) [teleport b, route-critical -- inserted first so the
        //                                  scan visits it before c]
        //         exit_b --- entry_c(4)  is NOT built -- c is reached via its own short bridge
        //         from entry_a instead, so it's close to a but off the actual route entirely.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(7, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        let entry_a = p(0);
        let exit_a = p(1);
        let entry_b = p(2);
        let exit_b = p(3);
        let entry_c = p(5);
        let exit_c = p(6);

        let id_a = g.add_edge(entry_a, exit_a, EdgeKind::Teleport);
        g.add_bidirectional_edge(exit_a, entry_b, EdgeKind::Basic);
        // b inserted before c so the scan from a's side visits b (the protected candidate) first.
        let id_b = g.add_edge(entry_b, exit_b, EdgeKind::Teleport);
        // c sits near entry_a via its own short bridge -- close enough to be a candidate, but
        // reaching finish through c is impossible (c dead-ends past exit_c with no way back to
        // exit_b), so c is not on the route and not route-critical.
        g.add_bidirectional_edge(entry_a, entry_c, EdgeKind::Basic);
        let id_c = g.add_edge(entry_c, exit_c, EdgeKind::Teleport);

        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(entry_a);
        maze.meta.finish = Some(exit_b);

        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());

        assert_eq!(issues.len(), 1);
        let pairs = &issues[0].pairs;
        // The key assertion is the *direction* (a, c): if the skip incorrectly `break`s a's scan
        // right after seeing the protected (a, b) candidate, a's own scan records nothing at all
        // for `a` — the only way (a, c)/(c, a) could still appear would be from c's own
        // independent scan (recorded as (c, a), never (a, c)). Asserting the exact (a, c)
        // direction is what actually exercises "skip doesn't break the scan", not a looser
        // "either direction" check which a regression could still satisfy via c's side alone.
        assert!(
            pairs.contains(&(id_a, id_c)),
            "a's scan must skip the fully-protected (a, b) pair and still record (a, c) from a's own side: got {pairs:?}"
        );
        assert!(
            !pairs.contains(&(id_a, id_b)) && !pairs.contains(&(id_b, id_a)),
            "the fully-protected (a, b) pair must never be recorded: got {pairs:?}"
        );
    }

    #[test]
    fn stops_at_first_problematic_pair_per_teleport() {
        // a is close to both b and c -- per the spec ("once one problematic pair is found for a
        // teleport, record it and move to the next teleport"), scanning from a's side must
        // record exactly one pair (a, _), not both (a, b) and (a, c).
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        let entry_a = p(0);
        let entry_b = p(1);
        let entry_c = p(2);
        let id_a = g.add_edge(entry_a, entry_a, EdgeKind::Teleport);
        let id_b = g.add_edge(entry_b, entry_b, EdgeKind::Teleport);
        let id_c = g.add_edge(entry_c, entry_c, EdgeKind::Teleport);
        g.add_bidirectional_edge(entry_a, entry_b, EdgeKind::Basic);
        g.add_bidirectional_edge(entry_b, entry_c, EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = &issues[0].pairs;
        let a_pairs: Vec<_> = pairs.iter().filter(|&&(x, _)| x == id_a).collect();
        assert_eq!(a_pairs.len(), 1, "scanning from a's side must stop at the first problematic pair (b or c), not record both: {a_pairs:?}");
        let (_, matched) = a_pairs[0];
        assert!(*matched == id_b || *matched == id_c);
    }

    #[test]
    fn records_the_configured_distance_as_a_detail() {
        let (maze, _, _) = maze_with_two_teleport_entries_at_gap(2);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].details().get(TEST_ID).and_then(|kv| kv.get("distance")), Some(&"5".to_string()));
    }

    #[test]
    fn check_type_id_matches_registered_type_id() {
        let c = check(0.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry);
        assert_eq!(<TeleportGroupProximityCheck as Check<SquareTessellation, TeleportGroupProximityIssue>>::check_type_id(&c), "teleport_group_proximity");
    }

    #[test]
    fn fires_for_both_directions_of_a_two_way_teleport_independently() {
        // A two-way teleport is two independent Teleport edges -- each direction is scanned as
        // its own element, same as TeleportSuperHubAvoidanceCheck/TeleportWaypointDistanceCheck.
        let mut ids = IdGenerator::new();
        let width = 5;
        let field: Field<SquareTessellation> = Field::new(square_rect(width, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(p(0), p(2), EdgeKind::Basic);
        let entry_a = p(0);
        let entry_b = p(2);
        let far_a = p(3);
        let far_b = p(4);
        let id_a = g.add_edge(entry_a, far_a, EdgeKind::Teleport);
        g.add_edge(far_a, entry_a, EdgeKind::Teleport); // reverse direction of teleport a
        let id_b = g.add_edge(entry_b, far_b, EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = &issues[0].pairs;
        // The original forward id_a->id_b pair (and its symmetric b->a) must still be present;
        // the new reverse-direction teleport has its own entry (= a's old exit) far from b's
        // entry, so it should not itself produce a pair under Entry/Entry.
        assert!(pairs.iter().any(|&(x, y)| (x == id_a && y == id_b) || (x == id_b && y == id_a)));
    }
}
