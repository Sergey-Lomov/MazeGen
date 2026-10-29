#[path = "vertex_based_event.rs"]
mod vertex_based_event;
#[path = "vertex_based_vertical.rs"]
mod vertex_based_vertical;
use vertex_based_vertical::{
    add_vertical_passage_edge, try_vertical_cyclic_edge, try_vertical_growth_connect,
};
#[cfg(test)]
use vertex_based_vertical::{
    elevator_floor_candidates, longest_consecutive_run, resolve_vertical_passage_target,
    try_elevator, try_growth_vertical_passage,
};

pub(super) use super::add_edge_and_detect_direction;
use super::debug_state::DebugGenerationState;
use super::split_logic::{SplitOutcome, StartReassignment, try_split_src};
use super::split_pattern::{PatternVariantCache, SplitGenerationConfig};
use super::{
    ElementPlacementRules, ElementsConfig, GeneratedElementKind, GenerationParams, PresetState,
    can_connect, gaussian_weighted_index, try_add_edge, try_add_edge_kind,
};
use crate::event_log::{EventLog, ScopeGuard};
use crate::graph::{EdgeKind, Graph};
use crate::ids::{IdGenerator, NodeId};
use crate::random::MazeRng;
use crate::space::{MultiLevelField, Tessellation};
use rand::{Rng, SeedableRng};
use std::collections::HashSet;
pub use vertex_based_event::{VertexBasedEvent, debug_value_names};

/// Emits the explicit no-roll diagnostic required when a cell-type placement rule blocks a
/// chance-driven generator element. Kept next to `GenState` so every vertex-based path shares
/// the same policy and narration payload.
pub(super) fn element_roll_allowed<T: Tessellation>(
    state: &GenState,
    field: &MultiLevelField<T>,
    src: NodeId,
    kind: GeneratedElementKind,
    scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> bool {
    if state.allows(field, kind, src) {
        return true;
    }
    if let Some(log) = scope
        && let Some(cell) = field.cell_of(src)
    {
        log.emit(VertexBasedEvent::ElementRollSkipped {
            src,
            element: kind.key().to_string(),
            cell_type: field.tessellation().cell_type_key_of(cell).to_string(),
        });
    }
    false
}

/// Adds a regular passage while suppressing its one-way-direction roll when either endpoint
/// forbids one-way elements. A regular passage remains valid: only its optional directionality
/// is constrained by the placement matrix.
pub(super) fn try_add_regular_edge<T: Tessellation>(
    graph: &mut Graph,
    field: &MultiLevelField<T>,
    src: NodeId,
    dst: NodeId,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> Option<(NodeId, NodeId, bool)> {
    let one_way_allowed = state.allows(field, GeneratedElementKind::OneWay, src)
        && state.allows(field, GeneratedElementKind::OneWay, dst);
    if !one_way_allowed && elements.one_way_chance > 0.0 {
        let _ = element_roll_allowed(
            state,
            field,
            src,
            GeneratedElementKind::OneWay,
            scope.as_deref_mut(),
        );
        let _ = element_roll_allowed(state, field, dst, GeneratedElementKind::OneWay, scope);
    }
    add_edge_and_detect_direction(graph, src, dst, |g| {
        if one_way_allowed {
            try_add_edge(g, src, dst, elements, preset_state, &mut state.rng)
        } else {
            try_add_edge_kind(
                g,
                src,
                dst,
                EdgeKind::Basic,
                0.0,
                preset_state,
                &mut state.rng,
            )
        }
    })
}

pub(super) struct FrontierEntry {
    node: NodeId,
    parent: Option<NodeId>,
}

/// Mutable traversal state threaded through one `generate` run — bundled so the per-step helper
/// functions don't each need a 6+ parameter list. `all_nodes` is sorted once at construction for
/// deterministic iteration order (candidate pool for teleport rolls: any node in the graph, not
/// restricted to geometric neighbors).
pub(super) struct GenState {
    pub(super) visited: HashSet<NodeId>,
    pub(super) in_frontier: HashSet<NodeId>,
    pub(super) frontier: Vec<FrontierEntry>,
    pub(super) reserve: Vec<NodeId>,
    pub(super) in_reserve: HashSet<NodeId>,
    pub(super) rng: MazeRng,
    pub(super) all_nodes: Vec<NodeId>,
    pub(super) element_placement_rules: Option<ElementPlacementRules>,
    /// Split-pattern variants per (pattern, cell binding), computed once per run.
    pub(super) pattern_variants: PatternVariantCache,
}

impl GenState {
    #[cfg(test)]
    pub(super) fn new(graph: &Graph, seed: u64, start: NodeId) -> Self {
        Self::new_with_rules(graph, seed, start, None)
    }

    pub(super) fn new_with_rules(
        graph: &Graph,
        seed: u64,
        start: NodeId,
        element_placement_rules: Option<ElementPlacementRules>,
    ) -> Self {
        let mut all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
        all_nodes.sort_unstable();
        let mut state = GenState {
            visited: HashSet::new(),
            in_frontier: HashSet::new(),
            frontier: Vec::new(),
            reserve: Vec::new(),
            in_reserve: HashSet::new(),
            rng: MazeRng::seed_from_u64(seed),
            all_nodes,
            element_placement_rules,
            pattern_variants: PatternVariantCache::default(),
        };
        // preset_connected nodes are NOT added to visited upfront — this keeps them visible
        // as connection targets for free_neighbors. Exception: start itself may be preset_connected
        // (e.g. gen_source inside a preset cluster) — it must enter the frontier regardless.
        state.visited.insert(start);
        add_to_frontier(start, None, &mut state.frontier, &mut state.in_frontier);
        state
    }

    pub(super) fn allows<T: Tessellation>(
        &self,
        field: &MultiLevelField<T>,
        kind: GeneratedElementKind,
        node: NodeId,
    ) -> bool {
        self.element_placement_rules.as_ref().is_none_or(|rules| {
            field
                .cell_of(node)
                .is_some_and(|cell| rules.allows(field.tessellation(), kind, cell))
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut IdGenerator,
    seed: u64,
    start: NodeId,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    start_reassignment: &mut Option<StartReassignment>,
    event_log: Option<&mut EventLog<VertexBasedEvent>>,
    debug_state: Option<&mut DebugGenerationState<T>>,
) {
    generate_with_rules(
        graph,
        field,
        ids,
        seed,
        start,
        params,
        elements,
        None,
        split_config,
        preset_state,
        start_reassignment,
        event_log,
        debug_state,
    );
}

#[allow(clippy::too_many_arguments)]
pub fn generate_with_rules<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut IdGenerator,
    seed: u64,
    start: NodeId,
    params: &GenerationParams,
    elements: &ElementsConfig,
    element_placement_rules: Option<ElementPlacementRules>,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    start_reassignment: &mut Option<StartReassignment>,
    mut event_log: Option<&mut EventLog<VertexBasedEvent>>,
    mut debug_state: Option<&mut DebugGenerationState<T>>,
) {
    let mut state = GenState::new_with_rules(graph, seed, start, element_placement_rules);
    if let Some(log) = event_log.as_deref_mut() {
        log.emit(VertexBasedEvent::StartVisited { node: start });
    }

    loop {
        if state.frontier.is_empty() {
            let mut step_scope = event_log
                .as_deref_mut()
                .map(|log| log.enter_numbered("step"));
            let keep_going = handle_empty_frontier(
                graph,
                field,
                ids,
                params,
                elements,
                split_config,
                preset_state,
                &mut state,
                start,
                start_reassignment,
                step_scope.as_mut(),
                debug_state.as_deref_mut(),
            );
            drop(step_scope);
            if !keep_going {
                break;
            }
            continue;
        }

        let mut step_scope = event_log
            .as_deref_mut()
            .map(|log| log.enter_numbered("step"));
        step_from_frontier(
            graph,
            field,
            ids,
            params,
            elements,
            split_config,
            preset_state,
            &mut state,
            start,
            start_reassignment,
            step_scope.as_mut(),
            debug_state.as_deref_mut(),
        );
    }
}

/// Brings a new node into the maze when the frontier is empty — via a teleport roll (a hit
/// replaces the step's entire mechanism: bridges via teleport instead of geometric adjacency), by
/// popping a reachable candidate off `reserve`, or — when neither finds a candidate but unvisited
/// nodes remain elsewhere on the field — by restarting growth from a random unvisited node as a
/// new, unbridged component (GitHub issue #417). Returns `false` only when no unvisited node
/// remains anywhere in the field, `true` to keep looping.
#[allow(clippy::too_many_arguments)]
fn handle_empty_frontier<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    mut debug_state: Option<&mut DebugGenerationState<T>>,
) -> bool {
    // Teleport roll happens before any reserve lookup — a hit replaces this step's
    // entire mechanism (bridges via a teleport instead of a geometric-adjacency bridge).
    let teleport_eligible = state.all_nodes.iter().any(|node| {
        state.visited.contains(node) && state.allows(field, GeneratedElementKind::Teleport, *node)
    }) && state.all_nodes.iter().any(|node| {
        !state.visited.contains(node) && state.allows(field, GeneratedElementKind::Teleport, *node)
    });
    let teleport_roll = teleport_eligible.then(|| state.rng.random::<f64>());
    let teleport_fired = teleport_roll.is_some_and(|roll| roll < elements.teleport_chance);
    if let Some(log) = scope.as_deref_mut()
        && let Some(roll) = teleport_roll
    {
        log.emit(VertexBasedEvent::TeleportBridgeRolled {
            roll,
            teleport_chance: elements.teleport_chance,
            fired: teleport_fired,
        });
    }
    if !teleport_eligible
        && elements.teleport_chance > 0.0
        && let Some(&blocked) = state
            .all_nodes
            .iter()
            .find(|node| !state.allows(field, GeneratedElementKind::Teleport, **node))
    {
        let _ = element_roll_allowed(
            state,
            field,
            blocked,
            GeneratedElementKind::Teleport,
            scope.as_deref_mut(),
        );
    }
    if teleport_fired {
        let unvisited: Vec<NodeId> = state
            .all_nodes
            .iter()
            .copied()
            .filter(|n| {
                !state.visited.contains(n)
                    && state.allows(field, GeneratedElementKind::Teleport, *n)
            })
            .collect();
        if unvisited.is_empty() {
            // Nothing left to bring in via teleport either — generation is done.
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::ReserveExhausted);
            }
            return false;
        }
        let visited_nodes: Vec<NodeId> = state
            .all_nodes
            .iter()
            .copied()
            .filter(|n| {
                state.visited.contains(n) && state.allows(field, GeneratedElementKind::Teleport, *n)
            })
            .collect();
        let bridge = visited_nodes[state.rng.random_range(0..visited_nodes.len())];

        // Cross-floor teleport balance (GitHub issue #337) — only rolled/applied when the maze
        // has more than one floor (RNG-parity policy). `bridge`'s own floor is "same floor" for
        // this roll, since `bridge` is the connection's already-fixed visited endpoint.
        let unvisited = if field.level_count() > 1 {
            filter_teleport_pool_by_floor(
                field,
                elements,
                state,
                bridge,
                unvisited,
                scope.as_deref_mut(),
            )
        } else {
            unvisited
        };
        if unvisited.is_empty() {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::ReserveExhausted);
            }
            return false;
        }
        let src = unvisited[state.rng.random_range(0..unvisited.len())];

        let outcome = try_split_src(
            graph,
            field,
            ids,
            params,
            elements,
            split_config,
            preset_state,
            state,
            src,
            Some(bridge),
            None,
            start,
            start_reassignment,
            scope.as_deref_mut(),
            debug_state.as_deref_mut(),
        );
        if outcome == SplitOutcome::Handled {
            return true;
        }

        let added = add_edge_and_detect_direction(graph, bridge, src, |g| {
            try_add_edge_kind(
                g,
                bridge,
                src,
                EdgeKind::Teleport,
                elements.teleport_one_way_chance,
                preset_state,
                &mut state.rng,
            )
        });
        if let Some((from, to, bidirectional)) = added
            && let Some(log) = scope.as_deref_mut()
        {
            log.emit(VertexBasedEvent::TeleportBridgeAdded {
                src: from,
                dst: to,
                bidirectional,
            });
        }
        state.visited.insert(src);
        add_to_frontier(
            src,
            Some(bridge),
            &mut state.frontier,
            &mut state.in_frontier,
        );
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::NodeVisited {
                node: src,
                parent: bridge,
            });
        }
        return true;
    }

    // Find a reserve candidate with a visited (reachable) neighbor. Previously this popped via
    // the weighted-random `pop_reserve` in a loop, re-pushing rejects and tracking a `seen` set
    // to detect cycling — but `pop_reserve`'s draw is random, not round-robin, so a rejected
    // candidate can resurface (and get re-counted or re-missed) long before every other candidate
    // has had a turn: no bound on how many draws a full pass over the reserve actually takes, so
    // the "abort on repeat" logic either gave up early (most of the reserve still untried) or
    // spun for a very long time chasing coverage that random re-drawing doesn't guarantee
    // (GitHub issue #356). Fixed by making the search itself deterministic: one linear pass over
    // the current reserve, each entry visited exactly once, splitting it into "keep" (still not
    // reachable, stays in reserve) and "drop" (already visited, discarded) — only the winning
    // candidate (if any) is actually removed via `pop_reserve`-style weighted pick, but restricted
    // to the reachable subset so it can't return an already-tried non-candidate.
    let src = {
        let mut search_scope = scope.as_deref_mut().map(|log| log.enter("reserve_search"));
        let mut kept: Vec<NodeId> = Vec::with_capacity(state.reserve.len());
        let mut reachable: Vec<NodeId> = Vec::new();
        let placement_rules = state.element_placement_rules.clone();
        let allows_vertical_passage = |node: NodeId| {
            placement_rules.as_ref().is_none_or(|rules| {
                field.cell_of(node).is_some_and(|cell| {
                    rules.allows(
                        field.tessellation(),
                        GeneratedElementKind::VerticalPassage,
                        cell,
                    )
                })
            })
        };
        for candidate in state.reserve.drain(..) {
            state.in_reserve.remove(&candidate);
            if state.visited.contains(&candidate) {
                if let Some(g) = search_scope.as_mut() {
                    g.emit(VertexBasedEvent::ReserveCandidateRejected {
                        node: candidate,
                        already_visited: true,
                    });
                }
                continue;
            }
            let has_visited_neighbor = field
                .neighbors(candidate)
                .into_iter()
                .any(|n| state.visited.contains(&n) && can_connect(n, candidate, preset_state))
                || (elements.vertical_chance > 0.0
                    && allows_vertical_passage(candidate)
                    && field.vertical_neighbors(candidate).into_iter().any(|n| {
                        state.visited.contains(&n)
                            && can_connect(n, candidate, preset_state)
                            && allows_vertical_passage(n)
                            && graph.edge_between(n, candidate).is_none()
                            && graph.edge_between(candidate, n).is_none()
                    }));
            if has_visited_neighbor {
                reachable.push(candidate);
            } else {
                if let Some(g) = search_scope.as_mut() {
                    g.emit(VertexBasedEvent::ReserveCandidateRejected {
                        node: candidate,
                        already_visited: false,
                    });
                }
                kept.push(candidate);
            }
        }
        // `ReserveCandidateChosen` is `mutating` (removes `node` from the debug `reserve` mirror)
        // and must fire for exactly the winner — emitting it for every reachable candidate found
        // during the scan would desync the mirror for every candidate that loses the weighted pick
        // and gets pushed back below (see `debug_value_deltas`'s doc comment on this event).
        let result = if reachable.is_empty() {
            None
        } else {
            let idx = gaussian_weighted_index(reachable.len(), params.depth_first, &mut state.rng);
            let winner = reachable.swap_remove(idx);
            if let Some(g) = search_scope.as_mut() {
                g.emit(VertexBasedEvent::ReserveCandidateChosen { node: winner });
                for &loser in &reachable {
                    g.emit(VertexBasedEvent::ReserveCandidateRejected {
                        node: loser,
                        already_visited: false,
                    });
                }
            }
            Some(winner)
        };
        // Everything not chosen goes back into the reserve: the rest of the reachable pool
        // (lost this round only because another candidate won the weighted pick) plus every
        // not-yet-reachable candidate.
        kept.extend(reachable);
        for n in &kept {
            state.in_reserve.insert(*n);
        }
        state.reserve = kept;
        if result.is_none()
            && let Some(g) = search_scope.as_mut()
        {
            g.emit(VertexBasedEvent::ReserveExhausted);
        }
        result
    };
    let Some(src) = src else {
        // Reserve exhausted and no reachable candidate found — but unvisited nodes may still
        // exist in a disconnected region that no visited node's neighbor pool ever reached
        // (GitHub issue #417). Rather than ending generation, start a fresh growth component
        // from a random unvisited node: mark it visited and push it to the frontier with no
        // parent/bridge edge, mirroring the run's own `start` (`GenState::new`/`StartVisited`).
        let unvisited: Vec<NodeId> = state
            .all_nodes
            .iter()
            .copied()
            .filter(|n| !state.visited.contains(n))
            .collect();
        if unvisited.is_empty() {
            return false;
        }
        let new_root = unvisited[state.rng.random_range(0..unvisited.len())];
        state.visited.insert(new_root);
        add_to_frontier(new_root, None, &mut state.frontier, &mut state.in_frontier);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::StartVisited { node: new_root });
        }
        return true;
    };
    let geometric_neighbors: Vec<NodeId> = field
        .neighbors(src)
        .into_iter()
        .filter(|&n| state.visited.contains(&n) && can_connect(n, src, preset_state))
        .collect();
    let vertical_neighbors: Vec<NodeId> = field
        .vertical_neighbors(src)
        .into_iter()
        .filter(|&n| {
            state.visited.contains(&n)
                && can_connect(n, src, preset_state)
                && state.allows(field, GeneratedElementKind::VerticalPassage, n)
                && graph.edge_between(n, src).is_none()
                && graph.edge_between(src, n).is_none()
        })
        .collect();

    let vertical_eligible = state.allows(field, GeneratedElementKind::VerticalPassage, src)
        && !vertical_neighbors.is_empty();
    if !vertical_eligible && elements.vertical_chance > 0.0 {
        let _ = element_roll_allowed(
            state,
            field,
            src,
            GeneratedElementKind::VerticalPassage,
            scope.as_deref_mut(),
        );
    }
    let vertical_roll = vertical_eligible.then(|| state.rng.random::<f64>());
    let vertical_hit = vertical_roll.is_some_and(|roll| roll < elements.vertical_chance);
    let use_vertical = if vertical_hit {
        !vertical_neighbors.is_empty()
    } else {
        elements.vertical_chance > 0.0
            && geometric_neighbors.is_empty()
            && !vertical_neighbors.is_empty()
    };

    let geometric_bridge = (!use_vertical)
        .then(|| geometric_neighbors[state.rng.random_range(0..geometric_neighbors.len())]);

    if let Some(geometric_bridge) = geometric_bridge {
        let outcome = try_split_src(
            graph,
            field,
            ids,
            params,
            elements,
            split_config,
            preset_state,
            state,
            src,
            Some(geometric_bridge),
            None,
            start,
            start_reassignment,
            scope.as_deref_mut(),
            debug_state,
        );
        if outcome == SplitOutcome::Handled {
            return true;
        }
    }

    let bridge = if use_vertical {
        let bridge = vertical_neighbors[state.rng.random_range(0..vertical_neighbors.len())];
        add_vertical_passage_edge(
            graph,
            field,
            elements,
            state,
            bridge,
            src,
            scope.as_deref_mut(),
        );
        bridge
    } else {
        let bridge = geometric_bridge.expect("geometric bridge picked above when !use_vertical");
        let added = try_add_regular_edge(
            graph,
            field,
            bridge,
            src,
            elements,
            preset_state,
            state,
            scope.as_deref_mut(),
        );
        if let Some((from, to, bidirectional)) = added
            && let Some(log) = scope.as_deref_mut()
        {
            log.emit(VertexBasedEvent::BridgeAdded {
                src: from,
                dst: to,
                bidirectional,
            });
        }
        bridge
    };
    state.visited.insert(src);
    add_to_frontier(
        src,
        Some(bridge),
        &mut state.frontier,
        &mut state.in_frontier,
    );
    if let Some(log) = scope {
        log.emit(VertexBasedEvent::NodeVisited {
            node: src,
            parent: bridge,
        });
    }
    true
}

/// One "pop a frontier node and connect its free neighbors" step — the main-loop body once the
/// frontier is non-empty: teleport roll, cyclic-roll (possibly teleport-widened), corridor/
/// junction connect-choice, then applying every mutation this step decided on in order.
#[allow(clippy::too_many_arguments)]
fn step_from_frontier<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    debug_state: Option<&mut DebugGenerationState<T>>,
) {
    let fi = choose_from_frontier(&state.frontier, params, &mut state.rng);
    let src = state.frontier[fi].node;
    let parent = state.frontier[fi].parent;
    let frontier_len = state.frontier.len();
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SrcChosenFromFrontier {
            src,
            frontier_len,
            position: fi,
            depth_first: params.depth_first,
        });
    }

    state.frontier.remove(fi);
    state.in_frontier.remove(&src);

    let outcome = try_split_src(
        graph,
        field,
        ids,
        params,
        elements,
        split_config,
        preset_state,
        state,
        src,
        None,
        parent,
        start,
        start_reassignment,
        scope.as_deref_mut(),
        debug_state,
    );
    if outcome == SplitOutcome::Handled {
        return;
    }

    run_ordinary_step_body_for_node(
        graph,
        field,
        params,
        elements,
        preset_state,
        state,
        src,
        parent,
        true,
        None,
        scope,
    );
}

/// The corridor/junction/cyclic/frontier-push body for one node, factored out of
/// `step_from_frontier` so the split paths (GitHub issue #222) can invoke it once per resulting
/// split node instead of once per ordinary frontier pop. `roll_teleport` gates whether this call's
/// own teleport roll/connect-step runs at all — `step_from_frontier`'s own (non-split) call site
/// always passes `true`; the non-pattern split path passes `false` for every per-node call and
/// rolls teleport once for the whole split event instead (see `handle_non_pattern_split`).
#[allow(clippy::too_many_arguments)]
pub(super) fn run_ordinary_step_body_for_node<T: Tessellation>(
    graph: &mut Graph,
    field: &MultiLevelField<T>,
    params: &GenerationParams,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    parent: Option<NodeId>,
    roll_teleport: bool,
    allowed_neighbors: Option<&HashSet<NodeId>>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    // Cyclic roll happens first (GitHub issue #337 — opposite order from teleport, by explicit
    // decision), before teleport/vertical rolls that may need to know cyclic_fired to decide
    // whether their own hit gets "spent" on the cyclic edge instead of a growth connection.
    let cyclic_roll = state.rng.random::<f64>();
    let cyclic_fired = cyclic_roll < params.cyclicity;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::CyclicRolled {
            src,
            roll: cyclic_roll,
            cyclicity: params.cyclicity,
            fired: cyclic_fired,
        });
    }

    // Teleport roll happens immediately after cyclic, before any geometric-neighbor pool is
    // built — a hit affects the cyclic candidate pool (below) and adds one extra teleport
    // connection alongside whatever the corridor/junction roll produces.
    let teleport_hit = if roll_teleport
        && element_roll_allowed(
            state,
            field,
            src,
            GeneratedElementKind::Teleport,
            scope.as_deref_mut(),
        ) {
        let teleport_roll = state.rng.random::<f64>();
        let hit = teleport_roll < elements.teleport_chance;
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::TeleportRolled {
                src,
                roll: teleport_roll,
                teleport_chance: elements.teleport_chance,
                fired: hit,
            });
        }
        hit
    } else {
        false
    };

    // Vertical-connection roll — RNG-parity policy (GitHub issue #337): only rolled when the
    // maze has more than one floor, so a single-floor maze's RNG sequence/golden tests stay
    // byte-identical to before this feature existed (floor_count is a static config property,
    // not per-step branching, so skipping it here doesn't violate the "always consumed" rule
    // that governs `teleport_chance`/`cyclicity`/`split_chance`).
    let vertical_eligible = state.allows(field, GeneratedElementKind::VerticalPassage, src)
        || state.allows(field, GeneratedElementKind::Elevator, src);
    let vertical_hit = if roll_teleport && field.level_count() > 1 && vertical_eligible {
        let vertical_roll = state.rng.random::<f64>();
        let hit = vertical_roll < elements.vertical_chance;
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::VerticalRolled {
                src,
                roll: vertical_roll,
                vertical_chance: elements.vertical_chance,
                fired: hit,
            });
        }
        hit
    } else {
        if roll_teleport && field.level_count() > 1 && !vertical_eligible {
            let _ = element_roll_allowed(
                state,
                field,
                src,
                GeneratedElementKind::VerticalPassage,
                scope.as_deref_mut(),
            );
            let _ = element_roll_allowed(
                state,
                field,
                src,
                GeneratedElementKind::Elevator,
                scope.as_deref_mut(),
            );
        }
        false
    };

    // free_regular: unvisited, non-frontier, non-preset neighbors — become frontier/reserve.
    // free_preset: preset-connected neighbors (geometric, vertical, or teleport) not yet visited —
    // connect to them but skip frontier's own edge-adding step (their edge already exists in the
    // graph). Preset `VerticalPassage`/`Elevator` partners (GitHub issue #371) are geometrically
    // invisible to `field.neighbors` (different floor), so they must be pulled in via
    // `field.vertical_neighbors` explicitly — otherwise a preset-planted vertical edge is never
    // discovered by ordinary growth and the partner floor only ever gets picked up later via the
    // reserve-bridge fallback, which doesn't know the edge already exists and can add a redundant
    // one (or, when `vertical_chance == 0`, add a vertical connection where none should exist).
    let preset_connected = &preset_state.preset_connected;
    let teleport_dsts = preset_state
        .preset_teleports
        .get(&src)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let preset_vertical_dsts: Vec<NodeId> = if preset_connected.contains(&src) {
        field
            .vertical_neighbors(src)
            .into_iter()
            .filter(|n| preset_connected.contains(n))
            .collect()
    } else {
        Vec::new()
    };
    let all_free: Vec<NodeId> = field
        .neighbors(src)
        .into_iter()
        .filter(|n| allowed_neighbors.is_none_or(|allowed| allowed.contains(n)))
        .chain(teleport_dsts.iter().copied())
        .chain(preset_vertical_dsts.iter().copied())
        .filter(|&n| {
            !state.visited.contains(&n)
                && !state.in_frontier.contains(&n)
                && (preset_connected.contains(&src) && preset_connected.contains(&n)
                    || teleport_dsts.contains(&n)
                    || can_connect(src, n, preset_state))
        })
        .collect();
    let (free_preset, free_regular): (Vec<NodeId>, Vec<NodeId>) = all_free
        .into_iter()
        .partition(|n| preset_connected.contains(n) || teleport_dsts.contains(n));

    // Vertical cyclic attempt: if both cyclic and vertical fired this step, vertical first tries
    // to realize the cyclic edge (visited target). Success spends both rolls entirely; failure
    // falls back to the ordinary geometric/teleport cyclic path below with vertical_hit untouched
    // for the growth-connect step (vertical_for_connect below already accounts for this).
    let vertical_cyclic_added = if cyclic_fired && vertical_hit {
        try_vertical_cyclic_edge(
            graph,
            field,
            elements,
            preset_state,
            state,
            src,
            scope.as_deref_mut(),
        )
    } else {
        false
    };

    let (cyclic_dst, teleport_spent_on_cycle) = if vertical_cyclic_added {
        (None, false)
    } else {
        roll_cyclic_edge(
            graph,
            field,
            preset_state,
            state,
            src,
            cyclic_fired,
            teleport_hit,
            scope.as_deref_mut(),
        )
    };
    // Teleport still available for the corridor/junction step below unless the cyclic
    // roll already consumed it (it fired and found a candidate).
    let teleport_for_connect = teleport_hit && !teleport_spent_on_cycle;
    // Vertical still available for the corridor/junction step below unless it was already spent
    // on the cyclic edge (vertical_cyclic_added) or wasn't hit / cyclic didn't fire in the first
    // place (in which case it's an ordinary growth-connect candidate, handled below).
    let vertical_for_connect = vertical_hit && !cyclic_fired;

    let connected = choose_connect_targets(
        field,
        params,
        state,
        &free_regular,
        parent,
        src,
        teleport_for_connect,
        scope.as_deref_mut(),
    );

    if let Some(cyclic) = cyclic_dst {
        let added = if teleport_spent_on_cycle {
            add_edge_and_detect_direction(graph, src, cyclic, |g| {
                try_add_edge_kind(
                    g,
                    src,
                    cyclic,
                    EdgeKind::Teleport,
                    elements.teleport_one_way_chance,
                    preset_state,
                    &mut state.rng,
                )
            })
        } else {
            try_add_regular_edge(
                graph,
                field,
                src,
                cyclic,
                elements,
                preset_state,
                state,
                scope.as_deref_mut(),
            )
        };
        if let Some((from, to, bidirectional)) = added
            && let Some(log) = scope.as_deref_mut()
        {
            log.emit(VertexBasedEvent::CyclicEdgeAdded {
                src: from,
                dst: to,
                teleport: teleport_spent_on_cycle,
                bidirectional,
            });
        }
    }

    if vertical_for_connect {
        try_vertical_growth_connect(
            graph,
            field,
            elements,
            preset_state,
            state,
            src,
            scope.as_deref_mut(),
        );
    }

    // Preset neighbors: already connected by preset edges, so skip try_add_edge.
    // Just mark visited and push to frontier so the algorithm traverses through them.
    for &dst in &free_preset {
        state.visited.insert(dst);
        state.in_reserve.remove(&dst);
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::PresetNeighborVisited { src, dst });
            log.emit(VertexBasedEvent::NodeVisited {
                node: dst,
                parent: src,
            });
        }
    }
    state.reserve.retain(|x| !free_preset.contains(x));

    let connected_set: HashSet<NodeId> = connected.iter().copied().collect();
    for &dst in &connected {
        let added = try_add_regular_edge(
            graph,
            field,
            src,
            dst,
            elements,
            preset_state,
            state,
            scope.as_deref_mut(),
        );
        if let Some((from, to, bidirectional)) = added
            && let Some(log) = scope.as_deref_mut()
        {
            log.emit(VertexBasedEvent::EdgeAdded {
                src: from,
                dst: to,
                bidirectional,
            });
        }
        state.visited.insert(dst);
        state.in_reserve.remove(&dst);
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::NodeVisited {
                node: dst,
                parent: src,
            });
        }
    }
    state.reserve.retain(|x| !connected_set.contains(x));

    // Teleport connection: added alongside whatever corridor/junction chose above, to a
    // random unvisited node in the graph (not necessarily a geometric neighbor). Skipped if
    // the teleport roll was already spent on the cyclic edge, or if no unvisited node remains.
    if teleport_for_connect {
        let unvisited: Vec<NodeId> = state
            .all_nodes
            .iter()
            .copied()
            .filter(|n| {
                !state.visited.contains(n)
                    && state.allows(field, GeneratedElementKind::Teleport, *n)
            })
            .collect();
        let unvisited = if field.level_count() > 1 {
            filter_teleport_pool_by_floor(
                field,
                elements,
                state,
                src,
                unvisited,
                scope.as_deref_mut(),
            )
        } else {
            unvisited
        };
        if !unvisited.is_empty() {
            let dst = unvisited[state.rng.random_range(0..unvisited.len())];
            let added = add_edge_and_detect_direction(graph, src, dst, |g| {
                try_add_edge_kind(
                    g,
                    src,
                    dst,
                    EdgeKind::Teleport,
                    elements.teleport_one_way_chance,
                    preset_state,
                    &mut state.rng,
                )
            });
            if let Some((from, to, bidirectional)) = added
                && let Some(log) = scope.as_deref_mut()
            {
                log.emit(VertexBasedEvent::TeleportConnectAdded {
                    src: from,
                    dst: to,
                    bidirectional,
                });
            }
            state.visited.insert(dst);
            state.in_reserve.remove(&dst);
            add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::NodeVisited {
                    node: dst,
                    parent: src,
                });
            }
        }
    }

    for n in free_regular {
        // A node that just became the teleport destination is already `visited` (marked
        // above) by this point, so `!visited.contains(&n)` alone already keeps it out of
        // reserve — it went to the frontier instead, as intended.
        if !connected_set.contains(&n)
            && !state.in_reserve.contains(&n)
            && !state.visited.contains(&n)
        {
            state.reserve.push(n);
            state.in_reserve.insert(n);
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::NodeQueuedToReserve { node: n });
            }
        }
    }

    // `src`'s own vertical-passage/elevator partners that weren't just connected by
    // `try_vertical_growth_connect` above (GitHub issue #337 follow-up) — unlike a geometric free
    // neighbor, a vertical partner never gets a second growth-step attempt on its own (the
    // `vertical_chance` roll only ever fires once per `src`, here), so without queuing it into
    // `reserve` too, missing that one roll loses it permanently instead of getting the same
    // "picked up later" fallback every geometric neighbor already has. Deliberately *not* folded
    // into `all_free`/`free_regular` above — those also drive `choose_connect_targets`'s ordinary
    // geometric corridor/junction connect, which a vertical partner must never enter (no geometric
    // adjacency exists between floors for `try_add_edge` to reason about).
    for n in field.vertical_neighbors(src) {
        if !state.in_reserve.contains(&n) && !state.visited.contains(&n) {
            state.reserve.push(n);
            state.in_reserve.insert(n);
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::NodeQueuedToReserve { node: n });
            }
        }
    }
}

fn geometric_cyclic_candidates<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
    state: &GenState,
    src: NodeId,
) -> Vec<NodeId> {
    field
        .neighbors(src)
        .into_iter()
        .filter(|&n| {
            state.visited.contains(&n)
                && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none()
                && graph.edge_between(n, src).is_none()
        })
        .collect()
}

/// Cyclic edge target selection, given `cyclic_fired` already rolled by the caller (GitHub issue
/// #337 — cyclic now rolls before teleport/vertical, so this function no longer rolls it itself).
/// If a teleport was rolled for this src, the candidate pool widens from "visited geometric
/// neighbors" to "any visited node in the graph" and the second return value is `true` (the
/// teleport roll is considered "spent" on this cyclic edge in that case, and must not also apply
/// to the corridor/junction step). If that widened pool is empty, falls back to the ordinary
/// geometric-neighbor pool instead of skipping the cyclic edge entirely (GitHub issue #337 —
/// intentional behavior change from the prior no-fallback semantics, for consistency with the new
/// vertical-cyclic model; applies independently of floor_count).
#[allow(clippy::too_many_arguments)]
fn roll_cyclic_edge<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    cyclic_fired: bool,
    teleport_hit: bool,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> (Option<NodeId>, bool) {
    if !cyclic_fired {
        return (None, false);
    }
    if teleport_hit {
        let candidates: Vec<NodeId> = state
            .all_nodes
            .iter()
            .copied()
            .filter(|&n| {
                n != src
                    && state.visited.contains(&n)
                    && state.allows(field, GeneratedElementKind::Teleport, n)
                    && can_connect(src, n, preset_state)
                    && graph.edge_between(src, n).is_none()
                    && graph.edge_between(n, src).is_none()
            })
            .collect();
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::CyclicCandidatesComputed {
                src,
                geometric: false,
                candidates: candidates.clone(),
            });
        }
        if !candidates.is_empty() {
            return (
                Some(candidates[state.rng.random_range(0..candidates.len())]),
                true,
            );
        }
        // Teleport-widened pool empty — fall back to the ordinary geometric pool below.
        let geometric = geometric_cyclic_candidates(graph, field, preset_state, state, src);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::CyclicCandidatesComputed {
                src,
                geometric: true,
                candidates: geometric.clone(),
            });
        }
        if geometric.is_empty() {
            (None, false)
        } else {
            (
                Some(geometric[state.rng.random_range(0..geometric.len())]),
                false,
            )
        }
    } else {
        let visited_neighbors = geometric_cyclic_candidates(graph, field, preset_state, state, src);
        if let Some(log) = scope {
            log.emit(VertexBasedEvent::CyclicCandidatesComputed {
                src,
                geometric: true,
                candidates: visited_neighbors.clone(),
            });
        }
        if visited_neighbors.is_empty() {
            (None, false)
        } else {
            (
                Some(visited_neighbors[state.rng.random_range(0..visited_neighbors.len())]),
                false,
            )
        }
    }
}

/// Corridor/junction connect-choice: picks which of `free_regular` to connect `src` to this step.
/// When `teleport_for_connect` is set, `junction_count` is rolled against one extra virtual slot
/// so the teleport doesn't add branching *beyond* what junction already decided for this src —
/// count-1 geometric connections are taken, leaving exactly one slot for the teleport connection
/// `step_from_frontier` adds afterward.
#[allow(clippy::too_many_arguments)]
fn choose_connect_targets<T: Tessellation>(
    field: &MultiLevelField<T>,
    params: &GenerationParams,
    state: &mut GenState,
    free_regular: &[NodeId],
    parent: Option<NodeId>,
    src: NodeId,
    teleport_for_connect: bool,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> Vec<NodeId> {
    let corridor_roll = state.rng.random::<f64>();
    let is_corridor = corridor_roll < params.corridor_chance;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::CorridorRolled {
            roll: corridor_roll,
            corridor_chance: params.corridor_chance,
            is_corridor,
        });
    }

    if is_corridor {
        if free_regular.is_empty() {
            vec![]
        } else {
            let mut ctx = PickContext {
                parent,
                src,
                params,
                rng: &mut state.rng,
                field,
            };
            let (dst, used_directionality) =
                choose_candidate(free_regular, &mut ctx, scope.as_deref_mut());
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::CandidateChosen {
                    src,
                    dst,
                    used_directionality,
                });
            }
            vec![dst]
        }
    } else {
        let max = free_regular.len();
        let virtual_max = if teleport_for_connect { max + 1 } else { max };
        if virtual_max == 0 {
            vec![]
        } else if virtual_max == 1 {
            if max == 0 {
                vec![]
            } else {
                vec![free_regular[0]]
            }
        } else {
            let count = junction_count(virtual_max, params, &mut state.rng, scope.as_deref_mut());
            let geometric_count = if teleport_for_connect {
                count.saturating_sub(1)
            } else {
                count
            };
            if geometric_count == 0 {
                vec![]
            } else {
                let mut ctx = PickContext {
                    parent,
                    src,
                    params,
                    rng: &mut state.rng,
                    field,
                };
                let chosen = choose_junction_candidates(
                    free_regular,
                    geometric_count,
                    &mut ctx,
                    scope.as_deref_mut(),
                );
                if let Some(log) = scope {
                    log.emit(VertexBasedEvent::JunctionCandidatesChosen {
                        src,
                        candidates: chosen.clone(),
                    });
                }
                chosen
            }
        }
    }
}

pub(super) fn add_to_frontier(
    node: NodeId,
    parent: Option<NodeId>,
    frontier: &mut Vec<FrontierEntry>,
    in_frontier: &mut HashSet<NodeId>,
) {
    if in_frontier.insert(node) {
        frontier.push(FrontierEntry { node, parent });
    }
}

fn choose_from_frontier(
    frontier: &[FrontierEntry],
    params: &GenerationParams,
    rng: &mut MazeRng,
) -> usize {
    if frontier.len() == 1 {
        return 0;
    }
    gaussian_weighted_index(frontier.len(), params.depth_first, rng)
}

/// Rolls how many junction slots beyond the mandatory first two are taken — every roll is nested
/// under its own `"junction_count"` scope (GitHub issue #143's follow-up) so a narration reader
/// sees the whole per-slot roll series (and the caller-computed final count, see
/// `JunctionCandidatesChosen`) grouped under one collapsible header instead of flattened directly
/// into the parent `"step N"` scope alongside every other decision that step makes.
pub(super) fn junction_count(
    max: usize,
    params: &GenerationParams,
    rng: &mut MazeRng,
    scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> usize {
    debug_assert!(max >= 2, "junction_count requires max >= 2, got {max}");
    let mut count = 2;
    let mut inner = scope.map(|s| s.enter("junction_count"));
    if let Some(log) = inner.as_mut() {
        log.emit(VertexBasedEvent::JunctionRollSetup { max });
    }
    for slot in 1..=max.saturating_sub(2) {
        let roll = rng.random::<f64>();
        let taken = roll < params.branching;
        if let Some(log) = inner.as_mut() {
            log.emit(VertexBasedEvent::JunctionSlotRolled {
                slot,
                roll,
                branching: params.branching,
                taken,
            });
        }
        if taken {
            count += 1;
        }
    }
    count
}

/// Bundles the parameters `choose_candidate`/`choose_junction_candidates` both need but never
/// mutate except through `rng` — mirrors why `GenState` exists (see its own doc comment): keeps
/// either function's own parameter list to just what varies per call (`candidates`/`count`),
/// instead of repeating `parent`/`src`/`params`/`rng`/`field` at every call site.
struct PickContext<'a, T: Tessellation> {
    parent: Option<NodeId>,
    src: NodeId,
    params: &'a GenerationParams,
    rng: &'a mut MazeRng,
    field: &'a MultiLevelField<T>,
}

/// Returns the chosen candidate and whether the directionality shortcut (continue straight from
/// `parent`) was actually taken, rather than falling back to a uniform pick — narrated by
/// `VertexBasedEvent::CandidateChosen`'s `used_directionality` field (GitHub issue #143).
fn choose_candidate<T: Tessellation>(
    candidates: &[NodeId],
    ctx: &mut PickContext<T>,
    scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> (NodeId, bool) {
    if candidates.len() == 1 {
        if ctx.parent.is_some()
            && let Some(log) = scope
        {
            log.emit(VertexBasedEvent::SingleCandidateSkipsDirectionality {
                node: candidates[0],
            });
        }
        return (candidates[0], false);
    }
    let Some(p) = ctx.parent else {
        if let Some(log) = scope {
            log.emit(VertexBasedEvent::NoParentSkipsDirectionality { node: ctx.src });
        }
        return (candidates[ctx.rng.random_range(0..candidates.len())], false);
    };
    let roll = ctx.rng.random::<f64>();
    let fired = roll < ctx.params.directionality;
    let straight = fired
        .then(|| {
            candidates
                .iter()
                .copied()
                .find(|&n| ctx.field.is_straight(p, ctx.src, n))
        })
        .flatten();
    if let Some(log) = scope {
        log.emit(VertexBasedEvent::DirectionalityRolled {
            roll,
            directionality: ctx.params.directionality,
            fired,
            straight_found: straight.is_some(),
        });
    }
    if let Some(straight) = straight {
        return (straight, true);
    }
    (candidates[ctx.rng.random_range(0..candidates.len())], false)
}

fn choose_junction_candidates<T: Tessellation>(
    candidates: &[NodeId],
    count: usize,
    ctx: &mut PickContext<T>,
    scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> Vec<NodeId> {
    let mut pool: Vec<NodeId> = candidates.to_vec();
    let mut chosen = Vec::with_capacity(count);

    let (first, _) = choose_candidate(&pool, ctx, scope);
    chosen.push(first);
    pool.retain(|&n| n != first);

    while chosen.len() < count && !pool.is_empty() {
        let idx = ctx.rng.random_range(0..pool.len());
        chosen.push(pool.swap_remove(idx));
    }

    chosen
}

/// Cross-floor-vs-same-floor candidate filtering for a teleport target, applied after
/// `teleport_chance` already hit — rolls `cross_floor_teleport_balance` and filters `pool` (every
/// unvisited node in the field) by floor. Falls back to the other floor-group whenever the
/// preferred group is empty — including extreme balance values (`0.0`/`1.0`): an extreme value
/// describes a strong preference, not a hard ban on the alternative (see the plan's fallback
/// rule). Only called when `field.level_count() > 1` (RNG-parity policy — see caller).
fn filter_teleport_pool_by_floor<T: Tessellation>(
    field: &MultiLevelField<T>,
    elements: &ElementsConfig,
    state: &mut GenState,
    src: NodeId,
    pool: Vec<NodeId>,
    scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> Vec<NodeId> {
    let roll = state.rng.random::<f64>();
    let other_floor_preferred = roll < elements.cross_floor_teleport_balance;
    if let Some(log) = scope {
        log.emit(VertexBasedEvent::CrossFloorTeleportRolled {
            roll,
            balance: elements.cross_floor_teleport_balance,
            other_floor_preferred,
        });
    }
    let src_level = field.level_of(src);
    let (same_floor, other_floor): (Vec<NodeId>, Vec<NodeId>) = pool
        .into_iter()
        .partition(|&n| field.level_of(n) == src_level);
    if other_floor_preferred {
        if !other_floor.is_empty() {
            other_floor
        } else {
            same_floor
        }
    } else if !same_floor.is_empty() {
        same_floor
    } else {
        other_floor
    }
}

#[cfg(test)]
#[path = "vertex_based_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "vertex_based_teleport_tests.rs"]
mod teleport_tests;

#[cfg(test)]
#[path = "vertex_based_golden_tests.rs"]
mod golden_tests;

#[cfg(test)]
#[path = "vertex_based_vertical_tests.rs"]
mod vertical_tests;
