use super::*;
use crate::ids::EdgeId;
use crate::quality_control::issue::{INVALID_ONE_WAY, INVALID_ONE_WAY_GROUP, IssueKind};
use crate::quality_control::{InvalidGroupIssue, InvalidGroupIssueKind, InvalidOneWayIssue};
use crate::random::MazeRng;
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::{SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

struct TestKind;
impl InvalidGroupIssueKind for TestKind {
    type Element = EdgeId;
    const KIND: IssueKind = INVALID_ONE_WAY_GROUP;
    const NESTED_KIND: IssueKind = INVALID_ONE_WAY;
    const NESTED_SLOT_ID: &'static str = "test_fix_target";
}
type TestIssue = InvalidGroupIssue<TestKind>;

static TEST_SLOT: NestedSlot = NestedSlot {
    slot_id: "test_fix_target",
    kind: INVALID_ONE_WAY,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
};

fn empty_maze() -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field =
        crate::space::MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids)
            .unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    Maze::new(field, g)
}

/// Panics if ever called -- for `issue.groups.is_empty()`, `group_select_apply` must return
/// early without making any nested call at all.
struct UnreachableStrategy;
impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for UnreachableStrategy {
    fn strategy_id(&self) -> &'static str {
        "unreachable_stub"
    }
    fn apply(
        &self,
        _issue: &InvalidOneWayIssue,
        _maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        panic!("group_select_apply must not make a nested call for an empty issue.groups");
    }
}
crate::impl_erased_repair_strategy!(UnreachableStrategy, InvalidOneWayIssue);

#[allow(clippy::ptr_arg)]
fn no_order(
    candidates: &mut Vec<EdgeId>,
    _membership: &HashMap<EdgeId, usize>,
    _rng: &mut dyn RngCore,
) {
    candidates.sort_unstable();
}

#[test]
fn apply_succeeds_on_empty_groups() {
    let maze = empty_maze();
    let issue = TestIssue::new_from_check("test_check", vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = NestedStrategyConfig {
        slot: &TEST_SLOT,
        strategy: Box::new(UnreachableStrategy),
        param_overrides: HashMap::new(),
        nested: vec![],
    };
    let (result, commands) = group_select_apply::<SquareTessellation, TestKind, _>(
        &issue,
        &maze,
        &mut rng,
        &PresetState::empty(),
        &nested,
        |_| true,
        |check, target, others| {
            Box::new(InvalidOneWayIssue::new_from_check(check, {
                let mut v = vec![*target];
                v.extend(others.iter().map(|&&e| e));
                v
            }))
        },
        |_, _| (),
        |_, _| false,
        no_order,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(commands.is_empty());
}

#[test]
fn others_passed_to_build_nested_issue_excludes_already_resolved_elements() {
    // group A = [e0, e1] to_remove=1, group B = [e2] to_remove=1. Fixing e0 resolves group A
    // outright (to_remove hits zero) but e1 stays a `groups_by_element` key (it's never picked
    // or invalidated). The very next candidate's `others` list must not still contain e1 --
    // it's no longer needed by any group with remaining > 0.
    let maze = empty_maze();
    let issue = TestIssue::new_from_check("test_check", vec![(vec![0, 1], 1), (vec![2], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let others_seen: Rc<RefCell<Vec<Vec<EdgeId>>>> = Rc::new(RefCell::new(Vec::new()));
    let others_seen_clone = others_seen.clone();

    struct CapturingStrategy {
        others_seen: Rc<RefCell<Vec<Vec<EdgeId>>>>,
    }
    impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for CapturingStrategy {
        fn strategy_id(&self) -> &'static str {
            "capturing_stub"
        }
        fn apply(
            &self,
            issue: &InvalidOneWayIssue,
            _maze: &Maze<T>,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            // issue.invalid[0] is the target, the rest is `others` (see build_nested_issue below).
            self.others_seen
                .borrow_mut()
                .push(issue.invalid[1..].to_vec());
            (
                RepairResult::Fixed { score: None },
                vec![MutationCommand::RemoveEdge {
                    id: issue.invalid[0],
                }],
            )
        }
    }
    crate::impl_erased_repair_strategy!(CapturingStrategy, InvalidOneWayIssue);

    let nested = NestedStrategyConfig {
        slot: &TEST_SLOT,
        strategy: Box::new(CapturingStrategy {
            others_seen: others_seen_clone,
        }),
        param_overrides: HashMap::new(),
        nested: vec![],
    };
    let (result, _commands) = group_select_apply::<SquareTessellation, TestKind, _>(
        &issue,
        &maze,
        &mut rng,
        &PresetState::empty(),
        &nested,
        |_| true,
        |check, target, others| {
            Box::new(InvalidOneWayIssue::new_from_check(check, {
                let mut v = vec![*target];
                v.extend(others.iter().map(|&&e| e));
                v
            }))
        },
        |_, _| (),
        |_, _| false,
        no_order,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let calls = others_seen.borrow();
    assert_eq!(
        calls.len(),
        2,
        "two candidates (e0, e2) expected -- e1 must never be picked as its own target since e0 resolves group A first"
    );
    assert!(
        !calls[1].contains(&1),
        "e1's group was already fully resolved by e0 -- it must not appear in a later call's `others`: {:?}",
        calls[1]
    );
}

#[test]
fn order_by_priority_problematic_visits_highest_membership_first() {
    let params = crate::repair::params::build_params(&[], None);
    let order = order_by_priority::<EdgeId>(&params);
    let mut candidates: Vec<EdgeId> = vec![0, 1, 2];
    let membership: HashMap<EdgeId, usize> = [(0, 1), (1, 3), (2, 1)].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);
    order(&mut candidates, &membership, &mut rng);
    assert_eq!(
        candidates[0], 1,
        "highest-membership candidate must be visited first under problematic priority"
    );
}

// ---- multi_target_group_select_apply ----------------------------------------------------

/// Removes `issue.invalid[0]` and reports `Fixed`. Reused across the multi-target tests as a
/// stand-in for any concrete `Remove*` nested strategy.
struct RemoveFirstStrategy;
impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for RemoveFirstStrategy {
    fn strategy_id(&self) -> &'static str {
        "remove_first_stub"
    }
    fn apply(
        &self,
        issue: &InvalidOneWayIssue,
        _maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        (
            RepairResult::Fixed { score: None },
            vec![MutationCommand::RemoveEdge {
                id: issue.invalid[0],
            }],
        )
    }
}
crate::impl_erased_repair_strategy!(RemoveFirstStrategy, InvalidOneWayIssue);

fn remove_first_config() -> NestedStrategyConfig<SquareTessellation> {
    NestedStrategyConfig {
        slot: &TEST_SLOT,
        strategy: Box::new(RemoveFirstStrategy),
        param_overrides: HashMap::new(),
        nested: vec![],
    }
}

fn one_way_issue(check: &str, target: &EdgeId, others: &[&EdgeId]) -> Box<dyn Issue> {
    let mut v = vec![*target];
    v.extend(others.iter().map(|&&e| e));
    Box::new(InvalidOneWayIssue::new_from_check(check, v))
}

#[test]
fn multi_target_empty_groups_makes_no_nested_call() {
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let cfg = NestedStrategyConfig {
        slot: &TEST_SLOT,
        strategy: Box::new(UnreachableStrategy),
        param_overrides: HashMap::new(),
        nested: vec![],
    };
    let params = crate::repair::params::build_params(&[], None);
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind, _>(
        &[],
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |_, _| {
            Some((
                &cfg,
                &params,
                Box::new(InvalidOneWayIssue::new_from_check("c", vec![0])),
            ))
        },
        |_, _| (),
        |_, _| false,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(commands.is_empty());
}

#[test]
fn multi_target_wholly_protected_group_fails_when_auto_resolve_is_false() {
    // Single group, `nested_for` rejects every element (Start/Finish analogue). With
    // `wholly_protected_auto_resolve: false` the budget is kept and the call reports Failed.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let cfg = remove_first_config();
    let params = crate::repair::params::build_params(&[], None);
    let groups = vec![(vec![0_usize, 1_usize], 1_u32)];
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind, _>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |_, _| {
            let _ = (&cfg, &params);
            None
        },
        |_, _| (),
        |_, _| false,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Failed));
    assert!(commands.is_empty());
}

#[test]
fn multi_target_wholly_protected_group_auto_resolves_when_flag_is_true() {
    // Same setup but `wholly_protected_auto_resolve: true` — matches `group_select_apply`'s
    // contract: a fully protected group is treated as resolved. Nothing succeeded, so the
    // overall result is still Failed (no *other* group made progress), but no panic and the
    // budget was zeroed.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let groups = vec![(vec![0_usize, 1_usize], 1_u32)];
    let (result, _commands) = multi_target_group_select_apply::<SquareTessellation, TestKind, _>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |_, _| None,
        |_, _| (),
        |_, _| false,
        no_order,
        true,
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn multi_target_mixed_issue_fixes_the_actionable_group_and_leaves_the_protected_one() {
    // group A = [e0, e1] fully protected; group B = [e2] actionable. Result is Fixed from B,
    // A is untouched.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let cfg = remove_first_config();
    let params = crate::repair::params::build_params(&[], None);
    let groups = vec![(vec![0_usize, 1_usize], 1_u32), (vec![2_usize], 1_u32)];
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind, _>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |e, others| {
            if *e == 2 {
                Some((&cfg, &params, one_way_issue("b", e, others)))
            } else {
                None
            }
        },
        |_, _| (),
        |_, _| false,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(commands, vec![MutationCommand::RemoveEdge { id: 2 }]);
}

#[test]
fn multi_target_shared_element_across_two_groups_is_fixed_once_and_resolves_both() {
    // group A = [e0, e1], group B = [e0, e2]. e0 is shared. One nested call on e0 must
    // retire the budget of BOTH groups, so e1/e2 are never offered.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let cfg = remove_first_config();
    let params = crate::repair::params::build_params(&[], None);
    // Count only real fix attempts (non-empty `others`), not the empty-slice index-build probes.
    let fix_targets: Rc<RefCell<Vec<EdgeId>>> = Rc::new(RefCell::new(Vec::new()));
    let fix_targets_seen = fix_targets.clone();
    let groups = vec![
        (vec![0_usize, 1_usize], 1_u32),
        (vec![0_usize, 2_usize], 1_u32),
    ];
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind, _>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |e, others| {
            if !others.is_empty() {
                fix_targets_seen.borrow_mut().push(*e);
            }
            Some((&cfg, &params, one_way_issue("c", e, others)))
        },
        // e0 removed => e1 and e2 (the "others") are NOT auto-invalidated by edge id here;
        // the shared-membership retirement must come from `groups_by_element` bookkeeping,
        // not from `element_invalidated`.
        |_, _| (),
        |_, _| false,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(commands, vec![MutationCommand::RemoveEdge { id: 0 }]);
    assert_eq!(
        *fix_targets.borrow(),
        vec![0],
        "only the shared element e0 is fixed; both groups' budgets retire from that single call"
    );
}

#[test]
fn multi_target_falls_through_to_next_candidate_when_first_nested_call_fails() {
    // group = [e0, e1] to_remove=1. Nested strategy fails for e0, succeeds for e1.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let params = crate::repair::params::build_params(&[], None);

    struct FailForZero;
    impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for FailForZero {
        fn strategy_id(&self) -> &'static str {
            "fail_for_zero_stub"
        }
        fn apply(
            &self,
            issue: &InvalidOneWayIssue,
            _maze: &Maze<T>,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            if issue.invalid[0] == 0 {
                (RepairResult::Failed, vec![])
            } else {
                (
                    RepairResult::Fixed { score: None },
                    vec![MutationCommand::RemoveEdge {
                        id: issue.invalid[0],
                    }],
                )
            }
        }
    }
    crate::impl_erased_repair_strategy!(FailForZero, InvalidOneWayIssue);
    let cfg = NestedStrategyConfig {
        slot: &TEST_SLOT,
        strategy: Box::new(FailForZero),
        param_overrides: HashMap::new(),
        nested: vec![],
    };
    let groups = vec![(vec![0_usize, 1_usize], 1_u32)];
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind, _>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |e, others| Some((&cfg, &params, one_way_issue("c", e, others))),
        |_, _| (),
        |_, _| false,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(commands, vec![MutationCommand::RemoveEdge { id: 1 }]);
}

// ---- candidate-pass characterization -----------------------------------------------------
//
// These pin the observable contract of `run_group_candidate_pass` (which nested calls happen, in
// what order, with which `others`, and which candidates `element_invalidated` is offered), so an
// internal change of how `others` is built or how invalidation is computed cannot silently alter
// behavior for any of the strategies built on the pass.

type Trace = Rc<RefCell<Vec<(EdgeId, Vec<EdgeId>)>>>;
type HookCall = (EdgeId, Vec<MutationCommand>);

/// Records `(target, others)` for every call. Fails for ids in `fail`; on success removes the
/// target plus any ids listed for it in `extra`.
struct RecordingStrategy {
    trace: Trace,
    fail: Vec<EdgeId>,
    extra: HashMap<EdgeId, Vec<EdgeId>>,
}
impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for RecordingStrategy {
    fn strategy_id(&self) -> &'static str {
        "recording_stub"
    }
    fn apply(
        &self,
        issue: &InvalidOneWayIssue,
        _maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let target = issue.invalid[0];
        self.trace
            .borrow_mut()
            .push((target, issue.invalid[1..].to_vec()));
        if self.fail.contains(&target) {
            return (RepairResult::Failed, vec![]);
        }
        let mut commands = vec![MutationCommand::RemoveEdge { id: target }];
        for id in self.extra.get(&target).into_iter().flatten() {
            commands.push(MutationCommand::RemoveEdge { id: *id });
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}
crate::impl_erased_repair_strategy!(RecordingStrategy, InvalidOneWayIssue);

fn recording_config(
    fail: Vec<EdgeId>,
    extra: Vec<(EdgeId, Vec<EdgeId>)>,
) -> (Trace, NestedStrategyConfig<SquareTessellation>) {
    let trace: Trace = Rc::new(RefCell::new(Vec::new()));
    let cfg = NestedStrategyConfig {
        slot: &TEST_SLOT,
        strategy: Box::new(RecordingStrategy {
            trace: trace.clone(),
            fail,
            extra: extra.into_iter().collect(),
        }),
        param_overrides: HashMap::new(),
        nested: vec![],
    };
    (trace, cfg)
}

fn removed_ids(commands: &[MutationCommand], _maze: &Maze<SquareTessellation>) -> Vec<EdgeId> {
    crate::repair::removed_edge_ids(commands)
}

#[allow(clippy::ptr_arg)]
fn removes_edge(removed: &Vec<EdgeId>, id: &EdgeId) -> bool {
    removed.contains(id)
}

/// Runs the single-slot pass with `removes_edge` invalidation.
fn run_pass(
    groups: Vec<(Vec<EdgeId>, u32)>,
    cfg: &NestedStrategyConfig<SquareTessellation>,
    seed: u64,
    element_allowed: impl Fn(&EdgeId) -> bool,
    order: impl Fn(&mut Vec<EdgeId>, &HashMap<EdgeId, usize>, &mut dyn RngCore),
) -> (RepairResult, Vec<MutationCommand>) {
    let maze = empty_maze();
    let issue = TestIssue::new_from_check("test_check", groups);
    let mut rng = MazeRng::seed_from_u64(seed);
    group_select_apply::<SquareTessellation, TestKind, _>(
        &issue,
        &maze,
        &mut rng,
        &PresetState::empty(),
        cfg,
        element_allowed,
        one_way_issue,
        removed_ids,
        removes_edge,
        order,
    )
}

#[test]
fn exact_call_sequence_on_small_overlapping_input() {
    // A = [0,1,2,3] to_remove=2, B = [3,4,5] to_remove=1. Fixing 0 also removes 1 (budget of A
    // 2 -> 0). 1 and 2 are then skipped (spent / not needed); 3 is still needed by B, and its
    // `others` exclude 2 (only in the exhausted group A) but keep 4 and 5.
    let (trace, cfg) = recording_config(vec![], vec![(0, vec![1])]);
    let (result, commands) = run_pass(
        vec![(vec![0, 1, 2, 3], 2), (vec![3, 4, 5], 1)],
        &cfg,
        1,
        |_| true,
        no_order,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(
        *trace.borrow(),
        vec![(0, vec![1, 2, 3, 4, 5]), (3, vec![4, 5])]
    );
    assert_eq!(
        commands,
        vec![
            MutationCommand::RemoveEdge { id: 0 },
            MutationCommand::RemoveEdge { id: 1 },
            MutationCommand::RemoveEdge { id: 3 },
        ]
    );
}

#[test]
fn others_are_sorted_and_never_contain_the_target() {
    // Visiting order is reversed, `others` must still come out ascending and exclude the target.
    let (trace, cfg) = recording_config(vec![], vec![]);
    let reverse = |c: &mut Vec<EdgeId>, _m: &HashMap<EdgeId, usize>, _r: &mut dyn RngCore| {
        c.sort_unstable_by(|a, b| b.cmp(a));
    };
    let (result, _) = run_pass(vec![(vec![5, 1, 9, 3], 1)], &cfg, 1, |_| true, reverse);
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(*trace.borrow(), vec![(9, vec![1, 3, 5])]);
}

#[test]
fn failed_target_is_dropped_from_later_others_and_never_retried() {
    let (trace, cfg) = recording_config(vec![0], vec![]);
    let (result, commands) = run_pass(vec![(vec![0, 1, 2], 1)], &cfg, 1, |_| true, no_order);
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(*trace.borrow(), vec![(0, vec![1, 2]), (1, vec![2])]);
    assert_eq!(commands, vec![MutationCommand::RemoveEdge { id: 1 }]);
}

#[test]
fn all_candidates_failing_yields_failed_with_no_commands() {
    let (trace, cfg) = recording_config(vec![0, 1, 2], vec![]);
    let (result, commands) = run_pass(vec![(vec![0, 1, 2], 1)], &cfg, 1, |_| true, no_order);
    assert!(matches!(result, RepairResult::Failed));
    assert!(commands.is_empty());
    // Each candidate tried exactly once; later calls no longer see the failed ones.
    assert_eq!(
        *trace.borrow(),
        vec![(0, vec![1, 2]), (1, vec![2]), (2, vec![])]
    );
}

#[test]
fn expired_qc_deadline_stops_the_pass_before_any_nested_call() {
    let (trace, cfg) = recording_config(vec![], vec![]);
    let _deadline = crate::deadline::install(Some(crate::clock::now_ms() - 1.0));
    let (result, commands) = run_pass(vec![(vec![0, 1, 2], 1)], &cfg, 1, |_| true, no_order);
    assert!(matches!(result, RepairResult::Failed));
    assert!(commands.is_empty());
    assert!(trace.borrow().is_empty());
}

#[test]
fn disallowed_element_is_neither_a_target_nor_in_others() {
    let (trace, cfg) = recording_config(vec![], vec![]);
    let (result, _) = run_pass(vec![(vec![0, 1, 2], 1)], &cfg, 1, |e| *e != 1, no_order);
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(*trace.borrow(), vec![(0, vec![2])]);
}

#[test]
fn invalidation_hook_sees_only_others_with_the_nested_commands() {
    let (_trace, cfg) = recording_config(vec![], vec![(0, vec![2])]);
    let seen: Rc<RefCell<Vec<HookCall>>> = Rc::new(RefCell::new(vec![]));
    let seen_hook = seen.clone();
    let maze = empty_maze();
    let issue = TestIssue::new_from_check("test_check", vec![(vec![0, 1, 2], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let (result, _) = group_select_apply::<SquareTessellation, TestKind, _>(
        &issue,
        &maze,
        &mut rng,
        &PresetState::empty(),
        &cfg,
        |_| true,
        one_way_issue,
        |commands, _maze| commands.to_vec(),
        move |commands: &Vec<MutationCommand>, id| {
            seen_hook.borrow_mut().push((*id, commands.clone()));
            false
        },
        no_order,
    );
    assert!(matches!(result, RepairResult::Fixed { .. }));
    // Never offered the target (0); offered every other live candidate once, ascending, each
    // time with the full command list of the single nested fix.
    let expected_commands = vec![
        MutationCommand::RemoveEdge { id: 0 },
        MutationCommand::RemoveEdge { id: 2 },
    ];
    assert_eq!(
        *seen.borrow(),
        vec![(1, expected_commands.clone()), (2, expected_commands)]
    );
}

#[test]
fn invalidated_shared_element_retires_budget_in_every_group_once() {
    // A=[0,1], B=[1,2], C=[3], all to_remove=1. Fixing 0 also removes 1: A is retired by 0 (and
    // not double-decremented by 1), B is retired by 1. So 2 is never tried; 3 still is.
    let (trace, cfg) = recording_config(vec![], vec![(0, vec![1])]);
    let (result, commands) = run_pass(
        vec![(vec![0, 1], 1), (vec![1, 2], 1), (vec![3], 1)],
        &cfg,
        1,
        |_| true,
        no_order,
    );
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(*trace.borrow(), vec![(0, vec![1, 2, 3]), (3, vec![])]);
    assert_eq!(
        commands,
        vec![
            MutationCommand::RemoveEdge { id: 0 },
            MutationCommand::RemoveEdge { id: 1 },
            MutationCommand::RemoveEdge { id: 3 },
        ]
    );
}

#[test]
fn nested_for_turning_none_mid_pass_drops_the_candidate() {
    // `nested_for` accepts 0 in the up-front probe (empty `others`) but rejects it once it is
    // actually visited (non-empty `others`): 0 must be dropped silently and 1 fixed instead.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let (trace, cfg) = recording_config(vec![], vec![]);
    let params = crate::repair::params::build_params(&[], None);
    let groups = vec![(vec![0_usize, 1_usize], 1_u32)];
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind, _>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |e, others| {
            if *e == 0 && !others.is_empty() {
                return None;
            }
            Some((&cfg, &params, one_way_issue("c", e, others)))
        },
        removed_ids,
        removes_edge,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(*trace.borrow(), vec![(1, vec![])]);
    assert_eq!(commands, vec![MutationCommand::RemoveEdge { id: 1 }]);
}

#[test]
fn fully_spent_group_stops_the_pass_early() {
    // to_remove=2 over 4 candidates: exactly two nested calls, the other two are never tried.
    let (trace, cfg) = recording_config(vec![], vec![]);
    let (_, commands) = run_pass(vec![(vec![0, 1, 2, 3], 2)], &cfg, 1, |_| true, no_order);
    assert_eq!(*trace.borrow(), vec![(0, vec![1, 2, 3]), (1, vec![2, 3])]);
    assert_eq!(commands.len(), 2);
}

#[test]
fn trace_is_reproducible_for_a_fixed_seed_with_shuffled_priority_order() {
    // 60 elements across overlapping groups; `order_by_priority` shuffles with the seeded rng.
    // `HashMap` iteration order differs between instances, so two runs only agree if the pass
    // normalizes it (sorted baseline + sorted `others`).
    let groups: Vec<(Vec<EdgeId>, u32)> = (0..20)
        .map(|g| ((g * 3..g * 3 + 9).map(|e| e % 60).collect(), 2))
        .collect();
    let params = crate::repair::params::build_params(&[], None);
    let run = |seed: u64| {
        let (trace, cfg) = recording_config(vec![7, 13], vec![(0, vec![1, 2]), (30, vec![31])]);
        let order = order_by_priority::<EdgeId>(&params);
        let (result, commands) = run_pass(groups.clone(), &cfg, seed, |_| true, order);
        let trace = trace.borrow().clone();
        (
            matches!(result, RepairResult::Fixed { .. }),
            commands,
            trace,
        )
    };
    let first = run(42);
    for _ in 0..5 {
        assert_eq!(run(42), first);
    }
    assert_ne!(
        run(43).2,
        first.2,
        "a different seed should change the visit order"
    );
    assert!(
        first.2.len() > 5,
        "scenario must exercise many nested calls"
    );
}

/// Manual timing of the pass engine alone (GitHub issue #904): 5000 single-edge candidates in one
/// group, nested stub and issue builder both O(1), so what is measured is the pass bookkeeping
/// (`others` construction, invalidation), not any per-candidate payload cloning.
/// `cargo test -p maze-core --release --lib engine_overhead -- --ignored --nocapture`
#[test]
#[ignore = "manual profiling aid"]
fn engine_overhead_timing() {
    let cfg = remove_first_config();
    let group: Vec<EdgeId> = (0..5000).collect();
    let start = std::time::Instant::now();
    let maze = empty_maze();
    let issue = TestIssue::new_from_check("test_check", vec![(group, 5000)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let (_, commands) = group_select_apply::<SquareTessellation, TestKind, _>(
        &issue,
        &maze,
        &mut rng,
        &PresetState::empty(),
        &cfg,
        |_| true,
        |check, target, _others| one_way_issue(check, target, &[]),
        removed_ids,
        removes_edge,
        no_order,
    );
    println!(
        "candidates=5000 nested_calls={} elapsed={:?}",
        commands.len(),
        start.elapsed()
    );
}
