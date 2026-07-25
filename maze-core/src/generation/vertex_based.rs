use std::collections::HashSet;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::{NodeId, IdGenerator};
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use crate::event_log::{DebugEvent, DebugValueDelta, DebugValueKind, DebugValueOp, EncodeEventPayload, EventLog, ScopeGuard};
use super::{ElementsConfig, GenerationParams, PresetState, try_add_edge, try_add_edge_kind, can_connect, gaussian_weighted_index};
use super::split_pattern::SplitGenerationConfig;
use super::split_logic::{try_split_src, SplitOutcome, StartReassignment};

/// Stable wire tags for [`VertexBasedEvent`] (see `Specs/event_log.md`'s #124 binary encoding) —
/// manually assigned, never derived from Rust enum variant order/discriminant. `0` is reserved
/// for scope nodes (`event_log::TAG_SCOPE`) and must never be assigned here.
mod wire_tags {
    pub const TELEPORT_BRIDGE_ROLLED: u16 = 1;
    pub const TELEPORT_BRIDGE_ADDED: u16 = 2;
    pub const RESERVE_CANDIDATE_REJECTED: u16 = 3;
    pub const RESERVE_CANDIDATE_CHOSEN: u16 = 4;
    pub const RESERVE_EXHAUSTED: u16 = 5;
    pub const BRIDGE_ADDED: u16 = 6;
    pub const SRC_CHOSEN_FROM_FRONTIER: u16 = 7;
    pub const TELEPORT_ROLLED: u16 = 8;
    pub const CYCLIC_ROLLED: u16 = 9;
    pub const CYCLIC_CANDIDATES_COMPUTED: u16 = 10;
    pub const CYCLIC_EDGE_ADDED: u16 = 11;
    pub const CORRIDOR_ROLLED: u16 = 12;
    pub const CANDIDATE_CHOSEN: u16 = 13;
    pub const JUNCTION_SLOT_ROLLED: u16 = 14;
    pub const JUNCTION_CANDIDATES_CHOSEN: u16 = 15;
    pub const EDGE_ADDED: u16 = 16;
    pub const PRESET_NEIGHBOR_VISITED: u16 = 17;
    pub const TELEPORT_CONNECT_ADDED: u16 = 18;
    pub const NODE_VISITED: u16 = 19;
    pub const NODE_QUEUED_TO_RESERVE: u16 = 20;
    pub const START_VISITED: u16 = 21;
    pub const JUNCTION_ROLL_SETUP: u16 = 22;
    pub const SINGLE_CANDIDATE_SKIPS_DIRECTIONALITY: u16 = 23;
    pub const NO_PARENT_SKIPS_DIRECTIONALITY: u16 = 24;
    pub const DIRECTIONALITY_ROLLED: u16 = 25;
    pub const SPLIT_ROLLED: u16 = 26;
    pub const SPLIT_NODES_CREATED: u16 = 27;
    pub const SPLIT_CYCLIC_ROLLED: u16 = 28;
    pub const PATTERN_ADAPTATIONS_COMPUTED: u16 = 29;
    pub const PATTERN_ADAPTATION_CHOSEN: u16 = 30;
    pub const SPLIT_TELEPORT_ROLLED: u16 = 31;
    pub const SPLIT_START_REASSIGNED: u16 = 32;
    pub const SPLIT_PARENT_EDGE_RELOCATED: u16 = 33;
}

/// Narration-level events for `CustomVertexBased` generation (see GitHub issue #143). Unlike
/// `CustomEdgeBased`'s single active-list per step, `vertex_based` has two distinct entry points
/// into its main loop — `handle_empty_frontier` (teleport-bridge or reserve-pop, when the
/// frontier is empty) and `step_from_frontier` (the normal frontier-pop step) — both emitted flat
/// under one `"step N"` scope per main-loop iteration (mirrors Kruskal/EdgeBased's flat shape),
/// except the reserve-candidate scan, which nests under its own fixed `"reserve_search"`
/// sub-scope (mirrors Wilson's fixed `"search"`/`"commit"` names) since it can reject several
/// candidates before settling on one — per explicit user decision (GitHub issue #143 discussion).
#[derive(Debug, Clone, PartialEq)]
pub enum VertexBasedEvent {
    /// The teleport-bridge roll tried first in `handle_empty_frontier`, against
    /// `elements.teleport_chance` — a hit bridges a new node into the maze via teleport instead
    /// of a reserve pop, replacing this step's entire mechanism. `fired` is `roll < teleport_chance`.
    TeleportBridgeRolled { roll: f64, teleport_chance: f64, fired: bool },
    /// A teleport bridge was added from `src` (an already-visited node, picked uniformly at
    /// random) to `dst` (an unvisited node, picked uniformly at random) — `src`/`dst` are the
    /// actual graph direction, not necessarily the roll's own naming, since `try_add_edge_kind`'s
    /// own one-way coin flip may reverse a one-way edge (mirrors `EdgeBasedEvent::EdgeAdded`'s
    /// direction-detection fix, GitHub issue #144). Only emitted when the graph actually gained
    /// an edge — `try_add_edge_kind` silently declines on a preset conflict, detected by comparing
    /// `graph.edge_between` before/after.
    TeleportBridgeAdded { src: NodeId, dst: NodeId, bidirectional: bool },
    /// One candidate popped off `reserve` during the reserve-scan (`"reserve_search"` sub-scope)
    /// was rejected and pushed back — either because it was already visited (`already_visited:
    /// true`), or because none of its geometric neighbors are visited yet (`already_visited:
    /// false` — not reachable this round, requeued for a future pop).
    ReserveCandidateRejected { node: NodeId, already_visited: bool },
    /// The reserve-scan settled on `node` — it has at least one visited, connectable geometric
    /// neighbor, so it becomes this step's bridge target.
    ReserveCandidateChosen { node: NodeId },
    /// The reserve-scan exhausted `reserve` (every candidate either already seen this scan or
    /// popped to empty) without finding a reachable node — generation has nothing left to bring
    /// in via either mechanism (teleport bridge or reserve pop), so the run ends after this step.
    ReserveExhausted,
    /// A geometric-adjacency bridge was added from `src` (a visited neighbor of `dst`, picked
    /// uniformly at random) to `dst` (the reserve-chosen candidate) — direction-detected the same
    /// way as `TeleportBridgeAdded`.
    BridgeAdded { src: NodeId, dst: NodeId, bidirectional: bool },
    /// `src` chosen via gaussian-weighted sampling over `frontier` by position (oldest = index 0,
    /// newest = `frontier_len - 1`), skewed by `params.depth_first`. `position` is the sampled
    /// index into `frontier`, before `src` is removed from it. Opens every `"step N"` scope that
    /// reaches `step_from_frontier` (as opposed to `handle_empty_frontier`).
    SrcChosenFromFrontier { src: NodeId, frontier_len: usize, position: usize, depth_first: f64 },
    /// The teleport roll for `src` against `elements.teleport_chance`, taken immediately after
    /// `src` is fixed — a hit widens the cyclic-roll's candidate pool (see
    /// `CyclicCandidatesComputed`) and adds an extra teleport connection alongside whatever the
    /// corridor/junction roll produces (see `TeleportConnectAdded`), unless the cyclic roll
    /// consumes it first. `fired` is `roll < teleport_chance`.
    TeleportRolled { src: NodeId, roll: f64, teleport_chance: f64, fired: bool },
    /// The cyclic-edge roll for `src` against `params.cyclicity`, decided independently of the
    /// teleport roll. `fired` is `roll < cyclicity`.
    CyclicRolled { src: NodeId, roll: f64, cyclicity: f64, fired: bool },
    /// The candidate pool computed for the cyclic edge attempt (only emitted when
    /// `CyclicRolled.fired` was true): visited nodes `src` could still connect to without
    /// duplicating an existing edge. `geometric = true` means visited geometric neighbors of
    /// `src`; `geometric = false` (the teleport-widened pool) means any visited node in the graph.
    /// Empty means the cyclic edge attempt is skipped.
    CyclicCandidatesComputed { src: NodeId, geometric: bool, candidates: Vec<NodeId> },
    /// A cyclic edge was added from `src` to a node drawn from `CyclicCandidatesComputed`'s pool,
    /// independent of the step's corridor/junction connect choice. `teleport` is whether it was
    /// added as a `Teleport` edge (widened pool) vs. a `Basic` edge (geometric pool).
    /// `src`/`dst` are the actual graph direction, detected the same way as `TeleportBridgeAdded`.
    CyclicEdgeAdded { src: NodeId, dst: NodeId, teleport: bool, bidirectional: bool },
    /// The corridor-vs-junction roll for this step's connect choice, against `params.corridor_chance`.
    /// `is_corridor` is `roll < corridor_chance` — when true, at most one candidate is connected
    /// (`CandidateChosen`); when false, `junction_count`'s branching rolls decide how many
    /// (`JunctionSlotRolled` + `JunctionCandidatesChosen`).
    CorridorRolled { roll: f64, corridor_chance: f64, is_corridor: bool },
    /// The corridor branch's single candidate pick from `free_regular`, via directionality-aware
    /// sampling: `used_directionality` records whether the pick actually took the "continue
    /// straight from `parent`" shortcut (a `directionality`-weighted roll hit AND a straight
    /// continuation existed among the candidates) rather than falling back to a uniform pick.
    /// Not emitted when `free_regular` is empty (no candidate to choose from at all).
    CandidateChosen { src: NodeId, dst: NodeId, used_directionality: bool },
    /// `choose_candidate` had exactly one candidate to pick from and `parent` was `Some` — the
    /// directionality roll never happens at all (nothing to weigh it against), which would
    /// otherwise silently read the same as a roll that happened but missed. Emitted right before
    /// the `CandidateChosen`/first-pick-of-`JunctionCandidatesChosen` it precedes, only when this
    /// short-circuit actually applies (never when `parent` is `None`, since directionality
    /// couldn't have rolled either way there).
    SingleCandidateSkipsDirectionality { node: NodeId },
    /// `choose_candidate` had more than one candidate but `parent` was `None` (this step's `src`
    /// has no traversal parent — e.g. a teleport/reserve bridge target) — the directionality roll
    /// never happens (nothing to continue "straight" from). Emitted right before the
    /// `CandidateChosen`/first-pick-of-`JunctionCandidatesChosen` it precedes.
    NoParentSkipsDirectionality { node: NodeId },
    /// `choose_candidate`'s directionality roll against `params.directionality`, taken whenever
    /// there's more than one candidate and a `parent` to continue straight from. `fired` is
    /// `roll < directionality`; `straight_found` is whether a candidate continuing straight from
    /// `parent` through `src` actually existed in the pool — the shortcut is only taken when both
    /// are true (`fired && straight_found`), which is exactly `CandidateChosen.used_directionality`/
    /// the first pick's own directionality flag. Emitted right before the
    /// `CandidateChosen`/first-pick-of-`JunctionCandidatesChosen` it precedes.
    DirectionalityRolled { roll: f64, directionality: f64, fired: bool, straight_found: bool },
    /// Opens `junction_count`'s roll series: `max` connections are possible in total for this
    /// step (2 mandatory + `max - 2` optional slots, each independently rolled against
    /// `params.branching` — see `JunctionSlotRolled`). Emitted once, directly under the
    /// `"junction_count"` scope, before any per-slot roll — gives a narration reader the total
    /// slot budget up front instead of having to infer it by counting the roll series that
    /// follows.
    JunctionRollSetup { max: usize },
    /// One of `junction_count`'s per-slot branching rolls against `params.branching`, deciding
    /// whether one additional connection slot beyond the mandatory first two is taken. Emitted
    /// once per roll — `(max - 2)` times per junction branch, `slot` numbering each roll 1-based
    /// within that series (`max` is the virtual candidate count, widened by one when a teleport
    /// connect is still pending). `taken` is `roll < branching`; the running slot count after this
    /// roll is `2 + (number of `taken: true` rolls so far, including this one)` — not carried on
    /// the wire, since a narration/replay consumer can tally it from the roll sequence itself.
    JunctionSlotRolled { slot: usize, roll: f64, branching: f64, taken: bool },
    /// The junction branch's chosen candidate set, drawn from `free_regular` — the first pick uses
    /// the same directionality-aware sampling as `CandidateChosen`'s single pick, the rest are
    /// uniform random draws from the remaining pool. `geometric_count` is how many of the final
    /// tally (2 plus every `JunctionSlotRolled.taken: true`) are actually geometric connections —
    /// one slot is reserved for a pending teleport connect when applicable, so
    /// `candidates.len() == geometric_count` always holds.
    JunctionCandidatesChosen { src: NodeId, candidates: Vec<NodeId> },
    /// The step's main (corridor or junction) edge from `src` to `dst` was added — direction
    /// detected the same way as `TeleportBridgeAdded`/`BridgeAdded`. Emitted once per candidate in
    /// `CandidateChosen`/`JunctionCandidatesChosen`.
    EdgeAdded { src: NodeId, dst: NodeId, bidirectional: bool },
    /// `dst` is a preset-connected neighbor of `src` — its edge was already built by
    /// `build_preset_state` before generation started, so no `EdgeAdded` follows; `dst` is simply
    /// marked visited and pushed to the frontier.
    PresetNeighborVisited { src: NodeId, dst: NodeId },
    /// The teleport connection added alongside this step's corridor/junction choice (only when
    /// `TeleportRolled.fired` was true and not already spent on a cyclic edge): `dst` is a random
    /// unvisited node in the graph. Skipped (no event) when no unvisited node remains.
    TeleportConnectAdded { src: NodeId, dst: NodeId, bidirectional: bool },
    /// `node` was marked visited and pushed onto the frontier, parented to `whoever just
    /// connected to it. Emitted for every node that enters `visited` this step — the
    /// teleport-bridge/reserve-bridge target in `handle_empty_frontier`, each `free_preset`/
    /// `connected`/teleport-connect target in `step_from_frontier`.
    NodeVisited { node: NodeId, parent: NodeId },
    /// A `free_regular` neighbor that wasn't connected to this step (not chosen by
    /// corridor/junction, not the teleport-connect target) was pushed onto `reserve` for a future
    /// step to pick up.
    NodeQueuedToReserve { node: NodeId },
    /// The run's start node is seeded into `visited` and pushed onto the frontier before the main
    /// loop even begins (`GenState::new`) — mirrors `WilsonEvent::StartVisited`. Emitted once,
    /// directly under the root scope, before the first `"step N"` scope opens, so a narration
    /// reader (and the `"frontier"` debug value) sees the start node there from the very first
    /// step instead of it silently appearing in the frontier with no corresponding event.
    StartVisited { node: NodeId },
    /// The split roll for `src`, taken before any other per-step logic (GitHub issue #222) —
    /// always consumed regardless of `split_chance`, same RNG-parity discipline as
    /// `TeleportRolled`/`CyclicRolled`. `fired` is `roll < split_chance`. A hit does not
    /// necessarily mean the split is applied — see `eligible`/`SplitNodesCreated`: an ineligible
    /// or pattern-exhausted hit still falls back to the ordinary per-step flow for `src`.
    SplitRolled { src: NodeId, roll: f64, split_chance: f64, fired: bool, eligible: bool },
    /// A split was actually applied to `src`'s tile: `nodes` is every resulting node (index 0 is
    /// always `src` itself), `pattern` is `Some(pattern index)` in pattern mode or `None` in
    /// non-pattern mode.
    SplitNodesCreated { src: NodeId, nodes: Vec<NodeId>, pattern: Option<usize> },
    /// Pattern mode's once-per-event cyclic roll (distinct from the ordinary per-node
    /// `CyclicRolled` — pattern mode rolls cyclicity once for the whole split event, not once per
    /// resulting node). `fired` is `roll < cyclicity`; a hit allows exactly one pattern face to
    /// resolve to an already-visited neighbor instead of requiring every `Passage`/`OneWay` face
    /// to land on an unvisited one.
    SplitCyclicRolled { src: NodeId, roll: f64, cyclicity: f64, fired: bool },
    /// Every valid rotation/mirror adaptation found for the chosen pattern, before one is picked —
    /// `count` is `adaptations.len()`, kept alongside since an empty result (pattern excluded,
    /// loop retries another) is exactly as narratively interesting as a non-empty one.
    PatternAdaptationsComputed { src: NodeId, pattern: usize, count: usize },
    /// The adaptation actually applied, picked uniformly at random from
    /// `PatternAdaptationsComputed`'s candidate set. `rotation`/`mirror` identify which of the
    /// candidate adaptations this was.
    PatternAdaptationChosen { src: NodeId, pattern: usize, rotation: usize, mirror: bool },
    /// The split event's once-per-event teleport roll (mirrors `TeleportRolled`, but rolled once
    /// for the whole split event rather than per resulting node — matches pattern mode's
    /// once-per-event cyclicity). `anchor` is the resulting node the teleport connects from, when
    /// it fires.
    SplitTeleportRolled { roll: f64, teleport_chance: f64, fired: bool, anchor: Option<NodeId> },
    /// `start` was reassigned from `original` to `reassigned_to` because the run's traversal-seed
    /// node was split — only possible once per run (`start` is only ever the pre-split seed the
    /// very first time this could apply), and only when no explicit `preset_start` pins it.
    SplitStartReassigned { original: NodeId, reassigned_to: NodeId },
    /// `src`'s pre-existing edge to its real traversal parent (already in the graph before this
    /// split event — see `try_split_src`'s doc comment on `parent`) was relocated: the edge between
    /// `parent` and `src` was removed, and the same direction/kind was recreated between `parent`
    /// and `taken_by` — one of this event's resulting nodes whose pattern face resolved to `parent`
    /// with a matching requirement. `taken_by == src` means the edge effectively stayed put (`src`
    /// itself caught its own parent face).
    SplitParentEdgeRelocated { parent: NodeId, src: NodeId, taken_by: NodeId },
}

impl DebugEvent for VertexBasedEvent {
    /// Mutating: events that change `visited`/`frontier`/`reserve` (the declared debug values) or
    /// the graph — including `SrcChosenFromFrontier`, which pops its node out of `frontier`.
    /// Every other roll/candidate-pool/choice event is trace-only — narration of a decision that
    /// doesn't itself change reconstructable state.
    fn is_mutating(&self) -> bool {
        matches!(
            self,
            VertexBasedEvent::TeleportBridgeAdded { .. }
                | VertexBasedEvent::BridgeAdded { .. }
                | VertexBasedEvent::CyclicEdgeAdded { .. }
                | VertexBasedEvent::EdgeAdded { .. }
                | VertexBasedEvent::PresetNeighborVisited { .. }
                | VertexBasedEvent::TeleportConnectAdded { .. }
                | VertexBasedEvent::NodeVisited { .. }
                | VertexBasedEvent::NodeQueuedToReserve { .. }
                | VertexBasedEvent::ReserveCandidateChosen { .. }
                | VertexBasedEvent::StartVisited { .. }
                | VertexBasedEvent::SrcChosenFromFrontier { .. }
                | VertexBasedEvent::SplitNodesCreated { .. }
                | VertexBasedEvent::SplitStartReassigned { .. }
                | VertexBasedEvent::SplitParentEdgeRelocated { .. }
        )
    }
}

pub const VISITED: &str = "visited";
pub const FRONTIER: &str = "frontier";
pub const RESERVE: &str = "reserve";

/// `visited` — a plain `Region` set, insert-only, mirroring `GenState.visited` (a node is never
/// un-visited). `frontier`/`reserve` — `Region` sets mirroring `GenState.frontier`/`GenState.reserve`'s
/// membership (order doesn't carry meaning the way Recursive Backtracker's stack does, so `Region`
/// rather than `Sequence` — per explicit user decision, GitHub issue #143 discussion). `NodeVisited`
/// drives `visited` (insert), `frontier` (insert, since every visited node is pushed to the
/// frontier in the same step), and `reserve` (remove — a node that was queued via
/// `NodeQueuedToReserve` in an earlier step and only later gets connected, e.g. via
/// `step_from_frontier`'s `connected`/`free_preset`/teleport-connect targets, must leave `reserve`
/// even though no `ReserveCandidateChosen` fires for it; `Remove` on an id that was never actually
/// in `reserve` — the common case — is a no-op on the receiving side, mirroring
/// `EdgeBasedEvent::SrcExhausted`'s unconditional remove). `SrcChosenFromFrontier` removes its node
/// from `frontier` (just popped); `ReserveCandidateChosen` removes its node from `reserve` (just
/// popped, redundant with but emitted ahead of the same node's later `NodeVisited`);
/// `NodeQueuedToReserve` inserts into `reserve`; `ReserveCandidateRejected` (requeue branch)
/// re-inserts into `reserve`.
impl DebugValueDelta<NodeId> for VertexBasedEvent {
    fn debug_value_deltas(&self) -> Vec<(&'static str, DebugValueOp, NodeId)> {
        match self {
            VertexBasedEvent::NodeVisited { node, .. } => {
                vec![
                    (VISITED, DebugValueOp::Insert, *node),
                    (FRONTIER, DebugValueOp::Insert, *node),
                    (RESERVE, DebugValueOp::Remove, *node),
                ]
            }
            VertexBasedEvent::ReserveCandidateChosen { node } => {
                vec![(RESERVE, DebugValueOp::Remove, *node)]
            }
            VertexBasedEvent::ReserveCandidateRejected { node, already_visited: false } => {
                vec![(RESERVE, DebugValueOp::Insert, *node)]
            }
            VertexBasedEvent::NodeQueuedToReserve { node } => {
                vec![(RESERVE, DebugValueOp::Insert, *node)]
            }
            VertexBasedEvent::StartVisited { node } => {
                vec![(VISITED, DebugValueOp::Insert, *node), (FRONTIER, DebugValueOp::Insert, *node)]
            }
            VertexBasedEvent::SrcChosenFromFrontier { src, .. } => {
                vec![(FRONTIER, DebugValueOp::Remove, *src)]
            }
            VertexBasedEvent::SplitNodesCreated { nodes, .. } => {
                // Only the newly minted nodes (index 0 is `src`, already visited by whatever
                // brought it into this step) need a delta here — each is visited immediately.
                // Whether a given new node also enters `frontier` depends on whether the split
                // path actually connected it to anything this event, which is decided per-node
                // by the ordinary/pattern apply step and carried by that node's own `NodeVisited`
                // (or, for a zero-connection pattern node, this is its only delta: `VISITED` only).
                nodes.iter().skip(1).map(|n| (VISITED, DebugValueOp::Insert, *n)).collect()
            }
            _ => Vec::new(),
        }
    }
}

/// Static declaration of `CustomVertexBased`'s debug values (GitHub issue #131) — mirrors
/// `edge_based::debug_value_names()`. A static property of the algorithm, not derived from what a
/// particular run happened to emit.
pub fn debug_value_names() -> &'static [(&'static str, DebugValueKind)] {
    &[
        (VISITED, DebugValueKind::Region),
        (FRONTIER, DebugValueKind::Region),
        (RESERVE, DebugValueKind::Region),
    ]
}

/// Binary encoding for the WASM boundary (GitHub issue #124's format) — same conventions as
/// `EdgeBasedEvent`: `NodeId` is `u64` (8 little-endian bytes); `f64` fields are 8 little-endian
/// bytes; `usize` count-like fields are `u32` LE; `bool` fields are a single byte (`0`/`1`);
/// `Vec<NodeId>` payloads are a `u32` LE length prefix followed by that many `NodeId`s.
impl EncodeEventPayload for VertexBasedEvent {
    fn type_id(&self) -> u16 {
        match self {
            VertexBasedEvent::TeleportBridgeRolled { .. } => wire_tags::TELEPORT_BRIDGE_ROLLED,
            VertexBasedEvent::TeleportBridgeAdded { .. } => wire_tags::TELEPORT_BRIDGE_ADDED,
            VertexBasedEvent::ReserveCandidateRejected { .. } => wire_tags::RESERVE_CANDIDATE_REJECTED,
            VertexBasedEvent::ReserveCandidateChosen { .. } => wire_tags::RESERVE_CANDIDATE_CHOSEN,
            VertexBasedEvent::ReserveExhausted => wire_tags::RESERVE_EXHAUSTED,
            VertexBasedEvent::BridgeAdded { .. } => wire_tags::BRIDGE_ADDED,
            VertexBasedEvent::SrcChosenFromFrontier { .. } => wire_tags::SRC_CHOSEN_FROM_FRONTIER,
            VertexBasedEvent::TeleportRolled { .. } => wire_tags::TELEPORT_ROLLED,
            VertexBasedEvent::CyclicRolled { .. } => wire_tags::CYCLIC_ROLLED,
            VertexBasedEvent::CyclicCandidatesComputed { .. } => wire_tags::CYCLIC_CANDIDATES_COMPUTED,
            VertexBasedEvent::CyclicEdgeAdded { .. } => wire_tags::CYCLIC_EDGE_ADDED,
            VertexBasedEvent::CorridorRolled { .. } => wire_tags::CORRIDOR_ROLLED,
            VertexBasedEvent::CandidateChosen { .. } => wire_tags::CANDIDATE_CHOSEN,
            VertexBasedEvent::JunctionRollSetup { .. } => wire_tags::JUNCTION_ROLL_SETUP,
            VertexBasedEvent::JunctionSlotRolled { .. } => wire_tags::JUNCTION_SLOT_ROLLED,
            VertexBasedEvent::JunctionCandidatesChosen { .. } => wire_tags::JUNCTION_CANDIDATES_CHOSEN,
            VertexBasedEvent::EdgeAdded { .. } => wire_tags::EDGE_ADDED,
            VertexBasedEvent::PresetNeighborVisited { .. } => wire_tags::PRESET_NEIGHBOR_VISITED,
            VertexBasedEvent::TeleportConnectAdded { .. } => wire_tags::TELEPORT_CONNECT_ADDED,
            VertexBasedEvent::NodeVisited { .. } => wire_tags::NODE_VISITED,
            VertexBasedEvent::NodeQueuedToReserve { .. } => wire_tags::NODE_QUEUED_TO_RESERVE,
            VertexBasedEvent::StartVisited { .. } => wire_tags::START_VISITED,
            VertexBasedEvent::SingleCandidateSkipsDirectionality { .. } => wire_tags::SINGLE_CANDIDATE_SKIPS_DIRECTIONALITY,
            VertexBasedEvent::NoParentSkipsDirectionality { .. } => wire_tags::NO_PARENT_SKIPS_DIRECTIONALITY,
            VertexBasedEvent::DirectionalityRolled { .. } => wire_tags::DIRECTIONALITY_ROLLED,
            VertexBasedEvent::SplitRolled { .. } => wire_tags::SPLIT_ROLLED,
            VertexBasedEvent::SplitNodesCreated { .. } => wire_tags::SPLIT_NODES_CREATED,
            VertexBasedEvent::SplitCyclicRolled { .. } => wire_tags::SPLIT_CYCLIC_ROLLED,
            VertexBasedEvent::PatternAdaptationsComputed { .. } => wire_tags::PATTERN_ADAPTATIONS_COMPUTED,
            VertexBasedEvent::PatternAdaptationChosen { .. } => wire_tags::PATTERN_ADAPTATION_CHOSEN,
            VertexBasedEvent::SplitTeleportRolled { .. } => wire_tags::SPLIT_TELEPORT_ROLLED,
            VertexBasedEvent::SplitStartReassigned { .. } => wire_tags::SPLIT_START_REASSIGNED,
            VertexBasedEvent::SplitParentEdgeRelocated { .. } => wire_tags::SPLIT_PARENT_EDGE_RELOCATED,
        }
    }

    fn encode_payload(&self, out: &mut Vec<u8>) {
        fn push_ids(out: &mut Vec<u8>, ids: &[NodeId]) {
            out.extend_from_slice(&(ids.len() as u32).to_le_bytes());
            for id in ids {
                out.extend_from_slice(&id.to_le_bytes());
            }
        }

        match self {
            VertexBasedEvent::TeleportBridgeRolled { roll, teleport_chance, fired } => {
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&teleport_chance.to_le_bytes());
                out.push(if *fired { 1 } else { 0 });
            }
            VertexBasedEvent::TeleportBridgeAdded { src, dst, bidirectional } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
                out.push(if *bidirectional { 1 } else { 0 });
            }
            VertexBasedEvent::ReserveCandidateRejected { node, already_visited } => {
                out.extend_from_slice(&node.to_le_bytes());
                out.push(if *already_visited { 1 } else { 0 });
            }
            VertexBasedEvent::ReserveCandidateChosen { node } => {
                out.extend_from_slice(&node.to_le_bytes());
            }
            VertexBasedEvent::ReserveExhausted => {}
            VertexBasedEvent::BridgeAdded { src, dst, bidirectional } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
                out.push(if *bidirectional { 1 } else { 0 });
            }
            VertexBasedEvent::SrcChosenFromFrontier { src, frontier_len, position, depth_first } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&(*frontier_len as u32).to_le_bytes());
                out.extend_from_slice(&(*position as u32).to_le_bytes());
                out.extend_from_slice(&depth_first.to_le_bytes());
            }
            VertexBasedEvent::TeleportRolled { src, roll, teleport_chance, fired } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&teleport_chance.to_le_bytes());
                out.push(if *fired { 1 } else { 0 });
            }
            VertexBasedEvent::CyclicRolled { src, roll, cyclicity, fired } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&cyclicity.to_le_bytes());
                out.push(if *fired { 1 } else { 0 });
            }
            VertexBasedEvent::CyclicCandidatesComputed { src, geometric, candidates } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.push(if *geometric { 1 } else { 0 });
                push_ids(out, candidates);
            }
            VertexBasedEvent::CyclicEdgeAdded { src, dst, teleport, bidirectional } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
                out.push(if *teleport { 1 } else { 0 });
                out.push(if *bidirectional { 1 } else { 0 });
            }
            VertexBasedEvent::CorridorRolled { roll, corridor_chance, is_corridor } => {
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&corridor_chance.to_le_bytes());
                out.push(if *is_corridor { 1 } else { 0 });
            }
            VertexBasedEvent::CandidateChosen { src, dst, used_directionality } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
                out.push(if *used_directionality { 1 } else { 0 });
            }
            VertexBasedEvent::JunctionRollSetup { max } => {
                out.extend_from_slice(&(*max as u32).to_le_bytes());
            }
            VertexBasedEvent::JunctionSlotRolled { slot, roll, branching, taken } => {
                out.extend_from_slice(&(*slot as u32).to_le_bytes());
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&branching.to_le_bytes());
                out.push(if *taken { 1 } else { 0 });
            }
            VertexBasedEvent::JunctionCandidatesChosen { src, candidates } => {
                out.extend_from_slice(&src.to_le_bytes());
                push_ids(out, candidates);
            }
            VertexBasedEvent::EdgeAdded { src, dst, bidirectional } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
                out.push(if *bidirectional { 1 } else { 0 });
            }
            VertexBasedEvent::PresetNeighborVisited { src, dst } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
            }
            VertexBasedEvent::TeleportConnectAdded { src, dst, bidirectional } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&dst.to_le_bytes());
                out.push(if *bidirectional { 1 } else { 0 });
            }
            VertexBasedEvent::NodeVisited { node, parent } => {
                out.extend_from_slice(&node.to_le_bytes());
                out.extend_from_slice(&parent.to_le_bytes());
            }
            VertexBasedEvent::NodeQueuedToReserve { node } => {
                out.extend_from_slice(&node.to_le_bytes());
            }
            VertexBasedEvent::StartVisited { node } => {
                out.extend_from_slice(&node.to_le_bytes());
            }
            VertexBasedEvent::SingleCandidateSkipsDirectionality { node } => {
                out.extend_from_slice(&node.to_le_bytes());
            }
            VertexBasedEvent::NoParentSkipsDirectionality { node } => {
                out.extend_from_slice(&node.to_le_bytes());
            }
            VertexBasedEvent::DirectionalityRolled { roll, directionality, fired, straight_found } => {
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&directionality.to_le_bytes());
                out.push(if *fired { 1 } else { 0 });
                out.push(if *straight_found { 1 } else { 0 });
            }
            VertexBasedEvent::SplitRolled { src, roll, split_chance, fired, eligible } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&split_chance.to_le_bytes());
                out.push(if *fired { 1 } else { 0 });
                out.push(if *eligible { 1 } else { 0 });
            }
            VertexBasedEvent::SplitNodesCreated { src, nodes, pattern } => {
                out.extend_from_slice(&src.to_le_bytes());
                push_ids(out, nodes);
                out.push(if pattern.is_some() { 1 } else { 0 });
                out.extend_from_slice(&(pattern.unwrap_or(0) as u32).to_le_bytes());
            }
            VertexBasedEvent::SplitCyclicRolled { src, roll, cyclicity, fired } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&cyclicity.to_le_bytes());
                out.push(if *fired { 1 } else { 0 });
            }
            VertexBasedEvent::PatternAdaptationsComputed { src, pattern, count } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&(*pattern as u32).to_le_bytes());
                out.extend_from_slice(&(*count as u32).to_le_bytes());
            }
            VertexBasedEvent::PatternAdaptationChosen { src, pattern, rotation, mirror } => {
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&(*pattern as u32).to_le_bytes());
                out.extend_from_slice(&(*rotation as u32).to_le_bytes());
                out.push(if *mirror { 1 } else { 0 });
            }
            VertexBasedEvent::SplitTeleportRolled { roll, teleport_chance, fired, anchor } => {
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&teleport_chance.to_le_bytes());
                out.push(if *fired { 1 } else { 0 });
                out.push(if anchor.is_some() { 1 } else { 0 });
                out.extend_from_slice(&anchor.unwrap_or(0).to_le_bytes());
            }
            VertexBasedEvent::SplitStartReassigned { original, reassigned_to } => {
                out.extend_from_slice(&original.to_le_bytes());
                out.extend_from_slice(&reassigned_to.to_le_bytes());
            }
            VertexBasedEvent::SplitParentEdgeRelocated { parent, src, taken_by } => {
                out.extend_from_slice(&parent.to_le_bytes());
                out.extend_from_slice(&src.to_le_bytes());
                out.extend_from_slice(&taken_by.to_le_bytes());
            }
        }
    }
}

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
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    seed: u64,
    start: NodeId,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    start_reassignment: &mut Option<StartReassignment>,
    mut event_log: Option<&mut EventLog<VertexBasedEvent>>,
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
                start, start_reassignment, step_scope.as_mut(),
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
            start, start_reassignment, step_scope.as_mut(),
        );
    }
}

/// Runs `add_fn` (a `try_add_edge`/`try_add_edge_kind` call), then detects what actually happened
/// by comparing `graph.edge_between` in both directions before/after — the only way to know,
/// since those functions return `()` and a one-way coin flip may add `dst->src` instead of
/// `src->dst` (mirrors `edge_based::add_edge_and_detect_direction`, GitHub issue #144). Returns
/// `Some((from, to, bidirectional))` with the graph's actual direction when an edge was added,
/// `None` when the attempt was silently declined by a preset conflict.
pub(super) fn add_edge_and_detect_direction(
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

/// Bridges a new node into the maze when the frontier is empty — either via a teleport roll (a
/// hit replaces the step's entire mechanism: bridges via teleport instead of geometric adjacency)
/// or by popping a reachable candidate off `reserve`. Returns `false` when generation is done
/// (nothing left to bring in either way), `true` to keep looping.
#[allow(clippy::too_many_arguments)]
fn handle_empty_frontier<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
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
        let src = unvisited[state.rng.random_range(0..unvisited.len())];
        let visited_nodes: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|n| state.visited.contains(n))
            .collect();
        let bridge = visited_nodes[state.rng.random_range(0..visited_nodes.len())];

        let outcome = try_split_src(
            graph, field, ids, params, elements, split_config, preset_state, state,
            src, Some(bridge), None, start, start_reassignment, scope.as_deref_mut(),
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

    // Pop candidates from reserve until we find one with a visited neighbor.
    // Track seen candidates to avoid infinite cycling over nodes that are
    // not yet reachable (none of their neighbors are visited).
    let mut seen: HashSet<NodeId> = HashSet::new();
    let src = {
        let mut search_scope = scope.as_deref_mut().map(|log| log.enter("reserve_search"));
        let result = loop {
            let Some(candidate) = pop_reserve(&mut state.reserve, &mut state.in_reserve, params, &mut state.rng) else {
                break None;
            };
            if state.visited.contains(&candidate) {
                if let Some(g) = search_scope.as_mut() {
                    g.emit(VertexBasedEvent::ReserveCandidateRejected { node: candidate, already_visited: true });
                }
                continue;
            }
            if seen.contains(&candidate) { break None; }
            seen.insert(candidate);
            let has_visited_neighbor = field.neighbors(candidate)
                .into_iter()
                .any(|n| state.visited.contains(&n) && can_connect(n, candidate, preset_state));
            if has_visited_neighbor {
                if let Some(g) = search_scope.as_mut() {
                    g.emit(VertexBasedEvent::ReserveCandidateChosen { node: candidate });
                }
                break Some(candidate);
            }
            if let Some(g) = search_scope.as_mut() {
                g.emit(VertexBasedEvent::ReserveCandidateRejected { node: candidate, already_visited: false });
            }
            state.reserve.push(candidate);
            state.in_reserve.insert(candidate);
        };
        if result.is_none() {
            if let Some(g) = search_scope.as_mut() {
                g.emit(VertexBasedEvent::ReserveExhausted);
            }
        }
        result
    };
    let Some(src) = src else { return false; };
    let visited_neighbors: Vec<NodeId> = field.neighbors(src)
        .into_iter()
        .filter(|&n| state.visited.contains(&n) && can_connect(n, src, preset_state))
        .collect();
    let bridge = visited_neighbors[state.rng.random_range(0..visited_neighbors.len())];

    let outcome = try_split_src(
        graph, field, ids, params, elements, split_config, preset_state, state,
        src, Some(bridge), None, start, start_reassignment, scope.as_deref_mut(),
    );
    if outcome == SplitOutcome::Handled {
        return true;
    }

    let added = add_edge_and_detect_direction(graph, bridge, src, |g| try_add_edge(g, bridge, src, elements, preset_state, &mut state.rng));
    if let Some((from, to, bidirectional)) = added {
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::BridgeAdded { src: from, dst: to, bidirectional });
        }
    }
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
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
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
        src, None, parent, start, start_reassignment, scope.as_deref_mut(),
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
    field: &Field<T>,
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
    // Teleport roll happens immediately after src is fixed, before any geometric-neighbor
    // pool is built — a hit affects the cyclic-roll's candidate pool (below) and adds one
    // extra teleport connection alongside whatever the corridor/junction roll produces.
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

    let (cyclic_dst, teleport_spent_on_cycle) =
        roll_cyclic_edge(graph, field, params, preset_state, state, src, teleport_hit, scope.as_deref_mut());
    // Teleport still available for the corridor/junction step below unless the cyclic
    // roll already consumed it (it fired and found a candidate).
    let teleport_for_connect = teleport_hit && !teleport_spent_on_cycle;

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
}

/// Cyclic roll: if triggered, picks one visited neighbor and returns it as a cycle-edge target.
/// This happens regardless of free_neighbors availability. If a teleport was rolled for this src,
/// the candidate pool widens from "visited geometric neighbors" to "any visited node in the
/// graph" and the second return value is `true` (the teleport roll is considered "spent" on this
/// cyclic edge in that case, and must not also apply to the corridor/junction step).
fn roll_cyclic_edge<T: Tessellation>(
    graph: &Graph,
    field: &Field<T>,
    params: &GenerationParams,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    teleport_hit: bool,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> (Option<NodeId>, bool) {
    let cyclic_roll = state.rng.random::<f64>();
    let cyclic_fired = cyclic_roll < params.cyclicity;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::CyclicRolled { src, roll: cyclic_roll, cyclicity: params.cyclicity, fired: cyclic_fired });
    }
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
        if candidates.is_empty() {
            (None, false)
        } else {
            (Some(candidates[state.rng.random_range(0..candidates.len())]), true)
        }
    } else {
        let visited_neighbors: Vec<NodeId> = field.neighbors(src)
            .into_iter()
            .filter(|&n| state.visited.contains(&n) && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
            .collect();
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
    field: &Field<T>,
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

fn pop_reserve(
    reserve: &mut Vec<NodeId>,
    in_reserve: &mut HashSet<NodeId>,
    params: &GenerationParams,
    rng: &mut MazeRng,
) -> Option<NodeId> {
    if reserve.is_empty() { return None; }
    let idx = gaussian_weighted_index(reserve.len(), params.depth_first, rng);
    let node = reserve.remove(idx);
    in_reserve.remove(&node);
    Some(node)
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
    field: &'a Field<T>,
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

#[cfg(test)]
#[path = "vertex_based_tests.rs"]
mod tests;
