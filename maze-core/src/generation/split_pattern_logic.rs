use super::debug_state::DebugGenerationState;
use super::split_logic::{SplitOutcome, StartReassignment};
use super::split_pattern::{
    OneWayDirection, PatternVariant, SplitFaceRequirement, SplitGenerationConfig, SplitPattern,
    pattern_variants,
};
use super::split_shared::{
    apply_split_teleport, mark_connected, maybe_reassign_start, mint_split_nodes, sync_all_nodes,
};
use super::vertex_based::{GenState, VertexBasedEvent};
use super::{ElementsConfig, GenerationParams, PresetState};
use crate::event_log::ScopeGuard;
use crate::graph::{EdgeKind, Graph};
use crate::ids::{IdGenerator, NodeId};
use crate::space::{LevelId, MultiLevelField, Tessellation};
use rand::Rng;
use std::collections::HashSet;

/// One face resolved against `src`'s actual field position for one candidate adaptation —
/// intermediate representation `enumerate_adaptations` builds and `adaptation_respects_presets`/
/// `apply_pattern_adaptation` consume. Public so `split_adaptation_candidates` can expose the
/// candidate set to canonical baselines (GitHub issue #753).
#[derive(Debug, Clone)]
pub struct ResolvedFace {
    pub node_index: usize,
    pub requirement: SplitFaceRequirement,
    pub sibling_target: Option<usize>,
    /// `None` for a `Wall` face pointing off-field, or for a `sibling_target` face (no outside
    /// neighbor involved at all). `Some(neighbor)` otherwise.
    pub neighbor: Option<NodeId>,
}

#[derive(Debug, Clone)]
struct Adaptation {
    /// Index into the cell's `descriptor().group()` (one of its allowed transforms).
    transform: usize,
    faces: Vec<ResolvedFace>,
}

/// Whether `src`'s cell can take any pattern of `split_config` — the cell has a shape template
/// and at least one pattern is declared for its descriptor. Pattern mode never splits any other
/// cell (`try_split_src` treats it as ineligible).
pub(super) fn cell_has_pattern<T: Tessellation>(
    field: &MultiLevelField<T>,
    split_config: &SplitGenerationConfig,
    src: NodeId,
) -> bool {
    let Some(point) = field.cell_of(src) else {
        return false;
    };
    let shape = field.tessellation().shape_of(point);
    split_config
        .patterns
        .iter()
        .any(|pattern| pattern.applies_to(shape.as_ref()))
}

/// Pattern path (GitHub issue #222): rolls cyclicity once for the whole event, then loops picking
/// a pattern by weight among the patterns declared for `src`'s shape template (excluding
/// already-rejected ones), enumerating every variant of the cell's allowed transform group, and
/// retrying another pattern when none validate. Returns `SplitOutcome::NoAdaptation` when every
/// pattern is exhausted — same fallback as a missed roll.
#[allow(clippy::too_many_arguments)]
pub(super) fn handle_pattern_split<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    bridge: Option<NodeId>,
    parent: Option<NodeId>,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    debug_state: Option<&mut DebugGenerationState<T>>,
) -> SplitOutcome {
    let cyclic_roll = state.rng.random::<f64>();
    let cyclic_fired = cyclic_roll < params.cyclicity;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitCyclicRolled {
            src,
            roll: cyclic_roll,
            cyclicity: params.cyclicity,
            fired: cyclic_fired,
        });
    }

    let shape = field
        .cell_of(src)
        .and_then(|point| field.tessellation().shape_of(point));
    let mut remaining: Vec<usize> = (0..split_config.patterns.len())
        .filter(|&i| split_config.patterns[i].applies_to(shape.as_ref()))
        .collect();
    while !remaining.is_empty() {
        let weights: Vec<f64> = remaining
            .iter()
            .map(|&i| split_config.patterns[i].weight)
            .collect();
        let pattern_idx = remaining[crate::math::weighted_index(&weights, &mut state.rng)];
        let pattern = &split_config.patterns[pattern_idx];

        let adaptations = match &shape {
            Some(shape) => {
                let variants =
                    state
                        .pattern_variants
                        .variants(&split_config.patterns, pattern_idx, shape);
                enumerate_variant_adaptations(
                    graph,
                    field,
                    preset_state,
                    &state.visited,
                    pattern,
                    &variants,
                    src,
                    bridge,
                    parent,
                    cyclic_fired,
                )
            }
            None => Vec::new(),
        };
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::PatternAdaptationsComputed {
                src,
                pattern: pattern_idx,
                count: adaptations.len(),
            });
        }
        if adaptations.is_empty() {
            remaining.retain(|&i| i != pattern_idx);
            continue;
        }

        let chosen = &adaptations[state.rng.random_range(0..adaptations.len())];
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::PatternAdaptationChosen {
                src,
                pattern: pattern_idx,
                transform: chosen.transform,
            });
        }
        let node_count = pattern.node_count;
        let faces = chosen.faces.clone();
        apply_pattern_adaptation(
            graph,
            field,
            ids,
            elements,
            preset_state,
            state,
            src,
            parent,
            node_count,
            &faces,
            pattern_idx,
            start,
            start_reassignment,
            scope,
            debug_state,
        );
        return SplitOutcome::Handled;
    }

    SplitOutcome::NoAdaptation
}

/// Per-variant scratch state threaded through `resolve_face` — tracks what a single
/// candidate adaptation has committed to so far, so later faces can be validated against earlier
/// ones (no duplicate neighbor claims, at most one visited-neighbor face, bridge/parent coverage).
struct AdaptationBuilder {
    faces: Vec<ResolvedFace>,
    used_neighbors: HashSet<NodeId>,
    visited_face_used: bool,
    bridge_targeted: bool,
    parent_targeted: bool,
}

/// Resolves one pattern face, already mapped onto local face `local_face` of `src`'s cell by the
/// variant, against `src`'s actual field position (`neighbor` plus field membership), pushing it
/// into `builder.faces` on success. Returns `false` when this face invalidates the whole
/// adaptation (caller must abort the rest of this variant).
#[allow(clippy::too_many_arguments)]
fn resolve_face<T: Tessellation>(
    field: &MultiLevelField<T>,
    level: LevelId,
    point: T::CellId,
    visited: &HashSet<NodeId>,
    bridge: Option<NodeId>,
    parent: Option<NodeId>,
    parent_fwd: bool,
    parent_bwd: bool,
    cyclic_fired: bool,
    node_index: usize,
    face: &super::split_pattern::SplitPatternFace,
    local_face: usize,
    builder: &mut AdaptationBuilder,
) -> bool {
    let tessellation = field.tessellation();
    let tess_face = tessellation.faces_of(point)[local_face];

    if face.sibling_target.is_some() {
        builder.faces.push(ResolvedFace {
            node_index,
            requirement: face.requirement,
            sibling_target: face.sibling_target,
            neighbor: None,
        });
        return true;
    }

    let neighbor = field
        .neighbor_via(level, point, tess_face)
        .and_then(|crossing| field.nodes_at(level, crossing.cell).first().copied());

    match face.requirement {
        SplitFaceRequirement::Wall => {
            builder.faces.push(ResolvedFace {
                node_index,
                requirement: face.requirement,
                sibling_target: None,
                neighbor: None,
            });
            true
        }
        SplitFaceRequirement::Unspecified => {
            builder.faces.push(ResolvedFace {
                node_index,
                requirement: face.requirement,
                sibling_target: None,
                neighbor,
            });
            true
        }
        SplitFaceRequirement::Passage | SplitFaceRequirement::OneWay(_) => {
            let Some(neighbor) = neighbor else {
                return false;
            };
            if !builder.used_neighbors.insert(neighbor) {
                return false;
            }
            let is_bridge = bridge == Some(neighbor);
            if is_bridge {
                builder.bridge_targeted = true;
            }
            let is_parent = parent == Some(neighbor);
            if is_parent {
                // The existing src<->parent edge's direction/kind must match this face's
                // requirement exactly, or this adaptation is invalid — never silently
                // reinterpreted as a fresh connection.
                let matches = match face.requirement {
                    SplitFaceRequirement::Passage => parent_fwd && parent_bwd,
                    SplitFaceRequirement::OneWay(OneWayDirection::Forward) => {
                        parent_fwd && !parent_bwd
                    }
                    SplitFaceRequirement::OneWay(OneWayDirection::Backward) => {
                        parent_bwd && !parent_fwd
                    }
                    SplitFaceRequirement::Wall | SplitFaceRequirement::Unspecified => false,
                };
                if !matches {
                    return false;
                }
                builder.parent_targeted = true;
            }
            // Every Passage/OneWay face must resolve to an unvisited neighbor, except at most one
            // (when cyclic_fired) may target an already-visited one — the bridge/parent targets
            // are exempt from this check entirely, since both are by definition already visited.
            if !is_bridge && !is_parent && visited.contains(&neighbor) {
                if !cyclic_fired || builder.visited_face_used {
                    return false;
                }
                builder.visited_face_used = true;
            }
            builder.faces.push(ResolvedFace {
                node_index,
                requirement: face.requirement,
                sibling_target: None,
                neighbor: Some(neighbor),
            });
            true
        }
    }
}

/// Tries one variant of `pattern` (topology level of the two-level applicability rule), returning
/// the resulting adaptation candidate if every face resolved and bridge/parent/preset requirements
/// were all met.
#[allow(clippy::too_many_arguments)]
fn try_adaptation<T: Tessellation>(
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
    visited: &HashSet<NodeId>,
    pattern: &SplitPattern,
    src: NodeId,
    level: LevelId,
    point: T::CellId,
    bridge: Option<NodeId>,
    parent: Option<NodeId>,
    parent_fwd: bool,
    parent_bwd: bool,
    cyclic_fired: bool,
    variant: &PatternVariant,
) -> Option<Adaptation> {
    let mut builder = AdaptationBuilder {
        faces: Vec::new(),
        used_neighbors: HashSet::new(),
        visited_face_used: false,
        bridge_targeted: bridge.is_none(),
        parent_targeted: parent.is_none(),
    };

    for (node_index, (node_faces, local_faces)) in
        pattern.faces.iter().zip(&variant.local_faces).enumerate()
    {
        for (face, &local_face) in node_faces.iter().zip(local_faces) {
            let ok = resolve_face(
                field,
                level,
                point,
                visited,
                bridge,
                parent,
                parent_fwd,
                parent_bwd,
                cyclic_fired,
                node_index,
                face,
                local_face,
                &mut builder,
            );
            if !ok {
                return None;
            }
        }
    }

    if !builder.bridge_targeted || !builder.parent_targeted {
        return None;
    }
    if !adaptation_respects_presets(src, &builder.faces, preset_state) {
        return None;
    }

    Some(Adaptation {
        transform: variant.transform,
        faces: builder.faces,
    })
}

/// Every valid adaptation of `pattern` at `src`, as resolved face lists only — the candidate set
/// `handle_pattern_split` picks from, without the transform index that produced each one. Same inputs and semantics as `enumerate_adaptations`. Used by
/// `maze-runner`'s canonical baselines (GitHub issue #753), which compare candidate sets
/// order-independently.
#[allow(clippy::too_many_arguments)]
pub fn split_adaptation_candidates<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
    visited: &HashSet<NodeId>,
    pattern: &SplitPattern,
    src: NodeId,
    bridge: Option<NodeId>,
    parent: Option<NodeId>,
    cyclic_fired: bool,
) -> Vec<Vec<ResolvedFace>> {
    enumerate_adaptations(
        graph,
        field,
        preset_state,
        visited,
        pattern,
        src,
        bridge,
        parent,
        cyclic_fired,
    )
    .into_iter()
    .map(|adaptation| adaptation.faces)
    .collect()
}

/// Deterministically enumerates every variant of `pattern` on `src`'s cell (`pattern_variants`:
/// the cell's allowed transform group, deduplicated; empty when the pattern's shape is not the
/// cell's) against `src`'s actual field position, filtering out invalid ones. **Pure, RNG-free** — the only RNG draw in
/// the whole pattern path is the single pick from this function's result, in `handle_pattern_split`.
/// A face is valid only if it lands on a real neighbor or is itself `Wall`; every `Passage`/
/// `OneWay` face must resolve to an unvisited neighbor, except at most one face (when
/// `cyclic_fired`) may target an already-visited one — and when `bridge` is `Some`, at least one
/// face must resolve specifically to `bridge` (the pre-existing connection the ordinary flow would
/// have made). Two faces claiming the same physical neighbor invalidates the adaptation. The whole
/// adaptation must also pass `adaptation_respects_presets`.
///
/// `parent`, when `Some`, is `src`'s real, already-in-`graph` edge partner (see `try_split_src`'s
/// doc comment) — exactly one face across every one of this event's resulting nodes must resolve to
/// it (same "must be targeted" requirement as `bridge`, checked independently), and that face's
/// requirement must match the *existing* edge's actual direction/kind exactly: `Passage` only if
/// both `src->parent` and `parent->src` already exist, `OneWay(Forward)` only if `src->parent`
/// exists and `parent->src` doesn't, `OneWay(Backward)` the reverse. A face resolving to `parent`
/// with a mismatching requirement invalidates the whole adaptation outright (no silent
/// reinterpretation) rather than falling through to the ordinary visited-neighbor check.
#[allow(clippy::too_many_arguments)]
fn enumerate_adaptations<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
    visited: &HashSet<NodeId>,
    pattern: &SplitPattern,
    src: NodeId,
    bridge: Option<NodeId>,
    parent: Option<NodeId>,
    cyclic_fired: bool,
) -> Vec<Adaptation> {
    let Some(shape) = field
        .cell_of(src)
        .and_then(|point| field.tessellation().shape_of(point))
    else {
        return Vec::new();
    };
    enumerate_variant_adaptations(
        graph,
        field,
        preset_state,
        visited,
        pattern,
        &pattern_variants(pattern, &shape),
        src,
        bridge,
        parent,
        cyclic_fired,
    )
}

/// `enumerate_adaptations` over already computed `variants` of `pattern` on `src`'s cell — the
/// generation path passes them from `GenState`'s `PatternVariantCache`.
#[allow(clippy::too_many_arguments)]
fn enumerate_variant_adaptations<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
    visited: &HashSet<NodeId>,
    pattern: &SplitPattern,
    variants: &[PatternVariant],
    src: NodeId,
    bridge: Option<NodeId>,
    parent: Option<NodeId>,
    cyclic_fired: bool,
) -> Vec<Adaptation> {
    let (Some(level), Some(point)) = (field.level_of(src), field.cell_of(src)) else {
        return Vec::new();
    };

    let parent_fwd = parent.is_some_and(|p| graph.edge_between(src, p).is_some());
    let parent_bwd = parent.is_some_and(|p| graph.edge_between(p, src).is_some());

    variants
        .iter()
        .filter_map(|variant| {
            try_adaptation(
                field,
                preset_state,
                visited,
                pattern,
                src,
                level,
                point,
                bridge,
                parent,
                parent_fwd,
                parent_bwd,
                cyclic_fired,
                variant,
            )
        })
        .collect()
}

/// Only pattern-local node 0 (= `src`) is subject to any preset constraint — every newly minted
/// node is unconstrained, since `PresetState` physically can't know about a node that doesn't
/// exist yet at preset-resolution time. `locked_out`/`locked_in` on `src` forbids node 0 from an
/// outgoing/incoming `Passage`/`OneWay` face; a `blocked` pair forbids node 0's face toward that
/// specific neighbor in that direction.
fn adaptation_respects_presets(
    src: NodeId,
    faces: &[ResolvedFace],
    preset_state: &PresetState,
) -> bool {
    for face in faces {
        if face.node_index != 0 {
            continue;
        }
        let Some(neighbor) = face.neighbor else {
            continue;
        };
        match face.requirement {
            SplitFaceRequirement::Passage => {
                // A Passage needs both directions free — unlike `can_connect`'s "at least one
                // direction" semantics (used elsewhere for a coin-flip one-way pick), either lock
                // or a one-directional `blocked` pair forbids a bidirectional face entirely.
                let fwd_blocked = preset_state.blocked.contains(&(src, neighbor))
                    || preset_state.locked_out.contains(&src)
                    || preset_state.locked_in.contains(&neighbor);
                let bwd_blocked = preset_state.blocked.contains(&(neighbor, src))
                    || preset_state.locked_out.contains(&neighbor)
                    || preset_state.locked_in.contains(&src);
                if fwd_blocked || bwd_blocked {
                    return false;
                }
            }
            SplitFaceRequirement::OneWay(OneWayDirection::Forward) => {
                if preset_state.locked_out.contains(&src)
                    || preset_state.blocked.contains(&(src, neighbor))
                    || preset_state.locked_in.contains(&neighbor)
                {
                    return false;
                }
            }
            SplitFaceRequirement::OneWay(OneWayDirection::Backward) => {
                if preset_state.locked_in.contains(&src)
                    || preset_state.blocked.contains(&(neighbor, src))
                    || preset_state.locked_out.contains(&neighbor)
                {
                    return false;
                }
            }
            SplitFaceRequirement::Wall | SplitFaceRequirement::Unspecified => {}
        }
    }
    true
}

/// Applies a chosen adaptation's face resolving to `parent` by relocating the real existing edge
/// (remove old, recreate on `node`) instead of adding a brand-new one — see
/// `apply_pattern_adaptation`'s own doc comment for why. Returns `true` when this face was in fact
#[allow(clippy::too_many_arguments)]
/// the parent-relocation case (caller skips ordinary requirement handling for it).
fn try_relocate_parent_edge(
    graph: &mut Graph,
    state: &mut GenState,
    src: NodeId,
    node: NodeId,
    dst: Option<NodeId>,
    parent: Option<NodeId>,
    nodes: &[NodeId],
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> bool {
    if dst.is_none() || parent != dst {
        return false;
    }
    let parent = dst.unwrap();
    // Replace every existing edge endpoint equal to `src` with `node` — `(src, parent)` becomes
    // `(node, parent)`, `(parent, src)` becomes `(parent, node)`, each only if that direction
    // actually existed.
    for (a, b) in [(src, parent), (parent, src)] {
        if let Some(id) = graph.edge_between(a, b) {
            graph.remove_edge(id);
            let new_a = if a == src { node } else { a };
            let new_b = if b == src { node } else { b };
            graph.add_edge(new_a, new_b, EdgeKind::Basic);
        }
    }
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitParentEdgeRelocated {
            parent,
            src,
            taken_by: node,
        });
    }
    mark_connected(state, parent, node, nodes, scope);
    true
}

/// Applies one resolved face's requirement (`Passage`/`OneWay`/`Wall`/`Unspecified`) once the
/// parent-relocation special case has already been ruled out — see `apply_pattern_adaptation`'s
/// own doc comment.
fn apply_face_requirement(
    graph: &mut Graph,
    state: &mut GenState,
    node: NodeId,
    dst: Option<NodeId>,
    requirement: SplitFaceRequirement,
    nodes: &[NodeId],
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    match requirement {
        SplitFaceRequirement::Passage => {
            let Some(dst) = dst else {
                return;
            };
            graph.add_bidirectional_edge(node, dst, EdgeKind::Basic);
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::EdgeAdded {
                    src: node,
                    dst,
                    bidirectional: true,
                });
            }
            mark_connected(state, dst, node, nodes, scope);
        }
        SplitFaceRequirement::OneWay(dir) => {
            let Some(dst) = dst else {
                return;
            };
            let (from, to) = match dir {
                OneWayDirection::Forward => (node, dst),
                OneWayDirection::Backward => (dst, node),
            };
            graph.add_edge(from, to, EdgeKind::Basic);
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::EdgeAdded {
                    src: from,
                    dst: to,
                    bidirectional: false,
                });
            }
            let other = if from == node { dst } else { from };
            mark_connected(state, other, node, nodes, scope);
        }
        SplitFaceRequirement::Wall => {}
        SplitFaceRequirement::Unspecified => {
            if let Some(dst) = dst
                && !state.visited.contains(&dst)
                && !state.in_reserve.contains(&dst)
            {
                state.reserve.push(dst);
                state.in_reserve.insert(dst);
                if let Some(log) = scope {
                    log.emit(VertexBasedEvent::NodeQueuedToReserve { node: dst });
                }
            }
        }
    }
}

/// Applies a chosen, already-validated adaptation: mints `node_count - 1` new nodes (node 0 reuses
/// `src`), adds edges per requirement (`Passage` unconditionally bidirectional, bypassing
/// `one_way_chance`; `OneWay` a single directed edge; `Wall`/`Unspecified` no edge — an
/// unvisited-resolving `Unspecified` face is queued into `reserve` like any undecided free
/// neighbor), marks every connected node visited/frontier'd, then rolls the event's shared
/// teleport connection. Node 0 never runs through `run_ordinary_step_body_for_node` — every one of
/// its connections is already fully decided by the chosen faces.
#[allow(clippy::too_many_arguments)]
fn apply_pattern_adaptation<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut IdGenerator,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    parent: Option<NodeId>,
    node_count: usize,
    faces: &[ResolvedFace],
    pattern_idx: usize,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    debug_state: Option<&mut DebugGenerationState<T>>,
) {
    let nodes = mint_split_nodes(graph, field, ids, src, node_count, debug_state);
    sync_all_nodes(state, &nodes[1..]);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitNodesCreated {
            src,
            nodes: nodes.clone(),
            pattern: Some(pattern_idx),
        });
    }
    maybe_reassign_start(
        src,
        &nodes,
        start,
        start_reassignment,
        state,
        scope.as_deref_mut(),
    );

    // Every node this pattern mints is fully resolved by this same event — every one of its faces
    // (Passage/OneWay/Wall/Unspecified) is already decided by the chosen adaptation, unlike an
    // ordinary frontier node whose connections are discovered incrementally. All of them become
    // `visited` right away, before any face is applied below, so a sibling_target face connecting
    // two of this event's own nodes (`dst` resolved from `nodes[sib]`) is never mistaken for an
    // unvisited node by the `Unspecified` branch's reserve check, and `mark_connected` never pushes
    // a sibling into `frontier` (only a genuine outside neighbor may enter `frontier` from here —
    // see this function's own doc comment).
    for &node in &nodes {
        state.visited.insert(node);
    }

    for face in faces {
        let node = nodes[face.node_index];
        let dst = match (face.sibling_target, face.neighbor) {
            (Some(sib), _) => Some(nodes[sib]),
            (None, Some(n)) => Some(n),
            (None, None) => None,
        };

        // `enumerate_adaptations` already validated that a face resolving to `parent` matches the
        // existing `src<->parent` edge's exact direction/kind — apply that match by relocating the
        // real edge instead of adding a brand-new one, which would either duplicate it (if
        // `node == src`, `add_edge`'s own dedup makes this a no-op) or leave the stale
        // `src<->parent` edge behind entirely (if `node != src`). `dst.is_some()` guards against
        // `parent: None` spuriously matching a Wall/sibling_target face's `dst: None`.
        if try_relocate_parent_edge(
            graph,
            state,
            src,
            node,
            dst,
            parent,
            &nodes,
            scope.as_deref_mut(),
        ) {
            continue;
        }

        apply_face_requirement(
            graph,
            state,
            node,
            dst,
            face.requirement,
            &nodes,
            scope.as_deref_mut(),
        );
    }

    // Neither `src` nor any sibling ever enters `frontier` directly (GitHub issue #222 follow-up)
    // — the whole point's nodes are fully processed by this one event, so none of them is a
    // pending traversal step the way an ordinary frontier entry is. Only their outside neighbors
    // (already pushed above, by `mark_connected`) continue the traversal from here.
    apply_split_teleport(graph, field, elements, preset_state, state, &nodes, scope);
}

#[cfg(test)]
#[path = "split_pattern_logic_test.rs"]
mod tests;
