use rand::{Rng, RngCore};
use std::collections::{HashMap, HashSet};
use crate::Maze;
use crate::ids::NodeId;
use crate::graph::scc::ComponentId;
use crate::space::Tessellation;
use crate::quality_control::RegionNeedsExpansionIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use crate::repair::strategies::region_merge_core::{
    self, PARAM_TARGET_MODE, PARAM_PREFER_PARTIALLY_CONNECTED, MODE_OPTIONS, MODE_RANDOM,
};
use crate::graph::scc::ConnectedComponents;

#[cfg(test)]
mod tests;

/// Tracks vertical-passage edges proposed as commands so far this `apply()` call, alongside the
/// real graph — mirrors `expand_region_passage::PendingEdges` exactly, just for
/// `VerticalPassage`-kind edges instead of `Basic` (GitHub issue #118, `Specs/repair.md`'s
/// immutable-snapshot contract; "single fixed snapshot for the whole call" decision, same as
/// `ExpandRegionPassageStrategy`).
#[derive(Default)]
struct PendingEdges {
    added: HashSet<(NodeId, NodeId)>,
    commands: Vec<MutationCommand>,
}

impl PendingEdges {
    fn has_edge<T: Tessellation>(&self, maze: &Maze<T>, from: NodeId, to: NodeId) -> bool {
        maze.graph.edge_between(from, to).is_some() || self.added.contains(&(from, to))
    }

    fn add_directed(&mut self, from: NodeId, to: NodeId) {
        self.added.insert((from, to));
        self.commands.push(MutationCommand::AddDirectedVerticalPassage { from, to });
    }

    fn add_bidirectional(&mut self, a: NodeId, b: NodeId) {
        self.added.insert((a, b));
        self.added.insert((b, a));
        self.commands.push(MutationCommand::AddBidirectionalVerticalPassage { a, b });
    }
}

pub const PARAM_CONNECTION_MODE: &str = "connection_mode";
pub const PARAM_DIRECTION_BALANCE: &str = "direction_balance";

pub const CONNECTION_PASSAGE: &str = "passage";
pub const CONNECTION_ONE_WAY: &str = "one_way";

static CONNECTION_OPTIONS: &[&str] = &[CONNECTION_PASSAGE, CONNECTION_ONE_WAY];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_TARGET_MODE,
        label: "Target selection mode",
        kind: StrategyParamKind::Enum { options: MODE_OPTIONS, default: MODE_RANDOM },
    },
    StrategyParam {
        id: PARAM_CONNECTION_MODE,
        label: "Connection mode",
        kind: StrategyParamKind::Enum { options: CONNECTION_OPTIONS, default: CONNECTION_PASSAGE },
    },
    StrategyParam {
        id: PARAM_PREFER_PARTIALLY_CONNECTED,
        label: "Prefer partially connected neighbors",
        kind: StrategyParamKind::Bool { default: true },
    },
    StrategyParam {
        id: PARAM_DIRECTION_BALANCE,
        label: "Direction balance",
        kind: StrategyParamKind::Float { default: 0.5, min: 0.0, max: 1.0 },
    },
];

/// Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #391. Merges each flagged undersized SCC
/// region into a neighboring region via a `VerticalPassage` edge, either a full bidirectional
/// passage or a pair of one-way edges (`connection_mode`) — same two-mode shape as
/// `ExpandRegionPassageStrategy`, mirrored exactly, just with vertical (cross-floor) adjacency
/// instead of geometric (`field.neighbors`) adjacency: a region's node is only a candidate
/// bridge if the same point exists one floor up and/or down.
///
/// Unlike geometric adjacency (fixed per node), a vertical bridge exists in up to two
/// directions per node — discovery therefore checks **both** up and down for every region node
/// deterministically (no `rng`), so an already-partially-connected neighbor floor is always
/// found regardless of which direction a brand new edge would eventually pick.
/// `direction_balance` comes into play once, as a tie-break in `find_merge_candidate`: if the
/// (possibly `prefer_partially_connected`-narrowed) candidate pool has neighbor components on
/// both sides, one roll picks which side `target_mode` then chooses among.
///
/// **`issue.data` is mandatory for this kind**: `invalid` (which `scc().components` indices are
/// undersized) is the producing check's result — there's no other channel to learn it.
pub struct VerticalPassageRegionMergeStrategy;

impl<T: Tessellation> RepairStrategy<T, RegionNeedsExpansionIssue> for VerticalPassageRegionMergeStrategy {
    fn strategy_id(&self) -> &'static str { "vertical_passage_region_merge" }

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
        let connection_mode = match params.get(PARAM_CONNECTION_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => CONNECTION_PASSAGE,
        };
        let prefer_partial = match params.get(PARAM_PREFER_PARTIALLY_CONNECTED) {
            Some(StrategyParamValue::Bool(b)) => *b,
            _ => false,
        };
        let direction_balance = params.get(PARAM_DIRECTION_BALANCE).and_then(|v| v.as_float()).unwrap_or(0.5);

        // One fixed snapshot for the whole apply() call — see Specs/repair.md's decision for
        // this strategy (same rationale as ExpandRegionPassageStrategy): `scc` read once, not
        // re-derived mid-call.
        let scc = maze.analysis.scc(&maze.graph);
        let mut pending = PendingEdges::default();

        let any_fixed = region_merge_core::run_merge_loop(invalid, |region_idx, needy| {
            let region = scc.components.get(region_idx)?;
            find_merge_candidate(
                region, region_idx, &scc, maze, preset_state, mode, connection_mode, prefer_partial,
                direction_balance, needy, rng, &mut pending,
            )
        });

        if any_fixed {
            (RepairResult::Fixed { score: None }, pending.commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(VerticalPassageRegionMergeStrategy, RegionNeedsExpansionIssue);

/// Existing directed-edge state between `region` and one neighboring component (reachable via a
/// `VerticalPassage`), plus every vertical bridging cell pair found between them (needed for
/// one_way mode's max-separation placement) — mirrors `expand_region_passage::NeighborInfo`
/// exactly, just for vertical pairs instead of geometric ones.
struct NeighborInfo {
    pairs: Vec<(NodeId, NodeId)>,
    has_outbound: bool, // region -> neighbor edge already exists (via some pair)
    has_inbound: bool,  // neighbor -> region edge already exists (via some pair)
    direction: Direction, // which floor this neighbor component is on, relative to region
}

/// Which floor direction a discovered bridging pair goes, relative to the region's node.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction { Up, Down }

/// Resolves the node at `src`'s own point one floor `direction`-ward, if that floor exists and
/// has a node at the same point. Unlike `vertical_target::resolve_vertical_target`, this never
/// rolls `rng` — it's a direct, deterministic lookup of one specific direction, used so both
/// directions can be checked independently during discovery.
fn adjacent_floor_node<T: Tessellation>(maze: &Maze<T>, src: NodeId, direction: Direction) -> Option<NodeId> {
    let point = maze.field.point_of(src)?;
    let src_level = maze.field.level_of(src)?;
    let levels: Vec<_> = maze.field.levels_ordered().collect();
    let idx = levels.iter().position(|&l| l == src_level)?;
    let target_level = match direction {
        Direction::Up => levels.get(idx + 1).copied()?,
        Direction::Down => idx.checked_sub(1).and_then(|i| levels.get(i).copied())?,
    };
    maze.field.node_at(target_level, point)
}

/// Scans `region`'s vertical neighbors, yielding every bridging cell pair `(region_node,
/// neighbor_node, neighbor_component_id, direction)` that isn't in `region`'s own component and
/// isn't preset-blocked (`pair_connectable`). Deterministic — checks **both** up and down for
/// every region node (never rolls `rng`), so an already-partially-connected neighbor floor is
/// always discovered regardless of which direction a brand new edge would eventually pick.
fn scan_neighbor_pairs<T: Tessellation>(
    region: &[NodeId],
    region_idx: ComponentId,
    scc: &ConnectedComponents,
    maze: &Maze<T>,
    preset_state: &PresetState,
) -> Vec<(NodeId, NodeId, ComponentId, Direction)> {
    let mut found = Vec::new();
    for &node in region {
        for direction in [Direction::Up, Direction::Down] {
            let Some(to) = adjacent_floor_node(maze, node, direction) else { continue };
            let Some(neighbor_idx) = scc.component_of(to) else { continue };
            if neighbor_idx == region_idx {
                continue;
            }
            if !pair_connectable(node, to, preset_state) {
                continue;
            }
            found.push((node, to, neighbor_idx, direction));
        }
    }
    found
}

/// Collects, per neighboring component reachable via a vertical bridge, every bridging cell pair
/// `(region_node, neighbor_node)` and whether a directed edge already exists in either direction
/// (via any pair) — mirrors `expand_region_passage::collect_neighbors`. Discovery is
/// deterministic (see `scan_neighbor_pairs`); every neighbor component reachable from `region` in
/// either direction is found, not just whichever direction a fresh `rng` roll would have picked.
fn collect_neighbors<T: Tessellation>(
    region: &[NodeId],
    region_idx: ComponentId,
    scc: &ConnectedComponents,
    maze: &Maze<T>,
    preset_state: &PresetState,
    pending: &PendingEdges,
) -> HashMap<ComponentId, NeighborInfo> {
    let mut by_neighbor: HashMap<ComponentId, NeighborInfo> = HashMap::new();

    let found = scan_neighbor_pairs(region, region_idx, scc, maze, preset_state);
    for (node, neighbor_node, neighbor_idx, direction) in found {
        let entry = by_neighbor.entry(neighbor_idx).or_insert_with(|| NeighborInfo {
            pairs: Vec::new(),
            has_outbound: false,
            has_inbound: false,
            direction,
        });
        entry.pairs.push((node, neighbor_node));
        if pending.has_edge(maze, node, neighbor_node) {
            entry.has_outbound = true;
        }
        if pending.has_edge(maze, neighbor_node, node) {
            entry.has_inbound = true;
        }
    }

    by_neighbor
}

/// Finds a neighboring component to merge `region` into (via a vertical passage) and applies the
/// connection according to `connection_mode`. Returns `Some((neighbor_idx, true))` on a
/// successful merge, `Some((neighbor_idx, false))` if the chosen candidate couldn't be fully
/// bridged, and `None` if `region` has no eligible vertical neighbor at all. Mirrors
/// `expand_region_passage::find_merge_candidate`, with one extra selection step ahead of
/// `target_mode`: if the (possibly `prefer_partial`-narrowed) pool contains candidates from both
/// directions, `direction_balance` rolls once to pick which direction's candidates `target_mode`
/// then chooses among — geometric adjacency has no such ambiguity (a node has only one set of
/// neighbors), but a vertical region can simultaneously have distinct up and down neighbor
/// components.
#[allow(clippy::too_many_arguments)]
fn find_merge_candidate<T: Tessellation>(
    region: &[NodeId],
    region_idx: ComponentId,
    scc: &ConnectedComponents,
    maze: &Maze<T>,
    preset_state: &PresetState,
    mode: &str,
    connection_mode: &str,
    prefer_partial: bool,
    direction_balance: f64,
    needy: &HashSet<ComponentId>,
    rng: &mut dyn RngCore,
    pending: &mut PendingEdges,
) -> Option<(ComponentId, bool)> {
    let by_neighbor = collect_neighbors(region, region_idx, scc, maze, preset_state, pending);
    if by_neighbor.is_empty() {
        return None;
    }

    // `HashMap` iteration order is randomized per-process — sort once here so tie-breaking
    // and rng-indexed picks stay reproducible across runs for the same seed.
    let mut keys: Vec<ComponentId> = by_neighbor.keys().copied().collect();
    keys.sort_unstable();

    // First priority level (only relevant to `one_way`, where a partial connection is
    // meaningful): partially-connected neighbors, if any and requested.
    let partial: Vec<ComponentId> = keys.iter().copied()
        .filter(|i| {
            let info = &by_neighbor[i];
            info.has_outbound != info.has_inbound // exactly one direction present
        })
        .collect();
    let pool = region_merge_core::narrow_to_partial(&keys, &partial, prefer_partial);

    // Second priority level: if the pool has candidates from both up and down, roll once via
    // direction_balance to settle on a single direction before target_mode picks among it.
    let up: Vec<ComponentId> = pool.iter().copied().filter(|i| by_neighbor[i].direction == Direction::Up).collect();
    let down: Vec<ComponentId> = pool.iter().copied().filter(|i| by_neighbor[i].direction == Direction::Down).collect();
    let direction_pool: &[ComponentId] = match (up.is_empty(), down.is_empty()) {
        (false, false) => if rng.random_bool(direction_balance.clamp(0.0, 1.0)) { &up } else { &down },
        (false, true) => &up,
        (true, false) => &down,
        (true, true) => pool, // unreachable: pool is non-empty and every entry is Up or Down
    };

    let chosen = region_merge_core::pick_by_mode(direction_pool, scc, mode, needy, rng)?;
    let info = &by_neighbor[&chosen];

    let applied = match connection_mode {
        CONNECTION_ONE_WAY => apply_one_way(maze, info, preset_state, rng, pending),
        _ => {
            // Every bridging pair is an equally valid passage placement (unlike geometric
            // adjacency, where a region typically has just one cell touching a given neighbor) —
            // picking a fixed index here would always bridge through the same cell whenever a
            // region spans a whole floor, regardless of seed. Picked uniformly via `rng` instead.
            let idx = rng.random_range(0..info.pairs.len());
            let (src, dst) = info.pairs[idx];
            let can_add = pair_connectable(src, dst, preset_state);
            if can_add {
                pending.add_bidirectional(src, dst);
            }
            can_add
        }
    };

    Some((chosen, applied))
}

/// Applies the `one_way` connection mode to a chosen neighbor: ensures both a `region ->
/// neighbor` and a `neighbor -> region` directed vertical-passage edge exist, each through its
/// own bridging cell pair (never the same pair for both directions).
///
/// Unlike `expand_region_passage::apply_one_way`, bridging-pair placement is **not**
/// farthest-apart-first: for a region on one floor (the common case — an entire floor is often
/// one SCC component), every point on that floor sits at the same relative offset from its
/// same-point neighbor above/below, so "maximize distance from the reference node(s)" always
/// converges on the same corner cells (typically the two diagonally-opposite ones) regardless of
/// seed — the metric has no floor-specific texture to break the tie with. A uniformly random
/// pick among the remaining candidates avoids that determinism instead.
fn apply_one_way<T: Tessellation>(
    maze: &Maze<T>,
    info: &NeighborInfo,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
    pending: &mut PendingEdges,
) -> bool {
    if info.has_outbound && info.has_inbound {
        return true; // already fully connected both ways
    }

    if info.has_outbound || info.has_inbound {
        // Partial: only need the missing direction, via a pair distinct from every pair
        // already carrying the existing edge.
        let existing_pairs: Vec<(NodeId, NodeId)> = info.pairs.iter().copied()
            .filter(|&(a, b)| {
                if info.has_outbound { pending.has_edge(maze, a, b) }
                else { pending.has_edge(maze, b, a) }
            })
            .collect();
        if existing_pairs.is_empty() {
            return false;
        }

        let remaining: Vec<(NodeId, NodeId)> = info.pairs.iter().copied()
            .filter(|p| !existing_pairs.contains(p))
            .collect();
        if remaining.is_empty() {
            return false;
        }
        let (a, b) = remaining[rng.random_range(0..remaining.len())];

        let (from, to) = if info.has_outbound { (b, a) } else { (a, b) };
        if pair_edge_blocked(from, to, preset_state) {
            return false;
        }
        pending.add_directed(from, to);
        true
    } else {
        // Neither direction exists: pick two distinct pairs uniformly at random.
        if info.pairs.len() < 2 {
            return false;
        }
        let first = rng.random_range(0..info.pairs.len());
        let mut second = rng.random_range(0..info.pairs.len() - 1);
        if second >= first {
            second += 1;
        }
        let (a1, b1) = info.pairs[first];
        let (a2, b2) = info.pairs[second];
        // All-or-nothing: `one_way` means two independently-cut directions, not "whichever one
        // happened to succeed" — checked as pure feasibility (never mutates) before proposing
        // either command.
        let out_ok = !pair_edge_blocked(a1, b1, preset_state);
        let in_ok = !pair_edge_blocked(b2, a2, preset_state);
        if out_ok && in_ok {
            pending.add_directed(a1, b1);
            pending.add_directed(b2, a2);
        }
        out_ok && in_ok
    }
}

/// Whether adding a single directed vertical-passage edge `from -> to` would be blocked by
/// preset state — negation of `generation::directed_edge_feasible`, the one place this check is
/// written.
fn pair_edge_blocked(from: NodeId, to: NodeId, preset_state: &PresetState) -> bool {
    !crate::generation::directed_edge_feasible(preset_state, from, to)
}

/// Whether a vertical passage can be added between `a` and `b` without violating preset locks —
/// both directions must be free. Delegates to `generation::bidirectional_edge_feasible` — the
/// one place this "both directions free" check is written.
fn pair_connectable(a: NodeId, b: NodeId, preset_state: &PresetState) -> bool {
    crate::generation::bidirectional_edge_feasible(preset_state, a, b)
}
