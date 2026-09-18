use crate::Maze;
use crate::generation::PresetState;
use crate::graph::Graph;
use crate::graph::scc::{ComponentId, ConnectedComponents};
use crate::ids::NodeId;
use crate::quality_control::RegionNeedsExpansionIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategies::region_merge_core::{
    self, MODE_OPTIONS, MODE_RANDOM, PARAM_PREFER_PARTIALLY_CONNECTED, PARAM_TARGET_MODE,
};
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::LevelId;
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::{HashMap, HashSet, VecDeque};

#[cfg(test)]
mod tests;

/// Tracks teleport edges proposed as commands so far this `apply()` call, alongside the real
/// graph — read-only stand-in for what an earlier region's real mutation would have made
/// observable via `outgoing_neighbors`/`incoming_neighbors` under the old in-place contract
/// (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot contract; "single fixed snapshot
/// for the whole call" decision, same as `ExpandRegionPassageStrategy`).
#[derive(Default)]
struct PendingTeleports {
    /// Directed pairs proposed so far (either direction of a two_way, or one_way's own pair).
    added: HashSet<(NodeId, NodeId)>,
    commands: Vec<MutationCommand>,
}

impl PendingTeleports {
    /// Every proposed-so-far outgoing pair from `node`, alongside the real graph's own.
    fn outgoing_from(&self, node: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        self.added
            .iter()
            .filter(move |&&(from, _)| from == node)
            .map(|&(_, to)| to)
    }

    /// Every proposed-so-far incoming pair into `node`, alongside the real graph's own.
    fn incoming_to(&self, node: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        self.added
            .iter()
            .filter(move |&&(_, to)| to == node)
            .map(|&(from, _)| from)
    }

    fn add_directed(&mut self, from: NodeId, to: NodeId) {
        self.added.insert((from, to));
        self.commands
            .push(MutationCommand::AddDirectedTeleport { from, to });
    }

    fn add_bidirectional(&mut self, a: NodeId, b: NodeId) {
        self.added.insert((a, b));
        self.added.insert((b, a));
        self.commands
            .push(MutationCommand::AddBidirectionalTeleport { a, b });
    }
}

pub const PARAM_DIRECTION_MODE: &str = "direction_mode";
pub const PARAM_MIN_DISTANCE: &str = "min_distance";
pub const PARAM_ALLOW_CROSS_FLOOR: &str = "allow_cross_floor";

pub const DIRECTION_TWO_WAY: &str = "two_way";
pub const DIRECTION_ONE_WAY: &str = "one_way";

static DIRECTION_OPTIONS: &[&str] = &[DIRECTION_TWO_WAY, DIRECTION_ONE_WAY];

/// Random-pick-with-retry attempts before falling back to the deterministic max-distance pick —
/// a circuit breaker against a pathological region where random sampling keeps missing
/// `min_distance`, not a tunable algorithm parameter.
const MAX_DISTANCE_PICK_ATTEMPTS: usize = 8;

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_TARGET_MODE,
        label: "Target selection mode",
        kind: StrategyParamKind::Enum {
            options: MODE_OPTIONS,
            default: MODE_RANDOM,
        },
    },
    StrategyParam {
        id: PARAM_DIRECTION_MODE,
        label: "Teleport direction mode",
        kind: StrategyParamKind::Enum {
            options: DIRECTION_OPTIONS,
            default: DIRECTION_TWO_WAY,
        },
    },
    StrategyParam {
        id: PARAM_PREFER_PARTIALLY_CONNECTED,
        label: "Prefer partially connected neighbors",
        kind: StrategyParamKind::Bool { default: true },
    },
    StrategyParam {
        id: PARAM_MIN_DISTANCE,
        label: "Minimum logical distance between teleport endpoints",
        kind: StrategyParamKind::Float {
            default: 1.0,
            min: 0.0,
            max: 1000.0,
        },
    },
    StrategyParam {
        id: PARAM_ALLOW_CROSS_FLOOR,
        label: "Allow merging with regions on another floor",
        kind: StrategyParamKind::Bool { default: true },
    },
];

/// Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #89. Merges each flagged undersized SCC
/// region into a neighboring region via a teleport edge instead of a geometric passage —
/// teleport endpoints don't need to be geometrically adjacent, so **any** node pair across the
/// two regions is a valid candidate (no `field.neighbors` adjacency requirement at all, unlike
/// `ExpandRegionPassageStrategy`).
///
/// Shares target-selection (`target_mode`/`prefer_partially_connected`) and merge-loop bookkeeping
/// with `ExpandRegionPassageStrategy` via `region_merge_core` — only candidate discovery (any
/// node pair vs geometric neighbors) and the actual connection (`Teleport` edges vs `Basic`) are
/// strategy-specific.
///
/// **`issue.data` is mandatory for this kind**: `invalid` (which `scc().components` indices
/// are undersized) is the producing check's result — there's no other channel to learn it.
pub struct TeleportRegionMergeStrategy;

impl<T: Tessellation> RepairStrategy<T, RegionNeedsExpansionIssue> for TeleportRegionMergeStrategy {
    fn strategy_id(&self) -> &'static str {
        "teleport_region_merge"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &RegionNeedsExpansionIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let invalid = &issue.invalid;
        if invalid.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let mode = match params.get(PARAM_TARGET_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => MODE_RANDOM,
        };
        let direction_mode = match params.get(PARAM_DIRECTION_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => DIRECTION_TWO_WAY,
        };
        let prefer_partial = match params.get(PARAM_PREFER_PARTIALLY_CONNECTED) {
            Some(StrategyParamValue::Bool(b)) => *b,
            _ => false,
        };
        let min_distance = match params.get(PARAM_MIN_DISTANCE) {
            Some(StrategyParamValue::Float(f)) => (*f).round().max(0.0) as usize,
            _ => 0,
        };
        let allow_cross_floor = match params.get(PARAM_ALLOW_CROSS_FLOOR) {
            Some(StrategyParamValue::Bool(b)) => *b,
            _ => true,
        };

        // One fixed snapshot for the whole apply() call — see Specs/repair.md's decision for
        // this strategy (same rationale as ExpandRegionPassageStrategy): `scc` read once, not
        // re-derived mid-call.
        let scc = maze.analysis.scc(&maze.graph);
        let mut pending = PendingTeleports::default();

        let any_fixed = region_merge_core::run_merge_loop(invalid, |region_idx, needy| {
            let region = scc.components.get(region_idx)?;
            find_merge_candidate(
                region,
                region_idx,
                &scc,
                maze,
                preset_state,
                mode,
                direction_mode,
                prefer_partial,
                min_distance,
                allow_cross_floor,
                needy,
                rng,
                &mut pending,
            )
        });

        if any_fixed {
            (RepairResult::Fixed { score: None }, pending.commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(TeleportRegionMergeStrategy, RegionNeedsExpansionIssue);

/// The subset of `nodes` whose floor is in `levels` — used to keep freshly-picked teleport
/// endpoints on the flagged region's own floor(s) when `allow_cross_floor` is off.
fn filter_nodes_on_levels<T: Tessellation>(
    field: &crate::space::MultiLevelField<T>,
    nodes: &[NodeId],
    levels: &HashSet<LevelId>,
) -> Vec<NodeId> {
    nodes
        .iter()
        .copied()
        .filter(|&n| field.level_of(n).is_some_and(|l| levels.contains(&l)))
        .collect()
}

/// Existing directed-edge state (any `EdgeKind`) between `region` and one other component —
/// unlike `ExpandRegionPassageStrategy`'s `NeighborInfo`, no bridging cell pairs are enumerated
/// ahead of time (teleport endpoints aren't geometrically constrained, so a specific pair of
/// nodes is only picked once a neighbor has actually been chosen). Tracks one representative
/// endpoint node per existing direction, per side, so a fresh endpoint can be picked away from it
/// (`min_distance`) rather than just knowing a direction exists.
struct NeighborInfo {
    /// `(region_node, neighbor_node)` of one existing `region -> neighbor` edge, if any.
    outbound: Option<(NodeId, NodeId)>,
    /// `(neighbor_node, region_node)` of one existing `neighbor -> region` edge, if any.
    inbound: Option<(NodeId, NodeId)>,
}

impl NeighborInfo {
    fn empty() -> Self {
        NeighborInfo {
            outbound: None,
            inbound: None,
        }
    }
}

/// Scans only `region`'s own nodes' incident edges — `O(region_size * avg_degree)` rather than
/// `O(E)` over the whole graph, since `region` is tiny (undersized by definition) while the graph
/// as a whole (and any one neighboring component) can be the bulk of the maze. This runs once per
/// region per `run_merge_loop` iteration, so keeping it scoped to the region avoids a full-graph
/// rescan on every one of potentially many flagged regions. Keeps the first edge found per
/// direction as the representative endpoint (deterministic given `outgoing_neighbors`/
/// `incoming_neighbors`'s stable iteration order).
fn collect_neighbors(
    region: &[NodeId],
    region_idx: ComponentId,
    scc: &ConnectedComponents,
    graph: &Graph,
    pending: &PendingTeleports,
) -> HashMap<ComponentId, NeighborInfo> {
    let mut by_neighbor: HashMap<ComponentId, NeighborInfo> = HashMap::new();
    for &node in region {
        for other in graph
            .outgoing_neighbors(node)
            .chain(pending.outgoing_from(node))
        {
            let Some(other_idx) = scc.component_of(other) else {
                continue;
            };
            if other_idx == region_idx {
                continue;
            }
            let entry = by_neighbor
                .entry(other_idx)
                .or_insert_with(NeighborInfo::empty);
            entry.outbound.get_or_insert((node, other));
        }
        for other in graph
            .incoming_neighbors(node)
            .chain(pending.incoming_to(node))
        {
            let Some(other_idx) = scc.component_of(other) else {
                continue;
            };
            if other_idx == region_idx {
                continue;
            }
            let entry = by_neighbor
                .entry(other_idx)
                .or_insert_with(NeighborInfo::empty);
            entry.inbound.get_or_insert((other, node));
        }
    }
    // Every other component is a valid teleport candidate even with zero existing edges —
    // ensure it's present in the map so target-selection sees it.
    for idx in 0..scc.components.len() {
        if idx != region_idx {
            by_neighbor.entry(idx).or_insert_with(NeighborInfo::empty);
        }
    }
    by_neighbor
}

/// Finds a neighboring component to merge `region` into and applies the teleport connection.
/// Returns `Some((neighbor_idx, true))` on success, `Some((neighbor_idx, false))` if the chosen
/// candidate couldn't be bridged (e.g. `min_distance` unsatisfiable and no fallback available),
/// `None` if there is no other component at all (single-component maze).
#[allow(clippy::too_many_arguments)]
fn find_merge_candidate<T: Tessellation>(
    region: &[NodeId],
    region_idx: ComponentId,
    scc: &ConnectedComponents,
    maze: &Maze<T>,
    preset_state: &PresetState,
    mode: &str,
    direction_mode: &str,
    prefer_partial: bool,
    min_distance: usize,
    allow_cross_floor: bool,
    needy: &HashSet<ComponentId>,
    rng: &mut dyn RngCore,
    pending: &mut PendingTeleports,
) -> Option<(ComponentId, bool)> {
    let by_neighbor = collect_neighbors(region, region_idx, scc, &maze.graph, pending);
    if by_neighbor.is_empty() {
        return None;
    }

    let mut keys: Vec<ComponentId> = by_neighbor.keys().copied().collect();
    keys.sort_unstable();

    // `allow_cross_floor == false` (GitHub issue #472): drop every candidate component that
    // shares no floor with the flagged region, so a teleport merge stays within one floor.
    // A region flagged as an undersized SCC is single-floor in practice, but its full level
    // set is used rather than assuming that. Below, freshly-picked endpoints on both sides are
    // also restricted to the region's floor set (`region_levels`) — filtering the candidate
    // components alone would still allow a cross-floor pair when the chosen neighbor spans
    // several floors.
    let region_levels: Option<HashSet<LevelId>> = (!allow_cross_floor).then(|| {
        region
            .iter()
            .filter_map(|&n| maze.field.level_of(n))
            .collect()
    });
    if let Some(region_levels) = &region_levels {
        keys.retain(|&idx| {
            scc.components[idx].iter().any(|&n| {
                maze.field
                    .level_of(n)
                    .is_some_and(|l| region_levels.contains(&l))
            })
        });
        if keys.is_empty() {
            return None;
        }
    }

    let partial: Vec<ComponentId> = keys
        .iter()
        .copied()
        .filter(|i| {
            let info = &by_neighbor[i];
            info.outbound.is_some() != info.inbound.is_some()
        })
        .collect();
    let pool = region_merge_core::narrow_to_partial(&keys, &partial, prefer_partial);

    let chosen = region_merge_core::pick_by_mode(pool, scc, mode, needy, rng)?;
    let info = &by_neighbor[&chosen];
    let neighbor = &scc.components[chosen];

    // When cross-floor merges are forbidden, restrict fresh endpoint picks on both sides to the
    // region's floor set. `region` is single-floor in practice so its filtered form is the same
    // slice; `neighbor` can legitimately span floors, and only its on-floor nodes are eligible.
    let (region_on_floor, neighbor_on_floor);
    let (region_pool, neighbor_pool): (&[NodeId], &[NodeId]) = match &region_levels {
        Some(levels) => {
            region_on_floor = filter_nodes_on_levels(&maze.field, region, levels);
            neighbor_on_floor = filter_nodes_on_levels(&maze.field, neighbor, levels);
            (&region_on_floor, &neighbor_on_floor)
        }
        None => (region, neighbor),
    };

    let applied = apply_teleport(
        maze,
        region_pool,
        neighbor_pool,
        info,
        direction_mode,
        min_distance,
        preset_state,
        rng,
        pending,
    );

    Some((chosen, applied))
}

/// Applies the teleport connection to a chosen neighbor. Merging requires the region to end up
/// strongly connected to its neighbor, so **both** directions always end up covered one way or
/// another (a single directed edge is never enough) — `direction_mode` only decides the
/// *mechanism*:
///
/// - `two_way`: both directions share **one** node pair `(a, b)` — a matched two-way teleport,
///   same shape as a preset `TeleportDirection::TwoWay` connection. If there's no existing edge
///   between `region` and `neighbor` at all, `(a, b)` is picked completely at random, with no
///   `min_distance` filtering — there is no other occupied pair to keep away from yet. If a
///   partial connection already exists (`outbound` and/or `inbound` in `info`, any edge kind),
///   the new pair is instead chosen to be `>= min_distance` away from the existing occupied
///   node(s), independently in each region (region-side away from the existing region-side node,
///   neighbor-side away from the existing neighbor-side node).
/// - `one_way`: each direction gets its **own**, distinct node pair — never the same pair for
///   both (that would just be a `two_way` teleport in disguise). Whichever pair(s) still need
///   picking are chosen `>= min_distance` away from whatever pair(s) are already occupied
///   (existing edges and/or a pair just picked earlier in this same call), independently within
///   each region.
///
/// Every fresh pick retries randomly up to `MAX_DISTANCE_PICK_ATTEMPTS` times before falling back
/// to the sampled candidate that best satisfies the distance requirement — see
/// `pick_node_away_from`. Returns `false` (no mutation attempted beyond whatever succeeded) if
/// either region turns out empty (defensive; SCC components are never empty by construction).
#[allow(clippy::too_many_arguments)]
fn apply_teleport<T: Tessellation>(
    maze: &Maze<T>,
    region: &[NodeId],
    neighbor: &[NodeId],
    info: &NeighborInfo,
    direction_mode: &str,
    min_distance: usize,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
    pending: &mut PendingTeleports,
) -> bool {
    if info.outbound.is_some() && info.inbound.is_some() {
        return true; // already connected both ways -- nothing more required
    }

    match direction_mode {
        DIRECTION_ONE_WAY => {
            let pairs = match (info.outbound, info.inbound) {
                (Some(existing_out), None) => {
                    // Only the inbound direction is missing -- pick its pair away from the
                    // existing outbound pair, independently in each region.
                    let Some(region_node) =
                        pick_node_away_from(&maze.graph, region, existing_out.0, min_distance, rng)
                    else {
                        return false;
                    };
                    let Some(neighbor_node) = pick_node_away_from(
                        &maze.graph,
                        neighbor,
                        existing_out.1,
                        min_distance,
                        rng,
                    ) else {
                        return false;
                    };
                    (None, Some((neighbor_node, region_node)))
                }
                (None, Some(existing_in)) => {
                    let Some(region_node) =
                        pick_node_away_from(&maze.graph, region, existing_in.1, min_distance, rng)
                    else {
                        return false;
                    };
                    let Some(neighbor_node) = pick_node_away_from(
                        &maze.graph,
                        neighbor,
                        existing_in.0,
                        min_distance,
                        rng,
                    ) else {
                        return false;
                    };
                    (Some((region_node, neighbor_node)), None)
                }
                (None, None) => {
                    // Neither exists -- both directions needed, through two distinct pairs, each
                    // one away from the other (there's nothing else occupied yet).
                    if region.is_empty() || neighbor.is_empty() {
                        return false;
                    }
                    let out_region_node = region[rng.random_range(0..region.len())];
                    let out_neighbor_node = neighbor[rng.random_range(0..neighbor.len())];
                    let Some(in_region_node) = pick_node_away_from(
                        &maze.graph,
                        region,
                        out_region_node,
                        min_distance,
                        rng,
                    ) else {
                        return false;
                    };
                    let Some(in_neighbor_node) = pick_node_away_from(
                        &maze.graph,
                        neighbor,
                        out_neighbor_node,
                        min_distance,
                        rng,
                    ) else {
                        return false;
                    };
                    (
                        Some((out_region_node, out_neighbor_node)),
                        Some((in_neighbor_node, in_region_node)),
                    )
                }
                (Some(_), Some(_)) => {
                    unreachable!("both-directions-present case already returned above")
                }
            };
            let (out_pair, in_pair) = pairs;
            let out_blocked = out_pair
                .map(|(a, b)| !crate::generation::directed_edge_feasible(preset_state, a, b))
                .unwrap_or(false);
            let in_blocked = in_pair
                .map(|(a, b)| !crate::generation::directed_edge_feasible(preset_state, a, b))
                .unwrap_or(false);
            if out_blocked || in_blocked {
                return false;
            }
            if let Some((a, b)) = out_pair {
                pending.add_directed(a, b);
            }
            if let Some((a, b)) = in_pair {
                pending.add_directed(a, b);
            }
            true
        }
        _ => {
            // two_way: one shared pair for both directions.
            if region.is_empty() || neighbor.is_empty() {
                return false;
            }
            let (a, b) = match (info.outbound, info.inbound) {
                (None, None) => (
                    region[rng.random_range(0..region.len())],
                    neighbor[rng.random_range(0..neighbor.len())],
                ),
                // `unwrap_or(ra)`/`unwrap_or(na)`: `pick_node_away_from` only returns `None` for
                // an empty candidate list, which never happens here (`region`/`neighbor` are
                // real SCC components, never empty) -- the fallback is unreachable in practice,
                // kept only so this call site doesn't need its own separate empty-region guard.
                (Some((ra, na)), _) => (
                    pick_node_away_from(&maze.graph, region, ra, min_distance, rng).unwrap_or(ra),
                    pick_node_away_from(&maze.graph, neighbor, na, min_distance, rng).unwrap_or(na),
                ),
                (None, Some((na, ra))) => (
                    pick_node_away_from(&maze.graph, region, ra, min_distance, rng).unwrap_or(ra),
                    pick_node_away_from(&maze.graph, neighbor, na, min_distance, rng).unwrap_or(na),
                ),
            };
            if !crate::generation::bidirectional_edge_feasible(preset_state, a, b) {
                return false;
            }
            pending.add_bidirectional(a, b);
            true
        }
    }
}

/// Picks a node from `candidates`, uniformly at random, retried up to
/// `MAX_DISTANCE_PICK_ATTEMPTS` times until its `bfs_min_distance` (directed BFS, both ways,
/// shorter one wins) to `away_from` is `>= min_distance`. `min_distance == 0` always succeeds on
/// the first attempt. If every attempt fails, falls back to whichever sampled candidate maximizes
/// that distance. `None` only if `candidates` is empty — never happens for a real SCC component
/// (`region`/`neighbor` in every call site here), since an SCC is never empty by construction;
/// callers still handle `None` explicitly rather than assuming it can't occur.
fn pick_node_away_from(
    graph: &Graph,
    candidates: &[NodeId],
    away_from: NodeId,
    min_distance: usize,
    rng: &mut dyn RngCore,
) -> Option<NodeId> {
    if candidates.is_empty() {
        return None;
    }
    let mut best: Option<(NodeId, usize)> = None;
    for _ in 0..MAX_DISTANCE_PICK_ATTEMPTS {
        let candidate = candidates[rng.random_range(0..candidates.len())];
        let dist = bfs_min_distance(graph, candidate, away_from);
        if dist >= min_distance {
            return Some(candidate);
        }
        if best.as_ref().map(|(_, bd)| dist > *bd).unwrap_or(true) {
            best = Some((candidate, dist));
        }
    }
    best.map(|(candidate, _)| candidate)
}

/// `min(dist(a -> b), dist(b -> a))` — directed BFS hop count in each direction within `graph`,
/// per the Determinism Contract question resolved for this strategy: a region's two directions
/// can have different lengths, so the metric takes whichever is shorter. `usize::MAX` if either
/// direction is unreachable (shouldn't happen for two nodes in the same SCC, but defensive).
fn bfs_min_distance(graph: &Graph, a: NodeId, b: NodeId) -> usize {
    let fwd = bfs_distance(graph, a, b);
    let bwd = bfs_distance(graph, b, a);
    fwd.min(bwd)
}

fn bfs_distance(graph: &Graph, from: NodeId, to: NodeId) -> usize {
    if from == to {
        return 0;
    }
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut queue: VecDeque<(NodeId, usize)> = VecDeque::new();
    visited.insert(from);
    queue.push_back((from, 0));
    while let Some((node, dist)) = queue.pop_front() {
        for next in graph.outgoing_neighbors(node) {
            if next == to {
                return dist + 1;
            }
            if visited.insert(next) {
                queue.push_back((next, dist + 1));
            }
        }
    }
    usize::MAX
}
