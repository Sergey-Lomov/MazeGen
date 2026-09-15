use rand::{Rng, RngCore};
use std::collections::{HashSet, VecDeque};
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::{MissingTeleportIssue, TeleportPairKey};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams, PriorityLevel};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::farthest_reachable::farthest_from;

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

pub const ENTRY_PICK_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ENTRY_PICK,
    label: "Entry pick",
    kind: StrategyParamKind::Enum { options: ENTRY_OPTIONS, default: ENTRY_RANDOM },
};
pub const UNREACHABLE_PRIORITY_PARAM: StrategyParam = StrategyParam {
    id: PARAM_UNREACHABLE_PRIORITY,
    label: "Unreachable area priority",
    kind: StrategyParamKind::Priority { default: PriorityLevel::Indifferent },
};
pub const DESIRED_LENGTH_PARAM: StrategyParam = StrategyParam {
    id: PARAM_DESIRED_LENGTH,
    label: "Desired graph length",
    kind: StrategyParamKind::Interval { default_min: 0.0, default_max: 1000.0, min: 0.0, max: 100_000.0 },
};
pub const ALLOW_OUT_OF_INTERVAL_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ALLOW_OUT_OF_INTERVAL,
    label: "Allow out-of-interval teleport",
    kind: StrategyParamKind::Bool { default: true },
};
pub const ONE_WAY_CHANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ONE_WAY_CHANCE,
    label: "One-way teleport chance",
    kind: StrategyParamKind::Float { default: 50.0, min: 0.0, max: 100.0 },
};
pub const CROSS_FLOOR_MODE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_CROSS_FLOOR_MODE,
    label: "Cross-floor mode",
    kind: StrategyParamKind::Enum { options: CROSS_FLOOR_MODE_OPTIONS, default: CROSS_FLOOR_NATURAL },
};
pub const CROSS_FLOOR_BALANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_CROSS_FLOOR_BALANCE,
    label: "Cross-floor balance",
    kind: StrategyParamKind::Float { default: 0.5, min: 0.0, max: 1.0 },
};

/// 7 creation-only params — no `reserve_percent`/`attempts_limit`/`src_mode`: those belong to the
/// series (`AddTeleportBatchStrategy`), which owns the pool/retry loop this strategy no longer has
/// (GitHub issue #522, part of epic #520).
static PARAMS: [StrategyParam; 7] = [
    ENTRY_PICK_PARAM,
    UNREACHABLE_PRIORITY_PARAM,
    DESIRED_LENGTH_PARAM,
    ALLOW_OUT_OF_INTERVAL_PARAM,
    ONE_WAY_CHANCE_PARAM,
    CROSS_FLOOR_MODE_PARAM,
    CROSS_FLOOR_BALANCE_PARAM,
];

/// Handles `MISSING_TELEPORT` (synthetic, singular — see that issue type's doc comment) by adding
/// exactly one teleport edge starting from `issue.candidate`, one attempt, no retry loop — GitHub
/// issue #522, part of epic #520. Split out of the old monolithic `MissingTeleportsStrategy` (now
/// the series `AddTeleportBatchStrategy`, `missing_teleports.rs`), which owns the pool/reserve/
/// attempts loop and calls this strategy once per attempt via its nested `SLOT_ADD_TELEPORT` slot.
///
/// **Owns `entry_pick` resolution** (GitHub issue #522's explicit ownership decision): the series
/// passes a raw, unresolved `candidate: NodeId` pool pick; this strategy resolves it to the actual
/// entry node itself via `farthest_from_via_nav` when `PARAM_ENTRY_PICK` asks for it. The series
/// never sees the resolved entry — it learns it only by parsing the returned `MutationCommand`s
/// (`logical_teleport_from_commands`).
///
/// All 7 params below are this strategy's own, fully user-configurable even when run as a nested
/// slot (`nested_suppressed_params()` uses the default `&[]` — no compatibility façade on the
/// series' side re-declares or overrides them, GitHub issue #522 design correction: a fixed façade
/// doesn't generalize to a slot whose filler is chosen dynamically among several future candidate
/// strategies). Only `reserve_percent`/`attempts_limit` are dispatcher-owned/inherited.
///
/// Entry's tile-hop graph distance to every other node is computed via plain forward BFS
/// (`bfs_distances`) — deliberately **not** the corridor-compressed `NavGraph` distance
/// `FarthestEndpointsStrategy` uses for its own `farthest_from`/`farthest_to` helpers
/// (`farthest_reachable` module): the issue asks for tile-hop distance for interval matching, so
/// an uncompressed BFS over the raw `Graph` is used here instead, same style as
/// `TeleportRegionMergeStrategy::bfs_distance`.
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
/// respectively with no fallback to the other (an empty restricted set fails the attempt outright,
/// same as `pick_exit` failing outright); `Preferred`/`Discouraged` try one set first and fall back
/// to the other only if it's empty; `Indifferent` (default) merges both sets and picks uniformly
/// at random. If both sets end up unusable, set 1 is tried only when `PARAM_ALLOW_OUT_OF_INTERVAL`
/// is set. This lets the strategy bridge across strongly-connected components (set 3) — a
/// teleport is always oriented `entry -> exit` regardless of which set `exit` came from, so even
/// an exit currently unreachable from entry becomes reachable the instant this very teleport is
/// added.
///
/// If no set yields a `preset_state`-feasible exit, this attempt fails outright (`RepairResult::
/// Failed`, no commands) — retrying with a fresh candidate is the series' job (it evicts the
/// failed candidate from its own pool and tries the next one), not this strategy's.
pub struct AddTeleportStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingTeleportIssue> for AddTeleportStrategy {
    fn strategy_id(&self) -> &'static str { "add_teleport" }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn apply(
        &self,
        issue: &MissingTeleportIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let entry_pick = match params.get(PARAM_ENTRY_PICK) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => ENTRY_RANDOM,
        };
        let unreachable_priority = params.get(PARAM_UNREACHABLE_PRIORITY).and_then(|v| v.as_priority()).unwrap_or(PriorityLevel::Indifferent);
        let (desired_min, desired_max) = params.get(PARAM_DESIRED_LENGTH).and_then(|v| v.as_interval()).unwrap_or((0.0, 1000.0));
        let desired_min = desired_min.max(0.0) as usize;
        let desired_max = desired_max.max(0.0) as usize;
        let allow_out_of_interval = matches!(params.get(PARAM_ALLOW_OUT_OF_INTERVAL), Some(StrategyParamValue::Bool(b)) if *b);
        let one_way_chance = params.get(PARAM_ONE_WAY_CHANCE).and_then(|v| v.as_float()).unwrap_or(50.0);
        let cross_floor_mode = match params.get(PARAM_CROSS_FLOOR_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => CROSS_FLOOR_NATURAL,
        };
        let cross_floor_balance = params.get(PARAM_CROSS_FLOOR_BALANCE).and_then(|v| v.as_float()).unwrap_or(0.5).clamp(0.0, 1.0);

        let entry = match entry_pick {
            ENTRY_FARTHEST_FROM_RANDOM => farthest_from_via_nav(maze, issue.candidate),
            _ => issue.candidate,
        };

        let Some(exit) = pick_exit(
            maze, entry, desired_min, desired_max, allow_out_of_interval,
            unreachable_priority, preset_state, &issue.excluded_pairs, rng,
            cross_floor_mode, cross_floor_balance,
        ) else {
            return (RepairResult::Failed, vec![]);
        };

        let add_reverse = !rng.random_bool((one_way_chance / 100.0).clamp(0.0, 1.0))
            && crate::generation::directed_edge_feasible(preset_state, exit, entry);
        let cmd = if add_reverse {
            MutationCommand::AddBidirectionalTeleport { a: entry, b: exit }
        } else {
            MutationCommand::AddDirectedTeleport { from: entry, to: exit }
        };

        (RepairResult::Fixed { score: None }, vec![cmd])
    }
}

crate::impl_erased_repair_strategy!(AddTeleportStrategy, MissingTeleportIssue);

/// `entry_pick: farthest_from_random`'s own step: hop from a uniformly-picked node to the
/// farthest node forward-reachable from it, via the corridor-compressed `NavGraph` — same
/// helper `FarthestEndpointsStrategy` uses (GitHub issue #212's shared-helper request).
///
/// `from` is usually a corridor-interior node (the candidate pool is every maze node, and those
/// vastly outnumber junction/dead-end nodes), which `NavGraph::nav_node_for` cannot resolve —
/// falling back to `from` itself there would silently skip the farthest-search for the common
/// case. Instead, resolve via `corridor_index` to the nav node the corridor leads into. This is
/// coarse (it's the corridor's destination nav node, not `from`'s own position), but it keeps the
/// search on the nav graph instead of degenerating into a no-op. Note: a true farthest point can
/// still land mid-corridor when loops are present — `farthest_from` only ever considers nav
/// nodes, so that deeper limitation remains unaddressed here.
fn farthest_from_via_nav<T: Tessellation>(maze: &Maze<T>, from: NodeId) -> NodeId {
    let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
    let Some(nav_id) = nav.nav_node_for(from).or_else(|| nav.corridor_index.get(&from).copied()) else {
        return from;
    };
    farthest_from(&nav, nav_id)
}

/// Tile-hop BFS distances from `source` over the raw graph (outgoing edges only) — deliberately
/// not the `NavGraph`, see `AddTeleportStrategy`'s doc comment. `usize::MAX` for any node never
/// visited (unreachable from `source`).
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
    excluded_pairs: &HashSet<TeleportPairKey>,
    rng: &mut dyn RngCore,
    cross_floor_mode: &str,
    cross_floor_balance: f64,
) -> Option<NodeId> {
    let dist = bfs_distances(maze, entry);
    let all_nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
    let entry_level = maze.field.level_of(entry);

    let feasible = |exit: &NodeId| -> bool {
        *exit != entry
            && !excluded_pairs.contains(&TeleportPairKey::Directed(entry, *exit))
            && !excluded_pairs.contains(&bidirectional_key(entry, *exit))
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

/// Canonical bidirectional key for `(a, b)` — matches `TeleportPairKey::bidirectional`'s own
/// ordering (smaller `NodeId` first), so a directed candidate `(entry, exit)` correctly hits an
/// already-excluded bidirectional pair regardless of which side of that pair `entry`/`exit` land on.
fn bidirectional_key(a: NodeId, b: NodeId) -> TeleportPairKey {
    if a <= b { TeleportPairKey::Bidirectional(a, b) } else { TeleportPairKey::Bidirectional(b, a) }
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
#[path = "add_teleport_tests.rs"]
mod tests;
