use rand::RngCore;
use crate::graph::Graph;
use crate::ids::NodeId;
use crate::space::Field;
use super::elements::EdgeWeights;

/// Phase 2 decorator: modifies edges in the graph after the spanning tree is built.
pub trait EdgeApplicator<F: Field> {
    fn apply(&self, graph: &mut Graph, field: &F, rng: &mut dyn RngCore);
}

/// Converts some bidirectional edges to one-way passages.
///
/// For each bidirectional pair (A↔B), rolls against one_way_probability and
/// removes one direction at random. Average conversion rate ≈ one_way_probability.
pub struct OneWayApplicator {
    pub weights: EdgeWeights,
}

impl<F: Field> EdgeApplicator<F> for OneWayApplicator {
    fn apply(&self, graph: &mut Graph, _field: &F, rng: &mut dyn RngCore) {
        let p = self.weights.one_way_probability();
        if p <= 0.0 { return; }

        // Collect all bidirectional pairs (a, b) where a < b to avoid duplicates.
        // Two passes to avoid holding borrow across mutation.
        let node_ids: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
        let mut pairs: Vec<(NodeId, NodeId)> = Vec::new();
        for &a in &node_ids {
            for b in graph.outgoing_neighbors(a).collect::<Vec<_>>() {
                if b > a && graph.edge_between(b, a).is_some() {
                    pairs.push((a, b));
                }
            }
        }

        use rand::Rng;
        for (a, b) in pairs {
            if rng.random::<f64>() < p {
                // Keep only one direction; remove the other at random.
                if rng.random::<bool>() {
                    // Keep A→B, remove B→A
                    if let Some(eid) = graph.edge_between(b, a) {
                        graph.remove_edge(eid);
                    }
                } else {
                    // Keep B→A, remove A→B
                    if let Some(eid) = graph.edge_between(a, b) {
                        graph.remove_edge(eid);
                    }
                }
            }
        }
    }
}
