use std::collections::HashMap;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};
use crate::generation::PresetState;
use crate::graph::gf2_basis::{GF2Basis, set_bit};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::cycle_cut_set::{
    edge_to_cycles_map, discard_cycles_with_edge, candidate_edges, apply_vertical_passage_priority,
    PARAM_VERTICAL_PASSAGE_PRIORITY, VERTICAL_PASSAGE_PRIORITY_OPTIONS, VERTICAL_PASSAGE_NEUTRAL,
};

pub const PARAM_INVALID_OVERLAP_WEIGHT: &str = "invalid_overlap_weight";
pub const PARAM_VALID_OVERLAP_WEIGHT: &str = "valid_overlap_weight";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_INVALID_OVERLAP_WEIGHT,
        label: "Shared invalid-loop weight",
        kind: StrategyParamKind::Float { default: 5.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_VALID_OVERLAP_WEIGHT,
        label: "Shared valid-loop penalty",
        kind: StrategyParamKind::Float { default: 6.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_VERTICAL_PASSAGE_PRIORITY,
        label: "Vertical passage priority",
        kind: StrategyParamKind::Enum { options: VERTICAL_PASSAGE_PRIORITY_OPTIONS, default: VERTICAL_PASSAGE_NEUTRAL },
    },
];

/// Handles INVALID_LOOP like `InvalidLoopRandomStrategy`, but picks which edge to cut
/// from each short cycle by score instead of uniformly at random. The score is currently just
/// the cycle-overlap term below, but the strategy is meant to grow more scoring terms over
/// time (à la `ScoredEndpointsStrategy`) — keep new criteria additive into the same score
/// rather than introducing a separate strategy per criterion.
///
/// For a candidate edge within the cycle being cut, `invalid_overlap` counts how many *other*
/// invalid cycles (also in `invalid`) also contain that edge — raw, uncorrected: every
/// invalid-cycle intersection is a real win regardless of linear dependence between invalid
/// cycles, since `invalid` already names the concrete cycles that must be broken. `valid_overlap`
/// counts how many valid cycles a candidate edge would break, but — since GitHub issue #284 —
/// only against the GF(2) independent basis of the valid subset of `all`, not every valid cycle:
/// a naive raw count overstates an edge's real impact when several valid cycles sharing it are
/// linearly dependent (cutting it can never reduce the valid subset's independent-cycle count by
/// more than its basis membership implies). Score is
/// `invalid_overlap * invalid_overlap_weight - valid_overlap * valid_overlap_weight`; the
/// highest-scoring candidate is cut. This biases cuts toward edges that simultaneously break
/// several invalid loops (fewer total cuts needed) while avoiding edges that would also break a
/// cycle the maze is meant to keep.
pub struct InvalidLoopScoredStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidLoopIssue> for InvalidLoopScoredStrategy {
    fn strategy_id(&self) -> &'static str { "invalid_loop_scored" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    /// Needs every valid cycle, not just invalid ones — `apply` walks the full `all` to compute
    /// `valid_overlap` (how many valid cycles a candidate edge would also break), so
    /// `VALID_CYCLES` is required by the algorithm itself, not left set out of inertia.
    fn requirement(&self, _params: &StrategyParams) -> InvalidLoopRequirement {
        InvalidLoopRequirement::VALID_CYCLES
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
        let (all, invalid) = (&issue.all, &issue.invalid);

        let invalid_overlap_weight = params.get(PARAM_INVALID_OVERLAP_WEIGHT).and_then(|v| v.as_float()).unwrap_or(5.0);
        let valid_overlap_weight = params.get(PARAM_VALID_OVERLAP_WEIGHT).and_then(|v| v.as_float()).unwrap_or(6.0);
        let vertical_priority = match params.get(PARAM_VERTICAL_PASSAGE_PRIORITY) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => VERTICAL_PASSAGE_NEUTRAL,
        };

        // edge -> (how many invalid cycles contain it, how many *basis* valid cycles contain it)
        let invalid_set: std::collections::HashSet<usize> = invalid.iter().copied().collect();
        let valid_basis_indices = valid_cycle_basis_indices(all, &invalid_set);
        let mut overlap: HashMap<EdgeId, (u32, u32)> = HashMap::new();
        for (idx, cycle) in all.iter().enumerate() {
            let is_invalid = invalid_set.contains(&idx);
            let is_valid_basis_member = !is_invalid && valid_basis_indices.contains(&idx);
            for &eid in cycle {
                let entry = overlap.entry(eid).or_insert((0, 0));
                if is_invalid { entry.0 += 1; }
                if is_valid_basis_member { entry.1 += 1; }
            }
        }

        let owners = edge_to_cycles_map(all);
        let mut pending: Vec<usize> = invalid.to_vec();
        let mut already_cut: std::collections::HashSet<EdgeId> = std::collections::HashSet::new();
        let mut commands = Vec::new();

        while let Some(idx) = pending.pop() {
            let Some(cycle) = all.get(idx) else { continue };
            if let Some((cut, reverse)) = apply_cut(cycle, &overlap, invalid_overlap_weight, valid_overlap_weight, maze, rng, preset_state, &already_cut, vertical_priority, &mut commands) {
                already_cut.insert(cut);
                discard_cycles_with_edge(&mut pending, &owners, cut);
                if let Some(reverse) = reverse {
                    already_cut.insert(reverse);
                    discard_cycles_with_edge(&mut pending, &owners, reverse);
                }
            }
        }

        let result = if invalid.is_empty() || !commands.is_empty() {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

crate::impl_erased_repair_strategy!(InvalidLoopScoredStrategy, InvalidLoopIssue);

/// GitHub issue #284: returns the indices (into `all`) of a GF(2) independent basis of the
/// valid subset of `all` (every index not in `invalid_set`) — used so `valid_overlap` reflects
/// real independent-cycle-count impact instead of raw (possibly linearly-dependent) overlap.
///
/// `EdgeId` is not a dense index (arbitrary values, not 0..N), so this builds its own local
/// dense remap (`EdgeId -> bit position`) over the `EdgeId`s actually appearing in the valid
/// subset, then runs each valid cycle through `GF2Basis::try_insert` as a bit-vector under that
/// remap. No canonical (forward/reverse) edge merging is applied here, unlike `cycles.rs`'s
/// nav-edge-index basis — this domain is base-`Graph` `EdgeId`s, where a forward and reverse
/// edge are already two distinct `EdgeId`s with no automatic pairing, and the penalty is about
/// concrete cut `EdgeId`s, not physical corridors, so no such merging is needed or wanted here.
fn valid_cycle_basis_indices(all: &[Vec<EdgeId>], invalid_set: &std::collections::HashSet<usize>) -> std::collections::HashSet<usize> {
    let mut remap: HashMap<EdgeId, usize> = HashMap::new();
    for (idx, cycle) in all.iter().enumerate() {
        if invalid_set.contains(&idx) {
            continue;
        }
        for &eid in cycle {
            let next = remap.len();
            remap.entry(eid).or_insert(next);
        }
    }

    let bit_count = remap.len().max(1);
    let words_per_row = bit_count.div_ceil(64).max(1);
    let mut gf2 = GF2Basis::new(bit_count);
    let mut basis_indices = std::collections::HashSet::new();
    for (idx, cycle) in all.iter().enumerate() {
        if invalid_set.contains(&idx) {
            continue;
        }
        let bits = set_bit(words_per_row, cycle.iter().map(|eid| remap[eid]));
        if gf2.try_insert(bits) {
            basis_indices.insert(idx);
        }
    }
    basis_indices
}

/// Pure scoring formula, kept standalone so new terms can be unit-tested in isolation as the
/// strategy grows (see the struct-level doc comment on why this is meant to be additive).
/// `invalid_overlap`/`valid_overlap` are the counts from the `overlap` map for one candidate edge.
fn score(invalid_overlap: u32, valid_overlap: u32, invalid_overlap_weight: f64, valid_overlap_weight: f64) -> f64 {
    invalid_overlap as f64 * invalid_overlap_weight - valid_overlap as f64 * valid_overlap_weight
}

/// Returns `(cut, reverse)` on success — `cut` is the removed edge's own id, `reverse` is its
/// opposite-direction id when that leg was also removed (`RemoveEdgeWithReverse`, GitHub issue
/// #185), `None` when only `cut` itself was removed (`RemoveEdge`). Both pushed onto `commands`.
/// The caller must drop any other pending cycle sharing *either* id (see
/// `discard_cycles_with_edge`) — a cycle that only traverses the reverse leg of the same physical
/// corridor is broken by this cut too. `None` (outer) means every candidate was protected.
/// Never mutates `maze` (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot contract);
/// `already_cut` stands in for what an earlier real mutation would have made observable.
#[allow(clippy::too_many_arguments)]
fn apply_cut<T: Tessellation>(
    cycle: &[EdgeId],
    overlap: &HashMap<EdgeId, (u32, u32)>,
    invalid_overlap_weight: f64,
    valid_overlap_weight: f64,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    already_cut: &std::collections::HashSet<EdgeId>,
    vertical_priority: &str,
    commands: &mut Vec<MutationCommand>,
) -> Option<(EdgeId, Option<EdgeId>)> {
    // Drop preset-protected and already-cut edges upfront, same as InvalidLoopRandomStrategy.
    let candidates = candidate_edges(cycle, maze, preset_state, already_cut);
    let mut candidates = apply_vertical_passage_priority(candidates, maze, vertical_priority);

    while !candidates.is_empty() {
        // This cycle's own membership counts toward `invalid_overlap`/`valid_overlap` too — it's
        // always in `invalid`, so every candidate gets +1 invalid_overlap from itself. That's a
        // constant offset shared by every candidate in this cycle, so it doesn't affect which
        // one scores highest; left in rather than special-cased for simplicity.
        //
        // A bidirectional corridor is two distinct `EdgeId`s (forward and `edge_between`'s
        // reverse) — two cycles sharing that corridor but each traversing it in the opposite
        // direction land on different `EdgeId`s in `overlap`, so a raw per-id lookup would miss
        // that they actually share a cut. Cutting `id` always also cuts its reverse (see the
        // `RemoveEdgeWithReverse` dispatch below), so a candidate's real overlap is its own
        // entry's plus its reverse's.
        let scores: Vec<f64> = candidates.iter()
            .map(|&id| {
                let (invalid_overlap, valid_overlap) = overlap.get(&id).copied().unwrap_or((0, 0));
                let reverse_overlap = maze.graph.edge(id)
                    .and_then(|edge| maze.graph.edge_between(edge.to, edge.from))
                    .filter(|&rev| rev != id)
                    .and_then(|rev| overlap.get(&rev))
                    .copied()
                    .unwrap_or((0, 0));
                let invalid_overlap = invalid_overlap + reverse_overlap.0;
                let valid_overlap = valid_overlap + reverse_overlap.1;
                score(invalid_overlap, valid_overlap, invalid_overlap_weight, valid_overlap_weight)
            })
            .collect();
        let best_score = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);

        let best_indices: Vec<usize> = scores.iter().enumerate()
            .filter(|&(_, &s)| s == best_score)
            .map(|(i, _)| i)
            .collect();

        let pick = best_indices[rng.random_range(0..best_indices.len())];
        let cut = candidates[pick];
        let (from, to) = {
            let edge = maze.graph.edge(cut).expect("checked above");
            (edge.from, edge.to)
        };
        if !preset_state.is_preset_edge(from, to) {
            let reverse_id = maze.graph.edge_between(to, from).filter(|&rev| rev != cut);
            let reverse_actually_removed = match reverse_id {
                Some(reverse_id) if !already_cut.contains(&reverse_id) => {
                    commands.push(MutationCommand::RemoveEdgeWithReverse { id: cut });
                    Some(reverse_id)
                }
                _ => {
                    commands.push(MutationCommand::RemoveEdge { id: cut });
                    None
                }
            };
            return Some((cut, reverse_actually_removed));
        }
        // Protected after all (shouldn't happen given the upfront filter, but stay defensive).
        candidates.swap_remove(pick);
    }
    None
}


#[cfg(test)]
#[path = "invalid_loop_scored_tests.rs"]
mod tests;
