#[path = "vertex_based_event.rs"]
mod vertex_based_event;

use std::collections::HashSet;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::{NodeId, IdGenerator};
use crate::graph::{Graph, EdgeKind};
use crate::space::{LevelId, MultiLevelField, Tessellation};
use crate::event_log::{EventLog, ScopeGuard};
use super::{ElementsConfig, GenerationParams, PresetState, try_add_edge, try_add_edge_kind, can_connect, gaussian_weighted_index};
pub(super) use super::add_edge_and_detect_direction;
use super::split_pattern::SplitGenerationConfig;
use super::split_logic::{try_split_src, SplitOutcome, StartReassignment};
use super::debug_state::DebugGenerationState;
pub use vertex_based_event::{VertexBasedEvent, debug_value_names};

pub(super) struct FrontierEntry {
    node:   NodeId,
    parent: Option<NodeId>,
}

/// Mutable traversal state threaded through one `generate` run — bundled so the per-step helper
/// functions don't each need a 6+ parameter list. `all_nodes` is sorted once at construction for
/// deterministic iteration order (candidate pool for teleport rolls: any node in the graph, not
/// restricted to geometric neighbors).
pub(super) struct GenState {
    pub(super) visited:     HashSet<NodeId>,
    pub(super) in_frontier: HashSet<NodeId>,
    pub(super) frontier:    Vec<FrontierEntry>,
    pub(super) reserve:     Vec<NodeId>,
    pub(super) in_reserve:  HashSet<NodeId>,
    pub(super) rng:         MazeRng,
    pub(super) all_nodes:   Vec<NodeId>,
}

impl GenState {
    pub(super) fn new(graph: &Graph, seed: u64, start: NodeId) -> Self {
        let mut all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
        all_nodes.sort_unstable();
        let mut state = GenState {
            visited:     HashSet::new(),
            in_frontier: HashSet::new(),
            frontier:    Vec::new(),
            reserve:     Vec::new(),
            in_reserve:  HashSet::new(),
            rng:         MazeRng::seed_from_u64(seed),
            all_nodes,
        };
        // preset_connected nodes are NOT added to visited upfront — this keeps them visible
        // as connection targets for free_neighbors. Exception: start itself may be preset_connected
        // (e.g. gen_source inside a preset cluster) — it must enter the frontier regardless.
        state.visited.insert(start);
        add_to_frontier(start, None, &mut state.frontier, &mut state.in_frontier);
        state
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
    mut event_log: Option<&mut EventLog<VertexBasedEvent>>,
    mut debug_state: Option<&mut DebugGenerationState<T>>,
) {
    let mut state = GenState::new(graph, seed, start);
    if let Some(log) = event_log.as_deref_mut() {
        log.emit(VertexBasedEvent::StartVisited { node: start });
    }

    loop {
        if state.frontier.is_empty() {
            let mut step_scope = event_log.as_deref_mut().map(|log| log.enter_numbered("step"));
            let keep_going = handle_empty_frontier(
                graph, field, ids, params, elements, split_config, preset_state, &mut state,
                start, start_reassignment, step_scope.as_mut(), debug_state.as_deref_mut(),
            );
            drop(step_scope);
            if !keep_going {
                break;
            }
            continue;
        }

        let mut step_scope = event_log.as_deref_mut().map(|log| log.enter_numbered("step"));
        step_from_frontier(
            graph, field, ids, params, elements, split_config, preset_state, &mut state,
            start, start_reassignment, step_scope.as_mut(), debug_state.as_deref_mut(),
        );
    }
}

/// Bridges a new node into the maze when the frontier is empty — either via a teleport roll (a
/// hit replaces the step's entire mechanism: bridges via teleport instead of geometric adjacency)
/// or by popping a reachable candidate off `reserve`. Returns `false` when generation is done
/// (nothing left to bring in either way), `true` to keep looping.
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
    let teleport_roll = state.rng.random::<f64>();
    let teleport_fired = teleport_roll < elements.teleport_chance;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::TeleportBridgeRolled { roll: teleport_roll, teleport_chance: elements.teleport_chance, fired: teleport_fired });
    }
    if teleport_fired {
        let unvisited: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|n| !state.visited.contains(n))
            .collect();
        if unvisited.is_empty() {
            // Nothing left to bring in via teleport either — generation is done.
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::ReserveExhausted);
            }
            return false;
        }
        let visited_nodes: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|n| state.visited.contains(n))
            .collect();
        let bridge = visited_nodes[state.rng.random_range(0..visited_nodes.len())];

        // Cross-floor teleport balance (GitHub issue #337) — only rolled/applied when the maze
        // has more than one floor (RNG-parity policy). `bridge`'s own floor is "same floor" for
        // this roll, since `bridge` is the connection's already-fixed visited endpoint.
        let unvisited = if field.level_count() > 1 {
            filter_teleport_pool_by_floor(field, elements, state, bridge, unvisited, scope.as_deref_mut())
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
            graph, field, ids, params, elements, split_config, preset_state, state,
            src, Some(bridge), None, start, start_reassignment, scope.as_deref_mut(), debug_state.as_deref_mut(),
        );
        if outcome == SplitOutcome::Handled {
            return true;
        }

        let added = add_edge_and_detect_direction(graph, bridge, src, |g| {
            try_add_edge_kind(g, bridge, src, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng)
        });
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::TeleportBridgeAdded { src: from, dst: to, bidirectional });
            }
        }
        state.visited.insert(src);
        add_to_frontier(src, Some(bridge), &mut state.frontier, &mut state.in_frontier);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::NodeVisited { node: src, parent: bridge });
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
        for candidate in state.reserve.drain(..) {
            state.in_reserve.remove(&candidate);
            if state.visited.contains(&candidate) {
                if let Some(g) = search_scope.as_mut() {
                    g.emit(VertexBasedEvent::ReserveCandidateRejected { node: candidate, already_visited: true });
                }
                continue;
            }
            let has_visited_neighbor = field.neighbors(candidate)
                .into_iter()
                .chain(field.vertical_neighbors(candidate))
                .any(|n| state.visited.contains(&n) && can_connect(n, candidate, preset_state));
            if has_visited_neighbor {
                reachable.push(candidate);
            } else {
                if let Some(g) = search_scope.as_mut() {
                    g.emit(VertexBasedEvent::ReserveCandidateRejected { node: candidate, already_visited: false });
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
                    g.emit(VertexBasedEvent::ReserveCandidateRejected { node: loser, already_visited: false });
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
        if result.is_none() {
            if let Some(g) = search_scope.as_mut() {
                g.emit(VertexBasedEvent::ReserveExhausted);
            }
        }
        result
    };
    let Some(src) = src else { return false; };
    let geometric_neighbors: Vec<NodeId> = field.neighbors(src)
        .into_iter()
        .filter(|&n| state.visited.contains(&n) && can_connect(n, src, preset_state))
        .collect();
    let vertical_neighbors: Vec<NodeId> = field.vertical_neighbors(src)
        .into_iter()
        .filter(|&n| state.visited.contains(&n) && can_connect(n, src, preset_state))
        .collect();

    let vertical_roll = state.rng.random::<f64>();
    let vertical_hit = vertical_roll < elements.vertical_chance;
    let use_vertical = if vertical_hit {
        !vertical_neighbors.is_empty()
    } else {
        geometric_neighbors.is_empty() && !vertical_neighbors.is_empty()
    };

    let geometric_bridge = (!use_vertical)
        .then(|| geometric_neighbors[state.rng.random_range(0..geometric_neighbors.len())]);

    if let Some(geometric_bridge) = geometric_bridge {
        let outcome = try_split_src(
            graph, field, ids, params, elements, split_config, preset_state, state,
            src, Some(geometric_bridge), None, start, start_reassignment, scope.as_deref_mut(), debug_state.as_deref_mut(),
        );
        if outcome == SplitOutcome::Handled {
            return true;
        }
    }

    let bridge = if use_vertical {
        let bridge = vertical_neighbors[state.rng.random_range(0..vertical_neighbors.len())];
        add_vertical_passage_edge(graph, elements, state, bridge, src, scope.as_deref_mut());
        bridge
    } else {
        let bridge = geometric_bridge.expect("geometric bridge picked above when !use_vertical");
        let added = add_edge_and_detect_direction(graph, bridge, src, |g| try_add_edge(g, bridge, src, elements, preset_state, &mut state.rng));
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::BridgeAdded { src: from, dst: to, bidirectional });
            }
        }
        bridge
    };
    state.visited.insert(src);
    add_to_frontier(src, Some(bridge), &mut state.frontier, &mut state.in_frontier);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::NodeVisited { node: src, parent: bridge });
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
        log.emit(VertexBasedEvent::SrcChosenFromFrontier { src, frontier_len, position: fi, depth_first: params.depth_first });
    }

    state.frontier.remove(fi);
    state.in_frontier.remove(&src);

    let outcome = try_split_src(
        graph, field, ids, params, elements, split_config, preset_state, state,
        src, None, parent, start, start_reassignment, scope.as_deref_mut(), debug_state,
    );
    if outcome == SplitOutcome::Handled {
        return;
    }

    run_ordinary_step_body_for_node(graph, field, params, elements, preset_state, state, src, parent, true, None, scope);
}

/// The corridor/junction/cyclic/frontier-push body for one node, factored out of
/// `step_from_frontier` so the split paths (GitHub issue #222) can invoke it once per resulting
/// split node instead of once per ordinary frontier pop. `roll_teleport` gates whether this call's
/// own teleport roll/connect-step runs at all — `step_from_frontier`'s own (non-split) call site
/// always passes `true`; the non-pattern split path passes `false` for every per-node call and
/// rolls teleport once for the whole split event instead (see `handle_non_pattern_split`).
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
        log.emit(VertexBasedEvent::CyclicRolled { src, roll: cyclic_roll, cyclicity: params.cyclicity, fired: cyclic_fired });
    }

    // Teleport roll happens immediately after cyclic, before any geometric-neighbor pool is
    // built — a hit affects the cyclic candidate pool (below) and adds one extra teleport
    // connection alongside whatever the corridor/junction roll produces.
    let teleport_hit = if roll_teleport {
        let teleport_roll = state.rng.random::<f64>();
        let hit = teleport_roll < elements.teleport_chance;
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::TeleportRolled { src, roll: teleport_roll, teleport_chance: elements.teleport_chance, fired: hit });
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
    let vertical_hit = if roll_teleport && field.level_count() > 1 {
        let vertical_roll = state.rng.random::<f64>();
        let hit = vertical_roll < elements.vertical_chance;
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::VerticalRolled { src, roll: vertical_roll, vertical_chance: elements.vertical_chance, fired: hit });
        }
        hit
    } else {
        false
    };

    // free_regular: unvisited, non-frontier, non-preset neighbors — become frontier/reserve.
    // free_preset: preset-connected neighbors (geometric or teleport) not yet visited — connect to
    // them but skip frontier's own edge-adding step (their edge already exists in the graph).
    let preset_connected = &preset_state.preset_connected;
    let teleport_dsts = preset_state.preset_teleports.get(&src).map(Vec::as_slice).unwrap_or(&[]);
    let all_free: Vec<NodeId> = field.neighbors(src)
        .into_iter()
        .filter(|n| allowed_neighbors.is_none_or(|allowed| allowed.contains(n)))
        .chain(teleport_dsts.iter().copied())
        .filter(|&n| !state.visited.contains(&n) && !state.in_frontier.contains(&n)
            && (preset_connected.contains(&src) && preset_connected.contains(&n) || teleport_dsts.contains(&n) || can_connect(src, n, preset_state)))
        .collect();
    let (free_preset, free_regular): (Vec<NodeId>, Vec<NodeId>) =
        all_free.into_iter().partition(|n| preset_connected.contains(n) || teleport_dsts.contains(n));

    // Vertical cyclic attempt: if both cyclic and vertical fired this step, vertical first tries
    // to realize the cyclic edge (visited target). Success spends both rolls entirely; failure
    // falls back to the ordinary geometric/teleport cyclic path below with vertical_hit untouched
    // for the growth-connect step (vertical_for_connect below already accounts for this).
    let vertical_cyclic_added = if cyclic_fired && vertical_hit {
        try_vertical_cyclic_edge(graph, field, elements, preset_state, state, src, scope.as_deref_mut())
    } else {
        false
    };

    let (cyclic_dst, teleport_spent_on_cycle) = if vertical_cyclic_added {
        (None, false)
    } else {
        roll_cyclic_edge(graph, field, preset_state, state, src, cyclic_fired, teleport_hit, scope.as_deref_mut())
    };
    // Teleport still available for the corridor/junction step below unless the cyclic
    // roll already consumed it (it fired and found a candidate).
    let teleport_for_connect = teleport_hit && !teleport_spent_on_cycle;
    // Vertical still available for the corridor/junction step below unless it was already spent
    // on the cyclic edge (vertical_cyclic_added) or wasn't hit / cyclic didn't fire in the first
    // place (in which case it's an ordinary growth-connect candidate, handled below).
    let vertical_for_connect = vertical_hit && !cyclic_fired;

    let connected = choose_connect_targets(field, params, state, &free_regular, parent, src, teleport_for_connect, scope.as_deref_mut());

    if let Some(cyclic) = cyclic_dst {
        let added = if teleport_spent_on_cycle {
            add_edge_and_detect_direction(graph, src, cyclic, |g| {
                try_add_edge_kind(g, src, cyclic, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng)
            })
        } else {
            add_edge_and_detect_direction(graph, src, cyclic, |g| try_add_edge(g, src, cyclic, elements, preset_state, &mut state.rng))
        };
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::CyclicEdgeAdded { src: from, dst: to, teleport: teleport_spent_on_cycle, bidirectional });
            }
        }
    }

    if vertical_for_connect {
        try_vertical_growth_connect(graph, field, elements, preset_state, state, src, scope.as_deref_mut());
    }

    // Preset neighbors: already connected by preset edges, so skip try_add_edge.
    // Just mark visited and push to frontier so the algorithm traverses through them.
    for &dst in &free_preset {
        state.visited.insert(dst);
        state.in_reserve.remove(&dst);
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::PresetNeighborVisited { src, dst });
            log.emit(VertexBasedEvent::NodeVisited { node: dst, parent: src });
        }
    }
    state.reserve.retain(|x| !free_preset.contains(x));

    let connected_set: HashSet<NodeId> = connected.iter().copied().collect();
    for &dst in &connected {
        let added = add_edge_and_detect_direction(graph, src, dst, |g| try_add_edge(g, src, dst, elements, preset_state, &mut state.rng));
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::EdgeAdded { src: from, dst: to, bidirectional });
            }
        }
        state.visited.insert(dst);
        state.in_reserve.remove(&dst);
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::NodeVisited { node: dst, parent: src });
        }
    }
    state.reserve.retain(|x| !connected_set.contains(x));

    // Teleport connection: added alongside whatever corridor/junction chose above, to a
    // random unvisited node in the graph (not necessarily a geometric neighbor). Skipped if
    // the teleport roll was already spent on the cyclic edge, or if no unvisited node remains.
    if teleport_for_connect {
        let unvisited: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|n| !state.visited.contains(n))
            .collect();
        let unvisited = if field.level_count() > 1 {
            filter_teleport_pool_by_floor(field, elements, state, src, unvisited, scope.as_deref_mut())
        } else {
            unvisited
        };
        if !unvisited.is_empty() {
            let dst = unvisited[state.rng.random_range(0..unvisited.len())];
            let added = add_edge_and_detect_direction(graph, src, dst, |g| {
                try_add_edge_kind(g, src, dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng)
            });
            if let Some((from, to, bidirectional)) = added {
                if let Some(log) = scope.as_deref_mut() {
                    log.emit(VertexBasedEvent::TeleportConnectAdded { src: from, dst: to, bidirectional });
                }
            }
            state.visited.insert(dst);
            state.in_reserve.remove(&dst);
            add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::NodeVisited { node: dst, parent: src });
            }
        }
    }

    for n in free_regular {
        // A node that just became the teleport destination is already `visited` (marked
        // above) by this point, so `!visited.contains(&n)` alone already keeps it out of
        // reserve — it went to the frontier instead, as intended.
        if !connected_set.contains(&n) && !state.in_reserve.contains(&n) && !state.visited.contains(&n) {
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
    field.neighbors(src)
        .into_iter()
        .filter(|&n| state.visited.contains(&n) && can_connect(src, n, preset_state)
            && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
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
        let candidates: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|&n| n != src && state.visited.contains(&n) && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
            .collect();
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::CyclicCandidatesComputed { src, geometric: false, candidates: candidates.clone() });
        }
        if !candidates.is_empty() {
            return (Some(candidates[state.rng.random_range(0..candidates.len())]), true);
        }
        // Teleport-widened pool empty — fall back to the ordinary geometric pool below.
        let geometric = geometric_cyclic_candidates(graph, field, preset_state, state, src);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::CyclicCandidatesComputed { src, geometric: true, candidates: geometric.clone() });
        }
        if geometric.is_empty() {
            (None, false)
        } else {
            (Some(geometric[state.rng.random_range(0..geometric.len())]), false)
        }
    } else {
        let visited_neighbors = geometric_cyclic_candidates(graph, field, preset_state, state, src);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::CyclicCandidatesComputed { src, geometric: true, candidates: visited_neighbors.clone() });
        }
        if visited_neighbors.is_empty() {
            (None, false)
        } else {
            (Some(visited_neighbors[state.rng.random_range(0..visited_neighbors.len())]), false)
        }
    }
}

/// Corridor/junction connect-choice: picks which of `free_regular` to connect `src` to this step.
/// When `teleport_for_connect` is set, `junction_count` is rolled against one extra virtual slot
/// so the teleport doesn't add branching *beyond* what junction already decided for this src —
/// count-1 geometric connections are taken, leaving exactly one slot for the teleport connection
/// `step_from_frontier` adds afterward.
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
        log.emit(VertexBasedEvent::CorridorRolled { roll: corridor_roll, corridor_chance: params.corridor_chance, is_corridor });
    }

    if is_corridor {
        if free_regular.is_empty() {
            vec![]
        } else {
            let mut ctx = PickContext { parent, src, params, rng: &mut state.rng, field };
            let (dst, used_directionality) = choose_candidate(free_regular, &mut ctx, scope.as_deref_mut());
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::CandidateChosen { src, dst, used_directionality });
            }
            vec![dst]
        }
    } else {
        let max = free_regular.len();
        let virtual_max = if teleport_for_connect { max + 1 } else { max };
        if virtual_max == 0 {
            vec![]
        } else if virtual_max == 1 {
            if max == 0 { vec![] } else { vec![free_regular[0]] }
        } else {
            let count = junction_count(virtual_max, params, &mut state.rng, scope.as_deref_mut());
            let geometric_count = if teleport_for_connect { count.saturating_sub(1) } else { count };
            if geometric_count == 0 {
                vec![]
            } else {
                let mut ctx = PickContext { parent, src, params, rng: &mut state.rng, field };
                let chosen = choose_junction_candidates(free_regular, geometric_count, &mut ctx, scope.as_deref_mut());
                if let Some(log) = scope.as_deref_mut() {
                    log.emit(VertexBasedEvent::JunctionCandidatesChosen { src, candidates: chosen.clone() });
                }
                chosen
            }
        }
    }
}

pub(super) fn add_to_frontier(node: NodeId, parent: Option<NodeId>, frontier: &mut Vec<FrontierEntry>, in_frontier: &mut HashSet<NodeId>) {
    if in_frontier.insert(node) {
        frontier.push(FrontierEntry { node, parent });
    }
}

fn choose_from_frontier(frontier: &[FrontierEntry], params: &GenerationParams, rng: &mut MazeRng) -> usize {
    if frontier.len() == 1 { return 0; }
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
            log.emit(VertexBasedEvent::JunctionSlotRolled { slot, roll, branching: params.branching, taken });
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
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> (NodeId, bool) {
    if candidates.len() == 1 {
        if ctx.parent.is_some() {
            if let Some(log) = scope {
                log.emit(VertexBasedEvent::SingleCandidateSkipsDirectionality { node: candidates[0] });
            }
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
    let straight = fired.then(|| candidates.iter().copied().find(|&n| ctx.field.is_straight(p, ctx.src, n))).flatten();
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::DirectionalityRolled { roll, directionality: ctx.params.directionality, fired, straight_found: straight.is_some() });
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

// --- Vertical connections (GitHub issue #337) ---

/// Whether a vertical-connection attempt landed on a `VerticalPassage` or `Elevator` outcome —
/// mirrors the roll described by `GenerationParams::vertical_passage_elevator_balance`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerticalKind {
    Passage,
    Elevator,
}

/// Rolls the passage-vs-elevator balance — always consumed once `vertical_chance` hit, regardless
/// of whether a valid target is later found (RNG-always-consumed discipline, same as the rest of
/// this model).
fn roll_vertical_balance(
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
fn adjacent_level<T: Tessellation>(field: &MultiLevelField<T>, src: NodeId, upward: bool) -> Option<LevelId> {
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
fn resolve_vertical_passage_target<T: Tessellation>(field: &MultiLevelField<T>, src: NodeId, upward: bool) -> Option<NodeId> {
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
fn add_vertical_passage_edge(
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
fn try_vertical_growth_connect<T: Tessellation>(
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
fn try_growth_vertical_passage<T: Tessellation>(
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
fn try_vertical_cyclic_edge<T: Tessellation>(
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
fn elevator_floor_candidates<T: Tessellation>(field: &MultiLevelField<T>, src: NodeId) -> Vec<(LevelId, NodeId)> {
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
fn longest_consecutive_run<T: Tessellation>(field: &MultiLevelField<T>, candidates: &[NodeId]) -> Vec<NodeId> {
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
fn try_elevator<T: Tessellation>(
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

fn try_growth_elevator<T: Tessellation>(
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
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> Vec<NodeId> {
    let roll = state.rng.random::<f64>();
    let other_floor_preferred = roll < elements.cross_floor_teleport_balance;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::CrossFloorTeleportRolled { roll, balance: elements.cross_floor_teleport_balance, other_floor_preferred });
    }
    let src_level = field.level_of(src);
    let (same_floor, other_floor): (Vec<NodeId>, Vec<NodeId>) = pool.into_iter()
        .partition(|&n| field.level_of(n) == src_level);
    if other_floor_preferred {
        if !other_floor.is_empty() { other_floor } else { same_floor }
    } else {
        if !same_floor.is_empty() { same_floor } else { other_floor }
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
