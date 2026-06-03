use rand::{Rng, RngCore};
use crate::ids::NodeId;
use crate::graph::Graph;

pub struct MazeMeta {
    pub start: Option<NodeId>,
    pub finish: Option<NodeId>,
}

impl MazeMeta {
    pub fn empty() -> Self {
        Self { start: None, finish: None }
    }
}

pub trait Rule {
    fn apply(&self, graph: &mut Graph, meta: &mut MazeMeta, rng: &mut dyn RngCore);
}

pub struct RuleEngine {
    rules: Vec<Box<dyn Rule>>,
}

impl RuleEngine {
    pub fn new(rules: Vec<Box<dyn Rule>>) -> Self {
        Self { rules }
    }

    pub fn run(&self, graph: &mut Graph, meta: &mut MazeMeta, rng: &mut impl RngCore) {
        for rule in &self.rules {
            rule.apply(graph, meta, rng);
        }
    }
}

pub struct AssignStartRule;

impl Rule for AssignStartRule {
    fn apply(&self, graph: &mut Graph, meta: &mut MazeMeta, rng: &mut dyn RngCore) {
        if meta.start.is_some() {
            return;
        }
        let mut nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
        if nodes.is_empty() {
            return;
        }
        nodes.sort_unstable();
        let idx = rng.random_range(0..nodes.len());
        meta.start = Some(nodes[idx]);
    }
}

pub struct AssignFinishRule;

impl Rule for AssignFinishRule {
    fn apply(&self, graph: &mut Graph, meta: &mut MazeMeta, rng: &mut dyn RngCore) {
        if meta.finish.is_some() {
            return;
        }
        let candidates: Vec<NodeId> = match meta.start {
            Some(start) => {
                let mut v = graph.reachable_from(start);
                v.retain(|&id| id != start);
                v
            }
            None => {
                let mut v: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
                v.sort_unstable();
                v
            }
        };
        if candidates.is_empty() {
            return;
        }
        let idx = rng.random_range(0..candidates.len());
        meta.finish = Some(candidates[idx]);
    }
}

/// A rule that does nothing. Useful as a placeholder or in tests.
pub struct NoOpRule;

impl Rule for NoOpRule {
    fn apply(&self, _graph: &mut Graph, _meta: &mut MazeMeta, _rng: &mut dyn RngCore) {}
}
