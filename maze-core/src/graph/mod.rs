pub mod bisect;
pub mod classify;
pub(crate) mod cycles;
pub(crate) mod distance_map;
pub(crate) mod gf2_basis;
pub mod graph_analytics;
pub mod nav;
pub mod node_shape;
pub(crate) mod pathfinding;
pub mod region_class;
pub mod route_protection;
pub mod routing;
pub mod scc;
pub mod split_topology;
pub mod stats;

use crate::ids::{EdgeId, NodeId};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub id: NodeId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EdgeKind {
    Basic,
    Teleport,
    /// Connects the same x-y point on two adjacent floors (`MultiLevelField` levels). May be
    /// one-way or two-way. See `Specs/generation.md`'s "Vertical Connections" section.
    VerticalPassage,
    /// Connects the same x-y point across multiple floors (not necessarily adjacent), fan-style
    /// (every pair of the elevator's own floors gets a bidirectional edge). Always two-way — no
    /// per-edge one-way roll exists for elevators.
    Elevator,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub id: EdgeId,
    pub from: NodeId,
    pub to: NodeId,
    pub kind: EdgeKind,
}

/// Read-only window onto a part of the graph (GitHub issue #1039, `Specs/quality_control.md`).
///
/// Nodes fall in three classes: *inner* (the scope's own nodes), *boundary* (outside the scope but
/// the far end of a visible edge) and invisible. An edge is visible when at least one end is inner.
/// While a mask is raised on a `Graph`, the enumerating accessors (`nodes`, `node_count`, `edges`,
/// `outgoing_neighbors`, `incoming_neighbors`, `outgoing_edges`, `edge_between`) show only inner
/// nodes and visible edges; lookup by id (`edge`) and every mutator ignore it. A boundary node is
/// a leaf: the neighbour accessors give an inner node its boundary neighbours but give the boundary
/// node none, so no traversal passes through it.
#[derive(Debug)]
pub struct ScopeMask {
    id: u64,
    inner: HashSet<NodeId>,
    /// Positions of the inner nodes in `Graph::nodes`, ascending.
    node_positions: Vec<usize>,
    /// Visible edges, ascending by id.
    edge_ids: Vec<EdgeId>,
    boundary: Vec<NodeId>,
}

impl ScopeMask {
    pub fn is_inner(&self, node: NodeId) -> bool {
        self.inner.contains(&node)
    }

    pub fn inner_count(&self) -> usize {
        self.node_positions.len()
    }

    fn sees(&self, edge: &Edge) -> bool {
        self.inner.contains(&edge.from) || self.inner.contains(&edge.to)
    }
}

/// Source of `ScopeMask::id`. Ids only tell masks apart for cache keys, so their values never
/// reach any output.
static NEXT_SCOPE_ID: AtomicU64 = AtomicU64::new(1);

/// The mask slot of a `Graph`. A clone starts without a mask: a mask is a temporary window onto
/// one graph value, not part of its data.
#[derive(Debug, Default)]
struct ScopeSlot(RefCell<Option<Arc<ScopeMask>>>);

impl Clone for ScopeSlot {
    fn clone(&self) -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone)]
pub struct Graph {
    nodes: Vec<Node>,
    edges: Vec<Option<Edge>>,
    outgoing: HashMap<NodeId, Vec<EdgeId>>,
    incoming: HashMap<NodeId, Vec<EdgeId>>,
    version: u64,
    scope: ScopeSlot,
}

impl Graph {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            outgoing: HashMap::new(),
            incoming: HashMap::new(),
            version: 0,
            scope: ScopeSlot::default(),
        }
    }

    fn mask(&self) -> Option<Arc<ScopeMask>> {
        self.scope.0.borrow().clone()
    }

    fn debug_assert_unmasked(&self, op: &str) {
        debug_assert!(
            self.scope.0.borrow().is_none(),
            "{op}: a graph mutator ran under a raised scope mask"
        );
    }

    /// Builds the mask for the scope whose own nodes are `inner` (ids absent from the graph are
    /// ignored). One pass over `nodes` for the positions, the rest is proportional to the scope.
    pub fn build_scope_mask(&self, inner: HashSet<NodeId>) -> Arc<ScopeMask> {
        let node_positions: Vec<usize> = self
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| inner.contains(&n.id))
            .map(|(i, _)| i)
            .collect();
        let inner: HashSet<NodeId> = node_positions.iter().map(|&i| self.nodes[i].id).collect();
        let mut edge_ids: Vec<EdgeId> = Vec::new();
        for node in &inner {
            for map in [&self.outgoing, &self.incoming] {
                if let Some(ids) = map.get(node) {
                    edge_ids.extend(ids.iter().copied());
                }
            }
        }
        edge_ids.sort_unstable();
        edge_ids.dedup();
        let mut boundary: Vec<NodeId> = edge_ids
            .iter()
            .filter_map(|&id| self.edges[id].as_ref())
            .flat_map(|e| [e.from, e.to])
            .filter(|n| !inner.contains(n))
            .collect();
        boundary.sort_unstable();
        boundary.dedup();
        Arc::new(ScopeMask {
            id: NEXT_SCOPE_ID.fetch_add(1, Ordering::Relaxed),
            inner,
            node_positions,
            edge_ids,
            boundary,
        })
    }

    /// Raises `mask` (or lowers the current one with `None`) and returns the mask it replaced.
    /// Does not change `version`.
    pub(crate) fn replace_scope(&self, mask: Option<Arc<ScopeMask>>) -> Option<Arc<ScopeMask>> {
        self.scope.0.replace(mask)
    }

    /// Runs `f` with the scope mask lifted and restores it afterwards, also on panic. For results
    /// that are about the whole maze whatever scope is raised: distances and routes from the
    /// start and the finish, which a zone only filters the candidates of, never the landmarks.
    pub fn unscoped<R>(&self, f: impl FnOnce() -> R) -> R {
        struct Restore<'a>(&'a Graph, Option<Arc<ScopeMask>>);
        impl Drop for Restore<'_> {
            fn drop(&mut self) {
                self.0.replace_scope(self.1.take());
            }
        }
        let previous = self.replace_scope(None);
        let _restore = Restore(self, previous);
        f()
    }

    /// The key analysis caches use: `version` plus the id of the raised mask (0 without one), so a
    /// result computed under one scope is never served to another scope or to the full graph.
    pub fn cache_key(&self) -> (u64, u64) {
        (self.version, self.mask().map_or(0, |m| m.id))
    }

    /// Whether a scope mask is raised.
    pub fn scope_active(&self) -> bool {
        self.scope.0.borrow().is_some()
    }

    /// Whether `node` is an own node of the raised scope; always `true` without a mask.
    pub fn is_inner(&self, node: NodeId) -> bool {
        self.scope
            .0
            .borrow()
            .as_ref()
            .is_none_or(|m| m.is_inner(node))
    }

    /// Nodes outside the raised scope that are the far end of a visible edge; empty without a mask.
    pub fn boundary_nodes(&self) -> Vec<NodeId> {
        self.mask().map_or_else(Vec::new, |m| m.boundary.clone())
    }

    fn edge_visible(mask: &Option<Arc<ScopeMask>>, edge: &Edge) -> bool {
        mask.as_ref().is_none_or(|m| m.sees(edge))
    }

    /// Bumped on every edge insertion/removal that actually changes the edge set. Lets cache
    /// layers (`MazeAnalysis`) detect that previously cached derived data is stale, instead of
    /// relying on callers to remember to invalidate by hand. Node additions don't bump it —
    /// they can't make a cached cycle/nav-graph result wrong, only edges can.
    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn add_node(&mut self, id: NodeId) {
        self.debug_assert_unmasked("add_node");
        self.nodes.push(Node { id });
        self.outgoing.insert(id, Vec::new());
        self.incoming.insert(id, Vec::new());
    }

    /// Removes `id` and every edge incident to it, both directions. A no-op for a node not in
    /// the graph. Bumps `version` even when the node had no edges — unlike an addition, a removal
    /// can make cached node-set data (e.g. SCC components) wrong.
    pub(crate) fn remove_node(&mut self, id: NodeId) {
        self.debug_assert_unmasked("remove_node");
        let Some(outgoing) = self.outgoing.remove(&id) else {
            return;
        };
        let incoming = self.incoming.remove(&id).unwrap_or_default();
        for edge in outgoing.into_iter().chain(incoming) {
            self.remove_edge(edge);
        }
        self.nodes.retain(|n| n.id != id);
        self.version += 1;
    }

    pub(crate) fn add_edge(&mut self, from: NodeId, to: NodeId, kind: EdgeKind) -> EdgeId {
        self.debug_assert_unmasked("add_edge");
        debug_assert!(
            self.outgoing.contains_key(&from),
            "add_edge: node {from} not in graph"
        );
        debug_assert!(
            self.incoming.contains_key(&to),
            "add_edge: node {to} not in graph"
        );
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

    /// Kind-specific lookup — only matches an existing edge of the same `kind`, so a `Teleport`
    /// edge can coexist with a `Basic` edge in the same direction between the same pair (e.g. a
    /// tile already reachable by a normal passage can also have a teleport into it). Originally
    /// private (used by `add_edge`'s dedup); `pub(crate)` so a caller that needs to know whether
    /// a *specific* kind of edge exists between a pair (not just "any edge") can ask directly,
    /// instead of resolving the ambiguity of `edge_between`'s "arbitrary matching edge" itself.
    /// Callers needing "any kind" use the public `edge_between` instead.
    pub(crate) fn edge_between_kind(
        &self,
        from: NodeId,
        to: NodeId,
        kind: &EdgeKind,
    ) -> Option<EdgeId> {
        self.outgoing
            .get(&from)?
            .iter()
            .find(|&&eid| {
                self.edges[eid]
                    .as_ref()
                    .is_some_and(|e| e.to == to && &e.kind == kind)
            })
            .copied()
    }

    pub(crate) fn add_bidirectional_edge(
        &mut self,
        a: NodeId,
        b: NodeId,
        kind: EdgeKind,
    ) -> (EdgeId, EdgeId) {
        let ab = self.add_edge(a, b, kind);
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
    pub fn build_initial_bidirectional_edge(
        &mut self,
        a: NodeId,
        b: NodeId,
        kind: EdgeKind,
    ) -> (EdgeId, EdgeId) {
        self.add_bidirectional_edge(a, b, kind)
    }

    /// Removes an edge with no `PresetState` check — same unchecked-construction contract as
    /// `build_initial_edge`, for hand-built test fixtures and graph setup. Repair strategies
    /// must go through `try_remove_edge` in `generation::mod` instead.
    pub fn remove_initial_edge(&mut self, id: EdgeId) {
        self.remove_edge(id);
    }

    pub(crate) fn remove_edge(&mut self, id: EdgeId) {
        self.debug_assert_unmasked("remove_edge");
        if let Some(edge) = self.edges[id].take() {
            self.outgoing
                .entry(edge.from)
                .and_modify(|v| v.retain(|&e| e != id));
            self.incoming
                .entry(edge.to)
                .and_modify(|v| v.retain(|&e| e != id));
            self.version += 1;
        }
    }

    pub fn outgoing_neighbors(&self, node: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        self.outgoing_edges(node).map(|e| e.to)
    }

    /// Like `outgoing_neighbors`, but yields the full `Edge` (kind included) rather than just the
    /// target `NodeId` — one entry per `EdgeId`, not deduped by target, so a parallel `Basic` +
    /// `Teleport` pair between the same nodes yields two distinct entries. Used where the specific
    /// edge's `kind` matters, not just which nodes are connected (GitHub issue #197).
    pub(crate) fn outgoing_edges(&self, node: NodeId) -> impl Iterator<Item = &Edge> + '_ {
        // Under a mask only an inner node has adjacency (every edge of it is visible); a boundary
        // node is a leaf, so no walk ever passes through one.
        let open = self.is_inner(node);
        self.outgoing
            .get(&node)
            .filter(move |_| open)
            .into_iter()
            .flat_map(|ids| ids.iter())
            .filter_map(move |&eid| self.edges[eid].as_ref())
    }

    pub fn incoming_neighbors(&self, node: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        let open = self.is_inner(node);
        self.incoming
            .get(&node)
            .filter(move |_| open)
            .into_iter()
            .flat_map(|ids| ids.iter())
            .filter_map(move |&eid| self.edges[eid].as_ref().map(|e| e.from))
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
        let mask = self.mask();
        self.outgoing
            .get(&from)?
            .iter()
            .find(|&&eid| {
                self.edges[eid]
                    .as_ref()
                    .is_some_and(|e| e.to == to && Self::edge_visible(&mask, e))
            })
            .copied()
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
        self.reverse_of_kind(id, EdgeKind::Teleport)
    }

    /// Returns the opposite-direction `VerticalPassage` edge of a two-way vertical passage, if any
    /// — mirrors `teleport_reverse` exactly, see GitHub issue #343. `id` must itself be a
    /// `VerticalPassage` edge. `None` if `id` doesn't exist, isn't a `VerticalPassage`, or has no
    /// reverse (a one-way vertical passage).
    pub fn vertical_passage_reverse(&self, id: EdgeId) -> Option<EdgeId> {
        self.reverse_of_kind(id, EdgeKind::VerticalPassage)
    }

    fn reverse_of_kind(&self, id: EdgeId, kind: EdgeKind) -> Option<EdgeId> {
        let edge = self.edge(id)?;
        if edge.kind != kind {
            return None;
        }
        self.edges()
            .find(|other| other.kind == kind && other.from == edge.to && other.to == edge.from)
            .map(|other| other.id)
    }

    pub fn reachable_to(&self, target: NodeId) -> Vec<NodeId> {
        self.reachable(target, |g, n| g.incoming_neighbors(n).collect::<Vec<_>>())
    }

    pub fn reachable_from(&self, start: NodeId) -> Vec<NodeId> {
        self.reachable(start, |g, n| g.outgoing_neighbors(n).collect::<Vec<_>>())
    }

    /// Sorted BFS closure of `origin` (itself included, if in the graph) under `step`.
    fn reachable(
        &self,
        origin: NodeId,
        step: impl Fn(&Self, NodeId) -> Vec<NodeId>,
    ) -> Vec<NodeId> {
        let mask = self.mask();
        let mut visited: HashSet<NodeId> = HashSet::new();
        let mut queue = VecDeque::new();
        if self.outgoing.contains_key(&origin) {
            visited.insert(origin);
            queue.push_back(origin);
        }
        while let Some(current) = queue.pop_front() {
            // A boundary node is a terminal: it is reached, but the walk does not continue past it.
            if mask.as_ref().is_some_and(|m| !m.is_inner(current)) {
                continue;
            }
            for neighbor in step(self, current) {
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
        self.mask().map_or(self.nodes.len(), |m| m.inner_count())
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        let mask = self.mask();
        let len = mask.as_ref().map_or(self.nodes.len(), |m| m.inner_count());
        (0..len).map(move |i| match &mask {
            Some(m) => &self.nodes[m.node_positions[i]],
            None => &self.nodes[i],
        })
    }

    pub fn edges(&self) -> impl Iterator<Item = &Edge> {
        let mask = self.mask();
        let len = mask.as_ref().map_or(self.edges.len(), |m| m.edge_ids.len());
        (0..len).filter_map(move |i| {
            let id = mask.as_ref().map_or(i, |m| m.edge_ids[i]);
            self.edges[id].as_ref()
        })
    }

    /// Every distinct `Elevator` group, as a connected component of `Elevator`-kind edges — never
    /// by shared x-y point, since two elevators can occupy the same point without being connected
    /// (e.g. one spanning floors 1-3, a separate one spanning floors 4-6, both at the same x-y —
    /// GitHub issue #346). Order of both the outer `Vec` and each group's node iteration is
    /// unspecified.
    pub fn elevator_groups(&self) -> Vec<HashSet<NodeId>> {
        let mut parent: HashMap<NodeId, NodeId> = HashMap::new();
        fn find(parent: &mut HashMap<NodeId, NodeId>, x: NodeId) -> NodeId {
            let p = *parent.get(&x).unwrap_or(&x);
            if p == x {
                x
            } else {
                let root = find(parent, p);
                parent.insert(x, root);
                root
            }
        }
        for edge in self.edges() {
            if edge.kind != EdgeKind::Elevator {
                continue;
            }
            parent.entry(edge.from).or_insert(edge.from);
            parent.entry(edge.to).or_insert(edge.to);
            let (ra, rb) = (find(&mut parent, edge.from), find(&mut parent, edge.to));
            if ra != rb {
                parent.insert(ra, rb);
            }
        }
        let nodes: Vec<NodeId> = parent.keys().copied().collect();
        let mut groups: HashMap<NodeId, HashSet<NodeId>> = HashMap::new();
        for node in nodes {
            let root = find(&mut parent, node);
            groups.entry(root).or_default().insert(node);
        }
        groups.into_values().collect()
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

#[cfg(test)]
mod remove_node_tests {
    use super::*;

    #[test]
    fn removes_the_node_and_every_incident_edge_and_bumps_version() {
        let mut g = Graph::new();
        for n in 0..3 {
            g.add_node(n);
        }
        g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
        g.add_edge(2, 1, EdgeKind::Teleport);
        g.add_edge(0, 2, EdgeKind::Basic);
        let before = g.version();

        g.remove_node(1);

        assert!(g.nodes().all(|n| n.id != 1));
        let remaining: Vec<(NodeId, NodeId)> = g.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(remaining, vec![(0, 2)]);
        assert!(g.version() > before);
        assert_eq!(g.outgoing_neighbors(0).collect::<Vec<_>>(), vec![2]);
        assert_eq!(g.incoming_neighbors(2).collect::<Vec<_>>(), vec![0]);
    }

    #[test]
    fn removing_an_unknown_node_is_a_noop() {
        let mut g = Graph::new();
        g.add_node(0);
        let before = g.version();
        g.remove_node(7);
        assert_eq!(g.node_count(), 1);
        assert_eq!(g.version(), before);
    }
}

#[cfg(test)]
mod elevator_groups_tests {
    use super::*;

    #[test]
    fn no_elevator_edges_yields_no_groups() {
        let mut g = Graph::new();
        g.add_node(0);
        g.add_node(1);
        g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
        assert!(g.elevator_groups().is_empty());
    }

    #[test]
    fn full_fan_across_three_floors_is_one_group_with_all_members() {
        let mut g = Graph::new();
        for n in [0, 1, 2] {
            g.add_node(n);
        }
        g.add_bidirectional_edge(0, 1, EdgeKind::Elevator);
        g.add_bidirectional_edge(0, 2, EdgeKind::Elevator);
        g.add_bidirectional_edge(1, 2, EdgeKind::Elevator);
        let groups = g.elevator_groups();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0], HashSet::from([0, 1, 2]));
    }

    #[test]
    fn two_disjoint_elevators_are_two_groups_even_with_no_direct_edge_between_them() {
        // Mirrors a real bug (GitHub issue #346): floors 0-2 form one elevator, floors 3-5 form a
        // separate one, connected to each other by nothing — must not merge into one group just
        // because both touch the graph.
        let mut g = Graph::new();
        for n in 0..6 {
            g.add_node(n);
        }
        g.add_bidirectional_edge(0, 1, EdgeKind::Elevator);
        g.add_bidirectional_edge(0, 2, EdgeKind::Elevator);
        g.add_bidirectional_edge(1, 2, EdgeKind::Elevator);
        g.add_bidirectional_edge(3, 4, EdgeKind::Elevator);
        g.add_bidirectional_edge(3, 5, EdgeKind::Elevator);
        g.add_bidirectional_edge(4, 5, EdgeKind::Elevator);

        let groups = g.elevator_groups();
        assert_eq!(groups.len(), 2);
        let mut sorted: Vec<Vec<NodeId>> = groups
            .iter()
            .map(|s| {
                let mut v: Vec<_> = s.iter().copied().collect();
                v.sort_unstable();
                v
            })
            .collect();
        sorted.sort();
        assert_eq!(sorted, vec![vec![0, 1, 2], vec![3, 4, 5]]);
    }

    #[test]
    fn non_elevator_edges_are_ignored() {
        let mut g = Graph::new();
        g.add_node(0);
        g.add_node(1);
        g.add_bidirectional_edge(0, 1, EdgeKind::VerticalPassage);
        g.add_bidirectional_edge(0, 1, EdgeKind::Teleport);
        assert!(g.elevator_groups().is_empty());
    }
}
