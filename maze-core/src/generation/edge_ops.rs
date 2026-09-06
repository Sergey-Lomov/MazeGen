use crate::random::MazeRng;
use rand::Rng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{MultiLevelField, Tessellation};
use super::types::ElementsConfig;
use super::preset_state::PresetState;

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

#[cfg(test)]
pub(crate) fn add_edge(graph: &mut Graph, src: NodeId, dst: NodeId, elements: &ElementsConfig, rng: &mut MazeRng) {
    add_edge_kind(graph, src, dst, EdgeKind::Basic, elements.one_way_chance, rng);
}

/// Runs `add_fn` (a `try_add_edge`/`try_add_edge_kind` call), then detects what actually happened
/// by comparing `graph.edge_between` in both directions before/after — the only way to know, since
/// those functions return `()` and a one-way coin flip may add `dst->src` instead of `src->dst`
/// (GitHub issue #144's direction-mismatch fix). Returns `Some((from, to, bidirectional))` with the
/// graph's actual direction when an edge was added, `None` when the attempt was silently declined
/// by a preset conflict. Shared by `vertex_based`'s `generate` and its split paths — every
/// direction-detection call site needs the exact same before/after comparison, only which `add_fn`
/// they call differs.
pub(crate) fn add_edge_and_detect_direction(
    graph: &mut Graph,
    src: NodeId,
    dst: NodeId,
    add_fn: impl FnOnce(&mut Graph),
) -> Option<(NodeId, NodeId, bool)> {
    let fwd_existed_before = graph.edge_between(src, dst).is_some();
    let bwd_existed_before = graph.edge_between(dst, src).is_some();
    add_fn(graph);
    let fwd_added = !fwd_existed_before && graph.edge_between(src, dst).is_some();
    let bwd_added = !bwd_existed_before && graph.edge_between(dst, src).is_some();
    if !fwd_added && !bwd_added { return None; }
    let (from, to) = if fwd_added { (src, dst) } else { (dst, src) };
    Some((from, to, fwd_added && bwd_added))
}

/// `field.neighbors(node)`, filtered for split-point safety (GitHub issue #242). `Field` has no
/// notion of which face belongs to which of a split point's several nodes (see `Field::neighbors`'s
/// own doc comment) — for a point with more than one node, plain geometric adjacency returns every
/// sibling node's neighbors indiscriminately, letting a canonical algorithm (RecursiveBacktracker,
/// Wilson, Kruskal) wire two independent split passages together by walking in through one
/// sibling's face and out through another's.
///
/// A geometric neighbor `n` is dropped from `node`'s candidate list when `n` already has an edge
/// (either direction, in `graph`) to a *different* node at `node`'s own point — that neighbor's
/// only face into this point is already claimed by a sibling (whether via a preset passage
/// resolved before generation started, or a dynamically-added edge from earlier in this same run),
/// so it can no longer be `node`'s neighbor too. An unsplit point (the common case, `nodes_at`
/// returns a single-element slice) never has a "different sibling" to check against, so this is a
/// no-op there — identical to calling `field.neighbors` directly.
pub(crate) fn split_aware_neighbors<T: Tessellation>(field: &MultiLevelField<T>, graph: &Graph, node: NodeId) -> Vec<NodeId> {
    let siblings: &[NodeId] = field.level_of(node).zip(field.point_of(node))
        .map(|(level, point)| field.nodes_at(level, point))
        .unwrap_or(&[]);
    field.neighbors(node)
        .into_iter()
        .filter(|&n| {
            siblings.iter().all(|&sib| {
                sib == node || (graph.edge_between(sib, n).is_none() && graph.edge_between(n, sib).is_none())
            })
        })
        .collect()
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

/// try_add_directed_vertical_passage: adds a single one-way `VerticalPassage` edge `a -> b` —
/// mirrors `try_add_directed_teleport` exactly, see GitHub issue #343.
pub(crate) fn try_add_directed_vertical_passage(
    graph: &mut Graph,
    a: NodeId,
    b: NodeId,
    preset_state: &PresetState,
) -> bool {
    if !directed_edge_feasible(preset_state, a, b) {
        return false;
    }
    if graph.edge_between(a, b).is_none() {
        graph.add_edge(a, b, EdgeKind::VerticalPassage);
    }
    true
}

/// try_add_bidirectional_vertical_passage: strict "both directions free, or skip the pair" connect
/// for a two-way `VerticalPassage` — mirrors `try_add_bidirectional_teleport` exactly, see GitHub
/// issue #343.
pub(crate) fn try_add_bidirectional_vertical_passage(
    graph: &mut Graph,
    a: NodeId,
    b: NodeId,
    preset_state: &PresetState,
) -> bool {
    if !bidirectional_edge_feasible(preset_state, a, b) {
        return false;
    }
    if graph.edge_between(a, b).is_none() {
        graph.add_edge(a, b, EdgeKind::VerticalPassage);
    }
    if graph.edge_between(b, a).is_none() {
        graph.add_edge(b, a, EdgeKind::VerticalPassage);
    }
    true
}

/// try_add_bidirectional_elevator: strict "both directions free, or skip the pair" connect for a
/// two-way `Elevator` edge between one pair of stops — mirrors
/// `try_add_bidirectional_vertical_passage` exactly, see GitHub issue #401. No directed variant —
/// generation/preset setup always wires an elevator's own fan as two-way (see
/// `elevator_core::Elevator`'s doc comment), and no current caller needs a one-way elevator hop.
pub(crate) fn try_add_bidirectional_elevator(
    graph: &mut Graph,
    a: NodeId,
    b: NodeId,
    preset_state: &PresetState,
) -> bool {
    if !bidirectional_edge_feasible(preset_state, a, b) {
        return false;
    }
    if graph.edge_between(a, b).is_none() {
        graph.add_edge(a, b, EdgeKind::Elevator);
    }
    if graph.edge_between(b, a).is_none() {
        graph.add_edge(b, a, EdgeKind::Elevator);
    }
    true
}

/// Shared feasibility predicate for `try_remove_edge`/`cmd_remove_edge` (GitHub issue #118): the
/// node pair must not be a preset (Basic) connection. See `bidirectional_edge_feasible`'s own
/// doc comment for why this is factored out (and `pub(crate)`) rather than re-derived on each side.
pub(crate) fn remove_edge_between_feasible(preset_state: &PresetState, from: NodeId, to: NodeId) -> bool {
    !preset_state.is_preset_edge(from, to)
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
    if preset_state.is_preset_edge_id(id) {
        return false;
    }
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
/// Preset protection is checked two ways here, because `preset_edges` and `preset_edge_ids` answer
/// different questions:
/// - `preset_edge_ids` (per-`EdgeId`, any kind): this exact edge was planted by a preset
///   connection — a preset `Teleport` / `VerticalPassage` / `Elevator` as well as a preset
///   `Basic`. A *different* edge on the same node pair (e.g. a user `Teleport` parallel to a
///   preset `Basic` passage) is not in this set and stays removable.
/// - `preset_edges` (per-pair, kind-agnostic) is also consulted for a `Basic` edge, so a `Basic`
///   edge dynamically added by generation/repair onto a pair a preset already occupies is still
///   protected — the preset builder records the pair even when the specific `Basic` edge id it
///   plants differs from the one being removed here (idempotent `build_initial_edge` returns the
///   existing id, but a later `add_edge` on the reverse direction would mint a new one).
///
/// Returns true if the edge was removed, false if it doesn't exist or is preset-protected.
pub(crate) fn try_remove_edge_by_id(
    graph: &mut Graph,
    id: crate::ids::EdgeId,
    preset_state: &PresetState,
) -> bool {
    let Some(edge) = graph.edge(id) else { return false; };
    if preset_state.is_preset_edge_id(id) {
        return false;
    }
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
/// track pending pairs/candidates by `EdgeId` (e.g. `TeleportGroupSelectStrategy`) need this to
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

/// try_remove_vertical_passage_with_reverse: like `try_remove_teleport_with_reverse`, but for a
/// `VerticalPassage` edge that may be one direction of a two-way vertical passage — see GitHub
/// issue #343.
pub(crate) fn try_remove_vertical_passage_with_reverse(
    graph: &mut Graph,
    id: crate::ids::EdgeId,
    preset_state: &PresetState,
) -> Vec<crate::ids::EdgeId> {
    let reverse_id = graph.vertical_passage_reverse(id);
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

/// try_remove_edge_with_reverse: like `try_remove_edge_by_id`, but for an edge that may be one
/// direction of a two-way connection between the same pair of nodes — also removes the
/// opposite-direction edge (`Graph::edge_between(edge.to, edge.from)`), if any, so a single
/// bidirectional passage cut is one atomic mutation instead of two independently revalidated
/// `RemoveEdge`s (GitHub issue #185). Unlike `try_remove_teleport_with_reverse`, the reverse
/// lookup isn't kind-filtered — a bidirectional `Basic` passage is always two `Basic` edges (see
/// `try_add_bidirectional_edge`), so kind-filtering isn't needed for that common case.
///
/// **Caveat**: `edge_between` returns an arbitrary edge of *any* kind between the pair (see its
/// own doc comment on parallel edges) — this helper does not verify the reverse it finds is
/// itself `Basic`. In the two current callers (`InvalidLoopRandomStrategy`/
/// `InvalidLoopScoredStrategy`), this is a non-issue in practice: cycle edges are resolved via
/// `resolve_to_edge_ids` (`graph/cycles.rs`) off the nav graph's tile paths, which are themselves
/// kind-agnostic, so a `Teleport` edge sitting on a cycle's tile-hop is possible in principle,
/// though not something either strategy's candidate selection specifically guards against or
/// relies on being absent. A future caller reusing this helper on a pair known to mix kinds should
/// not assume the reverse it removes is necessarily `Basic`.
///
/// Returns the set of `EdgeId`s actually removed (empty, one, or both directions) — mirrors
/// `try_remove_teleport_with_reverse`'s return contract.
pub(crate) fn try_remove_edge_with_reverse(
    graph: &mut Graph,
    id: crate::ids::EdgeId,
    preset_state: &PresetState,
) -> Vec<crate::ids::EdgeId> {
    let reverse_id = graph.edge(id).and_then(|edge| graph.edge_between(edge.to, edge.from));
    let mut removed = Vec::with_capacity(2);
    if try_remove_edge_by_id(graph, id, preset_state) {
        removed.push(id);
    }
    if let Some(reverse_id) = reverse_id {
        if reverse_id != id && try_remove_edge_by_id(graph, reverse_id, preset_state) {
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
