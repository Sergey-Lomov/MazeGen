use super::dead_end_priority::apply_src_mode;
use super::remaining_deficits::RemainingDeficits;
use super::standard_add_params::{self, attempts_limit, reserve_target, src_mode};
use crate::Maze;
use crate::generation::PresetState;
use crate::generation::{cmd_add_bidirectional_edge, cmd_add_directed_edge};
use crate::ids::NodeId;
use crate::quality_control::{MissingLoopsIssue, RepairArea};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::HashSet;

pub const PARAM_ONE_WAY_CHANCE: &str = "loop_one_way_chance";

const ONE_WAY_CHANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ONE_WAY_CHANCE,
    label: "Loop one-way chance",
    kind: StrategyParamKind::Float {
        default: 0.0,
        min: 0.0,
        max: 100.0,
    },
};

static PARAMS: [StrategyParam; 4] = crate::add_strategy_params!(ONE_WAY_CHANCE_PARAM);

/// Handles `MISSING_LOOPS` — opposite approach from `InvalidLoopRandomStrategy`/
/// `InvalidLoopScoredStrategy`, which cut edges from existing bad loops. This strategy instead
/// seeds new connections at random, expecting a follow-up QC pass to discard whichever of them
/// don't end up forming a valid loop.
///
/// **`issue.data` is mandatory for this kind**: `missing` (how many loops short of the
/// requirement) has no other channel — the producing check (`MinLoopsCheck`, either `Absolute` or
/// `Ratio` mode) already computed it.
///
/// `loop_one_way_chance` (GitHub issue #217 follow-up) mirrors base-generation's own
/// `ElementsConfig::one_way_chance` coin-flip contract (`generation::edge_ops::add_edge_kind`) —
/// named distinctly from that field (and from `MissingTeleportsStrategy`'s own `one_way_chance`
/// param) since a `StrategyParam::id` is looked up by web i18n as a flat key with no
/// strategy-scoping, and a shared id would resolve to whichever strategy's label was registered,
/// not necessarily this one's. Per candidate pair, a `[0, 100)` roll below `loop_one_way_chance`
/// adds a single directed edge in a random direction instead of a full bidirectional passage — letting this strategy seed one-way
/// shortcuts (which QC's `CycleKind::OneWay` filter, see #217, can then evaluate) rather than
/// always producing fully bidirectional loops. Default `0.0` reproduces the pre-#217-follow-up
/// always-bidirectional behavior exactly.
///
/// `src_mode` (GitHub issue #254 follow-up, shared with `MissingLoopsSplitStrategy` via
/// `dead_end_priority`) — `dead_end_priority` orders the candidate pool so dead ends (nodes with
/// exactly one distinct graph neighbor) are tried first, so a fix grows out from the maze's
/// least-connected cells before an arbitrary one. Every other candidate stays in the pool behind
/// them (see GitHub issue #278's exhaustion-fallback audit — the original version dropped them
/// entirely, silently under-delivering once dead ends ran out), so exhausting the dead ends falls
/// through to the rest automatically. `src` is popped from the pool's end each iteration (not a
/// random index) specifically to preserve this ordering. Default `random` shuffles the whole pool
/// with no partition.
pub struct MissingLoopsRandomStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingLoopsIssue> for MissingLoopsRandomStrategy {
    fn strategy_id(&self) -> &'static str {
        "missing_loops_random"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
    }

    fn apply(
        &self,
        issue: &MissingLoopsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let one_way_chance = params
            .get(PARAM_ONE_WAY_CHANCE)
            .and_then(|v| v.as_float())
            .unwrap_or(0.0)
            / 100.0;
        let src_mode = src_mode(params);
        let max_failed_attempts = attempts_limit(params);

        // Pairs proposed as a bidirectional-edge command so far this call — stands in for what
        // an earlier real mutation would have made observable via `edge_between` under the old
        // in-place contract (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot contract).
        let mut proposed_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
        let mut commands = Vec::new();
        let mut total_added: u32 = 0;

        let mut deficits = RemainingDeficits::new(&issue.missing);
        let areas: Vec<RepairArea> = deficits.areas().collect();
        for area in areas {
            let missing = deficits.live(area);
            if missing == 0 {
                continue;
            }
            let target = reserve_target(params, missing);

            let candidates: Vec<NodeId> = maze
                .field
                .all_node_ids()
                .filter(|&n| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(n) == Some(level),
                })
                .collect();
            let mut pool: Vec<NodeId> = apply_src_mode(maze, candidates, src_mode, rng);
            let mut added: u32 = 0;
            // A popped `src` that yields no new edge counts against the budget; a successful one
            // does not (`attempts_limit`, GitHub issue #486).
            let mut failed_attempts: usize = 0;

            while added < target && !pool.is_empty() && failed_attempts < max_failed_attempts {
                // Pop from the end, not a random index — `apply_src_mode` orders the pool so
                // dead-end candidates sit at this end when `dead_end_priority` is active (GitHub
                // issue #278's exhaustion-fallback fix); a random-index pick would destroy that
                // ordering and re-introduce the original bug (falling through to the rest of the
                // pool only by accident, not by design). Every one of `src`'s neighbors is tried in
                // the inner loop below regardless of outcome, so `src` is never worth revisiting this
                // same call either way — popping it (success or failure) is correct, not just
                // convenient.
                let src = pool
                    .pop()
                    .expect("pool.is_empty() already checked by the while condition");
                let added_before = added;

                let mut neighbors = maze.field.neighbors(src);

                while !neighbors.is_empty() {
                    let n_pick = rng.random_range(0..neighbors.len());
                    let dst = neighbors.swap_remove(n_pick);

                    let already_connected = maze.graph.edge_between(src, dst).is_some()
                        || maze.graph.edge_between(dst, src).is_some()
                        || proposed_pairs.contains(&(src, dst))
                        || proposed_pairs.contains(&(dst, src));
                    if already_connected {
                        continue;
                    }
                    // Same RNG sample-consumption contract as `generation::edge_ops::add_edge_kind`:
                    // a one-way pair rolls the chance check then the direction (two samples), a
                    // bidirectional pair rolls only the chance check (one sample) — always rolled,
                    // regardless of which branch preset_state ends up permitting, so a later param
                    // change doesn't reorder RNG draws relative to earlier iterations of this loop.
                    if rng.random::<f64>() < one_way_chance {
                        let forward = rng.random::<bool>();
                        let (from, to) = if forward { (src, dst) } else { (dst, src) };
                        let cmds = cmd_add_directed_edge(from, to, preset_state);
                        if cmds.is_empty() {
                            continue;
                        }
                        commands.extend(cmds);
                    } else {
                        // Strictly bidirectional: skip the pair unless both directions are
                        // unblocked, rather than `can_connect`'s "at least one direction" contract.
                        let cmds = cmd_add_bidirectional_edge(src, dst, preset_state);
                        if cmds.is_empty() {
                            continue;
                        }
                        commands.extend(cmds);
                    }
                    proposed_pairs.insert((src, dst));
                    added += 1;
                    deficits.consume(&[area, RepairArea::WholeMaze]);
                    break;
                }
                if added == added_before {
                    failed_attempts += 1;
                }
            }
            total_added += added;
        }

        if total_added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(MissingLoopsRandomStrategy, MissingLoopsIssue);

#[cfg(test)]
#[path = "missing_loops_random_tests.rs"]
mod tests;
