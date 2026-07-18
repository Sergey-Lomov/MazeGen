pub mod nav;
pub mod scc;
pub mod classify;
pub mod stats;
pub mod routing;
pub mod graph_analytics;
pub mod region_class;
pub mod route_protection;
pub(crate) mod pathfinding;
pub(crate) mod cycles;
pub(crate) mod distance_map;

use std::collections::{HashMap, HashSet, VecDeque};
use crate::ids::{NodeId, EdgeId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub id: NodeId,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum EdgeKind {
    Basic,
    Teleport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub id: EdgeId,
    pub from: NodeId,
    pub to: NodeId,
    pub kind: EdgeKind,
}

#[derive(Debug, Clone)]
pub struct Graph {
    nodes: Vec<Node>,
    edges: Vec<Option<Edge>>,
    outgoing: HashMap<NodeId, Vec<EdgeId>>,
    incoming: HashMap<NodeId, Vec<EdgeId>>,
    version: u64,
}

impl Graph {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            outgoing: HashMap::new(),
            incoming: HashMap::new(),
            version: 0,
        }
    }

    /// Bumped on every edge insertion/removal that actually changes the edge set. Lets cache
    /// layers (`MazeAnalysis`) detect that previously cached derived data is stale, instead of
    /// relying on callers to remember to invalidate by hand. Node additions don't bump it —
    /// they can't make a cached cycle/nav-graph result wrong, only edges can.
    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn add_node(&mut self, id: NodeId) {
        self.nodes.push(Node { id });
        self.outgoing.insert(id, Vec::new());
        self.incoming.insert(id, Vec::new());
    }

    pub(crate) fn add_edge(&mut self, from: NodeId, to: NodeId, kind: EdgeKind) -> EdgeId {
        debug_assert!(self.outgoing.contains_key(&from), "add_edge: node {from} not in graph");
        debug_assert!(self.incoming.contains_key(&to), "add_edge: node {to} not in graph");
        if let Some(existing) = self.edge_between_kind(from, to, &kind) {
            return existing;
        }
        let id = self.edges.len();
        self.edges.push(Some(Edge { id, from, to, kind }));
        self.outgoing.entry(from).or_default().push(id);
        self.incoming.entry(to).or_default().push(id);
        self.version += 1;
        id
    }

    /// Dedup lookup used by `add_edge` — only matches an existing edge of the same `kind`,
    /// so a `Teleport` edge can coexist with a `Basic` edge in the same direction between the
    /// same pair (e.g. a tile already reachable by a normal passage can also have a teleport
    /// into it). Private: callers needing "any kind" use the public `edge_between` instead.
    fn edge_between_kind(&self, from: NodeId, to: NodeId, kind: &EdgeKind) -> Option<EdgeId> {
        self.outgoing.get(&from)?.iter().find(|&&eid| {
            self.edges[eid].as_ref().map_or(false, |e| e.to == to && &e.kind == kind)
        }).copied()
    }

    pub(crate) fn add_bidirectional_edge(&mut self, a: NodeId, b: NodeId, kind: EdgeKind) -> (EdgeId, EdgeId) {
        let ab = self.add_edge(a, b, kind.clone());
        let ba = self.add_edge(b, a, kind);
        (ab, ba)
    }

    /// Adds a directed edge with no `PresetState` check — for building the initial graph
    /// from caller-trusted preset/post-edit data (before generation/repair starts) or for
    /// hand-built test fixtures, not for mutating an already-generated graph. Generation
    /// algorithms and repair strategies must go through the `try_add_edge`/`try_remove_edge`/
    /// `try_add_bidirectional_edge` helpers in `generation::mod` instead.
    pub fn build_initial_edge(&mut self, from: NodeId, to: NodeId, kind: EdgeKind) -> EdgeId {
        self.add_edge(from, to, kind)
    }

    /// Bidirectional counterpart of `build_initial_edge` — same unchecked-construction contract.
    pub fn build_initial_bidirectional_edge(&mut self, a: NodeId, b: NodeId, kind: EdgeKind) -> (EdgeId, EdgeId) {
        self.add_bidirectional_edge(a, b, kind)
    }

    /// Removes an edge with no `PresetState` check — same unchecked-construction contract as
    /// `build_initial_edge`, for hand-built test fixtures and graph setup. Repair strategies
    /// must go through `try_remove_edge` in `generation::mod` instead.
    pub fn remove_initial_edge(&mut self, id: EdgeId) {
        self.remove_edge(id);
    }

    pub(crate) fn remove_edge(&mut self, id: EdgeId) {
        if let Some(edge) = self.edges[id].take() {
            self.outgoing.entry(edge.from).and_modify(|v| v.retain(|&e| e != id));
            self.incoming.entry(edge.to).and_modify(|v| v.retain(|&e| e != id));
            self.version += 1;
        }
    }

    pub fn outgoing_neighbors(&self, node: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        self.outgoing
            .get(&node)
            .into_iter()
            .flat_map(|ids| ids.iter())
            .filter_map(move |&eid| {
                self.edges[eid].as_ref().map(|e| e.to)
            })
    }

    pub fn incoming_neighbors(&self, node: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        self.incoming
            .get(&node)
            .into_iter()
            .flat_map(|ids| ids.iter())
            .filter_map(move |&eid| {
                self.edges[eid].as_ref().map(|e| e.from)
            })
    }

    pub fn edge(&self, id: EdgeId) -> Option<&Edge> {
        self.edges.get(id).and_then(Option::as_ref)
    }

    /// Returns the first edge between the pair, of any `EdgeKind` — since `Teleport` edges may
    /// coexist with a `Basic` edge in the same direction (see `add_edge`'s kind-aware dedup),
    /// this can return an arbitrary one of possibly several matching edges. Callers that need a
    /// specific kind must filter `edges()` themselves; the private `edge_between_kind` is used
    /// internally by `add_edge` for that purpose.
    pub fn edge_between(&self, from: NodeId, to: NodeId) -> Option<EdgeId> {
        self.outgoing.get(&from)?.iter().find(|&&eid| {
            self.edges[eid].as_ref().map_or(false, |e| e.to == to)
        }).copied()
    }

    /// Structural-only dry-run for a `MutationCommand` builder (`cmd_remove_edge`/
    /// `cmd_remove_edge_by_id`/`cmd_remove_teleport_with_reverse` in `generation::mod`, GitHub
    /// issue #118): is there an edge to remove at all. Does not consult `PresetState` — that stays
    /// the caller's own concern (`generation::remove_edge_between_feasible`/`try_remove_*`), same
    /// separation of concerns as today. Advisory only: used by a strategy building its own
    /// `Vec<MutationCommand>` to decide whether emitting a command is worthwhile, never by
    /// `apply_commands` at commit time (which calls the real `try_*` helper instead — see
    /// `Specs/repair.md`).
    ///
    /// There is no `can_add_edge` counterpart: every `try_add_*` helper is completion-aware/
    /// idempotent (adds whichever direction is missing, or is a no-op if the edge already exists),
    /// so an add command never fails for a structural reason — only removal has a real
    /// "does this even exist" structural precondition worth checking ahead of time.
    pub(crate) fn can_remove_edge(&self, id: EdgeId) -> bool {
        self.edge(id).is_some()
    }

    /// Returns the opposite-direction `Teleport` edge of a two-way teleport, if any — `id` must
    /// itself be a `Teleport` edge. A two-way teleport is two independent `EdgeId`s in this graph
    /// (no `reverse_edge` link like `NavEdge` has), so this scans for a `Teleport` edge going
    /// `to -> from`. `None` if `id` doesn't exist, isn't a `Teleport`, or has no reverse
    /// (a one-way teleport).
    pub fn teleport_reverse(&self, id: EdgeId) -> Option<EdgeId> {
        let edge = self.edge(id)?;
        if edge.kind != EdgeKind::Teleport { return None; }
        self.edges().find(|other| {
            other.kind == EdgeKind::Teleport && other.from == edge.to && other.to == edge.from
        }).map(|other| other.id)
    }

    pub fn reachable_to(&self, target: NodeId) -> Vec<NodeId> {
        let mut visited: HashSet<NodeId> = HashSet::new();
        let mut queue = VecDeque::new();
        if self.incoming.contains_key(&target) {
            visited.insert(target);
            queue.push_back(target);
        }
        while let Some(current) = queue.pop_front() {
            for neighbor in self.incoming_neighbors(current) {
                if visited.insert(neighbor) {
                    queue.push_back(neighbor);
                }
            }
        }
        let mut result: Vec<NodeId> = visited.into_iter().collect();
        result.sort_unstable();
        result
    }

    pub fn reachable_from(&self, start: NodeId) -> Vec<NodeId> {
        let mut visited: HashSet<NodeId> = HashSet::new();
        let mut queue = VecDeque::new();
        if self.outgoing.contains_key(&start) {
            visited.insert(start);
            queue.push_back(start);
        }
        while let Some(current) = queue.pop_front() {
            for neighbor in self.outgoing_neighbors(current) {
                if visited.insert(neighbor) {
                    queue.push_back(neighbor);
                }
            }
        }
        let mut result: Vec<NodeId> = visited.into_iter().collect();
        result.sort_unstable();
        result
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.iter()
    }

    pub fn edges(&self) -> impl Iterator<Item = &Edge> {
        self.edges.iter().filter_map(|e| e.as_ref())
    }
}

impl Default for Graph {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod parallel_edges_tests {
    use super::*;

    #[test]
    fn teleport_coexists_with_basic_same_direction() {
        let mut g = Graph::new();
        g.add_node(0);
        g.add_node(1);
        let basic_id = g.add_edge(0, 1, EdgeKind::Basic);
        let teleport_id = g.add_edge(0, 1, EdgeKind::Teleport);
        assert_ne!(basic_id, teleport_id);
        assert_eq!(g.edges().count(), 2);
    }

    #[test]
    fn adding_second_teleport_same_direction_is_noop() {
        let mut g = Graph::new();
        g.add_node(0);
        g.add_node(1);
        let first = g.add_edge(0, 1, EdgeKind::Teleport);
        let second = g.add_edge(0, 1, EdgeKind::Teleport);
        assert_eq!(first, second);
        assert_eq!(g.edges().count(), 1);
    }

    #[test]
    fn bidirectional_teleport_over_existing_bidirectional_basic_yields_four_edges() {
        let mut g = Graph::new();
        g.add_node(0);
        g.add_node(1);
        g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
        let (ab, ba) = g.add_bidirectional_edge(0, 1, EdgeKind::Teleport);
        assert_ne!(ab, ba);
        assert_eq!(g.edges().count(), 4);
    }
}
