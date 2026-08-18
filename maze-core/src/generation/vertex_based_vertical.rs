use rand::Rng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{LevelId, MultiLevelField, Tessellation};
use crate::event_log::ScopeGuard;
use super::super::{ElementsConfig, PresetState, can_connect};
use super::{GenState, add_to_frontier};
use super::vertex_based_event::VertexBasedEvent;

// --- Vertical connections (GitHub issue #337) ---

/// Whether a vertical-connection attempt landed on a `VerticalPassage` or `Elevator` outcome —
/// mirrors the roll described by `GenerationParams::vertical_passage_elevator_balance`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum VerticalKind {
    Passage,
    Elevator,
}

/// Rolls the passage-vs-elevator balance — always consumed once `vertical_chance` hit, regardless
/// of whether a valid target is later found (RNG-always-consumed discipline, same as the rest of
/// this model).
pub(super) fn roll_vertical_balance(
    elements: &ElementsConfig,
    state: &mut GenState,
    src: NodeId,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> VerticalKind {
    let roll = state.rng.random::<f64>();
    let is_elevator = roll < elements.vertical_passage_elevator_balance;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::VerticalBalanceRolled { src, roll, balance: elements.vertical_passage_elevator_balance, is_elevator });
    }
    if is_elevator { VerticalKind::Elevator } else { VerticalKind::Passage }
}

/// The adjacent-floor neighbor (by position in `levels_ordered()`, never by raw `LevelId` — see
/// `Specs/space.md`) `src`'s level has in the given direction. `None` at a boundary (first/last
/// floor) where that direction doesn't exist.
pub(super) fn adjacent_level<T: Tessellation>(field: &MultiLevelField<T>, src: NodeId, upward: bool) -> Option<LevelId> {
    let levels: Vec<LevelId> = field.levels_ordered().collect();
    let src_level = field.level_of(src)?;
    let idx = levels.iter().position(|&l| l == src_level)?;
    if upward {
        levels.get(idx + 1).copied()
    } else {
        idx.checked_sub(1).and_then(|i| levels.get(i).copied())
    }
}

/// Resolves `VerticalPassage`'s single target node: the node at `src`'s own x-y point on the
/// unique adjacent floor available (boundary floors have only one direction; interior floors
/// still resolve to exactly one target here since a passage always targets one specific
/// neighbor — the caller decides which direction via context, see `try_vertical_growth_connect`/
/// `try_vertical_cyclic_edge`). Returns `None` if that direction has no floor, or `node_at`
/// doesn't resolve a node there (different shape/custom cells between floors) — both are
/// `VerticalPassage` failure per the plan, never a coordinate lookup of our own.
pub(super) fn resolve_vertical_passage_target<T: Tessellation>(field: &MultiLevelField<T>, src: NodeId, upward: bool) -> Option<NodeId> {
    let point = field.point_of(src)?;
    let level = adjacent_level(field, src, upward)?;
    field.node_at(level, point)
}

/// Rolls one-way-vs-two-way and, if one-way, the up/down direction for a `VerticalPassage` edge
/// between `src` and the already-resolved `dst`. Adds the edge and emits `VerticalPassageAdded`.
/// `dst` is fixed by the caller (growth: unvisited target; cyclic: the sole visited neighbor) —
/// this function only decides directionality of the edge, never which floor `dst` is on (see the
/// plan's "Direction roll" note: boundary floors need no special-casing here, they simply already
/// have only one possible `dst`).
pub(super) fn add_vertical_passage_edge(
    graph: &mut Graph,
    elements: &ElementsConfig,
    state: &mut GenState,
    src: NodeId,
    dst: NodeId,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    let one_way_roll = state.rng.random::<f64>();
    let one_way = one_way_roll < elements.one_way_vertical_passage_chance;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::VerticalPassageOneWayRolled { roll: one_way_roll, one_way_chance: elements.one_way_vertical_passage_chance, fired: one_way });
    }
    let mut upward = true;
    if one_way {
        let dir_roll = state.rng.random::<f64>();
        upward = dir_roll < elements.vertical_up_down_balance;
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::VerticalPassageDirectionRolled { roll: dir_roll, balance: elements.vertical_up_down_balance, upward });
        }
        let (from, to) = if upward { (src, dst) } else { (dst, src) };
        graph.add_edge(from, to, EdgeKind::VerticalPassage);
    } else {
        graph.add_bidirectional_edge(src, dst, EdgeKind::VerticalPassage);
    }
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::VerticalPassageAdded { src, dst, one_way, upward });
    }
}

/// Growth-context vertical-connect attempt: `vertical_hit` fired, cyclic did not (or vertical
/// wasn't spent on it). Balance decides passage vs. elevator; on failure, falls back to the other
/// kind exactly once (never both ways in the same attempt — see the plan's "not more than one
/// jump" rule), gated by the balance not being fully committed to the failed kind.
#[allow(clippy::too_many_arguments)]
pub(super) fn try_vertical_growth_connect<T: Tessellation>(
    graph: &mut Graph,
    field: &MultiLevelField<T>,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    let kind = roll_vertical_balance(elements, state, src, scope.as_deref_mut());
    match kind {
        VerticalKind::Passage => {
            if try_growth_vertical_passage(graph, field, elements, preset_state, state, src, scope.as_deref_mut()) {
                return;
            }
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::VerticalPassageFailed { src, elevator_fallback_allowed: elements.vertical_passage_elevator_balance != 0.0 });
            }
            if elements.vertical_passage_elevator_balance != 0.0 {
                try_growth_elevator(graph, field, elements, preset_state, state, src, scope);
            }
        }
        VerticalKind::Elevator => {
            if try_growth_elevator(graph, field, elements, preset_state, state, src, scope.as_deref_mut()) {
                return;
            }
            if elements.vertical_passage_elevator_balance != 1.0 {
                try_growth_vertical_passage(graph, field, elements, preset_state, state, src, scope);
            }
        }
    }
}

/// Attempts a growth-context `VerticalPassage`: target must be unvisited, on either adjacent
/// floor (whichever resolves to an unvisited node; if both do, picks uniformly). Returns whether
/// an edge was added.
pub(super) fn try_growth_vertical_passage<T: Tessellation>(
    graph: &mut Graph,
    field: &MultiLevelField<T>,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> bool {
    let candidates: Vec<(bool, NodeId)> = [true, false].into_iter()
        .filter_map(|upward| resolve_vertical_passage_target(field, src, upward).map(|n| (upward, n)))
        .filter(|&(_, n)| !state.visited.contains(&n) && can_connect(src, n, preset_state))
        .collect();
    let Some(&(_, dst)) = (if candidates.len() <= 1 {
        candidates.first()
    } else {
        let idx = state.rng.random_range(0..candidates.len());
        Some(&candidates[idx])
    }) else {
        return false;
    };
    add_vertical_passage_edge(graph, elements, state, src, dst, scope.as_deref_mut());
    state.visited.insert(dst);
    state.in_reserve.remove(&dst);
    add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::NodeVisited { node: dst, parent: src });
    }
    true
}

/// Vertical-cyclic attempt: cyclic and vertical both fired this step. Balance decides passage vs.
/// elevator (cyclic candidate pool: 1 visited neighbor for passage, or an elevator whose floor set
/// includes exactly one visited floor for elevator). On failure, falls back to the ordinary
/// geometric cyclic path (handled by the caller when this returns `false`) — never to the other
/// vertical kind (only growth-context vertical failures bounce between passage/elevator).
pub(super) fn try_vertical_cyclic_edge<T: Tessellation>(
    graph: &mut Graph,
    field: &MultiLevelField<T>,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> bool {
    let kind = roll_vertical_balance(elements, state, src, scope.as_deref_mut());
    match kind {
        VerticalKind::Passage => {
            let candidates: Vec<(bool, NodeId)> = [true, false].into_iter()
                .filter_map(|upward| resolve_vertical_passage_target(field, src, upward).map(|n| (upward, n)))
                .filter(|&(_, n)| state.visited.contains(&n) && can_connect(src, n, preset_state)
                    && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
                .collect();
            let Some(&(_, dst)) = (if candidates.len() <= 1 {
                candidates.first()
            } else {
                Some(&candidates[state.rng.random_range(0..candidates.len())])
            }) else {
                return false;
            };
            add_vertical_passage_edge(graph, elements, state, src, dst, scope);
            true
        }
        VerticalKind::Elevator => {
            try_elevator(graph, field, elements, preset_state, state, src, true, scope)
        }
    }
}

/// Every other floor (besides `src`'s own) that resolves a node at `src`'s x-y via `node_at`,
/// paired with whether that node is unvisited. Ordered by position in `levels_ordered()`.
pub(super) fn elevator_floor_candidates<T: Tessellation>(field: &MultiLevelField<T>, src: NodeId) -> Vec<(LevelId, NodeId)> {
    let Some(point) = field.point_of(src) else { return Vec::new(); };
    let Some(src_level) = field.level_of(src) else { return Vec::new(); };
    field.levels_ordered()
        .filter(|&l| l != src_level)
        .filter_map(|l| field.node_at(l, point).map(|n| (l, n)))
        .collect()
}

/// Longest run of consecutive-by-position floors within `candidates` (already ordered by
/// `levels_ordered()` position) — used to clamp the unvisited pool when
/// `allow_non_consecutive_elevator_floors` is false, computed *before* the branching roll so
/// `floor_count` is never drawn from an unreachable range.
pub(super) fn longest_consecutive_run<T: Tessellation>(field: &MultiLevelField<T>, candidates: &[NodeId]) -> Vec<NodeId> {
    let levels: Vec<LevelId> = field.levels_ordered().collect();
    let mut positions: Vec<(usize, NodeId)> = candidates.iter()
        .filter_map(|&n| field.level_of(n).and_then(|l| levels.iter().position(|&x| x == l)).map(|p| (p, n)))
        .collect();
    positions.sort_by_key(|&(p, _)| p);
    let mut best: Vec<NodeId> = Vec::new();
    let mut current: Vec<NodeId> = Vec::new();
    let mut prev: Option<usize> = None;
    for (pos, node) in positions {
        if prev.map(|p| pos == p + 1).unwrap_or(true) {
            current.push(node);
        } else {
            if current.len() > best.len() { best = current.clone(); }
            current = vec![node];
        }
        prev = Some(pos);
    }
    if current.len() > best.len() { best = current; }
    best
}

/// Full elevator construction attempt for `src`: growth-context (`from_cyclic == false`, floor
/// set entirely unvisited) or cyclic-context (`from_cyclic == true`, exactly one guaranteed
/// visited floor plus unvisited fill). Returns whether the elevator was actually built.
#[allow(clippy::too_many_arguments)]
pub(super) fn try_elevator<T: Tessellation>(
    graph: &mut Graph,
    field: &MultiLevelField<T>,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    from_cyclic: bool,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> bool {
    let all_candidates = elevator_floor_candidates(field, src);
    let unvisited_all: Vec<NodeId> = all_candidates.iter()
        .filter(|&&(_, n)| !state.visited.contains(&n) && can_connect(src, n, preset_state))
        .map(|&(_, n)| n)
        .collect();
    let visited_all: Vec<NodeId> = all_candidates.iter()
        .filter(|&&(_, n)| state.visited.contains(&n) && can_connect(src, n, preset_state)
            && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
        .map(|&(_, n)| n)
        .collect();

    let has_cyclic_visited = from_cyclic && !visited_all.is_empty();
    let cyclic_visited_node = if has_cyclic_visited { Some(visited_all[0]) } else { None };
    if from_cyclic && !has_cyclic_visited {
        // Cyclic elevator attempt with no visited floor available at all — nothing to realize.
        return false;
    }

    let unvisited_pool: Vec<NodeId> = if elements.allow_non_consecutive_elevator_floors {
        unvisited_all.clone()
    } else {
        longest_consecutive_run(field, &unvisited_all)
    };

    // `max_slots`/`floor_count` count *total* floors the elevator connects, including `src`
    // itself (per the plan's terminology) — the candidate pool only ever supplies the floors
    // *besides* src, so it caps out at `pool.len() + 1` (the "+1" is src's own floor).
    let max_slots = unvisited_pool.len() + if has_cyclic_visited { 1 } else { 0 } + 1;
    let max_slots_clamped = max_slots.min(elements.elevator_span_max);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::ElevatorSlotsComputed {
            src, unvisited_pool_size: unvisited_pool.len(), has_cyclic_visited,
            max_slots: max_slots_clamped, span_min: elements.elevator_span_min,
        });
    }
    if max_slots_clamped < elements.elevator_span_min {
        let fallback_allowed = if from_cyclic { true } else { elements.vertical_passage_elevator_balance != 1.0 };
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::ElevatorSlotsFailed { src, fallback_allowed });
        }
        return false;
    }

    let floor_count = if max_slots_clamped == elements.elevator_span_min {
        elements.elevator_span_min
    } else {
        let mut count = elements.elevator_span_min;
        for _slot in 1..=(max_slots_clamped - elements.elevator_span_min) {
            let roll = state.rng.random::<f64>();
            if roll < elements.elevator_branching {
                count += 1;
            }
        }
        count
    };
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::ElevatorFloorCountChosen { src, floor_count });
    }

    // `chosen` holds the floors besides src — floor_count includes src, so it needs floor_count-1
    // entries here (one of which is the guaranteed cyclic floor, when present).
    let chosen_needed = floor_count.saturating_sub(1);
    let mut chosen: Vec<NodeId> = Vec::with_capacity(chosen_needed);
    let unvisited_needed = if has_cyclic_visited { chosen_needed.saturating_sub(1) } else { chosen_needed };
    let mut pool = unvisited_pool.clone();
    for _ in 0..unvisited_needed.min(pool.len()) {
        let idx = state.rng.random_range(0..pool.len());
        chosen.push(pool.swap_remove(idx));
    }
    if let Some(cyclic_node) = cyclic_visited_node {
        chosen.push(cyclic_node);
    }

    let mut nodes: Vec<NodeId> = vec![src];
    nodes.extend(chosen.iter().copied());
    let mut edges_added = 0usize;
    for i in 0..nodes.len() {
        for j in (i + 1)..nodes.len() {
            let (a, b) = (nodes[i], nodes[j]);
            if !can_connect(a, b, preset_state) || !can_connect(b, a, preset_state) { continue; }
            if graph.edge_between(a, b).is_none() {
                graph.add_edge(a, b, EdgeKind::Elevator);
                edges_added += 1;
            }
            if graph.edge_between(b, a).is_none() {
                graph.add_edge(b, a, EdgeKind::Elevator);
                edges_added += 1;
            }
        }
    }
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::ElevatorAdded { nodes: nodes.clone(), edges_added });
    }

    for &n in &chosen {
        if !state.visited.contains(&n) {
            state.visited.insert(n);
            state.in_reserve.remove(&n);
            add_to_frontier(n, Some(src), &mut state.frontier, &mut state.in_frontier);
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::NodeVisited { node: n, parent: src });
            }
        }
    }
    true
}

pub(super) fn try_growth_elevator<T: Tessellation>(
    graph: &mut Graph,
    field: &MultiLevelField<T>,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> bool {
    try_elevator(graph, field, elements, preset_state, state, src, false, scope)
}
