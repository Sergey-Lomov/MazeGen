use std::collections::HashMap;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use crate::event_log::{DebugEvent, DebugValueDelta, DebugValueKind, DebugValueOp, EncodeEventPayload, EventLog, ScopeGuard};
use super::{EdgeBasedParams, ElementsConfig, PresetState, try_add_edge, try_add_edge_kind, can_connect, gaussian_weighted_index};

/// Stable wire tags for [`EdgeBasedEvent`] (see `Specs/event_log.md`'s #124 binary encoding) —
/// manually assigned, never derived from Rust enum variant order/discriminant. `0` is reserved
/// for scope nodes (`event_log::TAG_SCOPE`) and must never be assigned here.
mod wire_tags {
    pub const CORRIDOR_ROLL_SKIPPED: u16 = 1;
    pub const CORRIDOR_ROLLED: u16 = 2;
    pub const CORRIDOR_DEAD_NO_UNSEEN: u16 = 3;
    pub const SRC_CHOSEN_BY_DEPTH_FIRST: u16 = 4;
    pub const TELEPORT_ROLLED: u16 = 5;
    pub const TELEPORT_ALREADY_ROLLED: u16 = 6;
    pub const CYCLIC_ROLLED: u16 = 7;
    pub const CYCLIC_ALREADY_ROLLED: u16 = 20;
    pub const CANDIDATE_POOL_BUILT: u16 = 8;
    pub const SRC_EXHAUSTED_EMPTY_POOL: u16 = 9;
    pub const CYCLIC_CANDIDATES_COMPUTED: u16 = 10;
    pub const CYCLIC_EDGE_ADDED: u16 = 11;
    pub const CYCLIC_EDGE_REJECTED: u16 = 12;
    pub const DST_WEIGHTS_COMPUTED: u16 = 13;
    pub const DST_CHOSEN: u16 = 14;
    pub const EDGE_ADDED: u16 = 15;
    pub const EDGE_REJECTED: u16 = 16;
    pub const PRESET_SKIPPED: u16 = 17;
    pub const NODE_ACTIVATED: u16 = 18;
    pub const SRC_EXHAUSTED: u16 = 19;
}

/// Narration-level events for `CustomEdgeBased` generation (see GitHub issue #144). Unlike
/// Wilson's two-level walk loop or Kruskal's single per-edge decision, `edge_based`'s main loop
/// makes several independent decisions per step (src choice, teleport roll, cyclic roll,
/// candidate pool, dst weighting, edge add) — the event set mirrors every one of them at
/// decision-level granularity (see issue #121's granularity target), all emitted flat under one
/// `"step N"` scope per main-loop iteration (mirrors Kruskal's flat `"edge N"` shape, not
/// Wilson's nested search/commit sub-scopes — a single step here has no natural two-phase split).
#[derive(Debug, Clone, PartialEq)]
pub enum EdgeBasedEvent {
    /// No corridor roll was attempted this step because there is no `last_dst` yet (the very
    /// first step of the run, or the previous step's `last_dst` was cleared). Emitted first in
    /// every "step N" scope that reaches this branch, so a narration reader isn't left wondering
    /// why no `CorridorRolled` appears.
    CorridorRollSkipped,
    /// The corridor-continuation roll against `params.corridor_length`, from `prev` (the previous
    /// step's `last_dst`). `continued` is `roll < corridor_length` — when true, `prev` becomes
    /// this step's `src` (a corridor chain continues); when false, `src` falls through to
    /// `SrcChosenByDepthFirst` instead.
    CorridorRolled { prev: NodeId, roll: f64, corridor_length: f64, continued: bool },
    /// The corridor roll succeeded (`continued: true` on the preceding `CorridorRolled`), but
    /// `prev` has no reachable unseen neighbor left — so the corridor chain can't actually
    /// continue from it. `src` falls through to `SrcChosenByDepthFirst` instead, same as a failed
    /// roll. Kept as its own event (rather than silently falling through) since a narration
    /// reader would otherwise see a "continued: true" roll immediately contradicted by a
    /// depth-first src choice with no explanation.
    CorridorDeadNoUnseen { prev: NodeId },
    /// `src` chosen via gaussian-weighted sampling over `active` by position (oldest = index 0,
    /// newest = `active_len - 1`), skewed by `params.depth_first` (closer to 1.0 prefers the
    /// newest/deepest node — DFS-like; closer to 0.0 samples more uniformly). `position` is the
    /// sampled index into `active`.
    SrcChosenByDepthFirst { src: NodeId, active_len: usize, position: usize, depth_first: f64 },
    /// The teleport roll for `src` against `elements.teleport_chance` — guarded to at most once
    /// per node's lifetime as `src` (see `TeleportAlreadyRolled`). `fired` is `roll < teleport_chance`.
    TeleportRolled { src: NodeId, roll: f64, teleport_chance: f64, fired: bool },
    /// `src` already had its teleport chance rolled during an earlier pass as `src` (a node can
    /// become `src` multiple times before exhausting its geometric neighbors) — the roll is
    /// skipped this time and treated as not-fired, without consuming a new RNG sample.
    TeleportAlreadyRolled { src: NodeId },
    /// The cyclic-edge roll for this step against `params.cyclicity`, decided independently of
    /// the teleport roll — guarded to at most once per node's lifetime as `src` (see
    /// `CyclicAlreadyRolled`), mirroring `TeleportRolled`/`TeleportAlreadyRolled`. `fired` is
    /// `roll < cyclicity`.
    CyclicRolled { src: NodeId, roll: f64, cyclicity: f64, fired: bool },
    /// `src` already had its cyclic chance rolled during an earlier pass as `src` (a node can
    /// become `src` multiple times before exhausting its geometric neighbors) — the roll is
    /// skipped this time and treated as not-fired, without consuming a new RNG sample.
    CyclicAlreadyRolled { src: NodeId },
    /// The candidate pool built for the main dst choice: `geometric = true` means unseen field
    /// neighbors of `src`; `geometric = false` means every unseen node in the graph (the teleport
    /// pool). Empty exactly when the following event is `SrcExhaustedEmptyPool`.
    CandidatePoolBuilt { src: NodeId, geometric: bool, candidates: Vec<NodeId> },
    /// The candidate pool (`CandidatePoolBuilt`, immediately preceding) came back empty — `src`
    /// has no reachable unseen node left to connect to at all, so it's removed from `active` and
    /// marked `Visited` without any edge being attempted this step.
    SrcExhaustedEmptyPool { src: NodeId },
    /// The candidate pool for the cyclic edge attempt (only emitted when `CyclicRolled.fired` was
    /// true): visited nodes `src` could still connect to without duplicating an existing edge.
    /// `geometric` mirrors `CandidatePoolBuilt`'s meaning (neighbors-only vs. whole-graph), driven
    /// by whether teleport also fired this step. Empty means the cyclic edge attempt is skipped.
    CyclicCandidatesComputed { src: NodeId, geometric: bool, candidates: Vec<NodeId> },
    /// A cyclic edge was added, independent of the step's main dst choice. `src`/`dst` here are
    /// the *actual graph direction* of the added edge, not necessarily the `src`/`cyclic_dst`
    /// values the attempt was made with — `add_edge_kind`'s own `one_way_chance` coin flip may
    /// reverse a one-way edge, so the event is detected (and its fields set) by comparing
    /// `graph.edge_between` in both directions before/after the attempt, then reporting whichever
    /// direction actually gained an edge (GitHub issue #144's direction-mismatch fix — narration
    /// must match what the graph really has, never the algorithm's connection-attempt intent).
    /// `teleport` is whether it was added as a `Teleport` edge (cyclic pool was the whole-graph
    /// teleport pool) vs. a `Basic` edge (geometric neighbor pool). `bidirectional` records
    /// whether the passage opened in both directions (mirrors `WilsonEvent::EdgeAdded`/
    /// `KruskalEvent::EdgeAdded`'s explicit field, carried so replay consumers don't have to
    /// assume two-way).
    CyclicEdgeAdded { src: NodeId, dst: NodeId, teleport: bool, bidirectional: bool },
    /// A cyclic edge attempt from `src` to `dst` was rejected by preset constraints
    /// (`locked_out`/`locked_in`/`blocked`) — the candidate passed `can_connect`'s pool filter but
    /// `try_add_edge`/`try_add_edge_kind`'s stricter per-direction check still silently declined
    /// to add it. Detected by comparing `graph.edge_between(src, dst)` before/after the attempt.
    CyclicEdgeRejected { src: NodeId, dst: NodeId, teleport: bool },
    /// Per-candidate weights computed for the main dst choice (`params.branching`, rewarding
    /// candidates with more free neighbors; `params.directionality`, bonus applied only for the
    /// geometric pool outside a corridor chain, rewarding a candidate that continues `src`'s
    /// incoming straight line). `directionality_eligible` records whether the directionality bonus
    /// could apply at all this step (geometric pool and not a corridor-continuation step) —
    /// independent of whether any individual candidate actually received the bonus.
    DstWeightsComputed {
        candidates: Vec<NodeId>,
        weights: Vec<f64>,
        branching: f64,
        directionality: f64,
        directionality_eligible: bool,
    },
    /// The weighted-sample roll over `DstWeightsComputed`'s weights (immediately preceding),
    /// picking `dst` from `candidates`. `roll` is the pre-scaled sample (`rng.random::<f64>() *
    /// total_weight`); `total_weight` is the weights' sum.
    DstChosen { dst: NodeId, roll: f64, total_weight: f64 },
    /// The chosen `dst` is itself `preset_connected` (a geometrically-adjacent preset pair) — its
    /// edge to `src` was already built by `build_preset_state` before generation started, so the
    /// main edge-add step is skipped entirely to avoid duplicating it. No `EdgeAdded`/`EdgeRejected`
    /// follows for this step's main edge in this case.
    PresetSkipped { src: NodeId, dst: NodeId },
    /// The main edge for this step was added. `src`/`dst` are the actual graph direction — see
    /// `CyclicEdgeAdded`'s doc comment for why this can differ from the step's own `src`/`dst` and
    /// how it's detected. `teleport` mirrors `CyclicEdgeAdded`'s meaning (whole-graph teleport
    /// pool vs. geometric neighbor pool).
    EdgeAdded { src: NodeId, dst: NodeId, teleport: bool, bidirectional: bool },
    /// The main edge attempt from `src` to `dst` was rejected by preset constraints — same
    /// detection method as `CyclicEdgeRejected`, for the step's main (non-cyclic) edge attempt.
    EdgeRejected { src: NodeId, dst: NodeId, teleport: bool },
    /// `dst` was marked `Active` (pushed onto the `active` list, parented to `src` at
    /// `tree_depth`) — happens regardless of whether the preceding edge attempt actually
    /// succeeded (mirrors the algorithm's existing behavior: `dst`'s node-state transition is not
    /// conditioned on `try_add_edge`'s silent success/failure). `parent` is `None` exactly once,
    /// for the run's start node — every other activation happens via a `src`-`dst` step.
    NodeActivated { node: NodeId, parent: Option<NodeId>, tree_depth: u32 },
    /// `src` was removed from `active` and marked `Visited` after this step, because it has no
    /// reachable unseen neighbor left (checked after `dst` was activated, so a neighbor `dst`
    /// itself just claimed no longer counts). Distinct from `SrcExhaustedEmptyPool`, which fires
    /// before any edge attempt this step (empty pool from the very start of the step).
    SrcExhausted { src: NodeId },
}

impl DebugEvent for EdgeBasedEvent {
    /// Mutating: events that change `active`/`visited` (the declared debug values) or the graph.
    /// `CorridorRollSkipped`/`CorridorRolled`/`CorridorDeadNoUnseen`/`SrcChosenByDepthFirst`/
    /// `TeleportRolled`/`TeleportAlreadyRolled`/`CyclicRolled`/`CandidatePoolBuilt`/
    /// `CyclicCandidatesComputed`/`DstWeightsComputed`/`DstChosen`/`PresetSkipped` are trace-only —
    /// pure narration of decisions that don't themselves change reconstructable state.
    /// `CyclicEdgeRejected`/`EdgeRejected` are mutating despite not touching the graph: they change
    /// no debug value by themselves, but see `debug_value_deltas` below for why they carry no
    /// delta — they are grouped with the mutating set only because a rejection is itself a
    /// noteworthy state-adjacent event a replay step-count should account for, mirroring
    /// Kruskal's `EdgeRejected` (also mutating there).
    fn is_mutating(&self) -> bool {
        matches!(
            self,
            EdgeBasedEvent::SrcExhaustedEmptyPool { .. }
                | EdgeBasedEvent::CyclicEdgeAdded { .. }
                | EdgeBasedEvent::CyclicEdgeRejected { .. }
                | EdgeBasedEvent::EdgeAdded { .. }
                | EdgeBasedEvent::EdgeRejected { .. }
                | EdgeBasedEvent::NodeActivated { .. }
                | EdgeBasedEvent::SrcExhausted { .. }
        )
    }
}

pub const ACTIVE: &str = "active";
pub const VISITED: &str = "visited";

/// `active` — mirrors the algorithm's own `active: Vec<NodeId>` insertion/removal order (still an
/// order-preserving `Vec` internally, per `debug_value_deltas`' insert/remove semantics), but
/// declared `Region` (not `Sequence`) below: unlike Recursive Backtracker's stack, `active`'s
/// members don't form a connected traversal chain — rendering them as a chain of arrows would be
/// misleading, so the web side highlights them as independent per-node regions instead (per
/// explicit user decision). `visited` — a plain `Region` set, insert-only, mirroring
/// `NodeState::Visited` (a node is never un-visited).
impl DebugValueDelta<NodeId> for EdgeBasedEvent {
    fn debug_value_deltas(&self) -> Vec<(&'static str, DebugValueOp, NodeId)> {
        match self {
            EdgeBasedEvent::NodeActivated { node, .. } => vec![(ACTIVE, DebugValueOp::Insert, *node)],
            EdgeBasedEvent::SrcExhaustedEmptyPool { src } | EdgeBasedEvent::SrcExhausted { src } => {
                vec![(ACTIVE, DebugValueOp::Remove, *src), (VISITED, DebugValueOp::Insert, *src)]
            }
            _ => Vec::new(),
        }
    }
}

/// Static declaration of `CustomEdgeBased`'s debug values (GitHub issue #131) — mirrors
/// `wilson::debug_value_names()`/`recursive_backtracker::debug_value_names()`. A static property
/// of the algorithm, not derived from what a particular run happened to emit.
pub fn debug_value_names() -> &'static [(&'static str, DebugValueKind)] {
    &[
        (ACTIVE, DebugValueKind::Region),
        (VISITED, DebugValueKind::Region),
    ]
}

/// Binary encoding for the WASM boundary (GitHub issue #124's format). `NodeId` is `u64` — every
/// single-id payload is 8 little-endian bytes; `f64` fields are 8 little-endian bytes
/// (`to_le_bytes`); `usize`/`u32` count-like fields are encoded as `u32` LE; `bool` fields are a
/// single byte (`0`/`1`); `Vec<NodeId>` payloads are a `u32` LE length prefix followed by that
/// many `NodeId`s, mirroring `KruskalEvent::EdgesShuffled`'s wire format. `Option<NodeId>`
/// (`NodeActivated.parent`, `None` only for the run's start node) is a 1-byte presence flag
/// followed by 8 bytes — `0` when absent (never a real `NodeId`'s bytes, but still fixed-width so
/// the decoder doesn't need a variable-length branch for this one field).
impl EncodeEventPayload for EdgeBasedEvent {
    fn type_id(&self) -> u16 {
        match self {
            EdgeBasedEvent::CorridorRollSkipped => wire_tags::CORRIDOR_ROLL_SKIPPED,
            EdgeBasedEvent::CorridorRolled { .. } => wire_tags::CORRIDOR_ROLLED,
            EdgeBasedEvent::CorridorDeadNoUnseen { .. } => wire_tags::CORRIDOR_DEAD_NO_UNSEEN,
            EdgeBasedEvent::SrcChosenByDepthFirst { .. } => wire_tags::SRC_CHOSEN_BY_DEPTH_FIRST,
            EdgeBasedEvent::TeleportRolled { .. } => wire_tags::TELEPORT_ROLLED,
            EdgeBasedEvent::TeleportAlreadyRolled { .. } => wire_tags::TELEPORT_ALREADY_ROLLED,
            EdgeBasedEvent::CyclicRolled { .. } => wire_tags::CYCLIC_ROLLED,
            EdgeBasedEvent::CyclicAlreadyRolled { .. } => wire_tags::CYCLIC_ALREADY_ROLLED,
            EdgeBasedEvent::CandidatePoolBuilt { .. } => wire_tags::CANDIDATE_POOL_BUILT,
            EdgeBasedEvent::SrcExhaustedEmptyPool { .. } => wire_tags::SRC_EXHAUSTED_EMPTY_POOL,
            EdgeBasedEvent::CyclicCandidatesComputed { .. } => wire_tags::CYCLIC_CANDIDATES_COMPUTED,
            EdgeBasedEvent::CyclicEdgeAdded { .. } => wire_tags::CYCLIC_EDGE_ADDED,
            EdgeBasedEvent::CyclicEdgeRejected { .. } => wire_tags::CYCLIC_EDGE_REJECTED,
            EdgeBasedEvent::DstWeightsComputed { .. } => wire_tags::DST_WEIGHTS_COMPUTED,
            EdgeBasedEvent::DstChosen { .. } => wire_tags::DST_CHOSEN,
            EdgeBasedEvent::PresetSkipped { .. } => wire_tags::PRESET_SKIPPED,
            EdgeBasedEvent::EdgeAdded { .. } => wire_tags::EDGE_ADDED,
            EdgeBasedEvent::EdgeRejected { .. } => wire_tags::EDGE_REJECTED,
            EdgeBasedEvent::NodeActivated { .. } => wire_tags::NODE_ACTIVATED,
            EdgeBasedEvent::SrcExhausted { .. } => wire_tags::SRC_EXHAUSTED,
        }
    }

    fn encode_payload(&self, out: &mut Vec<u8>) {
        fn push_ids(out: &mut Vec<u8>, ids: &[NodeId]) {
            out.extend_from_slice(&(ids.len() as u32).to_le_bytes());
            for id in ids {
                out.extend_from_slice(&id.to_le_bytes());
            }
        }
        fn push_f64s(out: &mut Vec<u8>, values: &[f64]) {
            out.extend_from_slice(&(values.len() as u32).to_le_bytes());
            for v in values {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }

        match self {
            EdgeBasedEvent::CorridorRollSkipped => {}
            EdgeBasedEvent::CorridorRolled { prev, roll, corridor_length, continued } => {
                out.extend_from_slice(&prev.to_le_bytes());
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&corridor_length.to_le_bytes());
                out.push(if *continued { 1 } else { 0 });
            }
            EdgeBasedEvent::CorridorDeadNoUnseen { prev } => {
                out.extend_from_slice(&prev.to_le_bytes());
            }
            EdgeBasedEvent::SrcChosenByDepthFirst { src, active_len, position, depth_first } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&(*active_len as u32).to_le_bytes());
                out.extend_from_slice(&(*position as u32).to_le_bytes());
                out.extend_from_slice(&depth_first.to_le_bytes());
            }
            EdgeBasedEvent::TeleportRolled { src, roll, teleport_chance, fired } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&teleport_chance.to_le_bytes());
                out.push(if *fired { 1 } else { 0 });
            }
            EdgeBasedEvent::TeleportAlreadyRolled { src } => {
                out.extend_from_slice(&src.to_le_bytes());
            }
            EdgeBasedEvent::CyclicRolled { src, roll, cyclicity, fired } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&cyclicity.to_le_bytes());
                out.push(if *fired { 1 } else { 0 });
            }
            EdgeBasedEvent::CyclicAlreadyRolled { src } => {
                out.extend_from_slice(&src.to_le_bytes());
            }
            EdgeBasedEvent::CandidatePoolBuilt { src, geometric, candidates } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.push(if *geometric { 1 } else { 0 });
                push_ids(out, candidates);
            }
            EdgeBasedEvent::SrcExhaustedEmptyPool { src } => {
                out.extend_from_slice(&src.to_le_bytes());
            }
            EdgeBasedEvent::CyclicCandidatesComputed { src, geometric, candidates } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.push(if *geometric { 1 } else { 0 });
                push_ids(out, candidates);
            }
            EdgeBasedEvent::CyclicEdgeAdded { src, dst, teleport, bidirectional } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
                out.push(if *teleport { 1 } else { 0 });
                out.push(if *bidirectional { 1 } else { 0 });
            }
            EdgeBasedEvent::CyclicEdgeRejected { src, dst, teleport } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
                out.push(if *teleport { 1 } else { 0 });
            }
            EdgeBasedEvent::DstWeightsComputed { candidates, weights, branching, directionality, directionality_eligible } => {
                push_ids(out, candidates);
                push_f64s(out, weights);
                out.extend_from_slice(&branching.to_le_bytes());
                out.extend_from_slice(&directionality.to_le_bytes());
                out.push(if *directionality_eligible { 1 } else { 0 });
            }
            EdgeBasedEvent::DstChosen { dst, roll, total_weight } => {
                out.extend_from_slice(&dst.to_le_bytes());
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&total_weight.to_le_bytes());
            }
            EdgeBasedEvent::PresetSkipped { src, dst } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
            }
            EdgeBasedEvent::EdgeAdded { src, dst, teleport, bidirectional } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
                out.push(if *teleport { 1 } else { 0 });
                out.push(if *bidirectional { 1 } else { 0 });
            }
            EdgeBasedEvent::EdgeRejected { src, dst, teleport } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
                out.push(if *teleport { 1 } else { 0 });
            }
            EdgeBasedEvent::NodeActivated { node, parent, tree_depth } => {
                out.extend_from_slice(&node.to_le_bytes());
                out.push(if parent.is_some() { 1 } else { 0 });
                out.extend_from_slice(&parent.unwrap_or(0).to_le_bytes());
                out.extend_from_slice(&(*tree_depth).to_le_bytes());
            }
            EdgeBasedEvent::SrcExhausted { src } => {
                out.extend_from_slice(&src.to_le_bytes());
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeState { Unseen, Active, Visited }

struct NodeEntry {
    state:      NodeState,
    parent:     Option<NodeId>,
    tree_depth: u32,
    /// Whether `teleport_chance` has already been rolled for this node while it was `src`. A
    /// node may become `src` multiple times before exhausting its geometric neighbors (each
    /// `active`-lifetime pop is a separate connection opportunity), so without this guard the
    /// same node's effective teleport probability would compound with its degree instead of
    /// applying once per node.
    teleport_rolled: bool,
    /// Whether `cyclicity` has already been rolled for this node while it was `src`, mirroring
    /// `teleport_rolled` — see `CyclicAlreadyRolled` and `roll_cyclic`.
    cyclic_rolled: bool,
}

impl NodeEntry {
    fn unseen() -> Self {
        Self { state: NodeState::Unseen, parent: None, tree_depth: 0, teleport_rolled: false, cyclic_rolled: false }
    }
}

pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    params: &EdgeBasedParams,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    mut event_log: Option<&mut EventLog<EdgeBasedEvent>>,
) {
    let mut rng = MazeRng::seed_from_u64(seed);

    let mut nodes: HashMap<NodeId, NodeEntry> = graph.nodes()
        .map(|n| (n.id, NodeEntry::unseen()))
        .collect();

    let mut active: Vec<NodeId> = Vec::new();
    let mut last_dst: Option<NodeId> = None;

    // preset_connected nodes stay Unseen so they remain visible as connection targets.
    // When an active node connects to one, it is marked Visited but NOT pushed to active.
    let preset_connected = &preset_state.preset_connected;

    // Ensure start is Active.
    if nodes.get(&start).map_or(true, |e| e.state == NodeState::Unseen) {
        nodes.insert(start, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 0, teleport_rolled: false, cyclic_rolled: false });
        active.push(start);
        if let Some(log) = event_log.as_deref_mut() {
            log.emit(EdgeBasedEvent::NodeActivated { node: start, parent: None, tree_depth: 0 });
        }
    }

    loop {
        if active.is_empty() { break; }

        let mut step_scope = event_log.as_deref_mut().map(|log| log.enter_numbered("step"));

        let prev_last_dst = last_dst;
        let choice = choose_src(&active, last_dst, &nodes, params, preset_state, field, &mut rng);
        if let Some(g) = step_scope.as_mut() {
            let event = match choice {
                SrcChoice::NoCorridorAttempt { .. } => EdgeBasedEvent::CorridorRollSkipped,
                SrcChoice::CorridorContinued { prev, roll } =>
                    EdgeBasedEvent::CorridorRolled { prev, roll, corridor_length: params.corridor_length, continued: true },
                SrcChoice::CorridorDeadFallthrough { prev, roll, .. } => {
                    g.emit(EdgeBasedEvent::CorridorRolled { prev, roll, corridor_length: params.corridor_length, continued: true });
                    EdgeBasedEvent::CorridorDeadNoUnseen { prev }
                }
                SrcChoice::CorridorFailedFallthrough { prev, roll, .. } =>
                    EdgeBasedEvent::CorridorRolled { prev, roll, corridor_length: params.corridor_length, continued: false },
            };
            g.emit(event);
            match choice {
                SrcChoice::NoCorridorAttempt { src, active_len, position }
                | SrcChoice::CorridorDeadFallthrough { src, active_len, position, .. }
                | SrcChoice::CorridorFailedFallthrough { src, active_len, position, .. } => {
                    g.emit(EdgeBasedEvent::SrcChosenByDepthFirst { src, active_len, position, depth_first: params.depth_first });
                }
                SrcChoice::CorridorContinued { .. } => {}
            }
        }
        let src = choice.src();
        let corridor_fired = prev_last_dst == Some(src);

        // Teleport and cyclic are both rolled right after src is fixed, before any candidate
        // pool is built — the combination of the two decides which pool the normal dst-choice
        // step (below) draws from: teleport only takes over that pool when cyclic did NOT also
        // fire this step (see try_add_cyclic_edge for the "both fired" case, where teleport is
        // spent on the cyclic edge instead).
        let teleport_roll = roll_teleport(src, &mut nodes, elements, &mut rng);
        let teleport_flag = teleport_roll.map(|(_, fired)| fired).unwrap_or(false);
        if let Some(g) = step_scope.as_mut() {
            match teleport_roll {
                Some((roll, fired)) => {
                    g.emit(EdgeBasedEvent::TeleportRolled { src, roll, teleport_chance: elements.teleport_chance, fired });
                }
                None => {
                    g.emit(EdgeBasedEvent::TeleportAlreadyRolled { src });
                }
            }
        }

        let cyclic_roll = roll_cyclic(src, &mut nodes, params, &mut rng);
        let cyclic_flag = cyclic_roll.map(|(_, fired)| fired).unwrap_or(false);
        if let Some(g) = step_scope.as_mut() {
            match cyclic_roll {
                Some((roll, fired)) => {
                    g.emit(EdgeBasedEvent::CyclicRolled { src, roll, cyclicity: params.cyclicity, fired });
                }
                None => {
                    g.emit(EdgeBasedEvent::CyclicAlreadyRolled { src });
                }
            }
        }
        let use_geometric_pool = !teleport_flag || cyclic_flag;

        let candidates = build_candidate_pool(src, use_geometric_pool, &nodes, preset_connected, preset_state, field);
        if let Some(g) = step_scope.as_mut() {
            g.emit(EdgeBasedEvent::CandidatePoolBuilt { src, geometric: use_geometric_pool, candidates: candidates.clone() });
        }
        if candidates.is_empty() {
            if let Some(g) = step_scope.as_mut() {
                g.emit(EdgeBasedEvent::SrcExhaustedEmptyPool { src });
            }
            remove_from_active(src, &mut active, &mut nodes);
            if last_dst == Some(src) { last_dst = None; }
            continue;
        }

        try_add_cyclic_edge(graph, field, src, cyclic_flag, teleport_flag, &nodes, elements, preset_state, &mut rng, step_scope.as_mut());

        let directionality_eligible = use_geometric_pool && !corridor_fired;
        let weights = dst_weights(src, &candidates, use_geometric_pool, corridor_fired, &nodes, params, field);
        if let Some(g) = step_scope.as_mut() {
            g.emit(EdgeBasedEvent::DstWeightsComputed {
                candidates: candidates.clone(),
                weights: weights.clone(),
                branching: params.branching,
                directionality: params.directionality,
                directionality_eligible,
            });
        }
        let (dst_index, dst_roll, dst_total_weight) = weighted_sample_index(&weights, &mut rng);
        let dst = candidates[dst_index];
        if let Some(g) = step_scope.as_mut() {
            g.emit(EdgeBasedEvent::DstChosen { dst, roll: dst_roll, total_weight: dst_total_weight });
        }

        if use_geometric_pool {
            // Geometric pool only: a `src`-`dst` preset pair (both `preset_connected`, matched by
            // the `preset_connected.contains(&src) && preset_connected.contains(&n)` exception in
            // `build_candidate_pool`) already has its edge built by `build_preset_state` — skip
            // `try_add_edge` (and `last_dst`, so a preset-skipped step can't seed a corridor
            // chain) to avoid duplicating it. Doesn't apply to the teleport pool below: there,
            // `dst` being `preset_connected` says nothing about the specific src-dst pair (it's
            // any Unseen node in the whole graph, not a geometric neighbor of `src`), so no edge
            // exists yet and skipping would silently drop the teleport.
            let dst_is_preset_teleport = preset_state.preset_teleports.get(&src).is_some_and(|dsts| dsts.contains(&dst));
            if !preset_connected.contains(&dst) && !dst_is_preset_teleport {
                let added = add_edge_and_detect_direction(graph, src, dst, |g| try_add_edge(g, src, dst, elements, preset_state, &mut rng));
                if let Some(g) = step_scope.as_mut() {
                    g.emit(match added {
                        Some((from, to, bidirectional)) => EdgeBasedEvent::EdgeAdded { src: from, dst: to, teleport: false, bidirectional },
                        None => EdgeBasedEvent::EdgeRejected { src, dst, teleport: false },
                    });
                }
                last_dst = Some(dst);
            } else if let Some(g) = step_scope.as_mut() {
                g.emit(EdgeBasedEvent::PresetSkipped { src, dst });
            }
        } else {
            let added = add_edge_and_detect_direction(graph, src, dst, |g| {
                try_add_edge_kind(g, src, dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut rng)
            });
            if let Some(g) = step_scope.as_mut() {
                g.emit(match added {
                    Some((from, to, bidirectional)) => EdgeBasedEvent::EdgeAdded { src: from, dst: to, teleport: true, bidirectional },
                    None => EdgeBasedEvent::EdgeRejected { src, dst, teleport: true },
                });
            }
            last_dst = Some(dst);
        }

        let depth = nodes.get(&src).map(|e| e.tree_depth + 1).unwrap_or(1);
        nodes.insert(dst, NodeEntry { state: NodeState::Active, parent: Some(src), tree_depth: depth, teleport_rolled: false, cyclic_rolled: false });
        active.push(dst);
        if let Some(g) = step_scope.as_mut() {
            g.emit(EdgeBasedEvent::NodeActivated { node: dst, parent: Some(src), tree_depth: depth });
        }

        if is_src_exhausted(src, &nodes, preset_connected, preset_state, field) {
            remove_from_active(src, &mut active, &mut nodes);
            if last_dst == Some(src) { last_dst = None; }
            if let Some(g) = step_scope.as_mut() {
                g.emit(EdgeBasedEvent::SrcExhausted { src });
            }
        }
    }
}

/// Rolls `teleport_chance` for `src`, guarded to at most once per node (`NodeEntry.teleport_rolled`).
/// A node may become `src` multiple times before exhausting its geometric neighbors (each
/// `active`-lifetime pop is a separate connection opportunity), so without this guard the same
/// node's effective teleport probability would compound with its degree instead of applying once
/// per node.
/// Returns `None` when the roll was skipped (already rolled for this node — see
/// `EdgeBasedEvent::TeleportAlreadyRolled`), or `Some((roll, fired))` when a fresh roll happened,
/// carrying the raw sample alongside the outcome so `EdgeBasedEvent::TeleportRolled` (GitHub
/// issue #144) can narrate the exact draw.
/// Runs `add_fn` (a `try_add_edge`/`try_add_edge_kind` call), then detects what actually happened
/// by comparing `graph.edge_between` in both directions before/after — the only way to know,
/// since those functions return `()` and `add_edge_kind`'s own one-way coin flip may add `dst->src`
/// instead of `src->dst` (GitHub issue #144's direction-mismatch fix). Returns `Some((from, to,
/// bidirectional))` with the graph's actual direction when an edge was added, `None` when the
/// attempt was silently declined by a preset conflict. Shared by `generate`'s main edge-add step
/// (geometric and teleport pools) and `try_add_cyclic_edge` — all four call sites need the exact
/// same detect-then-report logic, only which `add_fn` they call differs.
fn add_edge_and_detect_direction(
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

fn roll_teleport(
    src: NodeId,
    nodes: &mut HashMap<NodeId, NodeEntry>,
    elements: &ElementsConfig,
    rng: &mut MazeRng,
) -> Option<(f64, bool)> {
    let already_rolled = nodes.get(&src).map_or(false, |e| e.teleport_rolled);
    if already_rolled { return None; }
    let roll = rng.random::<f64>();
    let hit = roll < elements.teleport_chance;
    if let Some(entry) = nodes.get_mut(&src) { entry.teleport_rolled = true; }
    Some((roll, hit))
}

/// Rolls `cyclicity` for `src`, guarded to at most once per node (`NodeEntry.cyclic_rolled`),
/// mirroring `roll_teleport` — a node may become `src` multiple times before exhausting its
/// geometric neighbors, so without this guard the same node's effective cyclic-edge probability
/// would compound with its degree instead of applying once per node.
/// Returns `None` when the roll was skipped (already rolled for this node — see
/// `EdgeBasedEvent::CyclicAlreadyRolled`), or `Some((roll, fired))` when a fresh roll happened.
fn roll_cyclic(
    src: NodeId,
    nodes: &mut HashMap<NodeId, NodeEntry>,
    params: &EdgeBasedParams,
    rng: &mut MazeRng,
) -> Option<(f64, bool)> {
    let already_rolled = nodes.get(&src).map_or(false, |e| e.cyclic_rolled);
    if already_rolled { return None; }
    let roll = rng.random::<f64>();
    let hit = roll < params.cyclicity;
    if let Some(entry) = nodes.get_mut(&src) { entry.cyclic_rolled = true; }
    Some((roll, hit))
}

/// Whether `n` is a geometric neighbor of `src` that a normal (non-teleport) connection could
/// still reach: Unseen, and either both nodes are preset_connected (a geometrically-adjacent
/// preset pair) or the pair isn't blocked/locked. Shared by `build_candidate_pool`'s geometric
/// branch and `is_src_exhausted`, which is exactly this predicate's negation over all neighbors.
fn is_reachable_unseen_neighbor(
    src: NodeId,
    n: NodeId,
    nodes: &HashMap<NodeId, NodeEntry>,
    preset_connected: &std::collections::BTreeSet<NodeId>,
    preset_state: &PresetState,
) -> bool {
    nodes.get(&n).map_or(false, |e| e.state == NodeState::Unseen)
        && (preset_connected.contains(&src) && preset_connected.contains(&n) || can_connect(src, n, preset_state))
}

fn build_candidate_pool<T: Tessellation>(
    src: NodeId,
    use_geometric_pool: bool,
    nodes: &HashMap<NodeId, NodeEntry>,
    preset_connected: &std::collections::BTreeSet<NodeId>,
    preset_state: &PresetState,
    field: &Field<T>,
) -> Vec<NodeId> {
    if use_geometric_pool {
        // Preset-teleport destinations of `src` are traversable extra neighbors (GitHub issue
        // #226) — their edge already exists in the graph regardless of this step's teleport roll,
        // so they join the geometric pool unconditionally (only gated on Unseen, not
        // `can_connect` — that governs adding a *new* edge, which doesn't apply here).
        let teleport_dsts = preset_state.preset_teleports.get(&src).map(Vec::as_slice).unwrap_or(&[]);
        let reachable_teleport_dsts = teleport_dsts.iter().copied()
            .filter(|n| nodes.get(n).map_or(false, |e| e.state == NodeState::Unseen));
        field.neighbors(src).into_iter()
            .filter(|&n| is_reachable_unseen_neighbor(src, n, nodes, preset_connected, preset_state))
            .chain(reachable_teleport_dsts)
            .collect()
    } else {
        // Teleport candidate pool: every Unseen node in the graph, not just geometric neighbors
        // of src. No preset_connected exception here — that exception exists only to handle
        // geometrically-adjacent preset pairs, which doesn't apply to teleport.
        sorted_nodes_in_state(nodes, NodeState::Unseen, |n| n != src && can_connect(src, n, preset_state))
    }
}

/// Cyclic roll (already decided by the caller): adds an extra edge to a visited node, independent
/// of the normal dst selection. If teleport also fired this step, the cyclic candidate pool
/// widens from "visited geometric neighbors" to "any visited node in the graph", and the added
/// edge is a Teleport rather than a Basic connection — teleport is considered spent on this
/// cyclic edge in that case (the caller's dst-choice step then always uses the geometric pool).
///
/// Emits `CyclicCandidatesComputed` always (even for an empty pool, so a narration reader sees
/// the attempt was made and why it stopped), and `CyclicEdgeAdded`/`CyclicEdgeRejected` — the
/// latter detected by comparing `graph.edge_between` before/after the attempt, since
/// `try_add_edge`/`try_add_edge_kind` return `()` and silently decline on a preset conflict
/// (GitHub issue #144).
fn try_add_cyclic_edge<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    src: NodeId,
    cyclic_flag: bool,
    teleport_flag: bool,
    nodes: &HashMap<NodeId, NodeEntry>,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    rng: &mut MazeRng,
    mut scope: Option<&mut ScopeGuard<EdgeBasedEvent>>,
) {
    if !cyclic_flag { return; }

    if teleport_flag {
        let visited_nodes = sorted_nodes_in_state(nodes, NodeState::Visited, |n| {
            n != src && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none()
        });
        if let Some(log) = scope.as_deref_mut() {
            log.emit(EdgeBasedEvent::CyclicCandidatesComputed { src, geometric: false, candidates: visited_nodes.clone() });
        }
        if !visited_nodes.is_empty() {
            let cyclic_dst = visited_nodes[rng.random_range(0..visited_nodes.len())];
            // Pool filter above already guarantees neither direction exists yet.
            let added = add_edge_and_detect_direction(graph, src, cyclic_dst, |g| {
                try_add_edge_kind(g, src, cyclic_dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, rng)
            });
            // last_dst not updated: visited node cannot seed a corridor chain
            if let Some(log) = scope.as_deref_mut() {
                log.emit(match added {
                    Some((from, to, bidirectional)) => EdgeBasedEvent::CyclicEdgeAdded { src: from, dst: to, teleport: true, bidirectional },
                    None => EdgeBasedEvent::CyclicEdgeRejected { src, dst: cyclic_dst, teleport: true },
                });
            }
        }
    } else {
        let visited_neighbors: Vec<NodeId> = field.neighbors(src).into_iter()
            .filter(|&n| nodes.get(&n).map_or(false, |e| e.state == NodeState::Visited)
                && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
            .collect();
        if let Some(log) = scope.as_deref_mut() {
            log.emit(EdgeBasedEvent::CyclicCandidatesComputed { src, geometric: true, candidates: visited_neighbors.clone() });
        }
        if !visited_neighbors.is_empty() {
            let cyclic_dst = visited_neighbors[rng.random_range(0..visited_neighbors.len())];
            // Filter above already guarantees neither direction exists yet.
            let added = add_edge_and_detect_direction(graph, src, cyclic_dst, |g| try_add_edge(g, src, cyclic_dst, elements, preset_state, rng));
            // last_dst not updated: visited node cannot seed a corridor chain
            if let Some(log) = scope.as_deref_mut() {
                log.emit(match added {
                    Some((from, to, bidirectional)) => EdgeBasedEvent::CyclicEdgeAdded { src: from, dst: to, teleport: false, bidirectional },
                    None => EdgeBasedEvent::CyclicEdgeRejected { src, dst: cyclic_dst, teleport: false },
                });
            }
        }
    }
}

/// dst-choice weight: directionality only makes sense for the geometric pool (it needs
/// `field.is_straight`, which is meaningless for a non-adjacent teleport candidate) — the
/// teleport pool (`!use_geometric_pool`) uses branching alone. The geometric pool itself can still
/// contain a non-adjacent candidate (a preset-teleport destination of `src`, GitHub issue #226) —
/// `field.is_straight` safely returns `false` for it (its `via`/`to` aren't geometrically adjacent,
/// so `Field::face_between` returns `None`), so it simply never gets the directionality bonus,
/// exactly as intended for a teleport jump.
fn dst_weights<T: Tessellation>(
    src: NodeId,
    candidates: &[NodeId],
    use_geometric_pool: bool,
    corridor_fired: bool,
    nodes: &HashMap<NodeId, NodeEntry>,
    params: &EdgeBasedParams,
    field: &Field<T>,
) -> Vec<f64> {
    candidates.iter().map(|&dst| {
        let free = field.neighbors(dst).iter()
            .filter(|n| nodes.get(n).map_or(false, |e| e.state == NodeState::Unseen))
            .count();
        let mut w = 1.0 + params.branching * (free as f64).sqrt();
        if use_geometric_pool && !corridor_fired {
            if let Some(entry) = nodes.get(&src) {
                if let Some(p) = entry.parent {
                    if field.is_straight(p, src, dst) {
                        w *= 1.0 + params.directionality * 3.0;
                    }
                }
            }
        }
        w
    }).collect()
}

fn is_src_exhausted<T: Tessellation>(
    src: NodeId,
    nodes: &HashMap<NodeId, NodeEntry>,
    preset_connected: &std::collections::BTreeSet<NodeId>,
    preset_state: &PresetState,
    field: &Field<T>,
) -> bool {
    let teleport_dsts = preset_state.preset_teleports.get(&src).map(Vec::as_slice).unwrap_or(&[]);
    let no_reachable_teleport_dst = teleport_dsts.iter()
        .all(|n| nodes.get(n).map_or(true, |e| e.state != NodeState::Unseen));
    no_reachable_teleport_dst
        && field.neighbors(src).into_iter().all(|n| !is_reachable_unseen_neighbor(src, n, nodes, preset_connected, preset_state))
}

/// How `choose_src` arrived at its result — carries the narration-relevant detail
/// (`EdgeBasedEvent::CorridorRollSkipped`/`CorridorRolled`/`CorridorDeadNoUnseen`/
/// `SrcChosenByDepthFirst`, GitHub issue #144) each caller needs to emit, so `generate` doesn't
/// have to reimplement `choose_src`'s corridor/depth-first branching a second time just to
/// narrate it.
enum SrcChoice {
    /// No `last_dst` yet — no corridor roll was attempted this call.
    NoCorridorAttempt { src: NodeId, active_len: usize, position: usize },
    /// Corridor roll attempted and succeeded (`roll < corridor_length`), and `prev` had a
    /// reachable unseen neighbor — `prev` became `src` directly, no depth-first sampling ran.
    CorridorContinued { prev: NodeId, roll: f64 },
    /// Corridor roll attempted and succeeded, but `prev` had no reachable unseen neighbor left —
    /// fell through to depth-first sampling.
    CorridorDeadFallthrough { prev: NodeId, roll: f64, src: NodeId, active_len: usize, position: usize },
    /// Corridor roll attempted and failed (`roll >= corridor_length`) — fell through to
    /// depth-first sampling.
    CorridorFailedFallthrough { prev: NodeId, roll: f64, src: NodeId, active_len: usize, position: usize },
}

impl SrcChoice {
    fn src(&self) -> NodeId {
        match *self {
            SrcChoice::NoCorridorAttempt { src, .. } => src,
            SrcChoice::CorridorContinued { prev, .. } => prev,
            SrcChoice::CorridorDeadFallthrough { src, .. } => src,
            SrcChoice::CorridorFailedFallthrough { src, .. } => src,
        }
    }
}

fn choose_src<T: Tessellation>(
    active: &[NodeId],
    last_dst: Option<NodeId>,
    nodes: &HashMap<NodeId, NodeEntry>,
    params: &EdgeBasedParams,
    preset_state: &PresetState,
    field: &Field<T>,
    rng: &mut MazeRng,
) -> SrcChoice {
    let depth_first_pick = |rng: &mut MazeRng| {
        let position = gaussian_weighted_index(active.len(), params.depth_first, rng);
        (active[position], position)
    };

    // Corridor attempt — continue from last dst (chain: A→B→C→...)
    if let Some(prev) = last_dst {
        let roll = rng.random::<f64>();
        if roll < params.corridor_length {
            let has_unseen = field.neighbors(prev).into_iter()
                .any(|n| nodes.get(&n).map_or(false, |e| e.state == NodeState::Unseen) && can_connect(prev, n, preset_state));
            if has_unseen {
                return SrcChoice::CorridorContinued { prev, roll };
            }
            let (src, position) = depth_first_pick(rng);
            return SrcChoice::CorridorDeadFallthrough { prev, roll, src, active_len: active.len(), position };
        }
        let (src, position) = depth_first_pick(rng);
        return SrcChoice::CorridorFailedFallthrough { prev, roll, src, active_len: active.len(), position };
    }

    // depth_first weighted sampling by position in active (oldest=0.0, newest=1.0)
    let (src, position) = depth_first_pick(rng);
    SrcChoice::NoCorridorAttempt { src, active_len: active.len(), position }
}

/// Returns `(chosen_index, roll, total_weight)` — `roll` is the pre-scaled sample
/// (`rng.random::<f64>() * total_weight`), carried out alongside the index so
/// `EdgeBasedEvent::DstChosen` (GitHub issue #144) can narrate the exact draw without
/// re-deriving it (the RNG sample can't be reproduced after the fact).
fn weighted_sample_index(weights: &[f64], rng: &mut MazeRng) -> (usize, f64, f64) {
    let total: f64 = weights.iter().sum();
    let roll = rng.random::<f64>() * total;
    let mut r = roll;
    for (i, &w) in weights.iter().enumerate() {
        r -= w;
        if r <= 0.0 { return (i, roll, total); }
    }
    (weights.len() - 1, roll, total)
}

/// Collects every node in the given `state` (besides `n != src`-style exclusions folded into
/// `extra_filter`) into a `Vec`, sorted for determinism. `nodes` is a `HashMap`, whose iteration
/// order is randomized per-process — without sorting, the same seed could pick a different node
/// on a different run. Shared by every "scan the whole graph for nodes in state X" pool used by
/// the teleport model (candidate pool, cyclic-partner pool), so the sort is applied exactly once.
fn sorted_nodes_in_state(
    nodes: &HashMap<NodeId, NodeEntry>,
    state: NodeState,
    extra_filter: impl Fn(NodeId) -> bool,
) -> Vec<NodeId> {
    let mut pool: Vec<NodeId> = nodes.iter()
        .filter(|&(&n, e)| e.state == state && extra_filter(n))
        .map(|(&n, _)| n)
        .collect();
    pool.sort_unstable();
    pool
}

fn remove_from_active(node: NodeId, active: &mut Vec<NodeId>, nodes: &mut HashMap<NodeId, NodeEntry>) {
    if let Some(pos) = active.iter().position(|&n| n == node) {
        active.remove(pos); // preserve insertion order for gaussian_weighted_index
    }
    if let Some(entry) = nodes.get_mut(&node) {
        entry.state = NodeState::Visited;
    }
}

#[cfg(test)]
#[path = "edge_based_tests.rs"]
mod tests;
