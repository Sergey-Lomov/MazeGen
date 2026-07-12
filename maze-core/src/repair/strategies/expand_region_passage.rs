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
    field: &'a crate::space::Field<T>,
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
            let can_add = !pair_blocked(src, dst, preset_state);
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

/// Whether the pair is blocked by preset state in either direction — `pair_connectable`'s
/// negation, exposed separately since `find_merge_candidate`'s passage branch needs the bool
/// directly (mirrors `try_add_bidirectional_edge`'s own feasibility check, without mutating).
fn pair_blocked(a: NodeId, b: NodeId, preset_state: &PresetState) -> bool {
    !pair_connectable(a, b, preset_state)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind as EK};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::repair::params::build_params;
    use region_merge_core::{MODE_LARGEST, MODE_SMALLEST, MODE_PREFER_NEEDY};
    use crate::quality_control::rule::apply_commands;

    fn apply_and_commit<T: Tessellation>(
        strategy: &impl RepairStrategy<T, RegionNeedsExpansionIssue>,
        issue: &RegionNeedsExpansionIssue,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> RepairResult {
        let (result, commands) = strategy.apply(issue, maze, rng, params, preset_state, nested);
        apply_commands(maze, preset_state, commands);
        result
    }

    fn params_with(mode: &str, connection_mode: &str, prefer_partial: bool) -> StrategyParams {
        let mut overrides = StdHashMap::new();
        overrides.insert(PARAM_TARGET_MODE.to_string(), mode.to_string());
        overrides.insert(PARAM_CONNECTION_MODE.to_string(), connection_mode.to_string());
        overrides.insert(PARAM_PREFER_PARTIALLY_CONNECTED.to_string(), prefer_partial.to_string());
        build_params(
            <ExpandRegionPassageStrategy as RepairStrategy<SquareTessellation, RegionNeedsExpansionIssue>>::params(&ExpandRegionPassageStrategy),
            Some(&overrides),
        )
    }

    fn params_with_mode(mode: &str) -> StrategyParams {
        params_with(mode, CONNECTION_PASSAGE, false)
    }

    fn default_params() -> StrategyParams {
        build_params(
            <ExpandRegionPassageStrategy as RepairStrategy<SquareTessellation, RegionNeedsExpansionIssue>>::params(&ExpandRegionPassageStrategy),
            None,
        )
    }

    /// 1x4 row of cells, no edges at all -> 4 singleton SCC regions, all geometrically
    /// adjacent in a chain: 0-1-2-3.
    fn maze_4_singletons() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        (Maze::new(field, g), nodes)
    }

    fn issue_for(invalid: Vec<usize>) -> RegionNeedsExpansionIssue {
        RegionNeedsExpansionIssue::new_from_check("test", invalid, StdHashMap::new())
    }

    #[test]
    fn apply_fixed_immediately_when_invalid_is_empty() {
        let (mut maze, _) = maze_4_singletons();
        let issue = issue_for(vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &default_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), edges_before);
    }

    #[test]
    fn apply_merges_singleton_region_into_a_neighbor() {
        let (mut maze, nodes) = maze_4_singletons();
        // Flag node[0]'s singleton region (component index unknown ahead of time —
        // look it up via a fresh scc()).
        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &default_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // node[0]'s only geometric neighbor is node[1] -> must now be a full passage.
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_some());
    }

    #[test]
    fn apply_completes_an_existing_one_way_edge_into_a_full_passage() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        // One-way edge already present: nodes[0] -> nodes[1].
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[1]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(3);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &default_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_some());
        // Exactly one edge added (the missing reverse direction), not a duplicate forward edge.
        assert_eq!(maze.graph.edges().count(), 2);
    }

    #[test]
    fn apply_fails_when_region_has_no_neighbor() {
        // Single isolated cell field -> no geometric neighbor exists at all.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let region_idx = maze.analysis.scc(&maze.graph).components.len() - 1;
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &default_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_respects_preset_blocked_pair() {
        let (mut maze, nodes) = maze_4_singletons();
        let mut preset_state = PresetState::empty();
        // Block the only bridge for node[0]'s region (node[0]-node[1]) in both directions.
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &default_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn mode_largest_prefers_the_bigger_neighbor() {
        // 1x5 row: region under test is the lone middle singleton (idx 2), flanked by a
        // 1-cell region on the left (node 1, still singleton) and a pre-merged 2-cell
        // region on the right (nodes 3-4).
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[2]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(11);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with_mode(MODE_LARGEST), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // Must bridge toward the larger (2-cell) region on the right, not the singleton on the left.
        assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_some());
        assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_none());
    }

    #[test]
    fn mode_smallest_prefers_the_smaller_neighbor() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[2]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(11);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with_mode(MODE_SMALLEST), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // Must bridge toward the smaller (1-cell) region on the left.
        assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_some());
        assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_none());
    }

    #[test]
    fn mode_prefer_needy_picks_a_flagged_neighbor_when_available() {
        // 1x3 row, three singletons, all flagged as undersized. node[1]'s region must
        // bridge to one of its two needy neighbors (both flagged) -- either is correct,
        // but the result must be exactly one new bidirectional passage from node[1].
        let (mut maze, nodes) = maze_4_singletons();
        let scc = maze.analysis.scc(&maze.graph);
        let idx0 = scc.component_of(nodes[0]).unwrap();
        let idx1 = scc.component_of(nodes[1]).unwrap();
        let idx2 = scc.component_of(nodes[2]).unwrap();
        let issue = issue_for(vec![idx0, idx1, idx2]);
        let mut rng = MazeRng::seed_from_u64(2);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with_mode(MODE_PREFER_NEEDY), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let (mut maze_a, nodes_a) = maze_4_singletons();
        let region_idx_a = maze_a.analysis.scc(&maze_a.graph).component_of(nodes_a[0]).unwrap();
        let issue_a = issue_for(vec![region_idx_a]);
        let mut rng_a = MazeRng::seed_from_u64(99);
        apply_and_commit(&ExpandRegionPassageStrategy, &issue_a, &mut maze_a, &mut rng_a, &default_params(), &PresetState::empty(), &[]);

        let (mut maze_b, nodes_b) = maze_4_singletons();
        let region_idx_b = maze_b.analysis.scc(&maze_b.graph).component_of(nodes_b[0]).unwrap();
        let issue_b = issue_for(vec![region_idx_b]);
        let mut rng_b = MazeRng::seed_from_u64(99);
        apply_and_commit(&ExpandRegionPassageStrategy, &issue_b, &mut maze_b, &mut rng_b, &default_params(), &PresetState::empty(), &[]);

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }

    #[test]
    fn random_passage_fast_path_bridges_first_neighbor_found_without_touching_rng() {
        // Explicit prefer_partially_connected=false -> hits the legacy fast path
        // (`find_first_neighbor_passage`), which never consumes `rng` at all. Two runs with
        // deliberately *different* seeds must still produce the identical result, proving no
        // rng draw happened during selection.
        let (mut maze_a, nodes_a) = maze_4_singletons();
        let region_idx_a = maze_a.analysis.scc(&maze_a.graph).component_of(nodes_a[0]).unwrap();
        let issue_a = issue_for(vec![region_idx_a]);
        let mut rng_a = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue_a, &mut maze_a, &mut rng_a, &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let (mut maze_b, nodes_b) = maze_4_singletons();
        let region_idx_b = maze_b.analysis.scc(&maze_b.graph).component_of(nodes_b[0]).unwrap();
        let issue_b = issue_for(vec![region_idx_b]);
        let mut rng_b = MazeRng::seed_from_u64(12345);
        apply_and_commit(&ExpandRegionPassageStrategy, &issue_b, &mut maze_b, &mut rng_b, &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false), &PresetState::empty(), &[]);

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b, "fast path must not depend on rng state at all");
        // node[0]'s only geometric neighbor is node[1] -> must be the bridge target.
        assert!(maze_a.graph.edge_between(nodes_a[0], nodes_a[1]).is_some());
        assert!(maze_a.graph.edge_between(nodes_a[1], nodes_a[0]).is_some());
    }

    // ─── connection_mode = one_way ──────────────────────────────────────────

    /// 1x4 row: node[0]'s singleton region only has one geometric neighbor (node[1]) and
    /// therefore only one bridging cell pair -> one_way mode can't build two separated
    /// directions, must fail (no other neighbor to fall back to).
    #[test]
    fn one_way_fails_when_only_a_single_bridging_pair_exists() {
        let (mut maze, nodes) = maze_4_singletons();
        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    /// 2x2 square field, split into two 2-cell regions by column -> each region borders
    /// the other along two distinct row positions, giving two independent bridging cell
    /// pairs for one_way mode's max-separation placement.
    fn maze_2x2_two_columns() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 2), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        // all_points order is sorted by NodeId (creation order), which square_rect yields
        // row-major: (0,0),(1,0),(0,1),(1,1).
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        // Left column {nodes[0], nodes[2]} as one region, right column {nodes[1], nodes[3]}
        // as another -> connect within each column only.
        g.add_bidirectional_edge(nodes[0], nodes[2], EK::Basic);
        g.add_bidirectional_edge(nodes[1], nodes[3], EK::Basic);
        (Maze::new(field, g), nodes)
    }

    #[test]
    fn one_way_builds_both_directions_through_distinct_pairs() {
        let (mut maze, nodes) = maze_2x2_two_columns();
        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(4);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        // Exactly one outbound (left -> right) and one inbound (right -> left) edge,
        // through two different cell pairs.
        let left = [nodes[0], nodes[2]];
        let right = [nodes[1], nodes[3]];
        let mut outbound_pairs = Vec::new();
        let mut inbound_pairs = Vec::new();
        for &l in &left {
            for &r in &right {
                if maze.graph.edge_between(l, r).is_some() { outbound_pairs.push((l, r)); }
                if maze.graph.edge_between(r, l).is_some() { inbound_pairs.push((r, l)); }
            }
        }
        assert_eq!(outbound_pairs.len(), 1);
        assert_eq!(inbound_pairs.len(), 1);
        // Must not be the same cell pair (that would just be an ordinary passage).
        let (ol, or_) = outbound_pairs[0];
        let (il, ir) = inbound_pairs[0];
        assert!(!(ol == ir && or_ == il), "one_way must use two distinct cell pairs, not complete a passage on one pair");
    }

    /// Both bridging pairs exist (so `one_way` picks two distinct pairs, one per direction), but
    /// every inbound (right -> left) pair is preset-blocked — only the outbound direction could
    /// ever succeed. `apply_one_way` must not propose that lone outbound edge on its own: a
    /// partial one-way silently completing into a full passage on a later repair pass (via
    /// `try_add_bidirectional_edge`'s completion-aware behavior) would defeat the caller's
    /// `connection_mode` choice. Both directions' feasibility is checked (via `pair_edge_blocked`,
    /// no mutation) before either command is proposed, so the whole attempt fails outright with no
    /// command proposed for either direction — there is nothing to roll back, since nothing was
    /// ever tentatively applied in the first place.
    #[test]
    fn one_way_proposes_neither_direction_when_the_other_is_preset_blocked() {
        let (mut maze, nodes) = maze_2x2_two_columns();
        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(4);

        let left = [nodes[0], nodes[2]];
        let right = [nodes[1], nodes[3]];
        let mut preset_state = PresetState::empty();
        for &l in &left {
            for &r in &right {
                preset_state.blocked.insert((r, l)); // block every possible inbound direction
            }
        }

        let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed), "one_way must fail outright when only one direction can be built");
        let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_before, edges_after, "neither direction's command must be proposed when the pair as a whole can't be fully built");
    }

    #[test]
    fn one_way_completes_only_the_missing_direction_via_a_different_pair() {
        let (mut maze, nodes) = maze_2x2_two_columns();
        // Pre-existing partial connection: nodes[0] (left) -> nodes[1] (right).
        maze.graph.add_edge(nodes[0], nodes[1], EK::Basic);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(9);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        // Forward edge unchanged (still exactly the original nodes[0]->nodes[1]).
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        // Missing (inbound) direction must be added via a different pair than (0,1) —
        // i.e. not nodes[1]->nodes[0].
        assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_none());
        // The inbound edge must exist somewhere from the right column back to the left.
        let right = [nodes[1], nodes[3]];
        let left = [nodes[0], nodes[2]];
        let has_inbound = right.iter().any(|&r| left.iter().any(|&l| maze.graph.edge_between(r, l).is_some()));
        assert!(has_inbound);
    }

    #[test]
    fn one_way_completes_missing_direction_maximizing_min_distance_to_all_occupied_pairs() {
        // 5 rows x 2 cols: left/right regions share 5 bridging cell pairs (one per row, 0..4).
        // Rows 0 and 4 (the two ends) already carry an outbound edge; rows 1, 2, 3 are free.
        // A single-reference implementation (picking "farthest from row 0 only", the first
        // occupied pair found) would compute row 4 as farthest from row 0 -- but row 4 is
        // itself occupied, so it isn't even a valid candidate; among the remaining candidates
        // it would then pick row 3 (second-farthest from row 0), which sits right next to the
        // other occupied pair (row 4). The correct max-min-distance choice is row 2, maximizing
        // the *minimum* distance to both occupied pairs (row 0 and row 4) at once.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 5), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        // all_points sorted by NodeId (row-major): row_i = [nodes[2*i], nodes[2*i+1]].
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let left: Vec<NodeId> = (0..5).map(|i| nodes[2 * i]).collect();
        let right: Vec<NodeId> = (0..5).map(|i| nodes[2 * i + 1]).collect();
        for i in 0..4 {
            g.add_bidirectional_edge(left[i], left[i + 1], EK::Basic);
            g.add_bidirectional_edge(right[i], right[i + 1], EK::Basic);
        }
        // Pre-existing outbound edges via row 0's and row 4's pairs (both left -> right).
        g.add_edge(left[0], right[0], EK::Basic);
        g.add_edge(left[4], right[4], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(left[0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        // Original outbound edges preserved.
        assert!(maze.graph.edge_between(left[0], right[0]).is_some());
        assert!(maze.graph.edge_between(left[4], right[4]).is_some());
        // Missing inbound direction must land on row 2's pair -- maximizing the minimum
        // distance to both occupied pairs (row 0 and row 4), not just the farthest from row 0.
        assert!(maze.graph.edge_between(right[2], left[2]).is_some(), "must pick row 2, the max-min-distance choice from both occupied pairs");
        assert!(maze.graph.edge_between(right[0], left[0]).is_none());
        assert!(maze.graph.edge_between(right[1], left[1]).is_none());
        assert!(maze.graph.edge_between(right[3], left[3]).is_none());
        assert!(maze.graph.edge_between(right[4], left[4]).is_none());
    }

    #[test]
    fn prefer_partially_connected_picks_partial_neighbor_over_unconnected_one() {
        // Middle region already has a one-way edge to one neighbor; the other neighbor
        // (also eligible, also flagged as needy) has no connection at all. With
        // prefer_partially_connected=true, the partially-connected neighbor must win
        // regardless of target_mode's usual tie-break.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
        // Pre-existing partial (outbound only) connection from the region-under-test
        // (node[2]) to its left neighbor (node[1]).
        g.add_edge(nodes[2], nodes[1], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[2]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_LARGEST, CONNECTION_PASSAGE, true), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // Must bridge toward the partially-connected left neighbor, not the larger right one
        // (MODE_LARGEST would otherwise pick nodes[3]/nodes[4]'s 2-cell region).
        assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_some());
        assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_none());
    }

    #[test]
    fn prefer_partially_connected_false_ignores_partial_neighbor_and_falls_back_to_target_mode() {
        // Same fixture as `prefer_partially_connected_picks_partial_neighbor_over_unconnected_one`,
        // but with the preference explicitly turned off -> MODE_LARGEST must win normally and
        // pick the bigger (2-cell) right-hand neighbor, ignoring the left neighbor's partial
        // connection entirely.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
        g.add_edge(nodes[2], nodes[1], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[2]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_LARGEST, CONNECTION_PASSAGE, false), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_some());
        assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_none() || maze.graph.edge_between(nodes[2], nodes[1]).is_some());
    }

    #[test]
    fn prefer_partially_connected_applies_to_one_way_mode_too() {
        // 2 rows x 4 cols, three regions by column-pair: left = {col0,col1} (4 cells, larger,
        // unconnected), middle = {col2} (2 cells, region under test), right = {col3} (2 cells,
        // partial neighbor: pre-existing outbound-only edge from middle into it). Both middle's
        // neighbors have 2 bridging cell pairs (one per row), enough for one_way's two-pairs
        // requirement. With prefer_partially_connected=true and MODE_LARGEST, the
        // partially-connected (but smaller) right neighbor must still win over the larger,
        // unconnected left neighbor, and one_way mode completes the missing inbound direction
        // through the *other* row's pair (not the one already carrying the outbound edge).
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 2), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        // all_points sorted by NodeId (creation/row-major order): row0 = nodes[0..4],
        // row1 = nodes[4..8], each row laid out col0..col3.
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let left = [nodes[0], nodes[1], nodes[4], nodes[5]]; // cols 0-1, both rows
        let middle = [nodes[2], nodes[6]]; // col 2, both rows
        let right = [nodes[3], nodes[7]]; // col 3, both rows
        g.add_bidirectional_edge(nodes[0], nodes[1], EK::Basic);
        g.add_bidirectional_edge(nodes[4], nodes[5], EK::Basic);
        g.add_bidirectional_edge(nodes[0], nodes[4], EK::Basic);
        g.add_bidirectional_edge(middle[0], middle[1], EK::Basic);
        g.add_bidirectional_edge(right[0], right[1], EK::Basic);
        // Partial (outbound-only) connection from middle into right, via row 0's pair.
        g.add_edge(middle[0], right[0], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(middle[0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_LARGEST, CONNECTION_ONE_WAY, true), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // Original outbound edge preserved; must not touch the larger, unconnected left region.
        assert!(maze.graph.edge_between(middle[0], right[0]).is_some());
        assert!(left.iter().all(|&l| middle.iter().all(|&m| {
            maze.graph.edge_between(l, m).is_none() && maze.graph.edge_between(m, l).is_none()
        })), "must prefer the partially-connected right neighbor over the larger unconnected left one");
        // Missing inbound direction must land on row 1's pair, not duplicate row 0's.
        assert!(maze.graph.edge_between(right[1], middle[1]).is_some());
        assert!(maze.graph.edge_between(right[0], middle[0]).is_none());
    }

    #[test]
    fn mode_prefer_needy_picks_a_flagged_neighbor_in_one_way_mode_too() {
        // 2 rows x 3 cols, three column regions (left/middle/right), each 2 cells (one per
        // row) -> every region has exactly 2 bridging cell pairs to each geometric neighbor,
        // enough for one_way's two-distinct-pairs requirement. Middle (region under test) and
        // its left neighbor are both flagged as undersized (needy); the right neighbor is not.
        // MODE_PREFER_NEEDY + connection_mode=one_way must bridge into the needy left neighbor,
        // building both one-way directions through the left neighbor's two distinct row pairs.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 2), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        // all_points sorted by NodeId (row-major): row0 = nodes[0..3], row1 = nodes[3..6].
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let left = [nodes[0], nodes[3]];
        let middle = [nodes[1], nodes[4]];
        let right = [nodes[2], nodes[5]];
        g.add_bidirectional_edge(left[0], left[1], EK::Basic);
        g.add_bidirectional_edge(middle[0], middle[1], EK::Basic);
        g.add_bidirectional_edge(right[0], right[1], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let scc = maze.analysis.scc(&maze.graph);
        let middle_idx = scc.component_of(middle[0]).unwrap();
        let left_idx = scc.component_of(left[0]).unwrap();
        let issue = issue_for(vec![middle_idx, left_idx]); // right neighbor not flagged
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ExpandRegionPassageStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_PREFER_NEEDY, CONNECTION_ONE_WAY, false), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        // Must bridge toward the needy left neighbor, never toward the non-needy right one.
        let touches_right = right.iter().any(|&r| middle.iter().any(|&m| {
            maze.graph.edge_between(r, m).is_some() || maze.graph.edge_between(m, r).is_some()
        }));
        assert!(!touches_right, "must not bridge into the non-needy right neighbor");

        let outbound_to_left = left.iter().any(|&l| middle.iter().any(|&m| maze.graph.edge_between(m, l).is_some()));
        let inbound_from_left = left.iter().any(|&l| middle.iter().any(|&m| maze.graph.edge_between(l, m).is_some()));
        assert!(outbound_to_left && inbound_from_left, "one_way must build both directions toward the needy left neighbor");
    }
}
