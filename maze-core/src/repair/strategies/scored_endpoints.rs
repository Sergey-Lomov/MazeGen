use std::collections::{BinaryHeap, HashSet};
use std::cmp::Reverse;
use rand::RngCore;
use crate::Maze;
use crate::space::Field;
use crate::graph::nav::{NavGraph, NavNodeId};
use crate::quality_control::Issue;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;

pub const PARAM_PATH_WEIGHT: &str = "path_weight";
pub const PARAM_JUNCTION_WEIGHT: &str = "junction_weight";
pub const PARAM_ONEWAY_WEIGHT: &str = "oneway_weight";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_PATH_WEIGHT,
        label: "Path length weight",
        kind: StrategyParamKind::Float { default: 1.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_JUNCTION_WEIGHT,
        label: "Junction weight",
        kind: StrategyParamKind::Float { default: 3.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_ONEWAY_WEIGHT,
        label: "One-way passage weight",
        kind: StrategyParamKind::Float { default: 5.0, min: 0.0, max: 100.0 },
    },
];

pub struct ScoredEndpointsStrategy;

impl<F: Field> RepairStrategy<F> for ScoredEndpointsStrategy {
    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        _issue: &Issue,
        maze: &mut Maze<F>,
        _rng: &mut dyn RngCore,
        params: &StrategyParams,
    ) -> RepairResult {
        if maze.meta.start.is_some() && maze.meta.finish.is_some() {
            return RepairResult::Fixed { score: None };
        }

        let path_weight = params.get(PARAM_PATH_WEIGHT)
            .and_then(|v| v.as_float()).unwrap_or(1.0);
        let junction_weight = params.get(PARAM_JUNCTION_WEIGHT)
            .and_then(|v| v.as_float()).unwrap_or(3.0);
        let oneway_weight = params.get(PARAM_ONEWAY_WEIGHT)
            .and_then(|v| v.as_float()).unwrap_or(5.0);

        let nav = maze.analysis.nav_graph(&maze.graph);

        if nav.nodes.is_empty() {
            return RepairResult::Failed;
        }

        let edges: Vec<_> = nav.edges().collect();
        let junction_flags = junction_flags(nav);
        let oneway_flags = oneway_flags(&edges);
        let outgoing_by_node = outgoing_by_node(nav, &edges);

        let achieved_score;

        match (maze.meta.start, maze.meta.finish) {
            (None, None) => {
                let best = best_pair(
                    nav, &edges, &junction_flags, &oneway_flags, &outgoing_by_node,
                    None, None, path_weight, junction_weight, oneway_weight,
                );
                match best {
                    Some((s, f, score)) => {
                        maze.meta.start = Some(nav.nodes[s].node_id);
                        maze.meta.finish = Some(nav.nodes[f].node_id);
                        achieved_score = score;
                    }
                    None => return RepairResult::Failed,
                }
            }
            (Some(start), None) => {
                let start_nav = match nav.nav_node_for(start) {
                    Some(id) => id,
                    None => return RepairResult::Failed,
                };
                let best = best_pair(
                    nav, &edges, &junction_flags, &oneway_flags, &outgoing_by_node,
                    Some(start_nav), None, path_weight, junction_weight, oneway_weight,
                );
                match best {
                    Some((_, f, score)) => {
                        maze.meta.finish = Some(nav.nodes[f].node_id);
                        achieved_score = score;
                    }
                    None => return RepairResult::Failed,
                }
            }
            (None, Some(finish)) => {
                let finish_nav = match nav.nav_node_for(finish) {
                    Some(id) => id,
                    None => return RepairResult::Failed,
                };
                let best = best_pair(
                    nav, &edges, &junction_flags, &oneway_flags, &outgoing_by_node,
                    None, Some(finish_nav), path_weight, junction_weight, oneway_weight,
                );
                match best {
                    Some((s, _, score)) => {
                        maze.meta.start = Some(nav.nodes[s].node_id);
                        achieved_score = score;
                    }
                    None => return RepairResult::Failed,
                }
            }
            (Some(_), Some(_)) => unreachable!(),
        }

        RepairResult::Fixed { score: Some(achieved_score) }
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

fn oneway_flags(edges: &[&crate::graph::nav::NavEdge]) -> Vec<bool> {
    let pairs: HashSet<(NavNodeId, NavNodeId)> = edges.iter().map(|e| (e.from, e.to)).collect();
    edges.iter().map(|e| !pairs.contains(&(e.to, e.from))).collect()
}

fn outgoing_by_node(nav: &NavGraph, edges: &[&crate::graph::nav::NavEdge]) -> Vec<Vec<usize>> {
    let mut out = vec![Vec::new(); nav.nodes.len()];
    for (ei, e) in edges.iter().enumerate() {
        out[e.from].push(ei);
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn best_pair(
    nav: &NavGraph,
    edges: &[&crate::graph::nav::NavEdge],
    junction_flags: &[bool],
    oneway_flags: &[bool],
    outgoing_by_node: &[Vec<usize>],
    fixed_start: Option<NavNodeId>,
    fixed_finish: Option<NavNodeId>,
    path_weight: f64,
    junction_weight: f64,
    oneway_weight: f64,
) -> Option<(NavNodeId, NavNodeId, f64)> {
    let n = nav.nodes.len();

    let starts: Vec<NavNodeId> = match fixed_start {
        Some(s) => vec![s],
        None => (0..n).collect(),
    };

    let mut best_score: Option<f64> = None;
    let mut best: Option<(NavNodeId, NavNodeId, f64)> = None;

    for &s in &starts {
        let (dist, prev_edge) = dijkstra(edges, outgoing_by_node, n, s);

        let finishes: Vec<NavNodeId> = match fixed_finish {
            Some(f) => vec![f],
            None => (0..n).collect(),
        };

        for f in finishes {
            if f == s { continue; }
            if dist[f] == usize::MAX { continue; }

            let path_edges = reconstruct_path_edges(edges, &prev_edge, s, f);
            let score = score_path(
                junction_flags, oneway_flags, &path_edges, edges, dist[f],
                path_weight, junction_weight, oneway_weight,
            );

            if best_score.map_or(true, |b| score > b) {
                best_score = Some(score);
                best = Some((s, f, score));
            }
        }
    }

    best
}

fn score_path(
    junction_flags: &[bool],
    oneway_flags: &[bool],
    path_edge_indices: &[usize],
    edges: &[&crate::graph::nav::NavEdge],
    path_tiles: usize,
    path_weight: f64,
    junction_weight: f64,
    oneway_weight: f64,
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

    path_tiles as f64 * path_weight
        + junction_count * junction_weight
        + oneway_count * oneway_weight
}

fn dijkstra(
    edges: &[&crate::graph::nav::NavEdge],
    outgoing_by_node: &[Vec<usize>],
    n: usize,
    source: NavNodeId,
) -> (Vec<usize>, Vec<Option<usize>>) {
    let mut dist = vec![usize::MAX; n];
    let mut prev_edge = vec![None::<usize>; n];
    let mut heap: BinaryHeap<Reverse<(usize, NavNodeId)>> = BinaryHeap::new();

    dist[source] = 0;
    heap.push(Reverse((0, source)));

    while let Some(Reverse((cost, u))) = heap.pop() {
        if dist[u] < cost { continue; }
        for &ei in &outgoing_by_node[u] {
            let e = edges[ei];
            let weight = e.path.len().saturating_sub(1);
            let next_cost = cost + weight;
            if next_cost < dist[e.to] {
                dist[e.to] = next_cost;
                prev_edge[e.to] = Some(ei);
                heap.push(Reverse((next_cost, e.to)));
            }
        }
    }

    (dist, prev_edge)
}

fn reconstruct_path_edges(
    edges: &[&crate::graph::nav::NavEdge],
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
