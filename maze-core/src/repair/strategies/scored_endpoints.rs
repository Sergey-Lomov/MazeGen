use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::space::{Field, Tessellation};
use crate::graph::nav::{NavGraph, NavNodeId, NavEdge};
use crate::graph::pathfinding::{dijkstra_with_prev, build_outgoing_index};
use crate::quality_control::MissingEndpointsIssue;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use crate::generation::PresetState;

pub const PARAM_PATH_WEIGHT: &str = "path_weight";
pub const PARAM_JUNCTION_WEIGHT: &str = "junction_weight";
pub const PARAM_ONEWAY_WEIGHT: &str = "oneway_weight";
pub const PARAM_TELEPORT_WEIGHT: &str = "teleport_weight";
pub const PARAM_SPLIT_WEIGHT: &str = "split_weight";

const DEFAULT_PATH_WEIGHT: f64 = 1.0;
const DEFAULT_JUNCTION_WEIGHT: f64 = 3.0;
const DEFAULT_ONEWAY_WEIGHT: f64 = 5.0;
const DEFAULT_TELEPORT_WEIGHT: f64 = 5.0;
const DEFAULT_SPLIT_WEIGHT: f64 = 5.0;

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_PATH_WEIGHT,
        label: "Path length weight",
        kind: StrategyParamKind::Float { default: DEFAULT_PATH_WEIGHT, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_JUNCTION_WEIGHT,
        label: "Junction weight",
        kind: StrategyParamKind::Float { default: DEFAULT_JUNCTION_WEIGHT, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_ONEWAY_WEIGHT,
        label: "One-way passage weight",
        kind: StrategyParamKind::Float { default: DEFAULT_ONEWAY_WEIGHT, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_TELEPORT_WEIGHT,
        label: "Teleport weight",
        kind: StrategyParamKind::Float { default: DEFAULT_TELEPORT_WEIGHT, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_SPLIT_WEIGHT,
        label: "Split tile weight",
        kind: StrategyParamKind::Float { default: DEFAULT_SPLIT_WEIGHT, min: 0.0, max: 100.0 },
    },
];

pub struct ScoredEndpointsStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for ScoredEndpointsStrategy {
    fn strategy_id(&self) -> &'static str { "scored_endpoints" }

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

        let path_weight    = params.get(PARAM_PATH_WEIGHT).and_then(|v| v.as_float()).unwrap_or(DEFAULT_PATH_WEIGHT);
        let junction_weight = params.get(PARAM_JUNCTION_WEIGHT).and_then(|v| v.as_float()).unwrap_or(DEFAULT_JUNCTION_WEIGHT);
        let oneway_weight  = params.get(PARAM_ONEWAY_WEIGHT).and_then(|v| v.as_float()).unwrap_or(DEFAULT_ONEWAY_WEIGHT);
        let teleport_weight = params.get(PARAM_TELEPORT_WEIGHT).and_then(|v| v.as_float()).unwrap_or(DEFAULT_TELEPORT_WEIGHT);
        let split_weight   = params.get(PARAM_SPLIT_WEIGHT).and_then(|v| v.as_float()).unwrap_or(DEFAULT_SPLIT_WEIGHT);

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;

        if nav.nodes.is_empty() {
            return (RepairResult::Failed, vec![]);
        }

        let ctx = ScoredPathContext::build(nav, &maze.field);
        let weights = ScoreWeights { path_weight, junction_weight, oneway_weight, teleport_weight, split_weight };

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

        let Some((s, f, achieved_score)) = ctx.best_pair(nav, fixed_start, fixed_finish, &weights) else {
            return (RepairResult::Failed, vec![]);
        };

        let mut commands = Vec::new();
        if issue.missing_start { commands.push(MutationCommand::SetStart(nav.nodes[s].node_id)); }
        if issue.missing_finish { commands.push(MutationCommand::SetFinish(nav.nodes[f].node_id)); }

        (RepairResult::Fixed { score: Some(achieved_score) }, commands)
    }
}

crate::impl_erased_repair_strategy!(ScoredEndpointsStrategy, MissingEndpointsIssue);

struct ScoreWeights {
    path_weight:    f64,
    junction_weight: f64,
    oneway_weight:  f64,
    teleport_weight: f64,
    split_weight:   f64,
}

/// Precomputed data derived from NavGraph for scoring endpoint pairs.
struct ScoredPathContext<'a> {
    edges:           Vec<&'a NavEdge>,
    junction_flags:  Vec<bool>,
    oneway_flags:    Vec<bool>,
    teleport_flags:  Vec<bool>,
    /// Per-edge count of split-tile occurrences among the edge's own tiles (its `to` node plus,
    /// for corridor edges, every interior node) — the edge's `from` node is excluded so a route's
    /// per-edge counts sum to the split occurrences on the full tile path without double-counting
    /// the shared node between consecutive edges (mirrors `routing::build_maze_path`'s split).
    /// Does not cover the route's own start node — see `split_flags`.
    split_counts:    Vec<usize>,
    /// Per-nav-node split flag — only ever consulted for a route's start nav node (the one node
    /// `split_counts` structurally excludes from every edge).
    split_flags:     Vec<bool>,
    outgoing_by_node: Vec<Vec<usize>>,
}

impl<'a> ScoredPathContext<'a> {
    fn build<T: Tessellation>(nav: &'a NavGraph, field: &Field<T>) -> Self {
        let edges: Vec<&'a NavEdge> = nav.edges().collect();
        let junction_flags = junction_flags(nav);
        let oneway_flags   = oneway_flags(&edges);
        let teleport_flags = teleport_flags(&edges);
        let split_counts   = split_counts(&edges, field);
        let split_flags    = nav_node_split_flags(nav, field);
        let outgoing_by_node = build_outgoing_index(nav, &edges);
        Self { edges, junction_flags, oneway_flags, teleport_flags, split_counts, split_flags, outgoing_by_node }
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

        for &s in &starts {
            let (dist, prev_edge) = dijkstra_with_prev(nav, s, &self.edges, &self.outgoing_by_node);

            let finishes: Vec<NavNodeId> = match fixed_finish {
                Some(f) => vec![f],
                None => (0..n).collect(),
            };

            for f in finishes {
                if f == s { continue; }
                if dist[f] == usize::MAX { continue; }

                let path_edges = reconstruct_path_edges(&self.edges, &prev_edge, s, f);
                let score = score_path(
                    &self.junction_flags, &self.oneway_flags, &self.teleport_flags,
                    &self.split_counts, &self.split_flags,
                    &path_edges, &self.edges, dist[f], weights,
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

fn junction_flags(nav: &NavGraph) -> Vec<bool> {
    nav.nodes.iter().enumerate().map(|(i, _)| {
        let mut neighbors = HashSet::new();
        for e in nav.outgoing_edges(i) { neighbors.insert(e.to); }
        for e in nav.incoming_edges(i) { neighbors.insert(e.from); }
        neighbors.len() >= 3
    }).collect()
}

fn oneway_flags(edges: &[&NavEdge]) -> Vec<bool> {
    let pairs: HashSet<(NavNodeId, NavNodeId)> = edges.iter().map(|e| (e.from, e.to)).collect();
    edges.iter().map(|e| !pairs.contains(&(e.to, e.from))).collect()
}

/// Flags each NavEdge that is itself teleport-backed (`NavEdge::is_teleport`, GitHub issue #197).
/// A corridor-compressed NavEdge is always Basic hops end to end (teleport endpoints are never
/// compressed into a corridor's interior), so this is equivalent to "path crosses a Teleport edge".
fn teleport_flags(edges: &[&NavEdge]) -> Vec<bool> {
    edges.iter().map(|e| e.is_teleport).collect()
}

/// True if `field.point_of(node_id)` is a split tile (a field point with >= 2 nodes).
fn is_split_node<T: Tessellation>(field: &Field<T>, node_id: crate::ids::NodeId) -> bool {
    field.point_of(node_id).is_some_and(|point| field.nodes_at(point).len() >= 2)
}

/// Per-nav-node split flag, keyed by `NavNodeId` — used only for a route's own start nav node
/// (`score_path`'s `nav_nodes_on_path[0]`, mirroring how `junction_flags` covers it), since
/// `split_counts` below deliberately excludes each edge's `from` node.
fn nav_node_split_flags<T: Tessellation>(nav: &NavGraph, field: &Field<T>) -> Vec<bool> {
    nav.nodes.iter().map(|n| is_split_node(field, n.node_id)).collect()
}

/// Per-edge count of split-tile occurrences (a field point with >= 2 nodes) among the edge's own
/// tiles, i.e. `path[1..]` — the `from` node is excluded so summing this over a route's edges
/// matches the split occurrences on the route's full tile path exactly once per hop, with no
/// double-count at the shared node between consecutive edges (see GitHub issue #261). The route's
/// very first node (edge 0's `from`, never anyone's `path[1..]`) is *not* covered here — callers
/// must add `nav_node_split_flags` for that node separately, the same way `score_path` adds edge
/// 0's `from` to `nav_nodes_on_path` for `junction_count`.
fn split_counts<T: Tessellation>(edges: &[&NavEdge], field: &Field<T>) -> Vec<usize> {
    edges.iter().map(|e| {
        e.path.iter().skip(1).filter(|&&node_id| is_split_node(field, node_id)).count()
    }).collect()
}

fn score_path(
    junction_flags: &[bool],
    oneway_flags: &[bool],
    teleport_flags: &[bool],
    split_counts: &[usize],
    split_flags: &[bool],
    path_edge_indices: &[usize],
    edges: &[&NavEdge],
    path_tiles: usize,
    weights: &ScoreWeights,
) -> f64 {
    if path_edge_indices.is_empty() {
        return 0.0;
    }

    let mut nav_nodes_on_path: Vec<NavNodeId> = Vec::new();
    for (i, &ei) in path_edge_indices.iter().enumerate() {
        if i == 0 { nav_nodes_on_path.push(edges[ei].from); }
        nav_nodes_on_path.push(edges[ei].to);
    }

    let junction_count = nav_nodes_on_path.iter()
        .filter(|&&nid| junction_flags[nid])
        .count() as f64;

    let oneway_count = path_edge_indices.iter()
        .filter(|&&ei| oneway_flags[ei])
        .count() as f64;

    let teleport_count = path_edge_indices.iter()
        .filter(|&&ei| teleport_flags[ei])
        .count() as f64;

    // split_counts covers every edge's own tiles except its `from` node (see split_counts' doc
    // comment) -- the route's very first node (nav_nodes_on_path[0], i.e. edge 0's `from`) is
    // added separately via split_flags, mirroring how nav_nodes_on_path itself includes it above.
    let split_count = path_edge_indices.iter()
        .map(|&ei| split_counts[ei])
        .sum::<usize>() as f64
        + if split_flags[nav_nodes_on_path[0]] { 1.0 } else { 0.0 };

    path_tiles as f64 * weights.path_weight
        + junction_count * weights.junction_weight
        + split_count * weights.split_weight
        + oneway_count * weights.oneway_weight
        + teleport_count * weights.teleport_weight
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
