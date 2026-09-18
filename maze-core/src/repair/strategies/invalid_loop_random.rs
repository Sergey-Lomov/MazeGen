use super::cycle_cut_set::{
    PARAM_VERTICAL_PASSAGE_PRIORITY, VERTICAL_PASSAGE_NEUTRAL, VERTICAL_PASSAGE_PRIORITY_OPTIONS,
    apply_vertical_passage_priority, candidate_edges, discard_cycles_with_edge, edge_to_cycles_map,
};
use crate::Maze;
use crate::generation::PresetState;
use crate::ids::EdgeId;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::HashSet;

static PARAMS: &[StrategyParam] = &[StrategyParam {
    id: PARAM_VERTICAL_PASSAGE_PRIORITY,
    label: "Vertical passage priority",
    kind: StrategyParamKind::Enum {
        options: VERTICAL_PASSAGE_PRIORITY_OPTIONS,
        default: VERTICAL_PASSAGE_NEUTRAL,
    },
}];

pub struct InvalidLoopRandomStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidLoopIssue> for InvalidLoopRandomStrategy {
    fn strategy_id(&self) -> &'static str {
        "invalid_loop_random"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    /// Proof this is safe (see GitHub issue #105): `apply` reads `issue.all`/`issue.invalid`
    /// only through `apply_cuts`, which builds `owners = edge_to_cycles_map(all)` and seeds
    /// `pending` with exactly `invalid`'s indices. `discard_cycles_with_edge` only ever shrinks
    /// `pending` via `retain` — it never adds an index outside what `pending` already holds — so
    /// no valid-cycle entry in `owners` is ever read. `invalid_sources` isn't read at all. A
    /// re-indexed `all` containing only the invalid cycles produces the identical result — so the
    /// `VALID_CYCLES` layer is never needed.
    fn requirement(&self, _params: &StrategyParams) -> InvalidLoopRequirement {
        InvalidLoopRequirement::empty()
    }

    fn apply(
        &self,
        issue: &InvalidLoopIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let vertical_priority = match params.get(PARAM_VERTICAL_PASSAGE_PRIORITY) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => VERTICAL_PASSAGE_NEUTRAL,
        };
        let commands = apply_cuts(
            &issue.all,
            &issue.invalid,
            maze,
            rng,
            preset_state,
            vertical_priority,
        );
        let result = if issue.invalid.is_empty() || !commands.is_empty() {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

crate::impl_erased_repair_strategy!(InvalidLoopRandomStrategy, InvalidLoopIssue);

/// Builds the list of edge-removal commands for every pending cycle — never mutates `maze`
/// (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot contract). `already_cut` tracks,
/// locally to this call, every edge already proposed for removal so far (own direction and
/// reverse), standing in for what an earlier cut's real mutation would otherwise have made
/// observable through `maze.graph.edge`/`edge_between` under the old in-place contract.
fn apply_cuts<T: Tessellation>(
    all: &[Vec<EdgeId>],
    short: &[usize],
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    vertical_priority: &str,
) -> Vec<MutationCommand> {
    let owners = edge_to_cycles_map(all);
    let mut pending: Vec<usize> = short.to_vec();
    let mut already_cut: HashSet<EdgeId> = HashSet::new();
    let mut commands = Vec::new();

    while let Some(idx) = pending.pop() {
        let Some(cycle) = all.get(idx) else { continue };
        // Drop preset-protected and already-cut edges upfront so the random pick never wastes a sample on them.
        let candidates = candidate_edges(cycle, maze, preset_state, &already_cut);
        let mut candidates = apply_vertical_passage_priority(candidates, maze, vertical_priority);

        while !candidates.is_empty() {
            let pick = rng.random_range(0..candidates.len());
            let cut = candidates[pick];
            let (from, to) = {
                let edge = maze.graph.edge(cut).expect("checked above");
                (edge.from, edge.to)
            };
            if !preset_state.is_preset_edge(from, to) {
                let reverse_id = maze.graph.edge_between(to, from);
                match reverse_id {
                    Some(reverse_id) if !already_cut.contains(&reverse_id) => {
                        commands.push(MutationCommand::RemoveEdgeWithReverse { id: cut });
                        already_cut.insert(reverse_id);
                        discard_cycles_with_edge(&mut pending, &owners, reverse_id);
                    }
                    _ => commands.push(MutationCommand::RemoveEdge { id: cut }),
                }
                already_cut.insert(cut);
                discard_cycles_with_edge(&mut pending, &owners, cut);
                break;
            }
            // Protected after all (shouldn't happen given the upfront filter, but stay defensive) — retry with another edge.
            candidates.swap_remove(pick);
        }
    }
    commands
}

#[cfg(test)]
#[path = "invalid_loop_random_tests.rs"]
mod tests;
