use super::debug_state::DebugGenerationState;
use super::split_non_pattern::handle_non_pattern_split;
use super::split_pattern::SplitGenerationConfig;
use super::split_pattern_logic::handle_pattern_split;
use super::vertex_based::{GenState, VertexBasedEvent};
use super::{ElementsConfig, GenerationParams, PresetState};
use crate::event_log::ScopeGuard;
use crate::graph::Graph;
use crate::ids::{IdGenerator, NodeId};
use crate::space::{MultiLevelField, Tessellation};
use rand::Rng;

/// Result of a split attempt — a 3-way outcome (rather than a plain bool/`Option`) purely so unit
/// tests can assert *why* a split didn't happen without parsing the event log. Every variant other
/// than `Handled` means the caller must proceed exactly as it would have without this feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SplitOutcome {
    /// The split path fully handled `src` for this step — caller skips its own ordinary logic.
    Handled,
    /// The split roll missed.
    Miss,
    /// The roll hit, but `src`'s tile is not eligible for splitting at all (locked, or already
    /// pre-split via `split_points`).
    Ineligible,
    /// Pattern mode rolled a hit on an eligible node, but no pattern (or no adaptation of any
    /// pattern) could be found — falls back to ordinary handling exactly like a miss.
    NoAdaptation,
}

/// A run's start-node reassignment when the traversal-seed node itself gets split — `generate`
/// only ever receives a plain `start: NodeId` and has no notion of `Maze::meta`, so this is
/// threaded back out to the caller (`run_generate`/`run_generate_typed`) as an out-parameter,
/// applied only when there's no explicit `preset_start` pinning the original choice.
#[derive(Debug, Clone, Copy)]
pub struct StartReassignment {
    pub original: NodeId,
    pub reassigned_to: NodeId,
}

/// Whole-node eligibility gate, checked before any per-face logic: any lock at all disqualifies
/// splitting entirely (a lock pins down topology, a split shouldn't touch that tile at all), and a
/// point that already has more than one node (a pre-generation `split_points` declaration — the
/// only way a point could already be multi-node at generation time, post-edit splits happen after
/// generation) is never double-split.
pub(crate) fn split_is_eligible<T: Tessellation>(
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
    src: NodeId,
) -> bool {
    if preset_state.locked_out.contains(&src) || preset_state.locked_in.contains(&src) {
        return false;
    }
    let Some(level) = field.level_of(src) else {
        return false;
    };
    let Some(point) = field.cell_of(src) else {
        return false;
    };
    field.nodes_at(level, point).len() <= 1
}

/// Shared split-roll entry point, called from `step_from_frontier` and both `handle_empty_frontier`
/// branches. Rolls `split_chance` (always consumed, regardless of value — same RNG-parity
/// discipline as `teleport_chance`/`cyclicity`), then on a hit checks eligibility and dispatches to
/// the pattern or non-pattern path. `bridge` is the pre-existing already-visited node the ordinary
/// flow would unconditionally have connected `src` to this step (`None` from `step_from_frontier`,
/// `Some` from either `handle_empty_frontier` branch) — both split paths must honor that guarantee
/// instead of silently dropping it. `parent` is `src`'s real, already-in-graph incoming/outgoing
/// edge partner (`FrontierEntry.parent`, `Some` only from `step_from_frontier` — `handle_empty_frontier`'s
/// two branches pick `src` from `reserve`/a teleport-bridge pool, where no such edge exists yet)
/// — pattern mode's `enumerate_adaptations` treats a face resolving to `parent` specially: instead
/// of rejecting it as "targets an already-visited neighbor", it accepts the face only if its
/// requirement's direction matches the real edge already in `graph` (see that function's own doc
/// comment), and `apply_pattern_adaptation` then reuses the existing edge instead of adding a new
/// one.
#[allow(clippy::too_many_arguments)]
pub(super) fn try_split_src<T: Tessellation>(
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
    let roll = state.rng.random::<f64>();
    let fired = roll < elements.split_chance;
    let eligible = fired && split_is_eligible(field, preset_state, src);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitRolled {
            src,
            roll,
            split_chance: elements.split_chance,
            fired,
            eligible,
        });
    }
    if !fired {
        return SplitOutcome::Miss;
    }
    if !eligible {
        return SplitOutcome::Ineligible;
    }

    if split_config.pattern_mode {
        handle_pattern_split(
            graph,
            field,
            ids,
            params,
            elements,
            split_config,
            preset_state,
            state,
            src,
            bridge,
            parent,
            start,
            start_reassignment,
            scope,
            debug_state,
        )
    } else {
        handle_non_pattern_split(
            graph,
            field,
            ids,
            params,
            elements,
            split_config,
            preset_state,
            state,
            src,
            bridge,
            start,
            start_reassignment,
            scope,
            debug_state,
        );
        SplitOutcome::Handled
    }
}

#[cfg(test)]
#[path = "split_logic_test.rs"]
mod tests;
