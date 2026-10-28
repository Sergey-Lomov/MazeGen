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
    let field = MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
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
        let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> = configs.iter().collect();
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
        let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> = configs.iter().collect();
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
        let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> = configs.iter().collect();
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
        let candidates: Vec<&NestedStrategyConfig<SquareTessellation>> = configs.iter().collect();
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
