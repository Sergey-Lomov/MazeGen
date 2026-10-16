use crate::Maze;
use crate::generation::PresetState;
use crate::graph::nav::{NavEdge, NavGraph, NavNodeId};
use crate::graph::pathfinding::{
    DijkstraScratch, OutgoingIndex, dijkstra_with_prev_into, route_aware_junction_flags,
};
use crate::graph::{EdgeKind, Graph};
use crate::ids::NodeId;
use crate::quality_control::MissingEndpointsIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::{MultiLevelField, Tessellation};
use rand::RngCore;
use std::collections::{HashMap, HashSet};

pub const PARAM_PATH_WEIGHT: &str = "path_weight";
pub const PARAM_JUNCTION_WEIGHT: &str = "junction_weight";
pub const PARAM_ONEWAY_WEIGHT: &str = "oneway_weight";
pub const PARAM_CROSS_FLOOR_WEIGHT: &str = "cross_floor_weight";
pub const PARAM_SPLIT_WEIGHT: &str = "split_weight";
pub const PARAM_TELEPORT_WEIGHT: &str = "teleport_weight";
pub const PARAM_ELEVATOR_STOP_WEIGHT: &str = "elevator_stop_weight";
pub const PARAM_MIN_SCORE: &str = "min_score";

const DEFAULT_PATH_WEIGHT: f64 = 2.0;
const DEFAULT_JUNCTION_WEIGHT: f64 = 3.0;
const DEFAULT_ONEWAY_WEIGHT: f64 = 8.0;
const DEFAULT_CROSS_FLOOR_WEIGHT: f64 = 12.0;
const DEFAULT_SPLIT_WEIGHT: f64 = 8.0;
const DEFAULT_TELEPORT_WEIGHT: f64 = 8.0;
const DEFAULT_ELEVATOR_STOP_WEIGHT: f64 = 4.0;
const DEFAULT_MIN_SCORE: f64 = 0.0;

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_PATH_WEIGHT,
        label: "Path length weight",
        kind: StrategyParamKind::Float {
            default: DEFAULT_PATH_WEIGHT,
            min: 0.0,
            max: 100.0,
        },
    },
    StrategyParam {
        id: PARAM_JUNCTION_WEIGHT,
        label: "Junction weight",
        kind: StrategyParamKind::Float {
            default: DEFAULT_JUNCTION_WEIGHT,
            min: 0.0,
            max: 100.0,
        },
    },
    StrategyParam {
        id: PARAM_ONEWAY_WEIGHT,
        label: "One-way passage weight",
        kind: StrategyParamKind::Float {
            default: DEFAULT_ONEWAY_WEIGHT,
            min: 0.0,
            max: 100.0,
        },
    },
    StrategyParam {
        id: PARAM_CROSS_FLOOR_WEIGHT,
        label: "Cross-floor weight",
        kind: StrategyParamKind::Float {
            default: DEFAULT_CROSS_FLOOR_WEIGHT,
            min: 0.0,
            max: 100.0,
        },
    },
    StrategyParam {
        id: PARAM_SPLIT_WEIGHT,
        label: "Split tile weight",
        kind: StrategyParamKind::Float {
            default: DEFAULT_SPLIT_WEIGHT,
            min: 0.0,
            max: 100.0,
        },
    },
    StrategyParam {
        id: PARAM_TELEPORT_WEIGHT,
        label: "Teleport weight",
        kind: StrategyParamKind::Float {
            default: DEFAULT_TELEPORT_WEIGHT,
            min: 0.0,
            max: 100.0,
        },
    },
    StrategyParam {
        id: PARAM_ELEVATOR_STOP_WEIGHT,
        label: "Elevator stop count weight",
        kind: StrategyParamKind::Float {
            default: DEFAULT_ELEVATOR_STOP_WEIGHT,
            min: 0.0,
            max: 100.0,
        },
    },
    StrategyParam {
        id: PARAM_MIN_SCORE,
        label: "Minimum score",
        kind: StrategyParamKind::Float {
            default: DEFAULT_MIN_SCORE,
            min: 0.0,
            max: 100_000.0,
        },
    },
];

/// Computes the same weighted score `ScoredEndpointsStrategy` uses to pick endpoints, but for an
/// already-fixed `(start, finish)` maze-node pair — used to report a route's score outside the
/// repair pipeline (e.g. `MazeAnalysis::route_score`), where both endpoints are already set and no
/// `MissingEndpointsIssue` ever fires to trigger the strategy itself (GitHub issue #532: without
/// this, a route's score was only ever set as a side effect of the strategy dispatching a repair,
/// so it silently disappeared after any post-edit confirm since start/finish are never missing
/// there). Returns `None` if either endpoint isn't a nav node or no path connects them.
pub fn score_for_route<T: Tessellation>(
    nav: &NavGraph,
    field: &MultiLevelField<T>,
    graph: &Graph,
    start: crate::ids::NodeId,
    finish: crate::ids::NodeId,
    weights: &ScoreWeights,
) -> Option<f64> {
    let start_nav = nav.nav_node_for(start)?;
    let finish_nav = nav.nav_node_for(finish)?;
    let ctx = ScoredPathContext::build(nav, field, graph, weights.path_weight);
    let (_, _, score) = ctx.best_pair(nav, Some(start_nav), Some(finish_nav), weights)?;
    Some(score)
}

/// No `search_mode` param here unlike `FarthestEndpointsStrategy`/`MissingTeleportsStrategy`
/// (GitHub issue #515): this strategy's `best_pair` is already an exhaustive search, but over
/// nav-node pairs — `O(nav_nodes^2)`. Widening it to every raw-graph tile pair would be
/// `O(tiles^2)`, and tiles typically outnumber nav nodes by 5-20x, making an exhaustive raw-graph
/// mode extremely expensive on any non-trivial maze. Deliberately not offered.
pub struct ScoredEndpointsStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for ScoredEndpointsStrategy {
    fn strategy_id(&self) -> &'static str {
        "scored_endpoints"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &MissingEndpointsIssue,
        maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if !issue.missing_start && !issue.missing_finish {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let weights = ScoreWeights::from_params(params);

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;

        if nav.nodes.is_empty() {
            return (RepairResult::Failed, vec![]);
        }

        let ctx = ScoredPathContext::build(nav, &maze.field, &maze.graph, weights.path_weight);

        // Resolve whichever endpoint is already set to its NavNodeId, fixing it as the
        // corresponding best_pair bound; the other stays None (searched over all nav-nodes).
        let fixed_start = if issue.missing_start {
            None
        } else {
            match maze.meta.start.and_then(|start| nav.nav_node_for(start)) {
                Some(id) => Some(id),
                None => return (RepairResult::Failed, vec![]),
            }
        };
        let fixed_finish = if issue.missing_finish {
            None
        } else {
            match maze.meta.finish.and_then(|finish| nav.nav_node_for(finish)) {
                Some(id) => Some(id),
                None => return (RepairResult::Failed, vec![]),
            }
        };

        let Some((s, f, achieved_score)) = ctx.best_pair(nav, fixed_start, fixed_finish, &weights)
        else {
            return (RepairResult::Failed, vec![]);
        };

        let min_score = params
            .get(PARAM_MIN_SCORE)
            .and_then(|v| v.as_float())
            .unwrap_or(DEFAULT_MIN_SCORE);
        if achieved_score < min_score {
            return (RepairResult::Failed, vec![]);
        }

        let mut commands = Vec::new();
        if issue.missing_start {
            commands.push(MutationCommand::SetStart(nav.nodes[s].node_id));
        }
        if issue.missing_finish {
            commands.push(MutationCommand::SetFinish(nav.nodes[f].node_id));
        }

        (
            RepairResult::Fixed {
                score: Some(achieved_score),
            },
            commands,
        )
    }
}

crate::impl_erased_repair_strategy!(ScoredEndpointsStrategy, MissingEndpointsIssue);

pub struct ScoreWeights {
    pub path_weight: f64,
    pub junction_weight: f64,
    pub oneway_weight: f64,
    pub cross_floor_weight: f64,
    pub split_weight: f64,
    pub teleport_weight: f64,
    pub elevator_stop_weight: f64,
}

impl ScoreWeights {
    fn from_params(params: &StrategyParams) -> Self {
        Self {
            path_weight: params
                .get(PARAM_PATH_WEIGHT)
                .and_then(|v| v.as_float())
                .unwrap_or(DEFAULT_PATH_WEIGHT),
            junction_weight: params
                .get(PARAM_JUNCTION_WEIGHT)
                .and_then(|v| v.as_float())
                .unwrap_or(DEFAULT_JUNCTION_WEIGHT),
            oneway_weight: params
                .get(PARAM_ONEWAY_WEIGHT)
                .and_then(|v| v.as_float())
                .unwrap_or(DEFAULT_ONEWAY_WEIGHT),
            cross_floor_weight: params
                .get(PARAM_CROSS_FLOOR_WEIGHT)
                .and_then(|v| v.as_float())
                .unwrap_or(DEFAULT_CROSS_FLOOR_WEIGHT),
            split_weight: params
                .get(PARAM_SPLIT_WEIGHT)
                .and_then(|v| v.as_float())
                .unwrap_or(DEFAULT_SPLIT_WEIGHT),
            teleport_weight: params
                .get(PARAM_TELEPORT_WEIGHT)
                .and_then(|v| v.as_float())
                .unwrap_or(DEFAULT_TELEPORT_WEIGHT),
            elevator_stop_weight: params
                .get(PARAM_ELEVATOR_STOP_WEIGHT)
                .and_then(|v| v.as_float())
                .unwrap_or(DEFAULT_ELEVATOR_STOP_WEIGHT),
        }
    }

    /// Builds weights from a `scored_endpoints` strategy config's raw `HashMap<String, String>`
    /// overrides (GitHub issue #532) — same parsing/clamping/defaulting `RepairStrategy::apply`
    /// gets via its own `StrategyParams`, but usable outside the repair pipeline (e.g. by a
    /// caller that only has the raw `StrategyConfig.params` from a project's rule config, not a
    /// live `RepairStrategy::apply` call).
    pub fn from_raw_overrides(overrides: &std::collections::HashMap<String, String>) -> Self {
        Self::from_params(&crate::repair::params::build_params(
            PARAMS,
            Some(overrides),
        ))
    }
}

/// Precomputed data derived from NavGraph for scoring endpoint pairs.
struct ScoredPathContext<'a> {
    edges: Vec<&'a NavEdge>,
    oneway_flags: Vec<bool>,
    /// Per-edge flag: edge crosses a floor boundary — true for any single-hop `VerticalPassage`-
    /// or `Elevator`-kind edge (`NavEdge::is_vertical`/`is_elevator`), regardless of
    /// directionality or, for elevators, how many stops the elevator has (GitHub issue #535
    /// follow-up: one-way/bidirectional and same-floor/cross-floor are independent, additive
    /// properties of a hop rather than separate flat weights per combination).
    cross_floor_flags: Vec<bool>,
    /// Per-edge flag: edge is teleport-backed (`NavEdge::is_teleport`).
    teleport_flags: Vec<bool>,
    /// Per-edge count of split-tile occurrences among the edge's own tiles (its `to` node plus,
    /// for corridor edges, every interior node) — the edge's `from` node is excluded so a route's
    /// per-edge counts sum to the split occurrences on the full tile path without double-counting
    /// the shared node between consecutive edges (mirrors `routing::build_maze_path`'s split).
    /// Does not cover the route's own start node — see `split_flags`.
    split_counts: Vec<usize>,
    /// Per-nav-node split flag — only ever consulted for a route's start nav node (the one node
    /// `split_counts` structurally excludes from every edge).
    split_flags: Vec<bool>,
    /// Per-edge elevator-stop bonus count: for a single-hop `Elevator`-kind edge, `max(0, stops -
    /// 2)` where `stops` is that elevator's total distinct-floor stop count (not just the two
    /// endpoints of this hop) — a 2-stop elevator is no more of a choice than a plain vertical
    /// passage, so it contributes 0; each additional stop beyond 2 adds one more unit. Zero for
    /// every non-elevator edge.
    elevator_stop_counts: Vec<usize>,
    outgoing_by_node: OutgoingIndex,
    /// Every nav node worth trying as a free (non-fixed) start/finish candidate in `best_pair`,
    /// after pruning dominated plain dead-end tails and the plain forks they dominate (see
    /// `prune_dominated_tail_nodes`) -- a strict subset of `0..nav.nodes.len()` on any graph with
    /// such tails, or everything when there are none or `path_weight <= 0.0` (pruning disabled,
    /// see `ScoredPathContext::build`).
    search_candidates: Vec<NavNodeId>,
}

impl<'a> ScoredPathContext<'a> {
    fn build<T: Tessellation>(
        nav: &'a NavGraph,
        field: &MultiLevelField<T>,
        graph: &Graph,
        path_weight: f64,
    ) -> Self {
        let edges: Vec<&'a NavEdge> = nav.edges().collect();
        let oneway_flags = oneway_flags(&edges);
        let cross_floor_flags = cross_floor_flags(&edges);
        let teleport_flags = teleport_flags(&edges);
        let split_counts = split_counts(&edges, field);
        let split_flags = nav_node_split_flags(nav, field);
        let elevator_stop_counts = elevator_stop_counts(&edges, graph, field);
        let outgoing_by_node = OutgoingIndex::build(nav, &edges);
        // The dead-end-tail/branch pruning below relies on a strictly deeper node's `path_weight`
        // contribution growing to guarantee it never scores lower (see `prune_dominated_tail_nodes`'s
        // doc comment) -- with `path_weight <= 0.0` that strict growth is gone (all `ScoreWeights`
        // fields clamp to >= 0.0, so 0.0 is the only non-positive value reachable here), so a
        // dominated node could tie the node dominating it instead of strictly losing, and pruning it
        // away would silently narrow `best_pair`'s candidate pool for no scoring benefit.
        let search_candidates = if path_weight > 0.0 {
            prune_dominated_tail_nodes(
                nav.nodes.len(),
                &edges,
                &oneway_flags,
                &cross_floor_flags,
                &teleport_flags,
                &split_counts,
                &split_flags,
            )
        } else {
            (0..nav.nodes.len()).collect()
        };
        Self {
            edges,
            oneway_flags,
            cross_floor_flags,
            teleport_flags,
            split_counts,
            split_flags,
            elevator_stop_counts,
            outgoing_by_node,
            search_candidates,
        }
    }

    fn best_pair(
        &self,
        nav: &NavGraph,
        fixed_start: Option<NavNodeId>,
        fixed_finish: Option<NavNodeId>,
        weights: &ScoreWeights,
    ) -> Option<(NavNodeId, NavNodeId, f64)> {
        let n = nav.nodes.len();

        // Free (non-fixed) start/finish search is restricted to `search_candidates` instead of
        // every `0..n` nav node -- see `prune_dominated_tail_nodes`. A fixed endpoint is exempt
        // (the caller/issue already pinned it to a specific node, pruned or not) since it is
        // never searched over, only ever used as-is.
        let starts: Vec<NavNodeId> = match fixed_start {
            Some(s) => vec![s],
            None => self.search_candidates.clone(),
        };

        let mut best_score: Option<f64> = None;
        let mut best: Option<(NavNodeId, NavNodeId, f64)> = None;
        // Shared across every candidate pair scored below -- the same elevator group is often
        // revisited by many different candidate paths, so memoizing its BFS here avoids
        // recomputing it once per candidate (GitHub issue #535 follow-up).
        let mut elevator_group_cache = HashMap::new();

        // Built once outside the `starts` loop (not per-`s`) -- its contents never depend on `s`,
        // so re-collecting on every outer iteration was pure O(n) waste repeated n times.
        let finishes: Vec<NavNodeId> = match fixed_finish {
            Some(f) => vec![f],
            None => self.search_candidates.clone(),
        };

        // Reused across every candidate pair below instead of allocating a fresh `Vec` per pair --
        // both are cleared (not reallocated) each iteration, so their backing storage grows once
        // to the longest path seen and is then reused for every shorter one.
        let mut path_edges: Vec<usize> = Vec::new();
        let mut nav_nodes_on_path: Vec<NavNodeId> = Vec::new();
        // Reused across every one of the `starts.len()` Dijkstra runs below instead of each one
        // allocating its own `dist`/`prev_edge` `Vec`s and `BinaryHeap` from scratch -- this is
        // the dominant cost in `best_pair`'s O(n) Dijkstra calls, so avoiding O(n) full-size
        // allocations per call matters far more here than the same trick applied to the much
        // smaller per-pair buffers above.
        let mut dijkstra_scratch = DijkstraScratch::new(n);

        for &s in &starts {
            let (dist, prev_edge) = dijkstra_with_prev_into(
                s,
                &self.edges,
                &self.outgoing_by_node,
                &mut dijkstra_scratch,
            );

            for &f in &finishes {
                if f == s {
                    continue;
                }
                if dist[f] == usize::MAX {
                    continue;
                }

                reconstruct_path_edges_into(&self.edges, prev_edge, s, f, &mut path_edges);
                let score = score_path(
                    nav,
                    &self.oneway_flags,
                    &self.cross_floor_flags,
                    &self.teleport_flags,
                    &self.split_counts,
                    &self.split_flags,
                    &self.elevator_stop_counts,
                    &path_edges,
                    &self.edges,
                    dist[f],
                    weights,
                    &mut elevator_group_cache,
                    &mut nav_nodes_on_path,
                );

                if best_score.is_none_or(|b| score > b) {
                    best_score = Some(score);
                    best = Some((s, f, score));
                }
            }
        }

        best
    }
}

/// Finds nav nodes that can never win `best_pair`'s free (non-fixed) endpoint search because some
/// other node strictly dominates them, and returns every node *except* those -- a safe subset of
/// `0..nav.nodes.len()` that `best_pair` can search over instead of every nav node, without ever
/// changing which pair wins.
///
/// The dominated nodes are "plain dead-end tails": maze-editor mazes are typically riddled with
/// dead-end branches (a corridor that just stops), and along any such branch that is *plain* --
/// every hop on it is a plain bidirectional `Basic` edge, not one-way, not cross-floor/elevator/
/// teleport, and touches no split tile -- going one hop deeper strictly increases `path_weight`'s
/// contribution while strictly *not decreasing* any other score component: a plain hop is never a
/// junction (the one-node-wide tail has exactly one way forward, or zero at its very tip), never a
/// one-way/cross-floor/teleport/elevator-stop hit, and touches no split tile. Since every
/// `ScoreWeights` field is clamped to >= 0.0 (see `PARAMS`), a route ending one hop deeper along
/// such a tail scores >= a route ending at the shallower node reached from the very same outside
/// path, with strictly greater score whenever `path_weight > 0`. So the shallower node can never
/// win over the tail's own deepest point and is safe to drop from the free-endpoint search
/// entirely -- only that deepest point remains as a candidate for the whole tail.
///
/// This peels iteratively (not just one hop): once a node's only remaining plain neighbor is
/// peeled away, it can itself become a new plain dead end and get peeled on a later pass, so a
/// whole plain subtree collapses down to the single leaf furthest from the rest of the graph, the
/// same way repeatedly removing degree-<=1 nodes prunes a tree down to its non-leaf core. A node
/// touched by any non-plain edge (one-way, cross-floor, elevator, teleport, or a split tile) is
/// never peeled -- its dominance can't be proven that simply (e.g. a one-way edge means "one hop
/// deeper" may not even be reachable from every direction), so it and everything past it is left
/// for `best_pair`'s ordinary exhaustive search, same as before this pruning existed.
fn prune_dominated_tail_nodes(
    n: usize,
    edges: &[&NavEdge],
    oneway_flags: &[bool],
    cross_floor_flags: &[bool],
    teleport_flags: &[bool],
    split_counts: &[usize],
    split_flags: &[bool],
) -> Vec<NavNodeId> {
    // An edge is "plain" if it's part of a genuine two-way pair (not one-way -- `oneway_flags`
    // already reflects whether a live reverse exists), isn't cross-floor/elevator/teleport, and
    // its own tiles hold no split. `split_counts` excludes the edge's `from` node by construction
    // (see that fn's doc comment), which is exactly right here: whether `from` itself sits on a
    // split tile is a property of `from`, checked separately when `from` is considered as a
    // candidate leaf, not of this specific edge.
    let is_plain = |ei: usize| -> bool {
        !oneway_flags[ei] && !cross_floor_flags[ei] && !teleport_flags[ei] && split_counts[ei] == 0
    };

    // Undirected plain-neighbor adjacency, built once: `plain_neighbors[node]` lists every node
    // reachable from `node` by exactly one plain edge, in either direction (a plain edge is always
    // two-way, so `from`- and `to`-side both see each other here).
    let mut plain_neighbors: Vec<Vec<NavNodeId>> = vec![Vec::new(); n];
    let mut total_degree = vec![0usize; n];
    for (ei, e) in edges.iter().enumerate() {
        total_degree[e.from] += 1;
        if is_plain(ei) {
            plain_neighbors[e.from].push(e.to);
        }
    }

    // A node with a non-plain edge (elevator/teleport/cross-floor/one-way) is a "true anchor": a
    // real scoring-relevant branch point that must always survive as a candidate, since the
    // non-plain edge means a path can enter/leave it in ways a plain-only analysis can't account
    // for. A node sitting on a split tile is also a true anchor: `score_path` adds a flat split
    // bonus for the route's own start node (`split_flags`), independent of how deep it sits on its
    // tail, so a shallower split node isn't dominated by a deeper non-split one the way a plain
    // node is. Computed once from each node's original edges -- never changes as peeling proceeds.
    let is_true_anchor: Vec<bool> = (0..n)
        .map(|node| total_degree[node] != plain_neighbors[node].len() || split_flags[node])
        .collect();

    // A genuine plain branch point (original plain-degree >= 3, e.g. a T-junction in a cycle-free
    // tree maze) stays structurally in place -- peeling runs *through* it, collapsing each of its
    // dead-end branches down to one leaf, rather than stopping at the branch point the way it stops
    // at a true anchor. Whether the branch point itself can then be *dropped from the candidate
    // list* depends on how many of its branches turned out to be dead ends (see
    // `is_dominated_fork` below): one hop deeper into a dead-end branch always dominates stopping at
    // the branch point, for both a finish and a start endpoint. For a finish, the branch point isn't
    // counted as a junction at all while it's the route's own end (`route_aware_junction_flags`
    // never flags the last node), but going one hop deeper makes it a genuine mid-route node --
    // either it now has a junction (>= 2 ways forward once the arrival edge's reverse is excluded),
    // which can only ever add to the score, or it has exactly one way forward and contributes no
    // junction either way, so junction_count never *decreases* by going deeper. For a start, the
    // branch point is already counted as a junction by itself (its full outgoing set, no reverse to
    // exclude) whenever it has >= 2 outgoing edges, and going one hop deeper into a branch leaves it
    // a mid-route node whose *own* junction status is decided by the same ">= 2 ways forward, minus
    // the one just arrived from" rule -- with a plain-degree-3 branch point this is unchanged (still
    // exactly 2 ways forward), so it neither gains nor loses; a fork with more branches can only
    // gain more ways once one branch is now "the way arrived from", never fewer. Either way, every
    // other score component along the extra hop(s) is non-negative and `path_weight`'s own
    // contribution strictly grows, so the deeper node's score is never lower -- *provided* the
    // comparison is against a single genuine dead end and not some other route back into the graph
    // (e.g. the other side of a loop through this same fork), where no such monotonic hop-by-hop
    // argument holds.
    let is_plain_fork: Vec<bool> = (0..n)
        .map(|node| plain_neighbors[node].len() >= 3)
        .collect();
    let is_never_removed: Vec<bool> = (0..n)
        .map(|node| is_true_anchor[node] || is_plain_fork[node])
        .collect();

    // Union-Find over nodes connected *only* by plain edges -- used below to recognize a
    // connected component that is a bare straight line (every node plain-degree <= 2, no true
    // anchor and no plain fork anywhere): a genuine dead end at both ends and nothing else. Such a
    // component has no single point that all of it can be shown to funnel through, so both of its
    // extreme ends must survive as candidates.
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], x: usize) -> usize {
        if parent[x] != x {
            parent[x] = find(parent, parent[x]);
        }
        parent[x]
    }
    for (ei, e) in edges.iter().enumerate() {
        if is_plain(ei) {
            let (ra, rb) = (find(&mut parent, e.from), find(&mut parent, e.to));
            if ra != rb {
                parent[ra] = rb;
            }
        }
    }
    let component_root: Vec<usize> = (0..n).map(|node| find(&mut parent, node)).collect();
    let has_funnel_point: Vec<bool> = {
        let mut flags = vec![false; n];
        for node in 0..n {
            if is_never_removed[node] {
                flags[component_root[node]] = true;
            }
        }
        flags
    };

    // BFS peel from every genuine leaf (total_degree <= 1) inward, stopping at the first node that
    // must survive structurally (`is_never_removed` -- a true anchor, or a plain fork acting as a
    // pass-through) -- this collapses each plain tail down to nothing but its own anchor/fork (or,
    // for a plain fork, one leaf per branch), discovering the stopping point from the peel rather
    // than assuming a specific graph shape. A component that's a bare straight line
    // (`has_funnel_point` false for its root) is left completely untouched: peeling it down to a
    // single node would wrongly merge its two genuine dead ends into one, so nothing in it is
    // removed and both original ends remain candidates.
    let mut removed = vec![false; n];
    let mut queue: std::collections::VecDeque<NavNodeId> = (0..n)
        .filter(|&node| {
            !is_never_removed[node]
                && plain_neighbors[node].len() <= 1
                && has_funnel_point[component_root[node]]
        })
        .collect();
    let mut in_queue = vec![false; n];
    for &node in &queue {
        in_queue[node] = true;
    }

    // Tracks, for each plain fork, how many of its original branches turned out to be a plain
    // dead-end tail -- i.e. peeling ran all the way down to a single representative leaf sitting
    // right next to the fork. A branch that instead leads back into the rest of the graph (a loop,
    // another fork, a true anchor reached by some other route) never triggers this, since peeling
    // never reaches a degree-<=1 state along it. A plain counter suffices instead of tracking which
    // specific neighbor resolved: the BFS loop below visits each `node` this branch applies to at
    // most once (it's neither removed nor re-queued afterwards), so no fork can ever be
    // double-counted for the same branch.
    let mut resolved_dead_end_branches = vec![0usize; n];

    while let Some(node) = queue.pop_front() {
        in_queue[node] = false;
        if removed[node] || is_never_removed[node] {
            continue;
        }
        plain_neighbors[node].retain(|&nb| !removed[nb]);
        if plain_neighbors[node].len() > 1 {
            continue;
        }
        let Some(&neighbor) = plain_neighbors[node].first() else {
            // Isolated plain-only node with no anchor in its (single-node) component: nothing to
            // fold into, leave it as its own candidate.
            continue;
        };
        if is_never_removed[neighbor] {
            // `node`'s only remaining neighbor must itself survive structurally (true anchor or
            // plain fork) -- `node` is the deepest point of a single-hop tail off it, i.e. the one
            // representative this tail must keep. Peeling it away here would leave the tail with
            // zero candidates (and, if it's the only tail on this side, could leave `best_pair`
            // with no distinct start/finish pair to try at all).
            if is_plain_fork[neighbor] {
                resolved_dead_end_branches[neighbor] += 1;
            }
            continue;
        }

        removed[node] = true;
        plain_neighbors[neighbor].retain(|&nb| nb != node);
        if !is_never_removed[neighbor]
            && plain_neighbors[neighbor].len() <= 1
            && !in_queue[neighbor]
        {
            in_queue[neighbor] = true;
            queue.push_back(neighbor);
        }
    }

    // A plain fork is dominated by one of its own branch leaves -- and so safe to drop from the
    // candidate list -- only if all but (at most) one of its *original* branches resolved to a
    // dead-end tail above. If >= 2 branches instead lead back into the rest of the graph (e.g. two
    // sides of a loop meeting at this fork), there's no single dead-end leaf on the "outside" branch
    // to compare against, so the dominance proof doesn't apply and the fork must stay a candidate.
    let is_dominated_fork: Vec<bool> = (0..n)
        .map(|node| {
            is_plain_fork[node] && resolved_dead_end_branches[node] + 1 >= total_degree[node]
        })
        .collect();

    (0..n)
        .filter(|&node| !removed[node] && !is_dominated_fork[node])
        .collect()
}

fn oneway_flags(edges: &[&NavEdge]) -> Vec<bool> {
    let pairs: HashSet<(NavNodeId, NavNodeId)> = edges.iter().map(|e| (e.from, e.to)).collect();
    edges
        .iter()
        .map(|e| !pairs.contains(&(e.to, e.from)))
        .collect()
}

/// True for a single-hop edge crossing a floor boundary — `VerticalPassage`- or `Elevator`-kind
/// (`NavEdge::is_vertical`/`is_elevator`), independent of directionality (GitHub issue #535
/// follow-up).
fn cross_floor_flags(edges: &[&NavEdge]) -> Vec<bool> {
    edges
        .iter()
        .map(|e| e.is_vertical || e.is_elevator)
        .collect()
}

fn teleport_flags(edges: &[&NavEdge]) -> Vec<bool> {
    edges.iter().map(|e| e.is_teleport).collect()
}

/// True if `field.cell_of(node_id)` is a split tile (a field point with >= 2 nodes).
fn is_split_node<T: Tessellation>(field: &MultiLevelField<T>, node_id: crate::ids::NodeId) -> bool {
    field
        .level_of(node_id)
        .zip(field.cell_of(node_id))
        .is_some_and(|(level, point)| field.nodes_at(level, point).len() >= 2)
}

/// Per-nav-node split flag, keyed by `NavNodeId` — used only for a route's own start nav node
/// (`score_path`'s `nav_nodes_on_path[0]`, mirroring how `junction_flags` covers it), since
/// `split_counts` below deliberately excludes each edge's `from` node.
fn nav_node_split_flags<T: Tessellation>(nav: &NavGraph, field: &MultiLevelField<T>) -> Vec<bool> {
    nav.nodes
        .iter()
        .map(|n| is_split_node(field, n.node_id))
        .collect()
}

/// Per-edge count of split-tile occurrences (a field point with >= 2 nodes) among the edge's own
/// tiles, i.e. `path[1..]` — the `from` node is excluded so summing this over a route's edges
/// matches the split occurrences on the route's full tile path exactly once per hop, with no
/// double-count at the shared node between consecutive edges (see GitHub issue #261). The route's
/// very first node (edge 0's `from`, never anyone's `path[1..]`) is *not* covered here — callers
/// must add `nav_node_split_flags` for that node separately, the same way `score_path` adds edge
/// 0's `from` to `nav_nodes_on_path` for `junction_count`.
fn split_counts<T: Tessellation>(edges: &[&NavEdge], field: &MultiLevelField<T>) -> Vec<usize> {
    edges
        .iter()
        .map(|e| {
            e.path
                .iter()
                .skip(1)
                .filter(|&&node_id| is_split_node(field, node_id))
                .count()
        })
        .collect()
}

/// Maps every node that is an `Elevator` stop to that elevator's total distinct-floor stop count
/// (mirrors `quality_control::checks::elevator_core::elevator_groups`/`stop_floors`, but built
/// directly from `graph`/`field` rather than a full `Maze`, since callers here only ever have the
/// two separately — see `score_for_route`). One entry per stop node; nodes belonging to the same
/// elevator all map to the same count.
fn elevator_stop_counts_by_node<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
) -> HashMap<NodeId, usize> {
    let mut adjacency: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    for edge in graph.edges().filter(|e| e.kind == EdgeKind::Elevator) {
        adjacency.entry(edge.from).or_default().push(edge.to);
        adjacency.entry(edge.to).or_default().push(edge.from);
    }

    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut result: HashMap<NodeId, usize> = HashMap::new();

    for &start in adjacency.keys() {
        if visited.contains(&start) {
            continue;
        }
        let mut stack = vec![start];
        let mut component: Vec<NodeId> = Vec::new();
        while let Some(node) = stack.pop() {
            if !visited.insert(node) {
                continue;
            }
            component.push(node);
            for &neighbor in adjacency.get(&node).into_iter().flatten() {
                if !visited.contains(&neighbor) {
                    stack.push(neighbor);
                }
            }
        }

        let mut floors: Vec<usize> = component
            .iter()
            .filter_map(|&n| field.level_index_of(n))
            .collect();
        floors.sort_unstable();
        floors.dedup();
        let stop_count = floors.len();
        for node in component {
            result.insert(node, stop_count);
        }
    }

    result
}

/// Per-edge elevator-stop bonus count — see `ScoredPathContext::elevator_stop_counts`' doc
/// comment for the `max(0, stops - 2)` rule.
fn elevator_stop_counts<T: Tessellation>(
    edges: &[&NavEdge],
    graph: &Graph,
    field: &MultiLevelField<T>,
) -> Vec<usize> {
    let by_node = elevator_stop_counts_by_node(graph, field);
    edges
        .iter()
        .map(|e| {
            if !e.is_elevator {
                return 0;
            }
            by_node
                .get(&e.path[0])
                .map_or(0, |&stops| stops.saturating_sub(2))
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn score_path(
    nav: &NavGraph,
    oneway_flags: &[bool],
    cross_floor_flags: &[bool],
    teleport_flags: &[bool],
    split_counts: &[usize],
    split_flags: &[bool],
    elevator_stop_counts: &[usize],
    path_edge_indices: &[usize],
    edges: &[&NavEdge],
    path_tiles: usize,
    weights: &ScoreWeights,
    elevator_group_cache: &mut HashMap<
        NavNodeId,
        std::rc::Rc<std::collections::HashSet<NavNodeId>>,
    >,
    // Reused across every call in `best_pair`'s O(n^2) loop instead of allocating a fresh `Vec`
    // per candidate pair -- cleared (not reallocated) on every call.
    nav_nodes_on_path: &mut Vec<NavNodeId>,
) -> f64 {
    if path_edge_indices.is_empty() {
        return 0.0;
    }

    nav_nodes_on_path.clear();
    for (i, &ei) in path_edge_indices.iter().enumerate() {
        if i == 0 {
            nav_nodes_on_path.push(edges[ei].from);
        }
        nav_nodes_on_path.push(edges[ei].to);
    }

    let junction_count = route_aware_junction_flags(
        nav,
        nav_nodes_on_path,
        path_edge_indices,
        edges,
        elevator_group_cache,
    )
    .into_iter()
    .filter(|&j| j)
    .count() as f64;

    // Single pass over the path's edges instead of five separate filter/map/sum passes -- same
    // per-edge flags/counts, just accumulated together to avoid re-walking `path_edge_indices`
    // (and re-touching each `*_flags`/`*_counts` slice) once per weight category.
    let mut oneway_count = 0usize;
    let mut cross_floor_count = 0usize;
    let mut teleport_count = 0usize;
    let mut split_count = 0usize;
    let mut elevator_stop_count = 0usize;
    for &ei in path_edge_indices {
        if oneway_flags[ei] {
            oneway_count += 1;
        }
        if cross_floor_flags[ei] {
            cross_floor_count += 1;
        }
        if teleport_flags[ei] {
            teleport_count += 1;
        }
        split_count += split_counts[ei];
        elevator_stop_count += elevator_stop_counts[ei];
    }
    // split_counts covers every edge's own tiles except its `from` node (see split_counts' doc
    // comment) -- the route's very first node (nav_nodes_on_path[0], i.e. edge 0's `from`) is
    // added separately via split_flags, mirroring how nav_nodes_on_path itself includes it above.
    if split_flags[nav_nodes_on_path[0]] {
        split_count += 1;
    }

    path_tiles as f64 * weights.path_weight
        + junction_count * weights.junction_weight
        + split_count as f64 * weights.split_weight
        + oneway_count as f64 * weights.oneway_weight
        + cross_floor_count as f64 * weights.cross_floor_weight
        + teleport_count as f64 * weights.teleport_weight
        + elevator_stop_count as f64 * weights.elevator_stop_weight
}

/// Like the old `reconstruct_path_edges`, but writes into a caller-owned buffer instead of
/// allocating a fresh `Vec` per call -- `best_pair` calls this once per candidate pair (up to
/// `O(n^2)` times), so reusing one buffer across all of them avoids `O(n^2)` short-lived
/// allocations. Always clears `out` first, including on the "no path" case.
fn reconstruct_path_edges_into(
    edges: &[&NavEdge],
    prev_edge: &[Option<usize>],
    source: NavNodeId,
    target: NavNodeId,
    out: &mut Vec<usize>,
) {
    out.clear();
    let mut cur = target;
    while cur != source {
        match prev_edge[cur] {
            None => {
                out.clear();
                return;
            }
            Some(ei) => {
                out.push(ei);
                cur = edges[ei].from;
            }
        }
    }
    out.reverse();
}

#[cfg(test)]
#[path = "scored_endpoints_tests.rs"]
mod tests;
