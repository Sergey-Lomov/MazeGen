use rand::RngCore;
use std::collections::HashMap;
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
use std::collections::HashSet;

#[cfg(test)]
mod tests;

/// Tracks edges proposed as commands so far this `apply()` call, alongside the real graph — a
/// read-only stand-in for what an earlier region's real mutation would have made observable
/// through `edge_between` under the old in-place contract (GitHub issue #118, `Specs/repair.md`'s
/// immutable-snapshot contract, and the "single fixed snapshot for the whole call" decision for
/// this strategy specifically). `has_edge` checks both the real graph and this set; `add` records
/// a proposed direction here and pushes the equivalent command.
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
        self.commands.push(MutationCommand::AddDirectedEdge { from, to });
    }

    fn add_bidirectional(&mut self, a: NodeId, b: NodeId) {
        self.added.insert((a, b));
        self.added.insert((b, a));
        self.commands.push(MutationCommand::AddBidirectionalEdge { a, b });
    }
}

pub const PARAM_CONNECTION_MODE: &str = "connection_mode";

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
];

/// Handles `REGION_NEEDS_EXPANSION`. Merges each flagged undersized SCC region into a
/// neighboring region, either via a full bidirectional passage or via a pair of one-way edges
/// (`connection_mode`) — geometric adjacency (`field.neighbors`), not graph adjacency, since two
/// regions can be neighbors with no existing edge between any of their cell pairs at all.
///
/// **`issue.data` is mandatory for this kind**: `invalid` (which `scc().components` indices
/// are undersized) is the producing check's result — there's no other channel to learn it.
pub struct ExpandRegionPassageStrategy;

impl<T: Tessellation> RepairStrategy<T, RegionNeedsExpansionIssue> for ExpandRegionPassageStrategy {
    fn strategy_id(&self) -> &'static str { "expand_region_passage" }

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

        // One fixed snapshot for the whole apply() call — see Specs/repair.md's decision for
        // this strategy: `scc` is read once here, never re-derived mid-call, so multiple regions
        // merged in one batch may occasionally pick the same neighbor rather than each other's
        // fresh post-merge state; accepted, same class of imprecision already documented for this
        // strategy's own "regions can merge into each other" behavior, self-corrects next
        // fixpoint iteration.
        let scc = maze.analysis.scc(&maze.graph);
        let mut pending = PendingEdges::default();

        let any_fixed = region_merge_core::run_merge_loop(invalid, |region_idx, needy| {
            let region = scc.components.get(region_idx)?;
            find_merge_candidate(
                region, region_idx, &scc, maze, preset_state, mode, connection_mode, prefer_partial, needy, rng, &mut pending,
            )
        });

        if any_fixed {
            (RepairResult::Fixed { score: None }, pending.commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(ExpandRegionPassageStrategy, RegionNeedsExpansionIssue);

/// Existing directed-edge state between `region` and one neighboring component, plus every
/// geometrically-adjacent bridging cell pair found between them (needed for one-way mode's
/// max-separation placement).
struct NeighborInfo {
    pairs: Vec<(NodeId, NodeId)>,
    has_outbound: bool, // region -> neighbor edge already exists (via some pair)
    has_inbound: bool,  // neighbor -> region edge already exists (via some pair)
}

/// Scans `region`'s geometric neighbors (`field.neighbors`), yielding every bridging cell pair
/// `(region_node, neighbor_node, neighbor_component_id)` that isn't in `region`'s own component
/// and isn't preset-blocked (`pair_connectable`). Shared scan order/filter for both
/// `collect_neighbors` (full enumeration) and `find_first_neighbor_passage` (legacy fast path) —
/// keeps "what counts as a valid neighbor pair" defined in exactly one place.
fn scan_neighbor_pairs<'a, T: Tessellation>(
    region: &'a [NodeId],
    region_idx: ComponentId,
    scc: &'a ConnectedComponents,
    field: &'a crate::space::MultiLevelField<T>,
    preset_state: &'a PresetState,
) -> impl Iterator<Item = (NodeId, NodeId, ComponentId)> + 'a {
    region.iter().flat_map(move |&node| {
        field.neighbors(node).into_iter().filter_map(move |neighbor_node| {
            let neighbor_idx = scc.component_of(neighbor_node)?;
            if neighbor_idx == region_idx {
                return None;
            }
            if !pair_connectable(node, neighbor_node, preset_state) {
                return None;
            }
            Some((node, neighbor_node, neighbor_idx))
        })
    })
}

/// Collects, per geometrically-adjacent neighboring component, every bridging cell pair
/// `(region_node, neighbor_node)` and whether a directed edge already exists in either
/// direction (via any pair) — used by both `passage` and `one_way` connection modes.
fn collect_neighbors<T: Tessellation>(
    region: &[NodeId],
    region_idx: ComponentId,
    scc: &ConnectedComponents,
    maze: &Maze<T>,
    preset_state: &PresetState,
    pending: &PendingEdges,
) -> HashMap<ComponentId, NeighborInfo> {
    let mut by_neighbor: HashMap<ComponentId, NeighborInfo> = HashMap::new();

    let found: Vec<(NodeId, NodeId, ComponentId)> =
        scan_neighbor_pairs(region, region_idx, scc, &maze.field, preset_state).collect();
    for (node, neighbor_node, neighbor_idx) in found {
        let entry = by_neighbor.entry(neighbor_idx).or_insert_with(|| NeighborInfo {
            pairs: Vec::new(),
            has_outbound: false,
            has_inbound: false,
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

/// Finds a neighboring component to merge `region` into and applies the connection according to
/// `connection_mode`. Returns `Some((neighbor_idx, true))` on a successful merge (fully bridged
/// in both directions), `Some((neighbor_idx, false))` if the chosen candidate couldn't be fully
/// bridged (e.g. `one_way` mode needing a second, distinct cell pair that doesn't exist), and
/// `None` if `region` has no eligible neighbor at all.
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
    needy: &HashSet<ComponentId>,
    rng: &mut dyn RngCore,
    pending: &mut PendingEdges,
) -> Option<(ComponentId, bool)> {
    // `random` + `passage` + no partial-preference is the original (pre-connection_mode)
    // contract: returns the first geometrically-adjacent, non-blocked neighbor found while
    // scanning, without enumerating every neighbor or touching `rng` — preserved verbatim here
    // since it's a documented behavior (`Specs/repair.md`), not just an optimization, and other
    // strategies (`ReduceSccCountStrategy`) rely on its exact scan order for determinism.
    if mode == MODE_RANDOM && connection_mode == CONNECTION_PASSAGE && !prefer_partial {
        return find_first_neighbor_passage(region, region_idx, scc, maze, preset_state, pending);
    }

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

    let chosen = region_merge_core::pick_by_mode(pool, scc, mode, needy, rng)?;
    let info = &by_neighbor[&chosen];

    let applied = match connection_mode {
        CONNECTION_ONE_WAY => apply_one_way(maze, info, preset_state, pending),
        _ => {
            let (src, dst) = info.pairs[0];
            let can_add = pair_connectable(src, dst, preset_state);
            if can_add {
                pending.add_bidirectional(src, dst);
            }
            can_add
        }
    };

    Some((chosen, applied))
}

/// Legacy fast path for `random` + `passage`: scans `region`'s geometric neighbors (same scan
/// order/filter as `collect_neighbors`, via `scan_neighbor_pairs`) and bridges into the first
/// eligible one found, without enumerating every neighbor or using `rng` at all.
fn find_first_neighbor_passage<T: Tessellation>(
    region: &[NodeId],
    region_idx: ComponentId,
    scc: &ConnectedComponents,
    maze: &Maze<T>,
    preset_state: &PresetState,
    pending: &mut PendingEdges,
) -> Option<(ComponentId, bool)> {
    let first = scan_neighbor_pairs(region, region_idx, scc, &maze.field, preset_state).next();
    let (node, neighbor_node, neighbor_idx) = first?;
    pending.add_bidirectional(node, neighbor_node);
    Some((neighbor_idx, true))
}

/// Applies the `one_way` connection mode to a chosen neighbor: ensures both a `region ->
/// neighbor` and a `neighbor -> region` directed edge exist, each through its own bridging cell
/// pair (never the same pair for both directions — that would just be an ordinary passage).
///
/// - If a direction already exists (from an earlier partial connection), only the missing
///   direction is added, through whichever remaining pair is geometrically farthest from the
///   pair(s) already carrying an edge.
/// - If neither direction exists, the two farthest-apart pairs (by `geometric_distance` between
///   their region-side node) are picked: one for each direction.
/// - Returns `false` (no mutation) if there's no second, distinct pair available to carry the
///   missing direction (a neighbor with only one bridging cell pair can't support a fully
///   separated one-way round trip) — the caller then tries a different neighbor.
fn apply_one_way<T: Tessellation>(
    maze: &Maze<T>,
    info: &NeighborInfo,
    preset_state: &PresetState,
    pending: &mut PendingEdges,
) -> bool {
    if info.has_outbound && info.has_inbound {
        return true; // already fully connected both ways
    }

    if info.has_outbound || info.has_inbound {
        // Partial: only need the missing direction, via a pair distinct from every pair
        // already carrying the existing edge (there can be more than one, e.g. from manual
        // preset/post-edit edges predating this repair pass).
        let existing_pairs: Vec<(NodeId, NodeId)> = info.pairs.iter().copied()
            .filter(|&(a, b)| {
                if info.has_outbound { pending.has_edge(maze, a, b) }
                else { pending.has_edge(maze, b, a) }
            })
            .collect();
        if existing_pairs.is_empty() {
            return false;
        }

        let candidate = farthest_pair(&info.pairs, &existing_pairs, maze);
        let Some((a, b)) = candidate else { return false };

        let (from, to) = if info.has_outbound { (b, a) } else { (a, b) };
        if pair_edge_blocked(from, to, preset_state) {
            return false;
        }
        pending.add_directed(from, to);
        true
    } else {
        // Neither direction exists: pick the two pairs farthest apart from each other.
        if info.pairs.len() < 2 {
            return false;
        }
        let Some((p1, p2)) = farthest_pair_combination(&info.pairs, maze) else { return false };
        let (a1, b1) = p1;
        let (a2, b2) = p2;
        // All-or-nothing: `one_way` means two independently-cut directions, not "whichever one
        // happened to succeed" — checked as pure feasibility (never mutates) before proposing
        // either command, so there's nothing to roll back if only one side would have gone
        // through (unlike the old in-place contract, which had to undo a real mutation here).
        let out_ok = !pair_edge_blocked(a1, b1, preset_state);
        let in_ok = !pair_edge_blocked(b2, a2, preset_state);
        if out_ok && in_ok {
            pending.add_directed(a1, b1);
            pending.add_directed(b2, a2);
        }
        out_ok && in_ok
    }
}

/// Whether adding a single directed edge `from -> to` would be blocked by preset state — negation
/// of `generation::directed_edge_feasible`, the one place this check is written.
fn pair_edge_blocked(from: NodeId, to: NodeId, preset_state: &PresetState) -> bool {
    !crate::generation::directed_edge_feasible(preset_state, from, to)
}

/// Among `pairs`, finds the one that maximizes the *minimum* geometric distance (by the
/// region-side node) to every pair in `references` — i.e. the candidate farthest from the
/// closest already-occupied pair, not just from one arbitrarily chosen reference. Pairs already
/// in `references` are excluded from consideration. `None` if no other pair exists.
fn farthest_pair<T: Tessellation>(
    pairs: &[(NodeId, NodeId)],
    references: &[(NodeId, NodeId)],
    maze: &Maze<T>,
) -> Option<(NodeId, NodeId)> {
    let ref_points: Vec<(f64, f64)> = references.iter()
        .filter_map(|r| maze.field.point_of(r.0))
        .map(T::cartesian)
        .collect();
    if ref_points.is_empty() {
        return None;
    }
    pairs.iter().copied()
        .filter(|p| !references.contains(p))
        .filter_map(|(a, b)| {
            let point = maze.field.point_of(a)?;
            let (px, py) = T::cartesian(point);
            let min_dist = ref_points.iter()
                .map(|&(rx, ry)| ((px - rx).powi(2) + (py - ry).powi(2)).sqrt())
                .fold(f64::INFINITY, f64::min);
            Some(((a, b), min_dist))
        })
        .max_by(|(_, d1), (_, d2)| d1.total_cmp(d2))
        .map(|(p, _)| p)
}

/// Finds the pair of distinct bridging cell pairs (by region-side node) with the maximum
/// geometric distance between each other. `None` if fewer than two pairs are given. Caches each
/// pair's region-side `cartesian` coordinate once (`O(n)` lookups) rather than recomputing it on
/// every inner-loop iteration (`O(n^2)` lookups for `O(n^2)` distance comparisons).
fn farthest_pair_combination<T: Tessellation>(
    pairs: &[(NodeId, NodeId)],
    maze: &Maze<T>,
) -> Option<((NodeId, NodeId), (NodeId, NodeId))> {
    if pairs.len() < 2 {
        return None;
    }
    let points: Vec<Option<(f64, f64)>> = pairs.iter()
        .map(|&(a, _)| maze.field.point_of(a).map(T::cartesian))
        .collect();
    let mut best: Option<((NodeId, NodeId), (NodeId, NodeId), f64)> = None;
    for i in 0..pairs.len() {
        let Some((x1, y1)) = points[i] else { continue };
        for j in (i + 1)..pairs.len() {
            let Some((x2, y2)) = points[j] else { continue };
            let d = ((x2 - x1).powi(2) + (y2 - y1).powi(2)).sqrt();
            if best.as_ref().map(|(_, _, bd)| d > *bd).unwrap_or(true) {
                best = Some((pairs[i], pairs[j], d));
            }
        }
    }
    best.map(|(p1, p2, _)| (p1, p2))
}

/// Whether a passage can be added between `a` and `b` without violating preset locks —
/// both directions must be free (a full bidirectional passage), same strict contract
/// `MissingLoopsRandomStrategy` uses. An existing one-way edge in either direction is not
/// a blocker by itself (the strategy is allowed to complete it into a full passage); only
/// `blocked`/`locked_out`/`locked_in` preset state blocks the pair. Delegates to
/// `generation::bidirectional_edge_feasible` — the one place this "both directions free" check is
/// written (GitHub issue #118).
fn pair_connectable(a: NodeId, b: NodeId, preset_state: &PresetState) -> bool {
    crate::generation::bidirectional_edge_feasible(preset_state, a, b)
}
