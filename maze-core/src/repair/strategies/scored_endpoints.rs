use crate::Maze;
use crate::generation::PresetState;
use crate::graph::nav::{NavEdge, NavGraph, NavNodeId};
use crate::graph::pathfinding::{
    build_outgoing_index, dijkstra_with_prev, route_aware_junction_flags,
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
    let ctx = ScoredPathContext::build(nav, field, graph);
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

        let ctx = ScoredPathContext::build(nav, &maze.field, &maze.graph);

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
    outgoing_by_node: Vec<Vec<usize>>,
}

impl<'a> ScoredPathContext<'a> {
    fn build<T: Tessellation>(
        nav: &'a NavGraph,
        field: &MultiLevelField<T>,
        graph: &Graph,
    ) -> Self {
        let edges: Vec<&'a NavEdge> = nav.edges().collect();
        let oneway_flags = oneway_flags(&edges);
        let cross_floor_flags = cross_floor_flags(&edges);
        let teleport_flags = teleport_flags(&edges);
        let split_counts = split_counts(&edges, field);
        let split_flags = nav_node_split_flags(nav, field);
        let elevator_stop_counts = elevator_stop_counts(&edges, graph, field);
        let outgoing_by_node = build_outgoing_index(nav, &edges);
        Self {
            edges,
            oneway_flags,
            cross_floor_flags,
            teleport_flags,
            split_counts,
            split_flags,
            elevator_stop_counts,
            outgoing_by_node,
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

        let starts: Vec<NavNodeId> = match fixed_start {
            Some(s) => vec![s],
            None => (0..n).collect(),
        };

        let mut best_score: Option<f64> = None;
        let mut best: Option<(NavNodeId, NavNodeId, f64)> = None;
        // Shared across every candidate pair scored below -- the same elevator group is often
        // revisited by many different candidate paths, so memoizing its BFS here avoids
        // recomputing it once per candidate (GitHub issue #535 follow-up).
        let mut elevator_group_cache = HashMap::new();

        for &s in &starts {
            let (dist, prev_edge) = dijkstra_with_prev(nav, s, &self.edges, &self.outgoing_by_node);

            let finishes: Vec<NavNodeId> = match fixed_finish {
                Some(f) => vec![f],
                None => (0..n).collect(),
            };

            for f in finishes {
                if f == s {
                    continue;
                }
                if dist[f] == usize::MAX {
                    continue;
                }

                let path_edges = reconstruct_path_edges(&self.edges, &prev_edge, s, f);
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
                );

                if best_score.map_or(true, |b| score > b) {
                    best_score = Some(score);
                    best = Some((s, f, score));
                }
            }
        }

        best
    }
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

/// True if `field.point_of(node_id)` is a split tile (a field point with >= 2 nodes).
fn is_split_node<T: Tessellation>(field: &MultiLevelField<T>, node_id: crate::ids::NodeId) -> bool {
    field
        .level_of(node_id)
        .zip(field.point_of(node_id))
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
) -> f64 {
    if path_edge_indices.is_empty() {
        return 0.0;
    }

    let mut nav_nodes_on_path: Vec<NavNodeId> = Vec::new();
    for (i, &ei) in path_edge_indices.iter().enumerate() {
        if i == 0 {
            nav_nodes_on_path.push(edges[ei].from);
        }
        nav_nodes_on_path.push(edges[ei].to);
    }

    let junction_count = route_aware_junction_flags(
        nav,
        &nav_nodes_on_path,
        path_edge_indices,
        edges,
        elevator_group_cache,
    )
    .into_iter()
    .filter(|&j| j)
    .count() as f64;

    let oneway_count = path_edge_indices
        .iter()
        .filter(|&&ei| oneway_flags[ei])
        .count() as f64;

    let cross_floor_count = path_edge_indices
        .iter()
        .filter(|&&ei| cross_floor_flags[ei])
        .count() as f64;

    let teleport_count = path_edge_indices
        .iter()
        .filter(|&&ei| teleport_flags[ei])
        .count() as f64;

    // split_counts covers every edge's own tiles except its `from` node (see split_counts' doc
    // comment) -- the route's very first node (nav_nodes_on_path[0], i.e. edge 0's `from`) is
    // added separately via split_flags, mirroring how nav_nodes_on_path itself includes it above.
    let split_count = path_edge_indices
        .iter()
        .map(|&ei| split_counts[ei])
        .sum::<usize>() as f64
        + if split_flags[nav_nodes_on_path[0]] {
            1.0
        } else {
            0.0
        };

    let elevator_stop_count = path_edge_indices
        .iter()
        .map(|&ei| elevator_stop_counts[ei])
        .sum::<usize>() as f64;

    path_tiles as f64 * weights.path_weight
        + junction_count * weights.junction_weight
        + split_count * weights.split_weight
        + oneway_count * weights.oneway_weight
        + cross_floor_count * weights.cross_floor_weight
        + teleport_count * weights.teleport_weight
        + elevator_stop_count * weights.elevator_stop_weight
}

fn reconstruct_path_edges(
    edges: &[&NavEdge],
    prev_edge: &[Option<usize>],
    source: NavNodeId,
    target: NavNodeId,
) -> Vec<usize> {
    let mut result = Vec::new();
    let mut cur = target;
    while cur != source {
        match prev_edge[cur] {
            None => return vec![],
            Some(ei) => {
                result.push(ei);
                cur = edges[ei].from;
            }
        }
    }
    result.reverse();
    result
}

#[cfg(test)]
#[path = "scored_endpoints_tests.rs"]
mod tests;
