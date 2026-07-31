use rand::{Rng, RngCore};
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::Issue;
use crate::generation::PresetState;
use super::params::build_params;
use super::result::RepairResult;
use super::strategy::NestedStrategyConfig;
use super::command::MutationCommand;

// `dispatch_weighted` operates at the erased boundary — nested candidates (`NestedStrategyConfig`)
// hold `Box<dyn ErasedRepairStrategy<T>>`, whose own kind may differ from the caller's own `I`
// (see `Specs/repair.md`'s nested-strategy contract) — so `issue` here is always `&dyn Issue`.

/// One nested-strategy candidate paired with its selection weight. The weight's meaning and
/// resolution (e.g. reading a `"weight"` key out of `config.param_overrides`) belongs entirely
/// to the caller — `dispatch_weighted` itself carries no convention for how a weight is derived,
/// only what it does with an already-resolved one.
pub struct WeightedCandidate<'a, T: Tessellation> {
    pub config: &'a NestedStrategyConfig<T>,
    pub weight: f64,
}

/// Tries `candidates` in weighted-random order, without replacement, until one succeeds
/// (`Fixed`) or every candidate has been tried and failed. See `Specs/repair.md`'s "Nested
/// strategies" section for the general nested-dispatch contract this builds on; this helper adds
/// weighted selection and failure-retry on top of it — issue #90.
///
/// **Weight contract**: every `weight` must be finite and `> 0.0` — the caller's responsibility;
/// `debug_assert!`-checked defensively on entry, never silently substituted. Empty `candidates`
/// returns `Failed` immediately without touching `rng`.
///
/// **Owns `StrategyParams` construction**: for each attempt, builds the nested strategy's
/// `StrategyParams` from `config.strategy.params()` and `config.param_overrides` — callers pass
/// raw `NestedStrategyConfig`s, never pre-built `StrategyParams`.
///
/// **No rollback bookkeeping needed** (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot
/// contract): every attempt is called against the same immutable `&Maze` — nothing mutates the
/// real graph mid-call, so a `Failed` candidate's returned commands are simply discarded (never
/// concatenated); the next weighted pick tries again against the identical unmutated snapshot. A
/// `Fixed` candidate's commands are returned as-is.
///
/// **Recursion**: each attempt is called with `&config.nested` passed straight through — a
/// nested-under-nested strategy chain is not truncated here.
///
/// **Only `Fixed`/`Failed`**: `RepairResult` is a two-variant enum today (`Specs/repair.md`).
/// The `match` below has no wildcard arm on purpose — adding a third `RepairResult` variant must
/// force a compile error here rather than a silently wrong runtime fallthrough.
pub fn dispatch_weighted<T: Tessellation>(
    issue: &dyn Issue,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    candidates: &[WeightedCandidate<T>],
) -> (RepairResult, Vec<MutationCommand>) {
    debug_assert!(
        candidates.iter().all(|c| c.weight.is_finite() && c.weight > 0.0),
        "dispatch_weighted: every candidate weight must be finite and > 0.0"
    );

    let mut pool: Vec<&WeightedCandidate<T>> = candidates.iter().collect();

    while !pool.is_empty() {
        let total: f64 = pool.iter().map(|c| c.weight).sum();
        let mut pick = rng.random_range(0.0..total);
        let mut chosen_idx = pool.len() - 1;
        for (i, candidate) in pool.iter().enumerate() {
            if pick < candidate.weight {
                chosen_idx = i;
                break;
            }
            pick -= candidate.weight;
        }
        let entry = pool.remove(chosen_idx);

        let params = build_params(entry.config.strategy.params(), Some(&entry.config.param_overrides));
        let (result, commands) = entry.config.strategy.apply(
            issue, maze, rng, &params, preset_state, &entry.config.nested,
        );
        match result {
            RepairResult::Fixed { .. } => {
                return (result, commands);
            }
            RepairResult::Failed => {
                // commands discarded — never applied against the real Maze in the first place.
            }
        }
    }

    (RepairResult::Failed, vec![])
}

/// Tries `candidates` in the order they're already given, until one succeeds (`Fixed`) or every
/// candidate has been tried and failed — GitHub issue #259, the priority-fallback companion to
/// `dispatch_weighted` above. Unlike weighted selection, order here carries the caller's entire
/// selection convention: `dispatch_priority` itself has no notion of priority beyond "try index 0
/// first, then 1, then 2, ...". Empty `candidates` returns `Failed` immediately without touching
/// `rng`.
///
/// **Owns `StrategyParams` construction**, **no rollback bookkeeping needed**, **recursion**, and
/// **only `Fixed`/`Failed`** — all four points from `dispatch_weighted`'s doc comment apply here
/// unchanged; see there for the rationale. `rng` is still threaded through to each candidate's own
/// `apply()` (a candidate strategy may itself be randomized), just never consulted by the dispatch
/// loop itself to pick an order.
pub fn dispatch_priority<T: Tessellation>(
    issue: &dyn Issue,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    candidates: &[&NestedStrategyConfig<T>],
) -> (RepairResult, Vec<MutationCommand>) {
    for config in candidates {
        let params = build_params(config.strategy.params(), Some(&config.param_overrides));
        let (result, commands) = config.strategy.apply(
            issue, maze, rng, &params, preset_state, &config.nested,
        );
        match result {
            RepairResult::Fixed { .. } => {
                return (result, commands);
            }
            RepairResult::Failed => {
                // commands discarded — never applied against the real Maze in the first place.
            }
        }
    }

    (RepairResult::Failed, vec![])
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use std::cell::Cell;
    use crate::random::MazeRng;
    use crate::graph::Graph;
    use crate::ids::{IdGenerator, NodeId};
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::quality_control::{MissingEndpointsIssue, MISSING_ENDPOINTS};
    use crate::repair::strategy::{RepairStrategy, ErasedRepairStrategy, NestedSlot, NestedDispatchKind};
    use crate::repair::params::StrategyParams;
    use std::collections::HashMap;

    static DUMMY_SLOT: NestedSlot = NestedSlot { slot_id: "dummy", kind: MISSING_ENDPOINTS, min: 0, max: None, dispatch_kind: NestedDispatchKind::Unordered };

    /// Proposes a command deterministically (add one fixed edge) then always fails — used to
    /// verify a failed candidate's commands are discarded, never applied.
    struct AlwaysFailedStrategy;
    impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for AlwaysFailedStrategy {
        fn strategy_id(&self) -> &'static str { "test_always_failed" }
        fn apply(
            &self,
            _issue: &MissingEndpointsIssue,
            maze: &Maze<T>,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            let nodes: Vec<NodeId> = maze.graph.nodes().map(|n| n.id).collect();
            let commands = if nodes.len() >= 2 {
                vec![MutationCommand::AddBidirectionalEdge { a: nodes[0], b: nodes[1] }]
            } else {
                vec![]
            };
            (RepairResult::Failed, commands)
        }
    }
    crate::impl_erased_repair_strategy!(AlwaysFailedStrategy, MissingEndpointsIssue);

    /// Never proposes anything, always succeeds.
    struct AlwaysFixedStrategy;
    impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for AlwaysFixedStrategy {
        fn strategy_id(&self) -> &'static str { "test_always_fixed" }
        fn apply(
            &self,
            _issue: &MissingEndpointsIssue,
            _maze: &Maze<T>,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            (RepairResult::Fixed { score: None }, vec![])
        }
    }
    crate::impl_erased_repair_strategy!(AlwaysFixedStrategy, MissingEndpointsIssue);

    /// Records the length of the `nested` slice it was called with, then succeeds — used to
    /// verify `dispatch_weighted` passes `config.nested` through rather than substituting `&[]`.
    struct RecordsReceivedNestedStrategy {
        seen_len: std::rc::Rc<Cell<Option<usize>>>,
    }
    impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for RecordsReceivedNestedStrategy {
        fn strategy_id(&self) -> &'static str { "test_records_nested" }
        fn apply(
            &self,
            _issue: &MissingEndpointsIssue,
            _maze: &Maze<T>,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            self.seen_len.set(Some(nested.len()));
            (RepairResult::Fixed { score: None }, vec![])
        }
    }
    crate::impl_erased_repair_strategy!(RecordsReceivedNestedStrategy, MissingEndpointsIssue);

    fn maze_2_nodes() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    fn no_params_config<T: Tessellation>(strategy: Box<dyn ErasedRepairStrategy<T>>) -> NestedStrategyConfig<T> {
        NestedStrategyConfig { slot: &DUMMY_SLOT, strategy, param_overrides: HashMap::new(), nested: vec![] }
    }

    fn issue() -> MissingEndpointsIssue {
        MissingEndpointsIssue::default()
    }

    #[test]
    fn empty_candidates_returns_failed_without_touching_rng() {
        let maze = maze_2_nodes();
        let mut rng_a = MazeRng::seed_from_u64(1);
        let mut rng_b = MazeRng::seed_from_u64(1);

        let (result, commands) = dispatch_weighted::<SquareTessellation>(
            &issue(), &maze, &mut rng_a, &PresetState::empty(), &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());

        // rng_a must not have advanced past rng_b, which was never touched.
        assert_eq!(rng_a.next_u64(), rng_b.next_u64());
    }

    #[test]
    fn all_failed_candidates_exhaust_pool_and_return_failed() {
        let maze = maze_2_nodes();
        let mut rng = MazeRng::seed_from_u64(1);
        let configs = vec![
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
        ];
        let candidates: Vec<WeightedCandidate<SquareTessellation>> =
            configs.iter().map(|c| WeightedCandidate { config: c, weight: 1.0 }).collect();
        let (result, commands) = dispatch_weighted(&issue(), &maze, &mut rng, &PresetState::empty(), &candidates);
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty(), "every failed attempt's commands must be discarded");
    }

    #[test]
    fn selection_order_is_deterministic_for_a_fixed_seed() {
        // All-failing candidates force the whole pool to be traversed, one weighted pick at a
        // time, so this observes dispatch_weighted's own selection order rather than any
        // candidate's behavior.
        fn run_order() -> Vec<&'static str> {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(42);
            struct Tracking { name: &'static str, order: std::rc::Rc<std::cell::RefCell<Vec<&'static str>>> }
            impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for Tracking {
                fn strategy_id(&self) -> &'static str { self.name }
                fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<T>, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState, _: &[NestedStrategyConfig<T>]) -> (RepairResult, Vec<MutationCommand>) {
                    self.order.borrow_mut().push(self.name);
                    (RepairResult::Failed, vec![])
                }
            }
            crate::impl_erased_repair_strategy!(Tracking, MissingEndpointsIssue);
            let order = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
            let configs = vec![
                no_params_config::<SquareTessellation>(Box::new(Tracking { name: "a", order: order.clone() })),
                no_params_config::<SquareTessellation>(Box::new(Tracking { name: "b", order: order.clone() })),
                no_params_config::<SquareTessellation>(Box::new(Tracking { name: "c", order: order.clone() })),
            ];
            let candidates: Vec<WeightedCandidate<SquareTessellation>> =
                configs.iter().map(|c| WeightedCandidate { config: c, weight: 1.0 }).collect();
            dispatch_weighted(&issue(), &maze, &mut rng, &PresetState::empty(), &candidates);
            let result = order.borrow().clone();
            result
        }

        assert_eq!(run_order(), run_order());
    }

    #[test]
    fn failed_then_fixed_candidate_ends_fixed_with_no_trace_of_failed_commands() {
        let maze = maze_2_nodes();
        let mut rng = MazeRng::seed_from_u64(7);
        let configs = vec![
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            no_params_config::<SquareTessellation>(Box::new(AlwaysFixedStrategy)),
        ];
        let candidates: Vec<WeightedCandidate<SquareTessellation>> =
            configs.iter().map(|c| WeightedCandidate { config: c, weight: 1.0 }).collect();
        let (result, commands) = dispatch_weighted(&issue(), &maze, &mut rng, &PresetState::empty(), &candidates);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(commands.is_empty(), "AlwaysFailedStrategy's proposed command must not leak into the final Fixed result");
    }

    #[test]
    fn nested_config_is_passed_through_to_the_candidate() {
        let maze = maze_2_nodes();
        let mut rng = MazeRng::seed_from_u64(9);
        let seen_len = std::rc::Rc::new(Cell::new(None));
        let inner_nested = vec![no_params_config::<SquareTessellation>(Box::new(AlwaysFixedStrategy))];
        let config = NestedStrategyConfig {
            slot: &DUMMY_SLOT,
            strategy: Box::new(RecordsReceivedNestedStrategy { seen_len: seen_len.clone() }),
            param_overrides: HashMap::new(),
            nested: inner_nested,
        };
        let candidates = vec![WeightedCandidate { config: &config, weight: 1.0 }];
        let (result, _commands) = dispatch_weighted(&issue(), &maze, &mut rng, &PresetState::empty(), &candidates);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(seen_len.get(), Some(1), "dispatch_weighted must pass config.nested through, not &[]");
    }

    mod dispatch_priority_tests {
        use super::*;

        #[test]
        fn empty_candidates_returns_failed_without_touching_rng() {
            let maze = maze_2_nodes();
            let mut rng_a = MazeRng::seed_from_u64(1);
            let mut rng_b = MazeRng::seed_from_u64(1);

            let (result, commands) = dispatch_priority::<SquareTessellation>(
                &issue(), &maze, &mut rng_a, &PresetState::empty(), &[],
            );
            assert!(matches!(result, RepairResult::Failed));
            assert!(commands.is_empty());
            assert_eq!(rng_a.next_u64(), rng_b.next_u64());
        }

        #[test]
        fn all_failed_candidates_exhaust_pool_and_return_failed() {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(1);
            let configs = vec![
                no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
                no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
                no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            ];
            let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> = configs.iter().collect();
            let (result, commands) = dispatch_priority(&issue(), &maze, &mut rng, &PresetState::empty(), &candidates);
            assert!(matches!(result, RepairResult::Failed));
            assert!(commands.is_empty(), "every failed attempt's commands must be discarded");
        }

        #[test]
        fn tries_candidates_in_configured_list_order() {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(42);
            struct Tracking { name: &'static str, order: std::rc::Rc<std::cell::RefCell<Vec<&'static str>>> }
            impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for Tracking {
                fn strategy_id(&self) -> &'static str { self.name }
                fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<T>, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState, _: &[NestedStrategyConfig<T>]) -> (RepairResult, Vec<MutationCommand>) {
                    self.order.borrow_mut().push(self.name);
                    (RepairResult::Failed, vec![])
                }
            }
            crate::impl_erased_repair_strategy!(Tracking, MissingEndpointsIssue);
            let order = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
            let configs = vec![
                no_params_config::<SquareTessellation>(Box::new(Tracking { name: "a", order: order.clone() })),
                no_params_config::<SquareTessellation>(Box::new(Tracking { name: "b", order: order.clone() })),
                no_params_config::<SquareTessellation>(Box::new(Tracking { name: "c", order: order.clone() })),
            ];
            let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> = configs.iter().collect();
            dispatch_priority(&issue(), &maze, &mut rng, &PresetState::empty(), &candidates);
            assert_eq!(order.borrow().clone(), vec!["a", "b", "c"], "dispatch_priority must try candidates strictly in configured order");
        }

        #[test]
        fn failed_then_fixed_candidate_ends_fixed_with_no_trace_of_failed_commands() {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(7);
            let configs = vec![
                no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
                no_params_config::<SquareTessellation>(Box::new(AlwaysFixedStrategy)),
            ];
            let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> = configs.iter().collect();
            let (result, commands) = dispatch_priority(&issue(), &maze, &mut rng, &PresetState::empty(), &candidates);
            assert!(matches!(result, RepairResult::Fixed { .. }));
            assert!(commands.is_empty(), "AlwaysFailedStrategy's proposed command must not leak into the final Fixed result");
        }

        #[test]
        fn a_later_candidate_is_never_tried_once_an_earlier_one_succeeds() {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(3);
            let tried = std::rc::Rc::new(Cell::new(false));
            struct RecordsTried { tried: std::rc::Rc<Cell<bool>> }
            impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for RecordsTried {
                fn strategy_id(&self) -> &'static str { "test_records_tried" }
                fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<T>, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState, _: &[NestedStrategyConfig<T>]) -> (RepairResult, Vec<MutationCommand>) {
                    self.tried.set(true);
                    (RepairResult::Fixed { score: None }, vec![])
                }
            }
            crate::impl_erased_repair_strategy!(RecordsTried, MissingEndpointsIssue);
            let configs = vec![
                no_params_config::<SquareTessellation>(Box::new(AlwaysFixedStrategy)),
                no_params_config::<SquareTessellation>(Box::new(RecordsTried { tried: tried.clone() })),
            ];
            let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> = configs.iter().collect();
            dispatch_priority(&issue(), &maze, &mut rng, &PresetState::empty(), &candidates);
            assert!(!tried.get(), "second candidate must not be tried once the first succeeds");
        }

        #[test]
        fn nested_config_is_passed_through_to_the_candidate() {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(9);
            let seen_len = std::rc::Rc::new(Cell::new(None));
            let inner_nested = vec![no_params_config::<SquareTessellation>(Box::new(AlwaysFixedStrategy))];
            let config = NestedStrategyConfig {
                slot: &DUMMY_SLOT,
                strategy: Box::new(RecordsReceivedNestedStrategy { seen_len: seen_len.clone() }),
                param_overrides: HashMap::new(),
                nested: inner_nested,
            };
            let candidates = vec![&config];
            let (result, _commands) = dispatch_priority(&issue(), &maze, &mut rng, &PresetState::empty(), &candidates);
            assert!(matches!(result, RepairResult::Fixed { .. }));
            assert_eq!(seen_len.get(), Some(1), "dispatch_priority must pass config.nested through, not &[]");
        }
    }
}
