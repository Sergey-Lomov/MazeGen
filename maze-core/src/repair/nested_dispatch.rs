use rand::{Rng, RngCore};
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::Issue;
use crate::generation::PresetState;
use super::params::build_params;
use super::result::RepairResult;
use super::strategy::NestedStrategyConfig;
use super::snapshot::SnapshotStack;

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
/// returns `Failed` immediately without touching `rng` or `snapshots`.
///
/// **Owns `StrategyParams` construction**: for each attempt, builds the nested strategy's
/// `StrategyParams` from `config.strategy.params()` and `config.param_overrides` — callers pass
/// raw `NestedStrategyConfig`s, never pre-built `StrategyParams`.
///
/// **Owns `SnapshotStack` bookkeeping around each attempt**: `snapshots.snapshot(maze)` before
/// calling a candidate's `apply()`. If the attempt returns `Fixed`, that snapshot is discarded
/// via `snapshots.discard_last()` (not restored) — the mutation is kept, and the stack ends the
/// call at the same depth it had on entry, no net growth. If the attempt returns `Failed`,
/// `snapshots.restore(maze)` undoes exactly that attempt's mutations before the next weighted
/// pick is tried on a clean graph.
///
/// **Recursion**: each attempt is called with `&config.nested` passed straight through — a
/// nested-under-nested strategy chain is not truncated here.
///
/// **Only `Fixed`/`Failed`**: `RepairResult` is a two-variant enum today (`Specs/repair.md`).
/// The `match` below has no wildcard arm on purpose — adding a third `RepairResult` variant must
/// force a compile error here rather than a silently wrong runtime fallthrough.
pub fn dispatch_weighted<T: Tessellation>(
    issue: &Issue,
    maze: &mut Maze<T>,
    snapshots: &mut SnapshotStack,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    candidates: &[WeightedCandidate<T>],
) -> RepairResult {
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

        snapshots.snapshot(maze);
        let params = build_params(entry.config.strategy.params(), Some(&entry.config.param_overrides));
        let result = entry.config.strategy.apply(
            issue, maze, snapshots, rng, &params, preset_state, &entry.config.nested,
        );
        match result {
            RepairResult::Fixed { .. } => {
                snapshots.discard_last();
                return result;
            }
            RepairResult::Failed => {
                snapshots.restore(maze);
            }
        }
    }

    RepairResult::Failed
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
    use crate::quality_control::{Issue, MISSING_ENDPOINTS};
    use crate::repair::strategy::{RepairStrategy, NestedSlot};
    use crate::repair::params::StrategyParams;
    use std::collections::HashMap;

    static DUMMY_SLOT: NestedSlot = NestedSlot { slot_id: "dummy", kind: MISSING_ENDPOINTS, min: 0, max: None };

    /// Mutates the graph deterministically (adds one fixed edge) then always fails — used to
    /// verify per-attempt rollback.
    struct AlwaysFailedStrategy;
    impl<T: Tessellation> RepairStrategy<T> for AlwaysFailedStrategy {
        fn strategy_id(&self) -> &'static str { "test_always_failed" }
        fn handles(&self) -> crate::quality_control::IssueKind { MISSING_ENDPOINTS }
        fn apply(
            &self,
            _issue: &Issue,
            maze: &mut Maze<T>,
            _snapshots: &mut SnapshotStack,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> RepairResult {
            let nodes: Vec<NodeId> = maze.graph.nodes().map(|n| n.id).collect();
            if nodes.len() >= 2 {
                let _ = crate::generation::try_add_bidirectional_edge(&mut maze.graph, nodes[0], nodes[1], &PresetState::empty());
            }
            RepairResult::Failed
        }
    }

    /// Never mutates, always succeeds.
    struct AlwaysFixedStrategy;
    impl<T: Tessellation> RepairStrategy<T> for AlwaysFixedStrategy {
        fn strategy_id(&self) -> &'static str { "test_always_fixed" }
        fn handles(&self) -> crate::quality_control::IssueKind { MISSING_ENDPOINTS }
        fn apply(
            &self,
            _issue: &Issue,
            _maze: &mut Maze<T>,
            _snapshots: &mut SnapshotStack,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> RepairResult {
            RepairResult::Fixed { score: None }
        }
    }

    /// Records the length of the `nested` slice it was called with, then succeeds — used to
    /// verify `dispatch_weighted` passes `config.nested` through rather than substituting `&[]`.
    struct RecordsReceivedNestedStrategy {
        seen_len: std::rc::Rc<Cell<Option<usize>>>,
    }
    impl<T: Tessellation> RepairStrategy<T> for RecordsReceivedNestedStrategy {
        fn strategy_id(&self) -> &'static str { "test_records_nested" }
        fn handles(&self) -> crate::quality_control::IssueKind { MISSING_ENDPOINTS }
        fn apply(
            &self,
            _issue: &Issue,
            _maze: &mut Maze<T>,
            _snapshots: &mut SnapshotStack,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            nested: &[NestedStrategyConfig<T>],
        ) -> RepairResult {
            self.seen_len.set(Some(nested.len()));
            RepairResult::Fixed { score: None }
        }
    }

    fn maze_2_nodes() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    fn no_params_config<T: Tessellation>(strategy: Box<dyn RepairStrategy<T>>) -> NestedStrategyConfig<T> {
        NestedStrategyConfig { slot: &DUMMY_SLOT, strategy, param_overrides: HashMap::new(), nested: vec![] }
    }

    fn issue() -> Issue {
        Issue::new(MISSING_ENDPOINTS)
    }

    #[test]
    fn empty_candidates_returns_failed_without_touching_rng() {
        let mut maze = maze_2_nodes();
        let mut rng_a = MazeRng::seed_from_u64(1);
        let mut rng_b = MazeRng::seed_from_u64(1);

        let result = dispatch_weighted::<SquareTessellation>(
            &issue(), &mut maze, &mut SnapshotStack::new(), &mut rng_a, &PresetState::empty(), &[],
        );
        assert!(matches!(result, RepairResult::Failed));

        // rng_a must not have advanced past rng_b, which was never touched.
        assert_eq!(rng_a.next_u64(), rng_b.next_u64());
    }

    #[test]
    fn all_failed_candidates_exhaust_pool_and_return_failed() {
        let mut maze = maze_2_nodes();
        let mut rng = MazeRng::seed_from_u64(1);
        let configs = vec![
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
        ];
        let candidates: Vec<WeightedCandidate<SquareTessellation>> =
            configs.iter().map(|c| WeightedCandidate { config: c, weight: 1.0 }).collect();
        let edges_before = maze.graph.edges().count();
        let mut snapshots = SnapshotStack::new();
        let result = dispatch_weighted(&issue(), &mut maze, &mut snapshots, &mut rng, &PresetState::empty(), &candidates);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), edges_before, "every failed attempt must be rolled back");
    }

    #[test]
    fn selection_order_is_deterministic_for_a_fixed_seed() {
        // All-failing candidates force the whole pool to be traversed, one weighted pick at a
        // time, so this observes dispatch_weighted's own selection order rather than any
        // candidate's behavior.
        fn run_order() -> Vec<&'static str> {
            let mut maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(42);
            struct Named(&'static str);
            impl<T: Tessellation> RepairStrategy<T> for Named {
                fn strategy_id(&self) -> &'static str { self.0 }
                fn handles(&self) -> crate::quality_control::IssueKind { MISSING_ENDPOINTS }
                fn apply(&self, _: &Issue, _: &mut Maze<T>, _: &mut SnapshotStack, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState, _: &[NestedStrategyConfig<T>]) -> RepairResult {
                    RepairResult::Failed
                }
            }
            let order = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
            struct Tracking { name: &'static str, order: std::rc::Rc<std::cell::RefCell<Vec<&'static str>>> }
            impl<T: Tessellation> RepairStrategy<T> for Tracking {
                fn strategy_id(&self) -> &'static str { self.name }
                fn handles(&self) -> crate::quality_control::IssueKind { MISSING_ENDPOINTS }
                fn apply(&self, _: &Issue, _: &mut Maze<T>, _: &mut SnapshotStack, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState, _: &[NestedStrategyConfig<T>]) -> RepairResult {
                    self.order.borrow_mut().push(self.name);
                    RepairResult::Failed
                }
            }
            let configs = vec![
                no_params_config::<SquareTessellation>(Box::new(Tracking { name: "a", order: order.clone() })),
                no_params_config::<SquareTessellation>(Box::new(Tracking { name: "b", order: order.clone() })),
                no_params_config::<SquareTessellation>(Box::new(Tracking { name: "c", order: order.clone() })),
            ];
            let candidates: Vec<WeightedCandidate<SquareTessellation>> =
                configs.iter().map(|c| WeightedCandidate { config: c, weight: 1.0 }).collect();
            let mut snapshots = SnapshotStack::new();
            dispatch_weighted(&issue(), &mut maze, &mut snapshots, &mut rng, &PresetState::empty(), &candidates);
            let result = order.borrow().clone();
            result
        }

        assert_eq!(run_order(), run_order());
    }

    #[test]
    fn failed_then_fixed_candidate_ends_fixed_with_no_trace_of_failed_mutation() {
        let mut maze = maze_2_nodes();
        let mut rng = MazeRng::seed_from_u64(7);
        let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        let configs = vec![
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            no_params_config::<SquareTessellation>(Box::new(AlwaysFixedStrategy)),
        ];
        let candidates: Vec<WeightedCandidate<SquareTessellation>> =
            configs.iter().map(|c| WeightedCandidate { config: c, weight: 1.0 }).collect();
        let mut snapshots = SnapshotStack::new();
        let result = dispatch_weighted(&issue(), &mut maze, &mut snapshots, &mut rng, &PresetState::empty(), &candidates);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_before, edges_after, "AlwaysFailedStrategy's edge must have been rolled back regardless of pick order");
    }

    #[test]
    fn snapshot_stack_depth_unchanged_after_fixed() {
        let mut maze = maze_2_nodes();
        let mut rng = MazeRng::seed_from_u64(3);
        let configs = vec![no_params_config::<SquareTessellation>(Box::new(AlwaysFixedStrategy))];
        let candidates: Vec<WeightedCandidate<SquareTessellation>> =
            configs.iter().map(|c| WeightedCandidate { config: c, weight: 1.0 }).collect();
        let mut snapshots = SnapshotStack::new();
        // Push one unrelated pre-existing snapshot to make sure dispatch_weighted only ever pops
        // what it itself pushed.
        snapshots.snapshot(&maze);
        let result = dispatch_weighted(&issue(), &mut maze, &mut snapshots, &mut rng, &PresetState::empty(), &candidates);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        // The one snapshot we pushed ourselves must still be there.
        snapshots.restore(&mut maze); // does not panic => exactly one entry remained
    }

    #[test]
    fn nested_config_is_passed_through_to_the_candidate() {
        let mut maze = maze_2_nodes();
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
        let mut snapshots = SnapshotStack::new();
        let result = dispatch_weighted(&issue(), &mut maze, &mut snapshots, &mut rng, &PresetState::empty(), &candidates);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(seen_len.get(), Some(1), "dispatch_weighted must pass config.nested through, not &[]");
    }
}
