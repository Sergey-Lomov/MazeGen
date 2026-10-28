use super::pool::Pool;
use super::remaining_deficits::RemainingDeficits;
use super::standard_add_params::{self, attempts_limit, reserve_target, src_mode};
use crate::Maze;
use crate::generation::PresetState;
use crate::ids::NodeId;
use crate::quality_control::{MissingElevatorsIssue, RepairArea};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::seq::SliceRandom;
use rand::{Rng, RngCore};

pub const PARAM_STOP_COUNT: &str = "stop_count";
pub const PARAM_SKIP: &str = "skip";
pub const PARAM_LENGTH: &str = "length_interval";

const STOP_COUNT_PARAM: StrategyParam = StrategyParam {
    id: PARAM_STOP_COUNT,
    label: "Stop count",
    kind: StrategyParamKind::Interval {
        default_min: 2.0,
        default_max: 10.0,
        min: 2.0,
        max: 1000.0,
    },
};
const SKIP_PARAM: StrategyParam = StrategyParam {
    id: PARAM_SKIP,
    label: "Skip",
    kind: StrategyParamKind::Interval {
        default_min: 0.0,
        default_max: 10.0,
        min: 0.0,
        max: 1000.0,
    },
};
const LENGTH_PARAM: StrategyParam = StrategyParam {
    id: PARAM_LENGTH,
    label: "Length interval",
    kind: StrategyParamKind::Interval {
        default_min: 3.0,
        default_max: 10.0,
        min: 1.0,
        max: 1000.0,
    },
};

static PARAMS: [StrategyParam; 6] =
    crate::add_strategy_params!(STOP_COUNT_PARAM, SKIP_PARAM, LENGTH_PARAM);

/// Handles `MISSING_ELEVATORS` (GitHub issue #401, epic #344) by building brand-new elevators, one
/// per deficit slot, each wired as a fully-connected two-way stop fan — same convention every other
/// elevator-consuming piece of code assumes (`elevator_core::Elevator`'s own doc comment,
/// `RemoveElevatorStrategy`/`ReplaceElevatorWithPassagesStrategy`).
///
/// Per slot: `PARAM_LENGTH` counts floors spanned **inclusively** (floors 1..3 = length 3), so the
/// geometric span used for index arithmetic is `length - 1`. `try_build_elevator` shuffles every
/// candidate length and, per length, every candidate base position, both in random order, and for
/// each combination computes the valid `PARAM_STOP_COUNT` range analytically from `PARAM_SKIP`
/// rather than guessing — this guarantees any geometrically feasible combination is eventually
/// tried instead of relying on a single blind random roll. `PARAM_SRC_MODE` (reusing
/// `dead_end_priority`'s shared helper per the issue's own reuse directive) orders the candidate
/// starting points so `dead_end_priority` grows elevators out from the maze's least-connected cells
/// first. Stops between the span's two endpoints are placed by `distribute_stops`, which draws an
/// independently random gap (within `PARAM_SKIP`'s range, 0 = adjacent floors) for each consecutive
/// stop pair via backtracking, so gaps aren't forced into a uniform/even spread; the two endpoint
/// floors are always included as stops.
///
/// **Infeasible slots don't abort the whole repair** — mirrors `MissingTeleportsStrategy`'s
/// `PARAM_ATTEMPTS_LIMIT` pattern: a slot retries up to `attempts_limit` times (new random start
/// point + span/stop-count roll each attempt), and a slot that never manages to build a fully valid
/// elevator (every planned stop's point free of an existing edge to every other planned stop, and
/// `preset_state`-feasible) is simply skipped, not the source of a `Failed` result — the whole
/// `apply()` call only reports `Failed` if literally zero elevators were built across every slot.
/// No partial/best-effort elevator is ever proposed: within one attempt, if the span can't fit the
/// rolled stop count under the rolled skip range, or any planned stop is infeasible, the whole
/// attempt is discarded and retried fresh, never patched up.
pub struct AddElevatorStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingElevatorsIssue> for AddElevatorStrategy {
    fn strategy_id(&self) -> &'static str {
        "add_elevator"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
    }

    fn apply(
        &self,
        issue: &MissingElevatorsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let (stop_count_min, stop_count_max) = params
            .get(PARAM_STOP_COUNT)
            .and_then(|v| v.as_interval())
            .unwrap_or((2.0, 10.0));
        let stop_count_min = stop_count_min.max(2.0).round() as usize;
        let stop_count_max = stop_count_max.max(stop_count_min as f64).round() as usize;
        let (skip_min, skip_max) = params
            .get(PARAM_SKIP)
            .and_then(|v| v.as_interval())
            .unwrap_or((0.0, 10.0));
        let skip_min = skip_min.max(0.0).round() as usize;
        let skip_max = skip_max.max(skip_min as f64).round() as usize;
        let (length_min, length_max) = params
            .get(PARAM_LENGTH)
            .and_then(|v| v.as_interval())
            .unwrap_or((3.0, 10.0));
        let length_min = length_min.max(1.0).round() as usize;
        let length_max = length_max.max(length_min as f64).round() as usize;
        let src_mode = src_mode(params);
        let attempts_limit = attempts_limit(params);

        let levels: Vec<_> = maze.field.levels_ordered().collect();
        if levels.len() < 2 {
            return (RepairResult::Failed, vec![]);
        }

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

            // `RepairArea::Level(level)` means the built elevator must actually stop on `level` —
            // resolved once per area since `levels` (hence the index) never changes mid-`apply`.
            // A level not found on the field (stale issue data) can never be satisfied; skip the
            // area rather than building an elevator that silently doesn't cover it.
            let required_idx = match area {
                RepairArea::WholeMaze => None,
                RepairArea::Level(level) => {
                    let Some(idx) = levels.iter().position(|&l| l == level) else {
                        continue;
                    };
                    Some(idx)
                }
            };

            let base_pool: Vec<NodeId> = maze.field.all_node_ids().collect();
            let mut pool = Pool::new(base_pool, src_mode, maze, rng);
            let mut added: u32 = 0;

            while added < target && !pool.is_empty() {
                let mut slot_filled = false;

                for _ in 0..attempts_limit {
                    let Some(start) = pool.take() else { break };

                    if let Some(stops) = try_build_elevator(
                        maze,
                        start,
                        &levels,
                        stop_count_min,
                        stop_count_max,
                        skip_min,
                        skip_max,
                        length_min,
                        length_max,
                        required_idx,
                        preset_state,
                        rng,
                    ) {
                        for i in 0..stops.len() {
                            for j in (i + 1)..stops.len() {
                                commands.push(MutationCommand::AddBidirectionalElevator {
                                    a: stops[i],
                                    b: stops[j],
                                });
                            }
                        }
                        added += 1;
                        slot_filled = true;
                        // `area` too (not just `WholeMaze`) -- a no-op when `area` already is
                        // `WholeMaze`, but required so a `RepairArea::Level`-scoped synthetic
                        // issue (see `add_elevator_stop`'s add-new branch) tracks real progress
                        // instead of looping until `attempts_limit`/pool exhaustion every time.
                        deficits.consume(&[RepairArea::WholeMaze, area]);
                        break;
                    }
                }

                if !slot_filled && pool.is_empty() {
                    break;
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

crate::impl_erased_repair_strategy!(AddElevatorStrategy, MissingElevatorsIssue);

/// One attempt to build a single elevator's stop set starting from `start`.
///
/// `PARAM_LENGTH` counts **floors spanned inclusively** (floors 1..3 = length 3), not the index
/// gap between the first and last stop — so the geometric span used everywhere below is
/// `length - 1`.
///
/// Rather than rolling span/base position/stop-count/gaps as one blind random combo and giving up
/// entirely on the first mismatch (which made tight/near-contradictory interval configs fail almost
/// always even though a valid combination exists), this walks every candidate length in
/// `length_min..=length_max` **in random order**, and for each length every candidate base position
/// **in random order**; the first length/base pair for which a valid stop count exists (computed
/// analytically from `span`/`skip`, not guessed) is used. Middle stops are then placed by evenly
/// distributing the span's floors across the chosen stop count (extra floors handed out to random
/// slots) — a distribution valid by construction, never itself a source of failure. Only a real
/// per-node conflict (existing edge between two planned stops, or preset infeasibility) can still
/// fail an attempt; every length/base combination that could geometrically work is tried before that
/// happens. Returns `None` only once every length/base combination has been exhausted.
#[allow(clippy::too_many_arguments)]
fn try_build_elevator<T: Tessellation>(
    maze: &Maze<T>,
    start: NodeId,
    levels: &[crate::space::LevelId],
    stop_count_min: usize,
    stop_count_max: usize,
    skip_min: usize,
    skip_max: usize,
    length_min: usize,
    length_max: usize,
    required_idx: Option<usize>,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<Vec<NodeId>> {
    let start_idx = maze.field.level_index_of(start)?;
    let point = maze.field.cell_of(start)?;

    let max_len_here = levels.len().min(length_max);
    if max_len_here < length_min {
        return None;
    }

    // A length shorter than the distance from `start` to `required_idx` can never span both --
    // skip it outright rather than let the `lo > hi` check below discard it per-base.
    let min_len_for_required = required_idx.map_or(0, |r| start_idx.abs_diff(r) + 1);

    let mut lengths: Vec<usize> = (length_min.max(min_len_for_required)..=max_len_here).collect();
    lengths.shuffle(rng);

    for length in lengths {
        let span = length - 1;
        let latest_start = levels.len() - 1 - span;
        let mut lo = start_idx.saturating_sub(span).max(0);
        let mut hi = start_idx.min(latest_start);
        if lo > hi {
            continue;
        }
        // Every base in `lo..=hi` must still leave `base_idx..=base_idx+span` covering
        // `required_idx` -- narrow the base range accordingly instead of relying on chance.
        if let Some(required_idx) = required_idx {
            lo = lo.max(required_idx.saturating_sub(span));
            hi = hi.min(required_idx);
            if lo > hi {
                continue;
            }
        }

        // Each of the `stop_count - 1` floor-index steps between stops is `skip + 1` (skip=0 means
        // adjacent floors). The step can range `step_min..=step_max` (`step_min = skip_min + 1`,
        // `step_max = skip_max + 1`), so `stop_count - 1` (the step count) must land in
        // `ceil(span / step_max)..=floor(span / step_min)` for `span` to be exactly coverable --
        // cap/floor `stop_count` from both ends accordingly.
        let step_min = skip_min + 1;
        let step_max = skip_max + 1;
        let max_stops_by_skip_min = span / step_min + 1;
        let min_stops_by_skip_max = span.div_ceil(step_max) + 1;
        let stop_count_cap = stop_count_max.min(span + 1).min(max_stops_by_skip_min);
        // A required floor that lands strictly inside the span (not on either endpoint, for at
        // least some base in `lo..=hi`) needs its own stop distinct from both endpoints, so the
        // floor is conservatively raised to 3 whenever `required_idx` is set at all -- some bases
        // in this length's range won't actually need the extra stop (required_idx lands on an
        // endpoint for them), but one extra stop is always a valid solution too, never a source of
        // failure, so this never wrongly rejects a length that could otherwise work.
        let min_for_required = if required_idx.is_some() {
            3
        } else {
            stop_count_min
        };
        let stop_count_floor = stop_count_min
            .max(min_stops_by_skip_max)
            .max(min_for_required);
        if stop_count_cap < stop_count_floor {
            continue;
        }
        let stop_count = if stop_count_floor == stop_count_cap {
            stop_count_floor
        } else {
            rng.random_range(stop_count_floor..=stop_count_cap)
        };

        let mut bases: Vec<usize> = (lo..=hi).collect();
        bases.shuffle(rng);

        for base_idx in bases {
            let end_idx = base_idx + span;
            // `required_idx` already falls within `base_idx..=end_idx` (guaranteed by the `lo`/`hi`
            // narrowing above); the endpoints are always stops by construction, so only pass it
            // through when it's a genuine interior floor that must additionally become a stop.
            let required_interior = required_idx.filter(|&r| r != base_idx && r != end_idx);
            let Some(floor_indices) = distribute_stops(
                base_idx,
                end_idx,
                stop_count,
                skip_min,
                skip_max,
                required_interior,
                rng,
            ) else {
                continue;
            };

            let stops: Option<Vec<NodeId>> = floor_indices
                .iter()
                .map(|&idx| maze.field.node_at(levels[idx], point))
                .collect();
            let Some(stops) = stops else { continue };

            if stops_feasible(maze, &stops, preset_state) {
                return Some(stops);
            }
        }
    }

    None
}

/// Places `stop_count` floor indices across `base_idx..=end_idx` (`stop_count >= 2`, endpoints
/// always included) by picking each of the `stop_count - 1` gaps independently at random within
/// `skip_min..=skip_max`, via backtracking — not an even split, so consecutive stops get genuinely
/// varied spacing instead of a near-uniform ladder. At each step the gap is drawn from a window
/// narrowed to what the *remaining* stops can still cover (so a greedy pick never strands the walk
/// short of `end_idx`); if a step still dead-ends (can happen since the window narrowing is
/// necessary but not sufficient — e.g. after landing exactly on `end_idx` early with stops still to
/// place), it backs up and retries the previous gap with a fresh random draw, capped at
/// `MAX_BACKTRACK_RETRIES` retries per step before giving up on this `stop_count` entirely.
/// Guaranteed to find a valid placement whenever one exists, since `try_build_elevator` already
/// proved `stop_count` is analytically reachable for this `span`/`skip` pair.
const MAX_BACKTRACK_RETRIES: usize = 50;

/// `required_interior`, when set, is a floor index strictly between `base_idx` and `end_idx` that
/// must itself become one of the returned stops — used when an elevator is being built to satisfy
/// a specific floor's deficit (`RepairArea::Level`), not just span the field. Implemented by
/// splitting into two independent sub-walks (`base_idx..=required_interior`,
/// `required_interior..=end_idx`) that share the required floor as their common endpoint, trying
/// every way to split `stop_count` between the two legs (each leg needs at least 2 stops -- its own
/// two endpoints) until one combination succeeds for both.
fn distribute_stops(
    base_idx: usize,
    end_idx: usize,
    stop_count: usize,
    skip_min: usize,
    skip_max: usize,
    required_interior: Option<usize>,
    rng: &mut dyn RngCore,
) -> Option<Vec<usize>> {
    if let Some(mid) = required_interior {
        // Each leg needs >= 2 stops (its own two endpoints); `mid` is shared between the legs and
        // counted once in `stop_count`, so `left_count + right_count == stop_count + 1`.
        if stop_count < 3 {
            return None;
        }
        let mut splits: Vec<usize> = (2..=stop_count - 1).collect();
        splits.shuffle(rng);
        for left_count in splits {
            let right_count = stop_count + 1 - left_count;
            if right_count < 2 {
                continue;
            }
            let Some(mut left) =
                distribute_stops(base_idx, mid, left_count, skip_min, skip_max, None, rng)
            else {
                continue;
            };
            let Some(right) =
                distribute_stops(mid, end_idx, right_count, skip_min, skip_max, None, rng)
            else {
                continue;
            };
            left.pop(); // drop `mid` from the left leg's tail -- `right` already starts with it
            left.extend(right);
            return Some(left);
        }
        return None;
    }

    // `skip` counts floors skipped, not the raw floor-index step -- skip=0 means adjacent floors
    // (index step 1), so the actual step is always `gap + 1`.
    let step_min = skip_min + 1;
    let step_max = skip_max + 1;

    let gaps_count = stop_count - 1;
    let mut floor_indices = vec![base_idx];
    let mut retries_at_depth = vec![0usize; gaps_count];
    let mut slot = 0usize;

    while slot < gaps_count {
        let cursor = *floor_indices.last().unwrap();
        let remaining_slots_after = gaps_count - slot - 1;
        let remaining_span = end_idx - cursor;

        // This step must leave enough room for every still-needed step to hit at least
        // `step_min`, and can't itself exceed what the *rest* can still cover at `step_max` per
        // remaining step.
        let max_step_here = remaining_span
            .saturating_sub(remaining_slots_after * step_min)
            .min(step_max);
        let min_step_here =
            step_min.max(remaining_span.saturating_sub(remaining_slots_after * step_max));

        if min_step_here > max_step_here || retries_at_depth[slot] >= MAX_BACKTRACK_RETRIES {
            // Dead end at this depth -- back up and let the previous step re-roll.
            if slot == 0 {
                return None;
            }
            retries_at_depth[slot] = 0;
            floor_indices.pop();
            slot -= 1;
            retries_at_depth[slot] += 1;
            continue;
        }

        let step = if min_step_here == max_step_here {
            min_step_here
        } else {
            rng.random_range(min_step_here..=max_step_here)
        };
        floor_indices.push(cursor + step);
        slot += 1;
    }

    Some(floor_indices)
}

fn stops_feasible<T: Tessellation>(
    maze: &Maze<T>,
    stops: &[NodeId],
    preset_state: &PresetState,
) -> bool {
    for i in 0..stops.len() {
        for j in (i + 1)..stops.len() {
            let (a, b) = (stops[i], stops[j]);
            if maze.graph.edge_between(a, b).is_some() || maze.graph.edge_between(b, a).is_some() {
                return false;
            }
            if !crate::generation::bidirectional_edge_feasible(preset_state, a, b) {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
#[path = "add_elevator_tests.rs"]
mod tests;
