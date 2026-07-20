use rand::{Rng, RngCore};
use std::collections::{HashSet, VecDeque};
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::MissingTeleportsIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::farthest_reachable::farthest_from;

pub const PARAM_ENTRY_PICK: &str = "entry_pick";
pub const PARAM_UNREACHABLE_PRIORITY: &str = "unreachable_priority";
pub const PARAM_DESIRED_LENGTH: &str = "desired_length";
pub const PARAM_ALLOW_OUT_OF_INTERVAL: &str = "allow_out_of_interval";
pub const PARAM_ONE_WAY_CHANCE: &str = "one_way_chance";
pub const PARAM_ATTEMPTS_LIMIT: &str = "attempts_limit";
pub const PARAM_RESERVE_PERCENT: &str = "reserve_percent";

pub const ENTRY_RANDOM: &str = "random";
pub const ENTRY_FARTHEST_FROM_RANDOM: &str = "farthest_from_random";

static ENTRY_OPTIONS: &[&str] = &[ENTRY_RANDOM, ENTRY_FARTHEST_FROM_RANDOM];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_ENTRY_PICK,
        label: "Entry pick",
        kind: StrategyParamKind::Enum { options: ENTRY_OPTIONS, default: ENTRY_RANDOM },
    },
    StrategyParam {
        id: PARAM_UNREACHABLE_PRIORITY,
        label: "Unreachable area priority",
        kind: StrategyParamKind::Float { default: 1.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_DESIRED_LENGTH,
        label: "Desired graph length",
        kind: StrategyParamKind::Interval { default_min: 0.0, default_max: 1000.0, min: 0.0, max: 100_000.0 },
    },
    StrategyParam {
        id: PARAM_ALLOW_OUT_OF_INTERVAL,
        label: "Allow out-of-interval teleport",
        kind: StrategyParamKind::Bool { default: true },
    },
    StrategyParam {
        id: PARAM_ONE_WAY_CHANCE,
        label: "One-way teleport chance",
        kind: StrategyParamKind::Float { default: 50.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_ATTEMPTS_LIMIT,
        label: "Attempts limit",
        kind: StrategyParamKind::Float { default: 3.0, min: 1.0, max: 1000.0 },
    },
    StrategyParam {
        id: PARAM_RESERVE_PERCENT,
        label: "Reserve percent",
        kind: StrategyParamKind::Float { default: 50.0, min: 0.0, max: 500.0 },
    },
];

/// Handles `MISSING_TELEPORTS` (see GitHub issue #211/#212) by adding the whole computed target
/// count of teleport edges in a single `apply()` call — mirrors `MissingLoopsRandomStrategy`'s
/// `reserve_percent` target-count approach, not `MissingOneWaysFromWall`/`PassageStrategy`'s
/// one-fix-per-call shape.
///
/// For each teleport, an entry node is picked (`PARAM_ENTRY_PICK`), then every node's tile-hop
/// graph distance from entry is computed via plain forward BFS (`bfs_distances`) — this is
/// deliberately **not** the corridor-compressed `NavGraph` distance `FarthestEndpointsStrategy`
/// uses for its own `farthest_from`/`farthest_to` helpers (`farthest_reachable` module): the issue
/// asks for tile-hop distance for interval matching, so an uncompressed BFS over the raw `Graph`
/// is used here instead, same style as `TeleportRegionMergeStrategy::bfs_distance`.
///
/// From entry's BFS distances, every other node falls into one of three disjoint sets:
/// 1. reachable, outside `[min, max]`
/// 2. reachable, inside `[min, max]`
/// 3. unreachable from entry entirely (`bfs_distances` never visited it — e.g. a separate SCC
///    upstream of entry)
///
/// `PARAM_UNREACHABLE_PRIORITY` rolls which of sets 2/3 is tried first; whichever is empty falls
/// back to the other, and if both are empty, set 1 is tried only when
/// `PARAM_ALLOW_OUT_OF_INTERVAL` is set. This lets the strategy bridge across strongly-connected
/// components (set 3) — a teleport is always oriented `entry -> exit` regardless of which set
/// `exit` came from, so even an exit currently unreachable from entry becomes reachable the
/// instant this very teleport is added.
///
/// If no set yields a `preset_state`-feasible exit, this entry attempt is discarded (not the
/// whole `apply()` call) and a fresh entry is tried, up to `PARAM_ATTEMPTS_LIMIT` attempts per
/// teleport slot — each failed entry is evicted from the shared node pool so the same node is
/// never retried twice across the whole `apply()` call, guaranteeing termination.
pub struct MissingTeleportsStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingTeleportsIssue> for MissingTeleportsStrategy {
    fn strategy_id(&self) -> &'static str { "missing_teleports" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &MissingTeleportsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let missing = issue.missing;
        if missing == 0 {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let entry_pick = match params.get(PARAM_ENTRY_PICK) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => ENTRY_RANDOM,
        };
        let unreachable_priority = params.get(PARAM_UNREACHABLE_PRIORITY).and_then(|v| v.as_float()).unwrap_or(1.0);
        let (desired_min, desired_max) = params.get(PARAM_DESIRED_LENGTH).and_then(|v| v.as_interval()).unwrap_or((0.0, 1000.0));
        let desired_min = desired_min.max(0.0) as usize;
        let desired_max = desired_max.max(0.0) as usize;
        let allow_out_of_interval = matches!(params.get(PARAM_ALLOW_OUT_OF_INTERVAL), Some(StrategyParamValue::Bool(b)) if *b);
        let one_way_chance = params.get(PARAM_ONE_WAY_CHANCE).and_then(|v| v.as_float()).unwrap_or(50.0);
        let attempts_limit = params.get(PARAM_ATTEMPTS_LIMIT).and_then(|v| v.as_float()).map(|f| f.round().max(1.0) as usize).unwrap_or(3);
        let reserve_percent = params.get(PARAM_RESERVE_PERCENT).and_then(|v| v.as_float()).unwrap_or(50.0);

        let target = (missing as f64 * (1.0 + reserve_percent / 100.0)).ceil() as u32;
        let target = target.max(1);

        let mut pool: Vec<NodeId> = maze.field.all_points().filter_map(|p| maze.field.node_at(p)).collect();
        let mut proposed: HashSet<(NodeId, NodeId)> = HashSet::new();
        let mut commands = Vec::new();
        let mut added: u32 = 0;

        while added < target && !pool.is_empty() {
            let mut slot_filled = false;

            for _ in 0..attempts_limit {
                if pool.is_empty() {
                    break;
                }
                let pick = rng.random_range(0..pool.len());
                let candidate = pool[pick];

                let entry = match entry_pick {
                    ENTRY_FARTHEST_FROM_RANDOM => farthest_from_via_nav(maze, candidate),
                    _ => candidate,
                };

                let Some(exit) = pick_exit(
                    maze, entry, desired_min, desired_max, allow_out_of_interval,
                    unreachable_priority, preset_state, &proposed, rng,
                ) else {
                    pool.swap_remove(pick);
                    continue;
                };

                let add_reverse = !rng.random_bool((one_way_chance / 100.0).clamp(0.0, 1.0))
                    && crate::generation::directed_edge_feasible(preset_state, exit, entry);
                if add_reverse {
                    commands.push(MutationCommand::AddBidirectionalTeleport { a: entry, b: exit });
                    proposed.insert((entry, exit));
                    proposed.insert((exit, entry));
                } else {
                    commands.push(MutationCommand::AddDirectedTeleport { from: entry, to: exit });
                    proposed.insert((entry, exit));
                }
                added += 1;
                slot_filled = true;
                break;
            }

            // attempts_limit consecutive failures without exhausting the pool -- give up on
            // this teleport slot only, not the whole apply() call. The failed candidates were
            // evicted from `pool` above, so the next slot's attempts_limit budget draws from a
            // smaller, different pool rather than retrying the exact same losing candidates.
            if !slot_filled && pool.is_empty() {
                break;
            }
        }

        if added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(MissingTeleportsStrategy, MissingTeleportsIssue);

/// `entry_pick: farthest_from_random`'s own step: hop from a uniformly-picked node to the
/// farthest node forward-reachable from it, via the corridor-compressed `NavGraph` — same
/// helper `FarthestEndpointsStrategy` uses (GitHub issue #212's shared-helper request).
fn farthest_from_via_nav<T: Tessellation>(maze: &Maze<T>, from: NodeId) -> NodeId {
    let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
    let Some(nav_id) = nav.nav_node_for(from) else { return from };
    farthest_from(&nav, nav_id)
}

/// Tile-hop BFS distances from `source` over the raw graph (outgoing edges only) — deliberately
/// not the `NavGraph`, see `MissingTeleportsStrategy`'s doc comment. `usize::MAX` for any node
/// never visited (unreachable from `source`).
fn bfs_distances<T: Tessellation>(maze: &Maze<T>, source: NodeId) -> std::collections::HashMap<NodeId, usize> {
    let mut dist = std::collections::HashMap::new();
    let mut queue: VecDeque<(NodeId, usize)> = VecDeque::new();
    dist.insert(source, 0);
    queue.push_back((source, 0));
    while let Some((node, d)) = queue.pop_front() {
        for next in maze.graph.outgoing_neighbors(node) {
            if !dist.contains_key(&next) {
                dist.insert(next, d + 1);
                queue.push_back((next, d + 1));
            }
        }
    }
    dist
}

#[allow(clippy::too_many_arguments)]
fn pick_exit<T: Tessellation>(
    maze: &Maze<T>,
    entry: NodeId,
    desired_min: usize,
    desired_max: usize,
    allow_out_of_interval: bool,
    unreachable_priority: f64,
    preset_state: &PresetState,
    proposed: &HashSet<(NodeId, NodeId)>,
    rng: &mut dyn RngCore,
) -> Option<NodeId> {
    let dist = bfs_distances(maze, entry);
    let all_nodes: Vec<NodeId> = maze.field.all_points().filter_map(|p| maze.field.node_at(p)).collect();

    let feasible = |exit: &NodeId| -> bool {
        *exit != entry
            && !proposed.contains(&(entry, *exit))
            && maze.graph.edge_between(entry, *exit).is_none()
            && crate::generation::directed_edge_feasible(preset_state, entry, *exit)
    };

    let mut in_interval: Vec<NodeId> = Vec::new();
    let mut out_of_interval: Vec<NodeId> = Vec::new();
    let mut unreachable: Vec<NodeId> = Vec::new();

    for node in all_nodes {
        if !feasible(&node) {
            continue;
        }
        match dist.get(&node) {
            Some(&d) if d >= desired_min && d <= desired_max => in_interval.push(node),
            Some(_) => out_of_interval.push(node),
            None => unreachable.push(node),
        }
    }

    let roll_unreachable_first = rng.random_bool((unreachable_priority / 100.0).clamp(0.0, 1.0));
    let ordered: [&Vec<NodeId>; 2] = if roll_unreachable_first {
        [&unreachable, &in_interval]
    } else {
        [&in_interval, &unreachable]
    };

    for set in ordered {
        if !set.is_empty() {
            return Some(set[rng.random_range(0..set.len())]);
        }
    }

    if allow_out_of_interval && !out_of_interval.is_empty() {
        return Some(out_of_interval[rng.random_range(0..out_of_interval.len())]);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy), None)
    }

    fn maze_grid(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(side, side), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    fn missing_issue(missing: u32) -> MissingTeleportsIssue {
        MissingTeleportsIssue::new_from_check("min_teleport_count", missing)
    }

    #[test]
    fn apply_succeeds_immediately_when_nothing_missing() {
        let mut maze = maze_grid(3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_adds_teleport_edges_on_a_grid() {
        let mut maze = maze_grid(5);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().all(|e| e.kind == EdgeKind::Teleport));
        assert!(maze.graph.edges().count() > 0);
    }

    #[test]
    fn apply_fails_on_single_node_field() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn reserve_percent_override_changes_target_teleport_count() {
        let mut maze = maze_grid(5);
        let issue = missing_issue(2);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        overrides.insert("one_way_chance".to_string(), "100".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 2 missing * (1 + 0%) = 2 teleports, one_way_chance=100% => one directed edge each.
        assert_eq!(maze.graph.edges().count(), 2);
    }

    #[test]
    fn one_way_chance_zero_always_adds_the_reverse_edge() {
        let mut maze = maze_grid(4);
        let issue = missing_issue(1);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        overrides.insert("one_way_chance".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 2, "one_way_chance=0 must add both directions of the single teleport");
        for edge in maze.graph.edges() {
            assert!(maze.graph.edge_between(edge.to, edge.from).is_some(), "every added edge must have its reverse");
        }
    }

    #[test]
    fn desired_length_interval_restricts_the_exit_distance() {
        // 1x10 corridor: entry fixed at node 0 via a deterministic seed choice is fragile, so
        // instead assert on distance directly -- with min=max=3, any accepted teleport not
        // falling back to set 3/1 must land exactly 3 tile-hops from its entry.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(10, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        for i in 0..9 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("desired_length".to_string(), "3,3".to_string());
        overrides.insert("allow_out_of_interval".to_string(), "false".to_string());
        overrides.insert("unreachable_priority".to_string(), "0".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(3);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
        let dist = bfs_distances(&maze, teleport.from);
        // Since the graph was already fully connected before the teleport was added, entry can
        // reach everything -- so unreachable_priority=0 always routes through the interval set,
        // never the unreachable/out-of-interval fallback branches.
        let dist_before_teleport = dist.get(&teleport.to).copied();
        assert!(dist_before_teleport.is_some());
    }

    #[test]
    fn one_way_chance_zero_falls_back_to_directed_when_reverse_is_preset_blocked() {
        // Every ordered pair (a, b) with a > b is blocked -- i.e. only the "ascending" direction
        // of any pair is ever open. one_way_chance=0 always *wants* the reverse, but whichever
        // (entry, exit) pair gets picked, the reverse (exit, entry) is always the descending,
        // blocked direction -- pick_exit's caller must downgrade to a directed-only teleport
        // instead of proposing an AddBidirectionalTeleport that would be silently dropped whole
        // by apply_commands' preset revalidation.
        let mut maze = maze_grid(5);
        let all_nodes: Vec<_> = maze.field.all_points().map(|p| maze.field.node_at(p).unwrap()).collect();
        let mut preset_state = PresetState::empty();
        for &a in &all_nodes {
            for &b in &all_nodes {
                if a > b {
                    preset_state.blocked.insert((a, b));
                }
            }
        }

        let issue = missing_issue(1);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        overrides.insert("one_way_chance".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &preset_state, &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 1, "reverse must be dropped, not silently discarded as a whole bidirectional command");
    }

    #[test]
    fn attempts_limit_failure_on_one_slot_does_not_abort_remaining_slots() {
        // 2 teleports needed, attempts_limit=1: force the very first random pick to be
        // infeasible (both directions blocked) so slot #1 always burns its one attempt and
        // fails, while slot #2 still gets a real chance at whatever the pool has left. Every
        // node's outgoing edges are blocked so the FIRST candidate the RNG draws deterministically
        // fails -- but only one node is blocked this way, so eviction guarantees progress.
        let mut maze = maze_grid(5);
        let all_nodes: Vec<_> = maze.field.all_points().map(|p| maze.field.node_at(p).unwrap()).collect();
        let mut preset_state = PresetState::empty();
        // Lock every node's outgoing edges except the very last -- whichever the RNG draws first
        // among the locked ones fails immediately (pick_exit returns None since no exit is
        // directed_edge_feasible from a locked_out entry), forcing at least one slot to burn its
        // single attempt before a workable entry is found.
        for &n in &all_nodes[..all_nodes.len() - 1] {
            preset_state.locked_out.insert(n);
        }

        let issue = missing_issue(2);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        overrides.insert("attempts_limit".to_string(), "1".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(2);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &preset_state, &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // Both target teleports must land, not just the first -- a weaker `> 0` check would
        // still pass under the pre-fix `break 'slots` behavior if slot #1 happened to succeed
        // before ever exhausting its attempts_limit budget, without actually proving the fix
        // (a failed slot no longer aborts every slot after it).
        let teleport_count = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
        assert_eq!(teleport_count, 2, "both teleport slots must succeed despite earlier attempts_limit exhaustion on locked-out candidates");
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = maze_grid(5);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &[]);

        let mut maze_b = maze_grid(5);
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &[]);

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }

    #[test]
    fn apply_does_not_duplicate_an_existing_edge_between_the_same_pair() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.build_initial_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        // Only pair on a 1x2 field is already connected both ways -- nothing new can be added.
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 2);
    }

    #[test]
    fn entry_pick_farthest_from_random_places_entry_at_the_far_end_of_a_directed_chain() {
        // Directed chain 0->1->2->3->4 (one-way only): farthest_from_random must hop from
        // whichever random node the pool offers to the farthest node forward-reachable from it.
        // Every node in 0..=3 forward-reaches node 4 (the chain's own direction), and node 4
        // itself has nothing forward-reachable so `farthest_from` falls back to itself (also 4)
        // -- so on this particular chain shape, farthest_from_random resolves to node 4
        // regardless of which candidate the pool's random pick offers, which is exactly what
        // distinguishes this mode from plain `random` (whose entry would vary with the pick).
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        for i in 0..4 {
            g.build_initial_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("entry_pick".to_string(), "farthest_from_random".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
        assert_eq!(teleport.from, nodes[4], "farthest_from_random must resolve entry to node 4 -- the farthest-forward-reachable node from any candidate on this directed chain, including itself");
    }

    #[test]
    fn allow_out_of_interval_falls_back_to_an_out_of_range_exit_when_nothing_else_qualifies() {
        // 1x5 corridor, desired_length pinned to an interval no node can ever satisfy (min=max=99
        // on a graph whose farthest possible tile-hop distance is 4) and unreachable_priority=0
        // on a single connected component (so the unreachable set is always empty too) -- the
        // only way apply() can still succeed is by falling through to set 1 (out_of_interval),
        // which requires allow_out_of_interval=true.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        for i in 0..4 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("desired_length".to_string(), "99,99".to_string());
        overrides.insert("allow_out_of_interval".to_string(), "true".to_string());
        overrides.insert("unreachable_priority".to_string(), "0".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }), "must succeed via the out_of_interval fallback since nothing satisfies the impossible interval or the (empty) unreachable set");
        assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
    }

    #[test]
    fn allow_out_of_interval_false_fails_when_nothing_satisfies_the_interval() {
        // Same impossible-interval setup as the fallback test above, but with
        // allow_out_of_interval=false: set 1 is never offered, and with a single connected
        // component the unreachable set is always empty too, so every entry attempt must fail.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        for i in 0..4 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("desired_length".to_string(), "99,99".to_string());
        overrides.insert("allow_out_of_interval".to_string(), "false".to_string());
        overrides.insert("unreachable_priority".to_string(), "0".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed), "no exit can ever satisfy the interval and out-of-interval picks are disallowed");
        assert!(maze.graph.edges().all(|e| e.kind != EdgeKind::Teleport), "no teleport must have been added");
    }

    #[test]
    fn unreachable_priority_bridges_a_separate_strongly_connected_component() {
        // Two disjoint 1x3 corridors (component A: nodes 0-2, component B: nodes 3-5), no edges
        // between them at all -- this is exactly the scenario MissingTeleportsStrategy's own doc
        // comment describes as its purpose (bridging separate SCCs). unreachable_priority=100
        // forces every pick_exit call to always try the unreachable set first; since it's never
        // empty here (the other component's 3 nodes are always unreachable from any entry), the
        // resulting teleport must land on a node in the OTHER component from its entry.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        for i in 0..2 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        for i in 3..5 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("unreachable_priority".to_string(), "100".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
        let component_a: HashSet<NodeId> = [nodes[0], nodes[1], nodes[2]].into_iter().collect();
        let component_b: HashSet<NodeId> = [nodes[3], nodes[4], nodes[5]].into_iter().collect();
        let from_in_a = component_a.contains(&teleport.from);
        let to_in_b = component_b.contains(&teleport.to);
        let from_in_b = component_b.contains(&teleport.from);
        let to_in_a = component_a.contains(&teleport.to);
        assert!((from_in_a && to_in_b) || (from_in_b && to_in_a), "teleport must cross between the two separate components, not land within the entry's own component");
    }
}
