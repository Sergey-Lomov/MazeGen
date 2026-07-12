pub mod pipeline;

pub(crate) mod vertex_based;
pub(crate) mod wilson;
pub(crate) mod kruskal;
pub(crate) mod recursive_backtracker;
pub(crate) mod edge_based;
mod preset_state;

pub use preset_state::{PresetState, build_preset_state};

use crate::random::MazeRng;
use rand::Rng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};

#[derive(Debug, Clone)]
pub struct ElementsConfig {
    pub one_way_chance: f64,
    /// Probability that, at each edge-addition opportunity `advance` handles, the edge is a
    /// teleport instead of a normal (geometrically-adjacent) connection.
    pub teleport_chance: f64,
    /// Probability that an added teleport is one-way rather than two-way. Only consulted when
    /// `teleport_chance` already hit — mirrors `one_way_chance`'s role but scoped to teleports.
    pub teleport_one_way_chance: f64,
}

impl Default for ElementsConfig {
    fn default() -> Self {
        ElementsConfig { one_way_chance: 0.04, teleport_chance: 0.0, teleport_one_way_chance: 0.0 }
    }
}

#[derive(Debug, Clone)]
pub struct GenerationParams {
    pub depth_first:     f64,
    pub corridor_chance: f64,
    pub branching:       f64,
    pub directionality:  f64,
    pub cyclicity:       f64,
}

impl Default for GenerationParams {
    fn default() -> Self {
        GenerationParams {
            depth_first:     0.9,
            corridor_chance: 0.7,
            branching:       0.5,
            directionality:  0.0,
            cyclicity:       0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EdgeBasedParams {
    pub corridor_length: f64,
    pub branching:       f64,
    pub depth_first:     f64,
    pub directionality:  f64,
    pub cyclicity:       f64,
}

impl Default for EdgeBasedParams {
    fn default() -> Self {
        EdgeBasedParams {
            corridor_length: 0.5,
            branching:       0.5,
            depth_first:     0.5,
            directionality:  0.0,
            cyclicity:       0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub enum GenerationAlgorithm {
    CustomVertexBased(GenerationParams),
    CustomEdgeBased(EdgeBasedParams),
    RecursiveBacktracker,
    WilsonAlgorithm,
    KruskalAlgorithm,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PresetConnectionState {
    Wall,
    Passage,
    OneWayForward,
    OneWayBackward,
    Teleport(TeleportDirection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportDirection {
    Forward,
    Backward,
    TwoWay,
}

#[derive(Debug, Clone)]
pub struct PresetConnection {
    pub from: (i32, i32),
    pub to:   (i32, i32),
    pub state: PresetConnectionState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeLockKind {
    In,
    Out,
    Both,
}

#[derive(Debug, Clone)]
pub struct LockedNode {
    pub point: (i32, i32),
    pub kind:  NodeLockKind,
}

#[derive(Debug, Clone)]
pub struct GenerationConfig {
    pub algorithm:          GenerationAlgorithm,
    pub elements:           ElementsConfig,
    pub preset_connections: Vec<PresetConnection>,
    pub locked_nodes:       Vec<LockedNode>,
}

impl Default for GenerationConfig {
    fn default() -> Self {
        GenerationConfig {
            algorithm:          GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
            elements:           ElementsConfig::default(),
            preset_connections: vec![],
            locked_nodes:       vec![],
        }
    }
}

#[derive(Debug, Clone)]
pub struct GenerationEdge {
    pub from: NodeId,
    pub to:   NodeId,
    pub kind: EdgeKind,
}

#[derive(Debug, Clone)]
pub struct GenerationStep {
    pub edges:        Vec<GenerationEdge>,
    pub active_nodes: Vec<NodeId>,
    pub current_src:  NodeId,
}

pub(crate) fn gaussian_weighted_index(len: usize, depth_first: f64, rng: &mut MazeRng) -> usize {
    crate::math::sample_by_position(len, depth_first, rng)
}

pub type StepCallback<'a> = dyn FnMut(&Graph, NodeId, &[NodeId]) + 'a;

fn dispatch<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
    on_step: Option<&mut StepCallback<'_>>,
) {
    match config.algorithm {
        GenerationAlgorithm::CustomVertexBased(params) =>
            vertex_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, on_step),
        GenerationAlgorithm::CustomEdgeBased(params) =>
            edge_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, on_step),
        GenerationAlgorithm::RecursiveBacktracker =>
            recursive_backtracker::generate(graph, field, seed, start, preset_state, on_step),
        GenerationAlgorithm::WilsonAlgorithm =>
            wilson::generate(graph, field, seed, start, preset_state, on_step),
        GenerationAlgorithm::KruskalAlgorithm =>
            kruskal::generate(graph, field, seed, preset_state, on_step),
    }
}

pub fn generate_maze<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
) {
    dispatch(graph, field, seed, start, config, preset_state, None);
}

pub fn generate_maze_steps<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
) -> Vec<GenerationStep> {
    let mut steps: Vec<GenerationStep> = Vec::new();
    let mut on_step = |g: &Graph, src: NodeId, active: &[NodeId]| {
        let edges = g.edges().map(|e| GenerationEdge { from: e.from, to: e.to, kind: e.kind.clone() }).collect();
        steps.push(GenerationStep { edges, active_nodes: active.to_vec(), current_src: src });
    };
    dispatch(graph, field, seed, start, config, preset_state, Some(&mut on_step));
    steps
}

// One-way edges consume two RNG samples (one for the chance check, one for direction),
// while bidirectional edges consume only one. This means maze topology differs between
// runs with `one_way_chance` > 0 and runs with `one_way_chance` == 0, even at the same seed.
// `kind`/`one_way_chance` are caller-supplied so this same sample-consumption contract applies
// identically whether `kind` is `Basic` (driven by `elements.one_way_chance`) or `Teleport`
// (driven by `elements.teleport_one_way_chance`) — there is no kind-specific special-casing here.
pub(crate) fn add_edge_kind(graph: &mut Graph, src: NodeId, dst: NodeId, kind: EdgeKind, one_way_chance: f64, rng: &mut MazeRng) {
    if rng.random::<f64>() < one_way_chance {
        if rng.random::<bool>() {
            graph.add_edge(src, dst, kind);
        } else {
            graph.add_edge(dst, src, kind);
        }
    } else {
        graph.add_bidirectional_edge(src, dst, kind);
    }
}

pub(crate) fn add_edge(graph: &mut Graph, src: NodeId, dst: NodeId, elements: &ElementsConfig, rng: &mut MazeRng) {
    add_edge_kind(graph, src, dst, EdgeKind::Basic, elements.one_way_chance, rng);
}

/// Returns true if the algorithm is allowed to add an edge src→dst (at least one direction).
pub(crate) fn can_connect(src: NodeId, dst: NodeId, preset_state: &PresetState) -> bool {
    if preset_state.locked_out.contains(&src) && preset_state.locked_out.contains(&dst) { return false; }
    if preset_state.locked_in.contains(&src)  && preset_state.locked_in.contains(&dst)  { return false; }
    let fwd_blocked = preset_state.blocked.contains(&(src, dst))
        || preset_state.locked_out.contains(&src)
        || preset_state.locked_in.contains(&dst);
    let bwd_blocked = preset_state.blocked.contains(&(dst, src))
        || preset_state.locked_out.contains(&dst)
        || preset_state.locked_in.contains(&src);
    !(fwd_blocked && bwd_blocked)
}

/// try_add_edge_kind: respects PresetState constraints before delegating to add_edge_kind.
/// Same contract as `try_add_edge`, but lets the caller pick `kind` and the one-way chance to
/// use — the mechanism `try_add_edge` uses for `Basic` edges with `elements.one_way_chance`
/// applies identically to `Teleport` edges with `elements.teleport_one_way_chance`.
pub(crate) fn try_add_edge_kind(
    graph: &mut Graph,
    src: NodeId,
    dst: NodeId,
    kind: EdgeKind,
    one_way_chance: f64,
    preset_state: &PresetState,
    rng: &mut MazeRng,
) {
    if preset_state.locked_out.contains(&src) { return; }
    if preset_state.locked_in.contains(&dst)  { return; }
    if preset_state.blocked.contains(&(src, dst)) { return; }

    // For one_way_chance: if reverse direction is also blocked, force forward only.
    let reverse_blocked = preset_state.blocked.contains(&(dst, src))
        || preset_state.locked_out.contains(&dst)
        || preset_state.locked_in.contains(&src);

    if reverse_blocked {
        // Can only go src→dst
        graph.add_edge(src, dst, kind);
        // Still consume RNG samples to preserve seed parity with normal add_edge_kind.
        let _ = rng.random::<f64>();
        let _ = rng.random::<bool>();
    } else {
        add_edge_kind(graph, src, dst, kind, one_way_chance, rng);
    }
}

/// try_add_edge: respects PresetState constraints before delegating to add_edge.
/// Returns true if the edge was added (at least one direction).
pub(crate) fn try_add_edge(
    graph: &mut Graph,
    src: NodeId,
    dst: NodeId,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    rng: &mut MazeRng,
) {
    try_add_edge_kind(graph, src, dst, EdgeKind::Basic, elements.one_way_chance, preset_state, rng);
}

/// Shared feasibility predicate for `try_add_bidirectional_edge`/`cmd_add_bidirectional_edge`
/// (GitHub issue #118): neither direction of the pair may be blocked by `preset_state`. The one
/// place this "both directions free" check is written, so apply-time and construction-time
/// feasibility can never disagree — see `MutationCommand`'s own doc comment. `pub(crate)`, not
/// private: strategies building their own pre-mutation feasibility check against a `&Maze`
/// snapshot (e.g. `ExpandRegionPassageStrategy::pair_connectable`,
/// `TeleportRegionMergeStrategy::teleport_bidirectional_blocked`,
/// `MissingLoopsRandomStrategy::apply`'s own inline check) call this directly instead of
/// re-deriving the same preset-lock formula — one definition, used by every side that needs it.
pub(crate) fn bidirectional_edge_feasible(preset_state: &PresetState, a: NodeId, b: NodeId) -> bool {
    let fwd_blocked = preset_state.blocked.contains(&(a, b))
        || preset_state.locked_out.contains(&a)
        || preset_state.locked_in.contains(&b);
    let bwd_blocked = preset_state.blocked.contains(&(b, a))
        || preset_state.locked_out.contains(&b)
        || preset_state.locked_in.contains(&a);
    !(fwd_blocked || bwd_blocked)
}

/// try_add_bidirectional_edge: strict "both directions free, or skip the pair" connect for
/// repair strategies (`MissingLoopsRandomStrategy`, `ExpandRegionPassageStrategy`) that need a
/// full passage, not the base-generation `try_add_edge` one_way_chance coin flip. Completion-
/// aware: if one direction already exists (e.g. a preset one-way edge), only the missing
/// direction is added rather than duplicating. Returns true if at least one direction was added
/// or both were already present (i.e. the pair ends up as a full passage); false if either
/// direction is blocked by `preset_state`, in which case nothing is mutated.
pub(crate) fn try_add_bidirectional_edge(
    graph: &mut Graph,
    a: NodeId,
    b: NodeId,
    preset_state: &PresetState,
) -> bool {
    if !bidirectional_edge_feasible(preset_state, a, b) {
        return false;
    }
    if graph.edge_between(a, b).is_none() {
        graph.add_edge(a, b, EdgeKind::Basic);
    }
    if graph.edge_between(b, a).is_none() {
        graph.add_edge(b, a, EdgeKind::Basic);
    }
    true
}

/// try_add_directed_teleport: adds a single one-way `Teleport` edge `a -> b`, respecting
/// `PresetState` on the forward direction only — for repair strategies that need an explicit
/// one-way teleport connection (e.g. `TeleportRegionMergeStrategy`). Idempotent against **any**
/// existing edge kind in that direction, not just an existing `Teleport`: if `a -> b` is already
/// carried by a `Basic` edge (e.g. a passage from an earlier repair pass), that direction is
/// treated as already closed and no `Teleport` is added on top of it — mirrors
/// `TeleportRegionMergeStrategy`'s "partial connection" concept, which also considers any edge
/// kind. Returns true if a `Teleport` edge was added or the direction was already covered by any
/// edge; false if blocked by `preset_state`.
pub(crate) fn try_add_directed_teleport(
    graph: &mut Graph,
    a: NodeId,
    b: NodeId,
    preset_state: &PresetState,
) -> bool {
    if !directed_edge_feasible(preset_state, a, b) {
        return false;
    }
    if graph.edge_between(a, b).is_none() {
        graph.add_edge(a, b, EdgeKind::Teleport);
    }
    true
}

/// try_add_bidirectional_teleport: strict "both directions free, or skip the pair" connect for
/// a matched two-way `Teleport` (`TeleportRegionMergeStrategy`'s `two_way` direction mode) —
/// same "check both directions before mutating either" contract as `try_add_bidirectional_edge`,
/// just for `Teleport` edges instead of `Basic`. Idempotent against any existing edge kind in
/// each direction (mirrors `try_add_directed_teleport`). Returns false (no mutation at all) if
/// either direction is blocked by `preset_state` — never leaves one direction added and the
/// other missing.
pub(crate) fn try_add_bidirectional_teleport(
    graph: &mut Graph,
    a: NodeId,
    b: NodeId,
    preset_state: &PresetState,
) -> bool {
    if !bidirectional_edge_feasible(preset_state, a, b) {
        return false;
    }
    if graph.edge_between(a, b).is_none() {
        graph.add_edge(a, b, EdgeKind::Teleport);
    }
    if graph.edge_between(b, a).is_none() {
        graph.add_edge(b, a, EdgeKind::Teleport);
    }
    true
}

/// Shared feasibility predicate for `try_remove_edge`/`cmd_remove_edge` (GitHub issue #118): the
/// node pair must not be a preset (Basic) connection. See `bidirectional_edge_feasible`'s own
/// doc comment for why this is factored out (and `pub(crate)`) rather than re-derived on each side.
pub(crate) fn remove_edge_between_feasible(preset_state: &PresetState, from: NodeId, to: NodeId) -> bool {
    !preset_state.preset_edges.contains(&(from, to))
}

/// try_remove_edge: respects PresetState before removing a directed edge.
/// Returns true if the edge was removed, false if it is protected by a preset connection.
pub(crate) fn try_remove_edge(
    graph: &mut Graph,
    from: NodeId,
    to: NodeId,
    preset_state: &PresetState,
) -> bool {
    if !remove_edge_between_feasible(preset_state, from, to) {
        return false;
    }
    let Some(id) = graph.edge_between(from, to) else { return false; };
    graph.remove_edge(id);
    true
}

/// try_remove_edge_by_id: removes a specific edge by its `EdgeId`, respecting PresetState.
/// Unlike `try_remove_edge`, never looks the edge up by node pair — `Graph::edge_between`
/// returns an arbitrary edge of any kind between a pair, which would risk removing the wrong
/// one when a `Teleport` and a `Basic` edge coexist in the same direction (see `EdgeKind`'s
/// parallel-edges note). Used by strategies that already hold the exact `EdgeId` to remove
/// (e.g. `RemoveTeleportStrategy`, from `IssueData::InvalidTeleports`).
///
/// `preset_edges` is keyed purely by `(from, to)` node pairs, with no `EdgeKind` — it only ever
/// gets populated from preset Passage/OneWay connections, which always build `EdgeKind::Basic`
/// edges (see `preset_state.rs`/`Specs/post-edit.md`). A `Teleport` edge can never itself be a
/// preset connection, so checking `preset_edges` for a `Teleport` id would be a false-positive
/// protection: a `Teleport` duplicating a preset `Basic` connection between the same pair would
/// never be removable, since the pair's `(from, to)` is in `preset_edges` on the `Basic` edge's
/// behalf. Only a `Basic` edge is ever subject to this protection.
/// Returns true if the edge was removed, false if it doesn't exist or is preset-protected.
pub(crate) fn try_remove_edge_by_id(
    graph: &mut Graph,
    id: crate::ids::EdgeId,
    preset_state: &PresetState,
) -> bool {
    let Some(edge) = graph.edge(id) else { return false; };
    if edge.kind == EdgeKind::Basic && !remove_edge_between_feasible(preset_state, edge.from, edge.to) {
        return false;
    }
    graph.remove_edge(id);
    true
}

/// try_remove_teleport_with_reverse: like `try_remove_edge_by_id`, but for a `Teleport` edge that
/// may be one direction of a two-way teleport — also removes the opposite-direction `Teleport`
/// edge (`Graph::teleport_reverse`), if any, so a repair strategy can never leave a two-way
/// teleport silently downgraded to one-way just because only one direction's `EdgeId` was flagged
/// (e.g. a per-teleport check using an `EntryOnly`-style selector that only inspects one end).
///
/// Returns the set of `EdgeId`s actually removed (empty, one, or both directions) — callers that
/// track pending pairs/candidates by `EdgeId` (e.g. `TeleportGroupProximityStrategy`) need this to
/// know the reverse was also consumed, not just whether the call "succeeded".
pub(crate) fn try_remove_teleport_with_reverse(
    graph: &mut Graph,
    id: crate::ids::EdgeId,
    preset_state: &PresetState,
) -> Vec<crate::ids::EdgeId> {
    let reverse_id = graph.teleport_reverse(id);
    let mut removed = Vec::with_capacity(2);
    if try_remove_edge_by_id(graph, id, preset_state) {
        removed.push(id);
    }
    if let Some(reverse_id) = reverse_id {
        if try_remove_edge_by_id(graph, reverse_id, preset_state) {
            removed.push(reverse_id);
        }
    }
    removed
}

/// Shared feasibility predicate for `try_add_directed_edge`/`try_add_directed_teleport` and their
/// `cmd_*` counterparts (GitHub issue #118): the single `from -> to` direction must not be
/// blocked by `preset_state`. See `bidirectional_edge_feasible`'s own doc comment for why this is
/// factored out (and `pub(crate)`) rather than re-derived on each side —
/// `TeleportRegionMergeStrategy::teleport_directed_blocked` uses this directly.
pub(crate) fn directed_edge_feasible(preset_state: &PresetState, from: NodeId, to: NodeId) -> bool {
    !preset_state.locked_out.contains(&from)
        && !preset_state.locked_in.contains(&to)
        && !preset_state.blocked.contains(&(from, to))
}

/// try_add_directed_edge: adds a single one-way edge `from -> to`, respecting PresetState.
/// Unlike `try_add_bidirectional_edge`, never adds the reverse direction — for repair
/// strategies that need an explicit one-way connection (e.g. `MissingRegionsStrategy`).
/// Returns true if the edge was added or already present; false if blocked by preset state.
pub(crate) fn try_add_directed_edge(
    graph: &mut Graph,
    from: NodeId,
    to: NodeId,
    preset_state: &PresetState,
) -> bool {
    if !directed_edge_feasible(preset_state, from, to) {
        return false;
    }
    if graph.edge_between(from, to).is_none() {
        graph.add_edge(from, to, EdgeKind::Basic);
    }
    true
}

// --- MutationCommand builders (GitHub issue #118) ---
//
// Read-only counterparts of the `try_*` helpers above, for a `RepairStrategy` holding only `&Maze`
// (never `&mut Maze`, see `Specs/repair.md`'s mutation-command contract). Each `cmd_*` function
// checks the same feasibility a strategy would need before proposing a mutation and, if feasible,
// returns the equivalent `MutationCommand`(s) instead of mutating — `apply_commands` (see
// `quality_control::rule`) later calls the matching `try_*` for real, so these two paths can never
// disagree about "was this even worth proposing" vs. "is this still valid to apply".
//
// Maintenance rule: every `try_*` above needs a `cmd_*` counterpart here (see `MutationCommand`'s
// own doc comment) — a strategy cannot reach a mutating helper that has none, since it never holds
// `&mut Graph`.

use crate::repair::command::MutationCommand;

// Step 1 of GitHub issue #118's migration (Specs/repair.md): additive, not yet wired into any
// caller — strategies still mutate `&mut Maze` directly today. `#[allow(dead_code)]` until step 2
// switches `RepairStrategy::apply` to call these instead of the `try_*` helpers above.
// Add-side `cmd_*` builders only ever consult `PresetState`, never `Graph` — every `try_add_*`
// counterpart is completion-aware/idempotent (adds whichever direction is missing, or is a no-op
// if the edge already exists) and so never fails for a *structural* reason, only a preset one
// (see each `try_add_*`'s own doc comment). There is no `can_add_edge`-style dry-run check to
// share here because there is nothing it could catch that preset feasibility doesn't already
// cover — see `Graph::can_add_edge`'s doc comment for where a structural check would matter.

#[allow(dead_code)]
pub(crate) fn cmd_add_directed_edge(from: NodeId, to: NodeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !directed_edge_feasible(preset_state, from, to) { return vec![]; }
    vec![MutationCommand::AddDirectedEdge { from, to }]
}

#[allow(dead_code)]
pub(crate) fn cmd_add_bidirectional_edge(a: NodeId, b: NodeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !bidirectional_edge_feasible(preset_state, a, b) { return vec![]; }
    // One command covers both directions — mirrors try_add_bidirectional_edge's own atomic
    // "complete whichever direction is missing" contract; see MutationCommand's doc comment.
    vec![MutationCommand::AddBidirectionalEdge { a, b }]
}

#[allow(dead_code)]
pub(crate) fn cmd_add_directed_teleport(a: NodeId, b: NodeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !directed_edge_feasible(preset_state, a, b) { return vec![]; }
    vec![MutationCommand::AddDirectedTeleport { from: a, to: b }]
}

#[allow(dead_code)]
pub(crate) fn cmd_add_bidirectional_teleport(a: NodeId, b: NodeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !bidirectional_edge_feasible(preset_state, a, b) { return vec![]; }
    vec![MutationCommand::AddBidirectionalTeleport { a, b }]
}

#[allow(dead_code)]
pub(crate) fn cmd_remove_edge(graph: &Graph, from: NodeId, to: NodeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !remove_edge_between_feasible(preset_state, from, to) { return vec![]; }
    let Some(id) = graph.edge_between(from, to) else { return vec![]; };
    if !graph.can_remove_edge(id) { return vec![]; }
    vec![MutationCommand::RemoveEdgeBetween { from, to }]
}

#[allow(dead_code)]
pub(crate) fn cmd_remove_edge_by_id(graph: &Graph, id: crate::ids::EdgeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !graph.can_remove_edge(id) { return vec![]; }
    let edge = graph.edge(id).expect("can_remove_edge just confirmed this id exists");
    if edge.kind == EdgeKind::Basic && !remove_edge_between_feasible(preset_state, edge.from, edge.to) {
        return vec![];
    }
    vec![MutationCommand::RemoveEdge { id }]
}

#[allow(dead_code)]
pub(crate) fn cmd_remove_teleport_with_reverse(graph: &Graph, id: crate::ids::EdgeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !graph.can_remove_edge(id) { return vec![]; }
    let _ = preset_state; // re-checked for real by try_remove_teleport_with_reverse at apply time
    vec![MutationCommand::RemoveTeleportWithReverse { id }]
}

/// Direct unit tests for the `cmd_*` `MutationCommand` builders and the feasibility predicates
/// they share with their `try_*` mutating counterparts (GitHub issue #118, `Specs/repair.md`).
/// These builders had no direct test coverage before — only exercised transitively (and only
/// while still `#[allow(dead_code)]`, i.e. not exercised at all) — so this module specifically
/// covers: each builder proposing the right command when feasible, and being blocked by the same
/// `PresetState` conditions its `try_*` counterpart is blocked by (the property the shared
/// predicates exist to guarantee).
#[cfg(test)]
mod cmd_builders_tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{Field, SquareTessellation, square_rect};

    fn graph_and_nodes(n: usize) -> (Graph, Vec<NodeId>) {
        let mut ids = crate::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(n, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<NodeId> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        (g, nodes)
    }

    #[test]
    fn cmd_add_directed_edge_proposes_when_feasible() {
        let (_, nodes) = graph_and_nodes(2);
        let cmds = cmd_add_directed_edge(nodes[0], nodes[1], &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::AddDirectedEdge { from: nodes[0], to: nodes[1] }]);
    }

    #[test]
    fn cmd_add_directed_edge_blocked_by_locked_out() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(nodes[0]);
        assert!(cmd_add_directed_edge(nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_add_directed_edge_blocked_by_locked_in() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.locked_in.insert(nodes[1]);
        assert!(cmd_add_directed_edge(nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_add_directed_edge_blocked_by_blocked_pair() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        assert!(cmd_add_directed_edge(nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_add_bidirectional_edge_proposes_when_feasible() {
        let (_, nodes) = graph_and_nodes(2);
        let cmds = cmd_add_bidirectional_edge(nodes[0], nodes[1], &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::AddBidirectionalEdge { a: nodes[0], b: nodes[1] }]);
    }

    #[test]
    fn cmd_add_bidirectional_edge_blocked_if_either_direction_blocked() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[1], nodes[0])); // only the reverse direction blocked
        assert!(cmd_add_bidirectional_edge(nodes[0], nodes[1], &preset_state).is_empty(),
            "bidirectional add must require BOTH directions free");
    }

    #[test]
    fn cmd_add_directed_teleport_proposes_when_feasible() {
        let (_, nodes) = graph_and_nodes(2);
        let cmds = cmd_add_directed_teleport(nodes[0], nodes[1], &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::AddDirectedTeleport { from: nodes[0], to: nodes[1] }]);
    }

    #[test]
    fn cmd_add_directed_teleport_blocked_by_preset() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        assert!(cmd_add_directed_teleport(nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_add_bidirectional_teleport_proposes_when_feasible() {
        let (_, nodes) = graph_and_nodes(2);
        let cmds = cmd_add_bidirectional_teleport(nodes[0], nodes[1], &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::AddBidirectionalTeleport { a: nodes[0], b: nodes[1] }]);
    }

    #[test]
    fn cmd_add_bidirectional_teleport_blocked_if_either_direction_blocked() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(nodes[1]);
        assert!(cmd_add_bidirectional_teleport(nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_remove_edge_proposes_when_edge_exists() {
        let (mut g, nodes) = graph_and_nodes(2);
        g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let cmds = cmd_remove_edge(&g, nodes[0], nodes[1], &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }]);
    }

    #[test]
    fn cmd_remove_edge_empty_when_no_edge_exists() {
        let (g, nodes) = graph_and_nodes(2);
        assert!(cmd_remove_edge(&g, nodes[0], nodes[1], &PresetState::empty()).is_empty(),
            "must not propose removing an edge that structurally doesn't exist");
    }

    #[test]
    fn cmd_remove_edge_blocked_by_preset_protection() {
        let (mut g, nodes) = graph_and_nodes(2);
        g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((nodes[0], nodes[1]));
        assert!(cmd_remove_edge(&g, nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_remove_edge_by_id_proposes_when_edge_exists() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let cmds = cmd_remove_edge_by_id(&g, id, &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::RemoveEdge { id }]);
    }

    #[test]
    fn cmd_remove_edge_by_id_empty_when_id_stale() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.remove_initial_edge(id);
        assert!(cmd_remove_edge_by_id(&g, id, &PresetState::empty()).is_empty(),
            "a removed edge's stale id must not be proposed for removal again");
    }

    #[test]
    fn cmd_remove_edge_by_id_blocked_by_preset_protection_for_basic_edge() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((nodes[0], nodes[1]));
        assert!(cmd_remove_edge_by_id(&g, id, &preset_state).is_empty());
    }

    #[test]
    fn cmd_remove_edge_by_id_ignores_preset_edges_for_teleport_kind() {
        // preset_edges only ever protects Basic edges (see try_remove_edge_by_id's own doc
        // comment) — a Teleport sharing the same (from, to) pair must still be removable.
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((nodes[0], nodes[1]));
        assert_eq!(cmd_remove_edge_by_id(&g, id, &preset_state), vec![MutationCommand::RemoveEdge { id }]);
    }

    #[test]
    fn cmd_remove_teleport_with_reverse_proposes_when_edge_exists() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let cmds = cmd_remove_teleport_with_reverse(&g, id, &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::RemoveTeleportWithReverse { id }]);
    }

    #[test]
    fn cmd_remove_teleport_with_reverse_empty_when_id_stale() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        g.remove_initial_edge(id);
        assert!(cmd_remove_teleport_with_reverse(&g, id, &PresetState::empty()).is_empty());
    }

    /// Cross-checks a `cmd_*` builder's verdict against its `try_*` counterpart's actual result
    /// for every corner of the shared feasibility predicate — the exact property the refactor to
    /// shared predicates (`directed_edge_feasible`/`bidirectional_edge_feasible`/
    /// `remove_edge_between_feasible`) exists to guarantee can never regress silently.
    #[test]
    fn cmd_and_try_agree_on_every_preset_lock_combination_for_directed_edge() {
        for (lock_out, lock_in, blocked) in [
            (false, false, false), (true, false, false), (false, true, false), (false, false, true),
        ] {
            let (mut g, nodes) = graph_and_nodes(2);
            let mut preset_state = PresetState::empty();
            if lock_out { preset_state.locked_out.insert(nodes[0]); }
            if lock_in { preset_state.locked_in.insert(nodes[1]); }
            if blocked { preset_state.blocked.insert((nodes[0], nodes[1])); }

            let proposed = !cmd_add_directed_edge(nodes[0], nodes[1], &preset_state).is_empty();
            let applied = try_add_directed_edge(&mut g, nodes[0], nodes[1], &preset_state);
            assert_eq!(proposed, applied,
                "cmd_add_directed_edge and try_add_directed_edge disagreed for locks ({lock_out}, {lock_in}, {blocked})");
        }
    }

    #[test]
    fn cmd_and_try_agree_on_every_preset_lock_combination_for_bidirectional_edge() {
        for (lock_out_a, lock_in_b, blocked_fwd) in [
            (false, false, false), (true, false, false), (false, true, false), (false, false, true),
        ] {
            let (mut g, nodes) = graph_and_nodes(2);
            let mut preset_state = PresetState::empty();
            if lock_out_a { preset_state.locked_out.insert(nodes[0]); }
            if lock_in_b { preset_state.locked_in.insert(nodes[1]); }
            if blocked_fwd { preset_state.blocked.insert((nodes[0], nodes[1])); }

            let proposed = !cmd_add_bidirectional_edge(nodes[0], nodes[1], &preset_state).is_empty();
            let applied = try_add_bidirectional_edge(&mut g, nodes[0], nodes[1], &preset_state);
            assert_eq!(proposed, applied,
                "cmd_add_bidirectional_edge and try_add_bidirectional_edge disagreed for locks ({lock_out_a}, {lock_in_b}, {blocked_fwd})");
        }
    }

    #[test]
    fn cmd_and_try_agree_on_preset_protection_for_remove_edge_by_id() {
        for protected in [false, true] {
            let (mut g, nodes) = graph_and_nodes(2);
            let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
            let mut preset_state = PresetState::empty();
            if protected { preset_state.preset_edges.insert((nodes[0], nodes[1])); }

            let proposed = !cmd_remove_edge_by_id(&g, id, &preset_state).is_empty();
            let applied = try_remove_edge_by_id(&mut g, id, &preset_state);
            assert_eq!(proposed, applied,
                "cmd_remove_edge_by_id and try_remove_edge_by_id disagreed for protected={protected}");
        }
    }
}

#[cfg(test)]
pub(crate) mod test_utils {
    use crate::graph::Graph;
    use crate::ids::IdGenerator;
    use crate::space::{Field, SquareTessellation, square_rect};
    use super::ElementsConfig;

    pub fn default_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 } }

    pub fn make_field_and_graph(w: usize, h: usize) -> (Field<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        (field, graph)
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
