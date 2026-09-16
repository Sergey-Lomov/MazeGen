use rand::{Rng, RngCore};
use std::collections::{HashSet, VecDeque};
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::{MissingTeleportsIssue, RepairArea};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams, PriorityLevel};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use crate::generation::{cmd_add_directed_teleport, cmd_add_bidirectional_teleport};
use super::farthest_reachable::{farthest_from, farthest_from_exhaustive, search_mode, SEARCH_MODE_PARAM, SEARCH_MODE_EXHAUSTIVE};
use super::standard_add_params::{self, reserve_target, attempts_limit};
use super::remaining_deficits::RemainingDeficits;

pub const PARAM_ENTRY_PICK: &str = "entry_pick";
pub const PARAM_UNREACHABLE_PRIORITY: &str = "unreachable_priority";
pub const PARAM_DESIRED_LENGTH: &str = "desired_length";
pub const PARAM_ALLOW_OUT_OF_INTERVAL: &str = "allow_out_of_interval";
pub const PARAM_ONE_WAY_CHANCE: &str = "one_way_chance";
pub const PARAM_CROSS_FLOOR_MODE: &str = "cross_floor_mode";
pub const PARAM_CROSS_FLOOR_BALANCE: &str = "cross_floor_balance";

pub const ENTRY_RANDOM: &str = "random";
pub const ENTRY_FARTHEST_FROM_RANDOM: &str = "farthest_from_random";

static ENTRY_OPTIONS: &[&str] = &[ENTRY_RANDOM, ENTRY_FARTHEST_FROM_RANDOM];

/// Cross-floor policy for the exit pick — see GitHub issue #381.
pub const CROSS_FLOOR_FORBIDDEN: &str = "forbidden";
pub const CROSS_FLOOR_NATURAL: &str = "natural";
pub const CROSS_FLOOR_MANUAL: &str = "manual";

static CROSS_FLOOR_MODE_OPTIONS: &[&str] = &[CROSS_FLOOR_FORBIDDEN, CROSS_FLOOR_NATURAL, CROSS_FLOOR_MANUAL];

const ENTRY_PICK_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ENTRY_PICK,
    label: "Entry pick",
    kind: StrategyParamKind::Enum { options: ENTRY_OPTIONS, default: ENTRY_RANDOM },
};
const UNREACHABLE_PRIORITY_PARAM: StrategyParam = StrategyParam {
    id: PARAM_UNREACHABLE_PRIORITY,
    label: "Unreachable area priority",
    kind: StrategyParamKind::Priority { default: PriorityLevel::Indifferent },
};
const DESIRED_LENGTH_PARAM: StrategyParam = StrategyParam {
    id: PARAM_DESIRED_LENGTH,
    label: "Desired graph length",
    kind: StrategyParamKind::Interval { default_min: 0.0, default_max: 1000.0, min: 0.0, max: 100_000.0 },
};
const ALLOW_OUT_OF_INTERVAL_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ALLOW_OUT_OF_INTERVAL,
    label: "Allow out-of-interval teleport",
    kind: StrategyParamKind::Bool { default: true },
};
const ONE_WAY_CHANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ONE_WAY_CHANCE,
    label: "One-way teleport chance",
    kind: StrategyParamKind::Float { default: 50.0, min: 0.0, max: 100.0 },
};
const CROSS_FLOOR_MODE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_CROSS_FLOOR_MODE,
    label: "Cross-floor mode",
    kind: StrategyParamKind::Enum { options: CROSS_FLOOR_MODE_OPTIONS, default: CROSS_FLOOR_NATURAL },
};
const CROSS_FLOOR_BALANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_CROSS_FLOOR_BALANCE,
    label: "Cross-floor balance",
    kind: StrategyParamKind::Float { default: 0.5, min: 0.0, max: 1.0 },
};

// `no_src_mode`: the entry pool is node-based, but this strategy already has `entry_pick` as its
// source-ordering knob — a second `src_mode` on top would be redundant. `reserve_percent` and
// `attempts_limit` are the shared standard block (GitHub issue #486); `attempts_limit`'s default
// unified from the old `3` to `25`.
static PARAMS: [StrategyParam; 10] = crate::add_strategy_params!(no_src_mode:
    ENTRY_PICK_PARAM,
    SEARCH_MODE_PARAM,
    UNREACHABLE_PRIORITY_PARAM,
    DESIRED_LENGTH_PARAM,
    ALLOW_OUT_OF_INTERVAL_PARAM,
    ONE_WAY_CHANCE_PARAM,
    CROSS_FLOOR_MODE_PARAM,
    CROSS_FLOOR_BALANCE_PARAM,
);

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
/// `PARAM_UNREACHABLE_PRIORITY` (a `PriorityLevel`, set 3 = "preferred", set 2 = "other" — see
/// `PriorityLevel::order_zones`, mirrors `AddElevatorStopCountStrategy`'s own `expand_elevator`)
/// orders sets 2/3 against each other: `Required`/`Forbidden` restrict the pick to set 3/2
/// respectively with no fallback to the other (an empty restricted set fails the whole entry
/// attempt, same as `pick_exit` failing outright); `Preferred`/`Discouraged` try one set first and
/// fall back to the other only if it's empty; `Indifferent` (default) merges both sets and picks
/// uniformly at random. If both sets end up unusable, set 1 is tried only when
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
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
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
        let search_mode = search_mode(params);
        let unreachable_priority = params.get(PARAM_UNREACHABLE_PRIORITY).and_then(|v| v.as_priority()).unwrap_or(PriorityLevel::Indifferent);
        let (desired_min, desired_max) = params.get(PARAM_DESIRED_LENGTH).and_then(|v| v.as_interval()).unwrap_or((0.0, 1000.0));
        let desired_min = desired_min.max(0.0) as usize;
        let desired_max = desired_max.max(0.0) as usize;
        let allow_out_of_interval = matches!(params.get(PARAM_ALLOW_OUT_OF_INTERVAL), Some(StrategyParamValue::Bool(b)) if *b);
        let one_way_chance = params.get(PARAM_ONE_WAY_CHANCE).and_then(|v| v.as_float()).unwrap_or(50.0);
        let attempts_limit = attempts_limit(params);
        let cross_floor_mode = match params.get(PARAM_CROSS_FLOOR_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => CROSS_FLOOR_NATURAL,
        };
        let cross_floor_balance = params.get(PARAM_CROSS_FLOOR_BALANCE).and_then(|v| v.as_float()).unwrap_or(0.5).clamp(0.0, 1.0);

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
            let target = reserve_target(params, missing);

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
                        ENTRY_FARTHEST_FROM_RANDOM => farthest_from_via_nav(maze, candidate, search_mode),
                        _ => candidate,
                    };

                    let Some(exit) = pick_exit(
                        maze, entry, desired_min, desired_max, allow_out_of_interval,
                        unreachable_priority, preset_state, &proposed, rng,
                        cross_floor_mode, cross_floor_balance,
                    ) else {
                        pool.swap_remove(pick);
                        continue;
                    };

                    let want_reverse = !rng.random_bool((one_way_chance / 100.0).clamp(0.0, 1.0));
                    let bidi_cmds = if want_reverse { cmd_add_bidirectional_teleport(entry, exit, preset_state) } else { vec![] };
                    if !bidi_cmds.is_empty() {
                        commands.extend(bidi_cmds);
                        proposed.insert((entry, exit));
                        proposed.insert((exit, entry));
                    } else {
                        commands.extend(cmd_add_directed_teleport(entry, exit, preset_state));
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
/// farthest node forward-reachable from it — helper shared with `FarthestEndpointsStrategy`
/// (GitHub issue #212's shared-helper request). `PARAM_SEARCH_MODE` (GitHub issue #515) picks
/// between the two search modes; see `farthest_reachable` module doc.
///
/// `SEARCH_MODE_EXHAUSTIVE` runs a plain BFS from `from` itself over the raw graph — every tile is
/// a candidate, so no resolution step is needed.
///
/// `SEARCH_MODE_NAV_GRAPH` (default) searches the corridor-compressed `NavGraph`, which only knows
/// junction/dead-end nodes. `from` is usually a corridor-interior node (the candidate pool is
/// every maze node, and those vastly outnumber junction/dead-end nodes), which
/// `NavGraph::nav_node_for` cannot resolve — falling back to `from` itself there would silently
/// skip the farthest-search for the common case. Instead, resolve via `corridor_index` to the nav
/// node the corridor leads into. This is coarse (it's the corridor's destination nav node, not
/// `from`'s own position), but it keeps the search on the nav graph instead of degenerating into a
/// no-op. Note: a true farthest point can still land mid-corridor when loops are present —
/// `farthest_from` only ever considers nav nodes, so that deeper limitation is exactly what
/// `SEARCH_MODE_EXHAUSTIVE` exists to address.
fn farthest_from_via_nav<T: Tessellation>(maze: &Maze<T>, from: NodeId, search_mode: &str) -> NodeId {
    if search_mode == SEARCH_MODE_EXHAUSTIVE {
        return farthest_from_exhaustive(&maze.graph, from);
    }
    let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
    let Some(nav_id) = nav.nav_node_for(from).or_else(|| nav.corridor_index.get(&from).copied()) else {
        return from;
    };
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
    unreachable_priority: PriorityLevel,
    preset_state: &PresetState,
    proposed: &HashSet<(NodeId, NodeId)>,
    rng: &mut dyn RngCore,
    cross_floor_mode: &str,
    cross_floor_balance: f64,
) -> Option<NodeId> {
    let dist = bfs_distances(maze, entry);
    let all_nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
    let entry_level = maze.field.level_of(entry);

    let feasible = |exit: &NodeId| -> bool {
        *exit != entry
            && !proposed.contains(&(entry, *exit))
            && maze.graph.edge_between(entry, *exit).is_none()
            && crate::generation::directed_edge_feasible(preset_state, entry, *exit)
            && (cross_floor_mode != CROSS_FLOOR_FORBIDDEN || maze.field.level_of(*exit) == entry_level)
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

    // "unreachable" is the "preferred" group, "in_interval" is "other" -- see `PriorityLevel`.
    let zones = unreachable_priority.order_zones(unreachable, in_interval, rng);

    for zone in &zones {
        if let Some(exit) = pick_from_set(maze, zone, entry_level, cross_floor_mode, cross_floor_balance, rng) {
            return Some(exit);
        }
    }

    if allow_out_of_interval {
        if let Some(exit) = pick_from_set(maze, &out_of_interval, entry_level, cross_floor_mode, cross_floor_balance, rng) {
            return Some(exit);
        }
    }

    None
}

/// Picks one node from `set`, applying `cross_floor_mode: manual`'s same-/other-floor balance
/// roll — see GitHub issue #381. `Forbidden` already filtered `set` down to same-floor-only
/// candidates in `pick_exit`'s own `feasible` closure, and `Natural` ignores floor entirely, so
/// both reduce to a plain uniform pick here. `set` empty returns `None` without rolling.
fn pick_from_set<T: Tessellation>(
    maze: &Maze<T>,
    set: &[NodeId],
    entry_level: Option<crate::space::LevelId>,
    cross_floor_mode: &str,
    cross_floor_balance: f64,
    rng: &mut dyn RngCore,
) -> Option<NodeId> {
    if set.is_empty() {
        return None;
    }
    if cross_floor_mode != CROSS_FLOOR_MANUAL {
        return Some(set[rng.random_range(0..set.len())]);
    }

    let (same_floor, other_floor): (Vec<NodeId>, Vec<NodeId>) =
        set.iter().partition(|&&n| maze.field.level_of(n) == entry_level);

    // Extreme balance values are a hard preference, not just a strong one — no fallback to the
    // opposite group when it's the only one left (mirrors `Forbidden`'s own hard exclusion, just
    // expressed as a balance extreme instead of a separate mode).
    let want_other = rng.random_bool(cross_floor_balance);
    let (preferred, fallback): (&[NodeId], Option<&[NodeId]>) = match (want_other, cross_floor_balance) {
        (_, b) if b <= 0.0 => (&same_floor, None),
        (_, b) if b >= 1.0 => (&other_floor, None),
        (true, _) => (&other_floor, Some(&same_floor)),
        (false, _) => (&same_floor, Some(&other_floor)),
    };

    let chosen = if !preferred.is_empty() {
        preferred
    } else {
        fallback.filter(|s| !s.is_empty())?
    };
    Some(chosen[rng.random_range(0..chosen.len())])
}


#[cfg(test)]
#[path = "missing_teleports_tests.rs"]
mod tests;
