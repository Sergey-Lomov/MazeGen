use super::command::MutationCommand;
use super::params::{StrategyParams, build_params};
use super::result::RepairResult;
use super::strategy::NestedStrategyConfig;
use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::Issue;
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::HashMap;

/// Builds a nested candidate's `StrategyParams`, honoring dispatcher-owned parameters — GitHub
/// issue #486. For every id the nested strategy lists in `nested_suppressed_params()` (for an
/// element-adding strategy: `reserve_percent`, `attempts_limit`), the value comes from
/// `inherited` — the dispatcher's own resolved value, computed once for the whole dispatch — and
/// any stale explicit override the config still carries for that id is dropped (the web UI no
/// longer shows it on a nested node, so a leftover value would be invisible yet active). Every
/// other id keeps its normal precedence: the candidate's own `param_overrides` wins.
///
/// `inherited` is only consulted for suppressed ids; passing an empty map (region-merge
/// dispatchers, whose nested strategies suppress nothing) makes this identical to the old
/// `build_params(config.strategy.params(), Some(&config.param_overrides))`.
///
/// `pub(crate)` because a handful of strategies dispatch to a nested strategy directly rather
/// than through `dispatch_priority`/`dispatch_weighted` (e.g. `AddElevatorStopStrategy::try_add_new`)
/// and still need the same suppressed-param handling.
pub(crate) fn nested_params<T: Tessellation>(
    config: &NestedStrategyConfig<T>,
    inherited: &HashMap<String, String>,
) -> StrategyParams {
    let suppressed = config.strategy.nested_suppressed_params();
    if suppressed.is_empty() {
        return build_params(config.strategy.params(), Some(&config.param_overrides));
    }

    let mut overrides: HashMap<String, String> = config.param_overrides.clone();
    for &id in suppressed {
        overrides.remove(id);
        if let Some(value) = inherited.get(id) {
            overrides.insert(id.to_string(), value.clone());
        }
    }
    build_params(config.strategy.params(), Some(&overrides))
}

/// Nested candidates filling `slot_id`, in configured order. Defensive runtime filter, not the
/// primary validation: `maze-runner`'s `build_nested` already guarantees every entry in `nested`
/// fills a slot the parent actually declared, so this only protects direct `apply()` calls made
/// outside the runner (tests, future internal callers). Shared by the priority/weighted
/// dispatchers.
pub(crate) fn slot_candidates<'a, T: Tessellation>(
    nested: &'a [NestedStrategyConfig<T>],
    slot_id: &str,
) -> Vec<&'a NestedStrategyConfig<T>> {
    nested
        .iter()
        .filter(|n| n.slot.slot_id == slot_id)
        .collect()
}

/// `param_overrides` key a weighted nested candidate's selection weight is read from — see
/// `resolve_weight`. Not a declared `StrategyParam` of the nested strategy itself (it's a
/// convention the weighted dispatchers impose on top of whatever params the nested strategy
/// already has), so it never appears in any strategy's `params()`.
pub(crate) const WEIGHT_KEY: &str = "weight";

/// Fallback weight used whenever `WEIGHT_KEY` is absent, unparsable, non-finite, or `<= 0.0`.
pub(crate) const DEFAULT_WEIGHT: f64 = 1.0;

/// Resolves a nested candidate's selection weight from its `param_overrides`. Never returns a
/// non-finite or non-positive value — any missing/unparsable/non-finite/`<= 0.0` input falls
/// back to `DEFAULT_WEIGHT`, guaranteeing that as long as at least one nested candidate is
/// configured, the pool passed to `dispatch_weighted` always has a strictly positive total
/// weight.
pub(crate) fn resolve_weight(param_overrides: &HashMap<String, String>) -> f64 {
    param_overrides
        .get(WEIGHT_KEY)
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(DEFAULT_WEIGHT)
}

/// Wraps `configs` (already filtered to `slot_id`) into `WeightedCandidate`s using the shared
/// `WEIGHT_KEY` convention (`resolve_weight`). Debug-asserts no candidate strategy declares its
/// own `WEIGHT_KEY` param, which would collide with the reserved `param_overrides` key.
pub(crate) fn weighted_candidates<'a, T: Tessellation>(
    configs: &[&'a NestedStrategyConfig<T>],
    slot_id: &str,
) -> Vec<WeightedCandidate<'a, T>> {
    debug_assert!(
        configs
            .iter()
            .all(|c| !c.strategy.params().iter().any(|p| p.id == WEIGHT_KEY)),
        "a {slot_id} candidate declares its own \"{WEIGHT_KEY}\" param — this collides with \
         resolve_weight's reserved param_overrides key; rename the candidate's param"
    );
    configs
        .iter()
        .map(|&config| WeightedCandidate {
            config,
            weight: resolve_weight(&config.param_overrides),
        })
        .collect()
}

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
/// `StrategyParams` from `config.strategy.params()`, `config.param_overrides` and
/// `inherited_overrides` (see `nested_params` — GitHub issue #486: dispatcher-owned params like
/// `reserve_percent`/`attempts_limit` are injected here and any stale nested override for them is
/// dropped). Callers pass raw `NestedStrategyConfig`s, never pre-built `StrategyParams`. A caller
/// with nothing to inherit down passes `&HashMap::new()`.
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
    inherited_overrides: &HashMap<String, String>,
) -> (RepairResult, Vec<MutationCommand>) {
    debug_assert!(
        candidates
            .iter()
            .all(|c| c.weight.is_finite() && c.weight > 0.0),
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

        let params = nested_params(entry.config, inherited_overrides);
        let (result, commands) = entry.config.strategy.apply(
            issue,
            maze,
            rng,
            &params,
            preset_state,
            &entry.config.nested,
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
    inherited_overrides: &HashMap<String, String>,
) -> (RepairResult, Vec<MutationCommand>) {
    for config in candidates {
        let params = nested_params(config, inherited_overrides);
        let (result, commands) =
            config
                .strategy
                .apply(issue, maze, rng, &params, preset_state, &config.nested);
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
    use crate::graph::Graph;
    use crate::ids::{IdGenerator, NodeId};
    use crate::quality_control::{MISSING_ENDPOINTS, MissingEndpointsIssue};
    use crate::random::MazeRng;
    use crate::repair::params::StrategyParams;
    use crate::repair::strategy::{
        ErasedRepairStrategy, NestedDispatchKind, NestedSlot, RepairStrategy,
    };
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::sync::Arc;

    static DUMMY_SLOT: NestedSlot = NestedSlot {
        slot_id: "dummy",
        kind: MISSING_ENDPOINTS,
        min: 0,
        max: None,
        dispatch_kind: NestedDispatchKind::Unordered,
    };

    /// Proposes a command deterministically (add one fixed edge) then always fails — used to
    /// verify a failed candidate's commands are discarded, never applied.
    struct AlwaysFailedStrategy;
    impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for AlwaysFailedStrategy {
        fn strategy_id(&self) -> &'static str {
            "test_always_failed"
        }
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
                vec![MutationCommand::AddBidirectionalEdge {
                    a: nodes[0],
                    b: nodes[1],
                }]
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
        fn strategy_id(&self) -> &'static str {
            "test_always_fixed"
        }
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
        fn strategy_id(&self) -> &'static str {
            "test_records_nested"
        }
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
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(field, g)
    }

    fn no_params_config<T: Tessellation>(
        strategy: Box<dyn ErasedRepairStrategy<T>>,
    ) -> NestedStrategyConfig<T> {
        NestedStrategyConfig {
            slot: &DUMMY_SLOT,
            strategy,
            param_overrides: HashMap::new(),
            nested: vec![],
        }
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
            &issue(),
            &maze,
            &mut rng_a,
            &PresetState::empty(),
            &[],
            &std::collections::HashMap::new(),
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
        let configs = [
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
        ];
        let candidates: Vec<WeightedCandidate<SquareTessellation>> = configs
            .iter()
            .map(|c| WeightedCandidate {
                config: c,
                weight: 1.0,
            })
            .collect();
        let (result, commands) = dispatch_weighted(
            &issue(),
            &maze,
            &mut rng,
            &PresetState::empty(),
            &candidates,
            &std::collections::HashMap::new(),
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(
            commands.is_empty(),
            "every failed attempt's commands must be discarded"
        );
    }

    #[test]
    fn selection_order_is_deterministic_for_a_fixed_seed() {
        // All-failing candidates force the whole pool to be traversed, one weighted pick at a
        // time, so this observes dispatch_weighted's own selection order rather than any
        // candidate's behavior.
        fn run_order() -> Vec<&'static str> {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(42);
            struct Tracking {
                name: &'static str,
                order: std::rc::Rc<std::cell::RefCell<Vec<&'static str>>>,
            }
            impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for Tracking {
                fn strategy_id(&self) -> &'static str {
                    self.name
                }
                fn apply(
                    &self,
                    _: &MissingEndpointsIssue,
                    _: &Maze<T>,
                    _: &mut dyn RngCore,
                    _: &StrategyParams,
                    _: &PresetState,
                    _: &[NestedStrategyConfig<T>],
                ) -> (RepairResult, Vec<MutationCommand>) {
                    self.order.borrow_mut().push(self.name);
                    (RepairResult::Failed, vec![])
                }
            }
            crate::impl_erased_repair_strategy!(Tracking, MissingEndpointsIssue);
            let order = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
            let configs = [
                no_params_config::<SquareTessellation>(Box::new(Tracking {
                    name: "a",
                    order: order.clone(),
                })),
                no_params_config::<SquareTessellation>(Box::new(Tracking {
                    name: "b",
                    order: order.clone(),
                })),
                no_params_config::<SquareTessellation>(Box::new(Tracking {
                    name: "c",
                    order: order.clone(),
                })),
            ];
            let candidates: Vec<WeightedCandidate<SquareTessellation>> = configs
                .iter()
                .map(|c| WeightedCandidate {
                    config: c,
                    weight: 1.0,
                })
                .collect();
            dispatch_weighted(
                &issue(),
                &maze,
                &mut rng,
                &PresetState::empty(),
                &candidates,
                &std::collections::HashMap::new(),
            );

            order.borrow().clone()
        }

        assert_eq!(run_order(), run_order());
    }

    #[test]
    fn failed_then_fixed_candidate_ends_fixed_with_no_trace_of_failed_commands() {
        let maze = maze_2_nodes();
        let mut rng = MazeRng::seed_from_u64(7);
        let configs = [
            no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            no_params_config::<SquareTessellation>(Box::new(AlwaysFixedStrategy)),
        ];
        let candidates: Vec<WeightedCandidate<SquareTessellation>> = configs
            .iter()
            .map(|c| WeightedCandidate {
                config: c,
                weight: 1.0,
            })
            .collect();
        let (result, commands) = dispatch_weighted(
            &issue(),
            &maze,
            &mut rng,
            &PresetState::empty(),
            &candidates,
            &std::collections::HashMap::new(),
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(
            commands.is_empty(),
            "AlwaysFailedStrategy's proposed command must not leak into the final Fixed result"
        );
    }

    #[test]
    fn nested_config_is_passed_through_to_the_candidate() {
        let maze = maze_2_nodes();
        let mut rng = MazeRng::seed_from_u64(9);
        let seen_len = std::rc::Rc::new(Cell::new(None));
        let inner_nested = vec![no_params_config::<SquareTessellation>(Box::new(
            AlwaysFixedStrategy,
        ))];
        let config = NestedStrategyConfig {
            slot: &DUMMY_SLOT,
            strategy: Box::new(RecordsReceivedNestedStrategy {
                seen_len: seen_len.clone(),
            }),
            param_overrides: HashMap::new(),
            nested: inner_nested,
        };
        let candidates = vec![WeightedCandidate {
            config: &config,
            weight: 1.0,
        }];
        let (result, _commands) = dispatch_weighted(
            &issue(),
            &maze,
            &mut rng,
            &PresetState::empty(),
            &candidates,
            &std::collections::HashMap::new(),
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(
            seen_len.get(),
            Some(1),
            "dispatch_weighted must pass config.nested through, not &[]"
        );
    }

    fn config_for_slot(
        slot: &'static NestedSlot,
        weight: Option<&str>,
    ) -> NestedStrategyConfig<SquareTessellation> {
        let mut param_overrides = HashMap::new();
        if let Some(w) = weight {
            param_overrides.insert(WEIGHT_KEY.to_string(), w.to_string());
        }
        NestedStrategyConfig {
            slot,
            strategy: Box::new(AlwaysFixedStrategy),
            param_overrides,
            nested: vec![],
        }
    }

    #[test]
    fn slot_candidates_keeps_only_matching_slot_in_configured_order() {
        static OTHER_SLOT: NestedSlot = NestedSlot {
            slot_id: "other",
            kind: MISSING_ENDPOINTS,
            min: 0,
            max: None,
            dispatch_kind: NestedDispatchKind::Unordered,
        };
        let configs = [
            config_for_slot(&DUMMY_SLOT, Some("1")),
            config_for_slot(&OTHER_SLOT, None),
            config_for_slot(&DUMMY_SLOT, Some("2")),
        ];
        let picked = slot_candidates(&configs, "dummy");
        assert_eq!(picked.len(), 2);
        assert!(std::ptr::eq(picked[0], &configs[0]));
        assert!(std::ptr::eq(picked[1], &configs[2]));
        assert!(slot_candidates(&configs, "absent").is_empty());
    }

    #[test]
    fn resolve_weight_falls_back_to_default_for_invalid_values() {
        for bad in ["not_a_number", "-3.0", "0", "NaN", "inf"] {
            assert_eq!(
                resolve_weight(&HashMap::from([(WEIGHT_KEY.to_string(), bad.to_string())])),
                DEFAULT_WEIGHT,
                "bad weight {bad:?} must fall back to default"
            );
        }
        assert_eq!(resolve_weight(&HashMap::new()), DEFAULT_WEIGHT);
        assert_eq!(
            resolve_weight(&HashMap::from([(
                WEIGHT_KEY.to_string(),
                "3.5".to_string()
            )])),
            3.5
        );
    }

    #[test]
    fn weighted_candidates_resolves_each_weight_in_order() {
        let configs = [
            config_for_slot(&DUMMY_SLOT, Some("3")),
            config_for_slot(&DUMMY_SLOT, None),
        ];
        let refs: Vec<&NestedStrategyConfig<SquareTessellation>> = configs.iter().collect();
        let weights: Vec<f64> = weighted_candidates(&refs, "dummy")
            .iter()
            .map(|c| c.weight)
            .collect();
        assert_eq!(weights, vec![3.0, DEFAULT_WEIGHT]);
    }

    mod dispatch_priority_tests {
        use super::*;

        #[test]
        fn empty_candidates_returns_failed_without_touching_rng() {
            let maze = maze_2_nodes();
            let mut rng_a = MazeRng::seed_from_u64(1);
            let mut rng_b = MazeRng::seed_from_u64(1);

            let (result, commands) = dispatch_priority::<SquareTessellation>(
                &issue(),
                &maze,
                &mut rng_a,
                &PresetState::empty(),
                &[],
                &std::collections::HashMap::new(),
            );
            assert!(matches!(result, RepairResult::Failed));
            assert!(commands.is_empty());
            assert_eq!(rng_a.next_u64(), rng_b.next_u64());
        }

        #[test]
        fn all_failed_candidates_exhaust_pool_and_return_failed() {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(1);
            let configs = [
                no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
                no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
                no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
            ];
            let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> =
                configs.iter().collect();
            let (result, commands) = dispatch_priority(
                &issue(),
                &maze,
                &mut rng,
                &PresetState::empty(),
                &candidates,
                &std::collections::HashMap::new(),
            );
            assert!(matches!(result, RepairResult::Failed));
            assert!(
                commands.is_empty(),
                "every failed attempt's commands must be discarded"
            );
        }

        #[test]
        fn tries_candidates_in_configured_list_order() {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(42);
            struct Tracking {
                name: &'static str,
                order: std::rc::Rc<std::cell::RefCell<Vec<&'static str>>>,
            }
            impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for Tracking {
                fn strategy_id(&self) -> &'static str {
                    self.name
                }
                fn apply(
                    &self,
                    _: &MissingEndpointsIssue,
                    _: &Maze<T>,
                    _: &mut dyn RngCore,
                    _: &StrategyParams,
                    _: &PresetState,
                    _: &[NestedStrategyConfig<T>],
                ) -> (RepairResult, Vec<MutationCommand>) {
                    self.order.borrow_mut().push(self.name);
                    (RepairResult::Failed, vec![])
                }
            }
            crate::impl_erased_repair_strategy!(Tracking, MissingEndpointsIssue);
            let order = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
            let configs = [
                no_params_config::<SquareTessellation>(Box::new(Tracking {
                    name: "a",
                    order: order.clone(),
                })),
                no_params_config::<SquareTessellation>(Box::new(Tracking {
                    name: "b",
                    order: order.clone(),
                })),
                no_params_config::<SquareTessellation>(Box::new(Tracking {
                    name: "c",
                    order: order.clone(),
                })),
            ];
            let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> =
                configs.iter().collect();
            dispatch_priority(
                &issue(),
                &maze,
                &mut rng,
                &PresetState::empty(),
                &candidates,
                &std::collections::HashMap::new(),
            );
            assert_eq!(
                order.borrow().clone(),
                vec!["a", "b", "c"],
                "dispatch_priority must try candidates strictly in configured order"
            );
        }

        #[test]
        fn failed_then_fixed_candidate_ends_fixed_with_no_trace_of_failed_commands() {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(7);
            let configs = [
                no_params_config::<SquareTessellation>(Box::new(AlwaysFailedStrategy)),
                no_params_config::<SquareTessellation>(Box::new(AlwaysFixedStrategy)),
            ];
            let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> =
                configs.iter().collect();
            let (result, commands) = dispatch_priority(
                &issue(),
                &maze,
                &mut rng,
                &PresetState::empty(),
                &candidates,
                &std::collections::HashMap::new(),
            );
            assert!(matches!(result, RepairResult::Fixed { .. }));
            assert!(
                commands.is_empty(),
                "AlwaysFailedStrategy's proposed command must not leak into the final Fixed result"
            );
        }

        #[test]
        fn a_later_candidate_is_never_tried_once_an_earlier_one_succeeds() {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(3);
            let tried = std::rc::Rc::new(Cell::new(false));
            struct RecordsTried {
                tried: std::rc::Rc<Cell<bool>>,
            }
            impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for RecordsTried {
                fn strategy_id(&self) -> &'static str {
                    "test_records_tried"
                }
                fn apply(
                    &self,
                    _: &MissingEndpointsIssue,
                    _: &Maze<T>,
                    _: &mut dyn RngCore,
                    _: &StrategyParams,
                    _: &PresetState,
                    _: &[NestedStrategyConfig<T>],
                ) -> (RepairResult, Vec<MutationCommand>) {
                    self.tried.set(true);
                    (RepairResult::Fixed { score: None }, vec![])
                }
            }
            crate::impl_erased_repair_strategy!(RecordsTried, MissingEndpointsIssue);
            let configs = [
                no_params_config::<SquareTessellation>(Box::new(AlwaysFixedStrategy)),
                no_params_config::<SquareTessellation>(Box::new(RecordsTried {
                    tried: tried.clone(),
                })),
            ];
            let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> =
                configs.iter().collect();
            dispatch_priority(
                &issue(),
                &maze,
                &mut rng,
                &PresetState::empty(),
                &candidates,
                &std::collections::HashMap::new(),
            );
            assert!(
                !tried.get(),
                "second candidate must not be tried once the first succeeds"
            );
        }

        #[test]
        fn nested_config_is_passed_through_to_the_candidate() {
            let maze = maze_2_nodes();
            let mut rng = MazeRng::seed_from_u64(9);
            let seen_len = std::rc::Rc::new(Cell::new(None));
            let inner_nested = vec![no_params_config::<SquareTessellation>(Box::new(
                AlwaysFixedStrategy,
            ))];
            let config = NestedStrategyConfig {
                slot: &DUMMY_SLOT,
                strategy: Box::new(RecordsReceivedNestedStrategy {
                    seen_len: seen_len.clone(),
                }),
                param_overrides: HashMap::new(),
                nested: inner_nested,
            };
            let candidates = vec![&config];
            let (result, _commands) = dispatch_priority(
                &issue(),
                &maze,
                &mut rng,
                &PresetState::empty(),
                &candidates,
                &std::collections::HashMap::new(),
            );
            assert!(matches!(result, RepairResult::Fixed { .. }));
            assert_eq!(
                seen_len.get(),
                Some(1),
                "dispatch_priority must pass config.nested through, not &[]"
            );
        }
    }
}
