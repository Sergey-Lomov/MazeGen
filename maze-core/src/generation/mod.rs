pub mod pipeline;
pub mod elements;
pub mod applicators;

use std::collections::{HashSet, VecDeque};
use rand::{SeedableRng, Rng};
use rand::rngs::SmallRng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::Field;
use elements::{VertexWeights, GenerationConfig};
use applicators::EdgeApplicator;

/// Generate a maze graph in two phases.
///
/// Phase 1: controlled graph growth.
///   Each node is popped from the frontier and expanded: it adds edges up to
///   its sampled target degree. On each edge addition the algorithm chooses
///   between a tree-edge (to an unqueued neighbour) and a back-edge (cycle,
///   to an already-queued neighbour that has not yet reached max_degree).
///   `cycle_prob` controls that choice. Connectivity is guaranteed: when the
///   frontier would empty before all nodes are covered, a forced tree-edge
///   bridges the gap.
///
/// Phase 2: applicators mutate edges (e.g. one-way passages).
pub fn generate_maze<F: Field>(
    graph: &mut Graph,
    field: &F,
    seed: u64,
    start: NodeId,
    config: &GenerationConfig,
    applicators: &[Box<dyn EdgeApplicator<F>>],
) {
    let mut rng = SmallRng::seed_from_u64(seed);

    // queued: node has been scheduled (in frontier or already expanded).
    let mut queued: HashSet<NodeId> = HashSet::new();
    let mut frontier: VecDeque<NodeId> = VecDeque::new();

    queued.insert(start);
    frontier.push_back(start);

    // Pre-collect all node ids for coverage loop (sorted for determinism).
    let mut all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
    all_nodes.sort_unstable();

    // Drain frontier; when it empties, seed next unqueued node.
    let mut coverage_iter = all_nodes.iter().peekable();
    loop {
        // Advance coverage cursor past already-queued nodes.
        while coverage_iter.peek().map_or(false, |&&n| queued.contains(&n)) {
            coverage_iter.next();
        }

        if frontier.is_empty() {
            match coverage_iter.next() {
                None => break, // all nodes queued, done
                Some(&next) => {
                    queued.insert(next);
                    frontier.push_back(next);
                }
            }
        }

        let current = frontier.pop_front().unwrap();
        let target = sample_target(&mut rng, &config.vertex_weights);
        let already = graph.bidirectional_degree(current);
        let remaining = target.saturating_sub(already);

        for step in 0..remaining {
            let tree_candidates: Vec<NodeId> = field
                .neighbors(current)
                .into_iter()
                .filter(|&n| !queued.contains(&n) && graph.edge_between(current, n).is_none())
                .collect();

            let back_candidates: Vec<NodeId> = field
                .neighbors(current)
                .into_iter()
                .filter(|&n| {
                    queued.contains(&n)
                    && graph.edge_between(current, n).is_none()
                    && graph.bidirectional_degree(n) < config.max_degree
                })
                .collect();

            // Connectivity rule: if this is the last tree step we can take AND
            // frontier would be empty after (no other node can bridge), force tree.
            let force_tree = !tree_candidates.is_empty()
                && frontier.is_empty()
                && step == 0
                && coverage_iter.peek().is_some();

            let chosen = if force_tree {
                // Must take tree-edge to keep connectivity.
                pick(&mut rng, &tree_candidates)
            } else if tree_candidates.is_empty() && back_candidates.is_empty() {
                break;
            } else if tree_candidates.is_empty() {
                pick(&mut rng, &back_candidates)
            } else if back_candidates.is_empty() || rng.random::<f64>() >= config.cycle_prob {
                pick(&mut rng, &tree_candidates)
            } else {
                pick(&mut rng, &back_candidates)
            };

            let is_tree = !queued.contains(&chosen);
            graph.add_bidirectional_edge(current, chosen, EdgeKind::Basic);

            if is_tree {
                queued.insert(chosen);
                frontier.push_back(chosen);
                // Advance coverage past this node so coverage_iter stays consistent.
                while coverage_iter.peek().map_or(false, |&&n| queued.contains(&n)) {
                    coverage_iter.next();
                }
            }
        }
    }

    // Phase 2: edge applicators
    for applicator in applicators {
        applicator.apply(graph, field, &mut rng);
    }
}

fn pick(rng: &mut SmallRng, candidates: &[NodeId]) -> NodeId {
    let mut sorted = candidates.to_vec();
    sorted.sort_unstable();
    sorted[rng.random_range(0..sorted.len())]
}

/// Sample a target degree >= 1 using vertex_weights.
fn sample_target(rng: &mut SmallRng, weights: &VertexWeights) -> usize {
    let n = weights.weights.len();
    if n == 0 {
        return 1;
    }

    let total: f64 = (0..n).map(|i| weights.get(i)).sum();
    if total <= 0.0 {
        return 1;
    }

    let mut roll = rng.random::<f64>() * total;
    for i in 0..n {
        roll -= weights.get(i);
        if roll <= 0.0 {
            return i.max(1);
        }
    }
    n.saturating_sub(1).max(1)
}
