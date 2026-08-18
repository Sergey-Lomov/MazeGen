use rand::{Rng, RngCore};
use rand::seq::SliceRandom;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::{MissingElevatorsIssue, RepairArea};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::remaining_deficits::RemainingDeficits;
use super::dead_end_priority::{apply_src_mode, PARAM_SRC_MODE, SRC_MODE_RANDOM, SRC_MODE_OPTIONS};

pub const PARAM_STOP_COUNT: &str = "stop_count";
pub const PARAM_SKIP: &str = "skip";
pub const PARAM_LENGTH: &str = "length_interval";
pub const PARAM_ATTEMPTS_LIMIT: &str = "attempts_limit";
pub const PARAM_RESERVE_PERCENT: &str = "reserve_percent";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_STOP_COUNT,
        label: "Stop count",
        kind: StrategyParamKind::Interval { default_min: 2.0, default_max: 10.0, min: 2.0, max: 1000.0 },
    },
    StrategyParam {
        id: PARAM_SKIP,
        label: "Skip",
        kind: StrategyParamKind::Interval { default_min: 0.0, default_max: 10.0, min: 0.0, max: 1000.0 },
    },
    StrategyParam {
        id: PARAM_LENGTH,
        label: "Length interval",
        kind: StrategyParamKind::Interval { default_min: 3.0, default_max: 10.0, min: 1.0, max: 1000.0 },
    },
    StrategyParam {
        id: PARAM_SRC_MODE,
        label: "Position selection",
        kind: StrategyParamKind::Enum { options: SRC_MODE_OPTIONS, default: SRC_MODE_RANDOM },
    },
    StrategyParam {
        id: PARAM_ATTEMPTS_LIMIT,
        label: "Attempts limit",
        kind: StrategyParamKind::Float { default: 20.0, min: 1.0, max: 1000.0 },
    },
    StrategyParam {
        id: PARAM_RESERVE_PERCENT,
        label: "Reserve percent",
        kind: StrategyParamKind::Float { default: 0.0, min: 0.0, max: 500.0 },
    },
];

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
    fn strategy_id(&self) -> &'static str { "add_elevator" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
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

        let (stop_count_min, stop_count_max) = params.get(PARAM_STOP_COUNT).and_then(|v| v.as_interval()).unwrap_or((2.0, 10.0));
        let stop_count_min = stop_count_min.max(2.0).round() as usize;
        let stop_count_max = stop_count_max.max(stop_count_min as f64).round() as usize;
        let (skip_min, skip_max) = params.get(PARAM_SKIP).and_then(|v| v.as_interval()).unwrap_or((0.0, 10.0));
        let skip_min = skip_min.max(0.0).round() as usize;
        let skip_max = skip_max.max(skip_min as f64).round() as usize;
        let (length_min, length_max) = params.get(PARAM_LENGTH).and_then(|v| v.as_interval()).unwrap_or((3.0, 10.0));
        let length_min = length_min.max(1.0).round() as usize;
        let length_max = length_max.max(length_min as f64).round() as usize;
        let src_mode = match params.get(PARAM_SRC_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => SRC_MODE_RANDOM,
        };
        let attempts_limit = params.get(PARAM_ATTEMPTS_LIMIT).and_then(|v| v.as_float()).map(|f| f.round().max(1.0) as usize).unwrap_or(20);
        let reserve_percent = params.get(PARAM_RESERVE_PERCENT).and_then(|v| v.as_float()).unwrap_or(0.0);

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
            let target = (missing as f64 * (1.0 + reserve_percent / 100.0)).ceil() as u32;
            let target = target.max(1);

            let base_pool: Vec<NodeId> = maze.field.all_node_ids().collect();
            let mut pool = apply_src_mode(maze, base_pool, src_mode, rng);
            let mut added: u32 = 0;

            while added < target && !pool.is_empty() {
                let mut slot_filled = false;

                for _ in 0..attempts_limit {
                    if pool.is_empty() {
                        break;
                    }
                    let start = pool.pop().unwrap();

                    if let Some(stops) = try_build_elevator(
                        maze, start, &levels, stop_count_min, stop_count_max,
                        skip_min, skip_max, length_min, length_max, preset_state, rng,
                    ) {
                        for i in 0..stops.len() {
                            for j in (i + 1)..stops.len() {
                                commands.push(MutationCommand::AddBidirectionalElevator { a: stops[i], b: stops[j] });
                            }
                        }
                        added += 1;
                        slot_filled = true;
                        deficits.consume(&[RepairArea::WholeMaze]);
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
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<Vec<NodeId>> {
    let start_idx = maze.field.level_index_of(start)?;
    let point = maze.field.point_of(start)?;

    let max_len_here = levels.len().min(length_max);
    if max_len_here < length_min {
        return None;
    }

    let mut lengths: Vec<usize> = (length_min..=max_len_here).collect();
    lengths.shuffle(rng);

    for length in lengths {
        let span = length - 1;
        let latest_start = levels.len() - 1 - span;
        let lo = start_idx.saturating_sub(span).max(0);
        let hi = start_idx.min(latest_start);
        if lo > hi {
            continue;
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
        let stop_count_floor = stop_count_min.max(min_stops_by_skip_max);
        if stop_count_cap < stop_count_floor {
            continue;
        }
        let stop_count = if stop_count_floor == stop_count_cap { stop_count_floor } else { rng.random_range(stop_count_floor..=stop_count_cap) };

        let mut bases: Vec<usize> = (lo..=hi).collect();
        bases.shuffle(rng);

        for base_idx in bases {
            let end_idx = base_idx + span;
            let Some(floor_indices) = distribute_stops(base_idx, end_idx, stop_count, skip_min, skip_max, rng) else { continue };

            let stops: Option<Vec<NodeId>> = floor_indices.iter()
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

fn distribute_stops(base_idx: usize, end_idx: usize, stop_count: usize, skip_min: usize, skip_max: usize, rng: &mut dyn RngCore) -> Option<Vec<usize>> {
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
        let max_step_here = remaining_span.saturating_sub(remaining_slots_after * step_min).min(step_max);
        let min_step_here = step_min.max(remaining_span.saturating_sub(remaining_slots_after * step_max));

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

        let step = if min_step_here == max_step_here { min_step_here } else { rng.random_range(min_step_here..=max_step_here) };
        floor_indices.push(cursor + step);
        slot += 1;
    }

    Some(floor_indices)
}

fn stops_feasible<T: Tessellation>(maze: &Maze<T>, stops: &[NodeId], preset_state: &PresetState) -> bool {
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
mod tests {
    use super::*;
    use std::collections::HashMap;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, SquarePoint, square_rect, MultiLevelField, Field};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::quality_control::checks::elevator_core::elevator_groups;

    fn no_params() -> StrategyParams {
        build_params(<AddElevatorStrategy as RepairStrategy<SquareTessellation, MissingElevatorsIssue>>::params(&AddElevatorStrategy), None)
    }

    fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
        let mut map = HashMap::new();
        for &(k, v) in overrides {
            map.insert(k.to_string(), v.to_string());
        }
        build_params(<AddElevatorStrategy as RepairStrategy<SquareTessellation, MissingElevatorsIssue>>::params(&AddElevatorStrategy), Some(&map))
    }

    fn multi_floor_maze(floors: usize, side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        for _ in 0..floors {
            mf.add_level(Field::<SquareTessellation>::new(square_rect(side, side), &mut ids).unwrap());
        }
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        Maze::new(mf, g)
    }

    fn missing_issue(missing: u32) -> MissingElevatorsIssue {
        let entries = if missing == 0 { vec![] } else { vec![(RepairArea::WholeMaze, missing)] };
        MissingElevatorsIssue::new_from_check("min_elevator_count", entries)
    }

    #[test]
    fn apply_succeeds_immediately_when_nothing_missing() {
        let mut maze = multi_floor_maze(5, 3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(&AddElevatorStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_builds_an_elevator_spanning_multiple_floors() {
        let mut maze = multi_floor_maze(6, 3);
        let issue = missing_issue(1);
        let params = params_with(&[("reserve_percent", "0")]);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&AddElevatorStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        assert_eq!(groups.len(), 1);
        assert!(groups[0].stops.len() >= 2);
        for edge in maze.graph.edges() {
            assert_eq!(edge.kind, EdgeKind::Elevator);
        }
    }

    #[test]
    fn apply_builds_a_fully_connected_fan_between_every_stop_pair() {
        let mut maze = multi_floor_maze(6, 3);
        let issue = missing_issue(1);
        let params = params_with(&[("stop_count", "4,4"), ("length_interval", "5,5"), ("skip", "0,10"), ("reserve_percent", "0")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&AddElevatorStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].stops.len(), 4, "stop_count pinned to 4");
        // Fully-connected fan of 4 stops -> 6 unordered pairs -> 12 directed edges.
        assert_eq!(maze.graph.edges().count(), 12);
    }

    #[test]
    fn apply_respects_the_length_range_as_the_stop_floor_span() {
        let mut maze = multi_floor_maze(8, 3);
        let issue = missing_issue(1);
        let params = params_with(&[("length_interval", "3,3"), ("stop_count", "2,2"), ("reserve_percent", "0")]);
        let mut rng = MazeRng::seed_from_u64(3);
        let result = apply_and_commit(&AddElevatorStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        assert_eq!(groups.len(), 1);
        let floors: Vec<usize> = groups[0].stops.iter().filter_map(|&n| maze.field.level_index_of(n)).collect();
        let span = floors.iter().max().unwrap() - floors.iter().min().unwrap();
        assert_eq!(span, 2, "length=3 counts floors inclusively, so the index span is length-1=2");
    }

    #[test]
    fn apply_fails_on_a_single_level_field() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&AddElevatorStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_fails_when_the_field_has_too_few_floors_for_the_configured_length_minimum() {
        let mut maze = multi_floor_maze(2, 3);
        let issue = missing_issue(1);
        let params = params_with(&[("length_interval", "5,10")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&AddElevatorStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed), "2 floors can never satisfy a length minimum of 5");
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn attempts_limit_failure_on_one_slot_does_not_abort_remaining_slots() {
        let mut maze = multi_floor_maze(6, 3);
        // Lock out every node except one point's column -- most random starts fail outright
        // (their own point's fan gets blocked), forcing attempts_limit exhaustion on some slots
        // while the surviving column still lets others succeed.
        let survivor_point = SquarePoint { x: 0, y: 0 };
        let mut preset_state = PresetState::empty();
        for level in maze.field.levels_ordered().collect::<Vec<_>>() {
            for node in maze.field.field_of(level).unwrap().all_points().filter_map(|p| {
                if p == survivor_point { None } else { maze.field.node_at(level, p) }
            }) {
                preset_state.locked_out.insert(node);
            }
        }

        let issue = missing_issue(3);
        let params = params_with(&[("reserve_percent", "0"), ("attempts_limit", "2")]);
        let mut rng = MazeRng::seed_from_u64(9);
        let result = apply_and_commit(&AddElevatorStrategy, &issue, &mut maze, &mut rng, &params, &preset_state, &[]);
        // Only one point's column is ever feasible, so at most 1 elevator can ever be built
        // (a second attempt on the same column always collides with the first's edges) -- the
        // point is that this still reports Fixed (not Failed) rather than aborting everything.
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(!elevator_groups(&maze).is_empty());
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = multi_floor_maze(6, 3);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit(&AddElevatorStrategy, &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &[]);

        let mut maze_b = multi_floor_maze(6, 3);
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit(&AddElevatorStrategy, &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &[]);

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }

    #[test]
    fn distribute_stops_places_endpoints_and_keeps_every_gap_in_the_skip_range() {
        // step in 1..=3 (skip 0..=2), 4 stops across a span of 9 -- multiple gap combinations are
        // valid, so different seeds exercise different backtracking paths through the same call.
        for seed in 0..30u64 {
            let mut rng = MazeRng::seed_from_u64(seed);
            let indices = distribute_stops(0, 9, 4, 0, 2, &mut rng).expect("a valid placement always exists for this span/stop_count/skip combo");
            assert_eq!(indices.len(), 4);
            assert_eq!(indices[0], 0, "first stop is always the base index");
            assert_eq!(*indices.last().unwrap(), 9, "last stop always lands exactly on the end index");
            for pair in indices.windows(2) {
                let step = pair[1] - pair[0];
                assert!((1..=3).contains(&step), "seed {seed}: step {step} outside the skip-derived 1..=3 range");
            }
        }
    }

    #[test]
    fn distribute_stops_returns_none_when_the_span_is_geometrically_unreachable() {
        // step fixed at exactly 1 (skip 0..=0), but a span of 5 can't be split into 2 gaps of 1 each.
        let mut rng = MazeRng::seed_from_u64(1);
        assert_eq!(distribute_stops(0, 5, 3, 0, 0, &mut rng), None);
    }

    #[test]
    fn reserve_percent_zero_builds_exactly_the_missing_count() {
        let mut maze = multi_floor_maze(10, 4);
        let issue = missing_issue(2);
        let params = params_with(&[("reserve_percent", "0"), ("length_interval", "2,2"), ("stop_count", "2,2")]);
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(&AddElevatorStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        assert_eq!(groups.len(), 2, "reserve_percent=0 must build exactly the 2 missing elevators, not more");
    }
}
