use rand::{Rng, RngCore};
use std::collections::{HashSet, VecDeque};
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::{MissingTeleportsIssue, RepairArea};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::farthest_reachable::farthest_from;
use super::remaining_deficits::RemainingDeficits;

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
        if issue.missing.is_empty() {
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

        let mut proposed: HashSet<(NodeId, NodeId)> = HashSet::new();
        let mut commands = Vec::new();
        let mut total_added: u32 = 0;

        let mut deficits = RemainingDeficits::new(&issue.missing);
        let areas: Vec<RepairArea> = deficits.areas().collect();
        for area in areas {
            let missing = deficits.live(area);
            if missing == 0 {
                continue;
            }
            let target = (missing as f64 * (1.0 + reserve_percent / 100.0)).ceil() as u32;
            let target = target.max(1);

            // Only the entry side is restricted to the reported area — a teleport's exit is free
            // to land on any floor (GitHub issue #369's floor-scope follow-up): teleports
            // legitimately connect points on different floors, so forcing the exit onto the same
            // area as the entry would rule out exactly the cross-floor teleports this strategy is
            // meant to be able to add.
            let mut pool: Vec<NodeId> = maze.field.all_node_ids()
                .filter(|&n| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(n) == Some(level),
                })
                .collect();
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

                    // Decrement the entry's own area (usually `area`, but the entry may differ
                    // from `candidate` under `entry_pick: farthest_from_random`, so re-derive it
                    // from `entry`'s actual level rather than assuming it's still `area`) plus the
                    // exit's level if it lands on a different floor, plus `WholeMaze` always — a
                    // teleport can cross floors, so both ends' per-floor deficits are satisfied by
                    // this one addition (GitHub issue #369 follow-up).
                    let mut covered = vec![RepairArea::WholeMaze];
                    if let Some(entry_level) = maze.field.level_of(entry) {
                        covered.push(RepairArea::Level(entry_level));
                    }
                    if let Some(exit_level) = maze.field.level_of(exit) {
                        covered.push(RepairArea::Level(exit_level));
                    }
                    deficits.consume(&covered);
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
            total_added += added;
        }

        if total_added == 0 {
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
    let all_nodes: Vec<NodeId> = maze.field.all_node_ids().collect();

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
#[path = "missing_teleports_tests.rs"]
mod tests;
