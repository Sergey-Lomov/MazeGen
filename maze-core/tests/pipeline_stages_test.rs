use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use maze_core::Maze;
use maze_core::space::SquareTessellation;
use maze_core::generation::{PresetState, pipeline::{build_maze, RepairLimits}};
use maze_core::quality_control::{
    QualityControlEngine, Rule, RuleTrait, Stage, Check,
    MissingEndpointsCheck, MissingEndpointsIssue, RepairLimitReachedIssue, RepairLimitKind,
};
use maze_core::repair::{FarthestEndpointsStrategy, StrategyParams, MutationCommand};

#[path = "pipeline_common/mod.rs"]
mod pipeline_common;
use pipeline_common::*;

#[test]
fn stage_2_rule_does_not_dispatch_until_stage_1_resolves() {
    // Stage 1: MissingEndpointsCheck/farthest_endpoints, sets start/finish.
    // Stage 2: a strategy that only succeeds once start/finish are both set — records every
    // call so the test can assert it was never invoked before stage 1 finished.
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct RequiresEndpoints {
        calls_before_endpoints_set: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for RequiresEndpoints {
        fn strategy_id(&self) -> &'static str { "requires_endpoints" }

        fn apply(&self, _: &MissingEndpointsIssue, maze: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            if maze.meta.start.is_none() || maze.meta.finish.is_none() {
                self.calls_before_endpoints_set.fetch_add(1, Ordering::SeqCst);
            }
            (RepairResult::Fixed { score: None }, vec![])
        }
    }

    struct AlwaysUnreachableFinishIssueCheck;
    impl Check<SquareTessellation, MissingEndpointsIssue> for AlwaysUnreachableFinishIssueCheck {
        fn check_type_id(&self) -> &'static str { "always_unreachable_finish_check" }

        fn repair_check(&self, maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            // Stand-in "stage 2" issue: fires every QC pass regardless of maze state, so the
            // test can observe whether stage 2 ever dispatches before stage 1 is done — the
            // real gate is `calls_before_endpoints_set` above, not this check's own logic.
            if maze.meta.start.is_none() || maze.meta.finish.is_none() {
                issues.push(MissingEndpointsIssue::new_from_check("stage2_check", true, true));
            }
        }
    }

    let (field, graph) = make_generated_graph(1);
    let calls_before_endpoints_set = Arc::new(AtomicUsize::new(0));
    let qc = two_stages(
        (vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "ga:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
         Box::new(FarthestEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation, MissingEndpointsIssue>>),
        (vec![("stage2_check", Box::new(AlwaysUnreachableFinishIssueCheck))],
         Box::new(RequiresEndpoints { calls_before_endpoints_set: Arc::clone(&calls_before_endpoints_set) })),
    );

    let (maze, _, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    assert!(maze.meta.start.is_some() && maze.meta.finish.is_some(), "stage 1 must have resolved endpoints");
    assert_eq!(calls_before_endpoints_set.load(Ordering::SeqCst), 0,
        "stage 2's strategy must never be dispatched before stage 1 finished resolving endpoints");
}

#[test]
fn failed_rule_in_stage_1_does_not_block_stage_2() {
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct AlwaysFail;
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for AlwaysFail {
        fn strategy_id(&self) -> &'static str { "always_fail" }

        fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            (RepairResult::Failed, vec![])
        }
    }

    let call_count = Arc::new(AtomicUsize::new(0));
    struct CountingFix {
        count: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for CountingFix {
        fn strategy_id(&self) -> &'static str { "counting_fix" }

        fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            self.count.fetch_add(1, Ordering::SeqCst);
            (RepairResult::Fixed { score: None }, vec![])
        }
    }

    // Unconditional issue, independent of maze state — stage 1's rule (`missing_endpoints`)
    // never resolves (AlwaysFail), so a check gated on start/finish being set (like the real
    // UnreachableFinishCheck) would never fire at all; this check fires regardless, isolating
    // the thing under test (does stage 2 dispatch despite stage 1's failure) from whether stage
    // 1's failure incidentally also starves stage 2's own check of its precondition.
    struct AlwaysFinishUnreachableIssueCheck;
    impl Check<SquareTessellation, MissingEndpointsIssue> for AlwaysFinishUnreachableIssueCheck {
        fn check_type_id(&self) -> &'static str { "always_finish_unreachable_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            issues.push(MissingEndpointsIssue::new_from_check("unreachable_finish", true, true));
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = two_stages(
        (vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "ga:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
         Box::new(AlwaysFail) as Box<dyn RepairStrategy<SquareTessellation, MissingEndpointsIssue>>),
        (vec![("unreachable_finish", Box::new(AlwaysFinishUnreachableIssueCheck))],
         Box::new(CountingFix { count: Arc::clone(&call_count) })),
    );

    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    assert!(warnings.iter().any(|i| as_issue::<MissingEndpointsIssue>(i.as_ref()).is_some()), "stage 1's rule must remain unresolved (Failed)");
    assert!(call_count.load(Ordering::SeqCst) > 0, "stage 2 must still have been dispatched despite stage 1's failure");
}

#[test]
fn failed_rule_in_middle_stage_does_not_block_last_stage() {
    // Unlike no-progress (which aborts every later stage — see
    // no_progress_in_middle_stage_aborts_last_stage_too above), a Failed rule only excludes
    // itself from further dispatch within its own stage's loop; it does not stop the stage
    // sequence. 3 stages: stage 1 resolves, stage 2's rule always Failed, stage 3 must still
    // dispatch. failed_rule_in_stage_1_does_not_block_stage_2 above only proves this one stage
    // ahead; this proves it propagates past an intermediate failed stage too.
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct AlwaysFail;
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for AlwaysFail {
        fn strategy_id(&self) -> &'static str { "always_fail" }

        fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            (RepairResult::Failed, vec![])
        }
    }
    struct AlwaysStage2IssueCheck;
    impl Check<SquareTessellation, MissingEndpointsIssue> for AlwaysStage2IssueCheck {
        fn check_type_id(&self) -> &'static str { "always_stage2_issue_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            issues.push(MissingEndpointsIssue::new_from_check("stage2_check", true, true));
        }
    }
    struct AlwaysStage3IssueCheck;
    impl Check<SquareTessellation, MissingEndpointsIssue> for AlwaysStage3IssueCheck {
        fn check_type_id(&self) -> &'static str { "always_stage3_issue_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            issues.push(MissingEndpointsIssue::new_from_check("stage3_check", true, true));
        }
    }
    let stage_3_calls = Arc::new(AtomicUsize::new(0));
    struct CountingFix {
        count: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for CountingFix {
        fn strategy_id(&self) -> &'static str { "counting_fix" }

        fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            self.count.fetch_add(1, Ordering::SeqCst);
            (RepairResult::Fixed { score: None }, vec![])
        }
    }

    let (field, graph) = make_generated_graph(1);
    let rule_1 = Rule::new(
        "g1".to_string(),
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g1:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
        Some(Box::new(FarthestEndpointsStrategy)), HashMap::new(), vec![],
    );
    let rule_2 = Rule::new(
        "g2".to_string(),
        vec![("stage2_check".to_string(), Box::new(AlwaysStage2IssueCheck) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
        Some(Box::new(AlwaysFail)), HashMap::new(), vec![],
    );
    let rule_3 = Rule::new(
        "g3".to_string(),
        vec![("stage3_check".to_string(), Box::new(AlwaysStage3IssueCheck) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
        Some(Box::new(CountingFix { count: Arc::clone(&stage_3_calls) })), HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![
        Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![Box::new(rule_1) as Box<dyn RuleTrait<SquareTessellation>>]),
        Stage::new("stage_2".to_string(), "Stage 2".to_string(), vec![Box::new(rule_2) as Box<dyn RuleTrait<SquareTessellation>>]),
        Stage::new("stage_3".to_string(), "Stage 3".to_string(), vec![Box::new(rule_3) as Box<dyn RuleTrait<SquareTessellation>>]),
    ]);

    let (maze, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    assert!(maze.meta.start.is_some() && maze.meta.finish.is_some(), "stage 1 must have resolved cleanly");
    assert!(warnings.iter().any(|i| as_issue::<MissingEndpointsIssue>(i.as_ref()).is_some()), "stage 2's rule must remain unresolved (Failed)");
    assert!(stage_3_calls.load(Ordering::SeqCst) > 0, "stage 3 must still be dispatched despite stage 2's failure");
}

#[test]
fn shared_repair_limit_stops_mid_stage_2_and_final_qc_still_runs() {
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct OneShotFix;
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for OneShotFix {
        fn strategy_id(&self) -> &'static str { "one_shot_fix" }

        fn apply(&self, _: &MissingEndpointsIssue, maze: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            let mut nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
            nodes.sort_unstable();
            let mut commands = Vec::new();
            if let Some(&first) = nodes.first() { commands.push(MutationCommand::SetStart(first)); }
            if let Some(&last) = nodes.last() { commands.push(MutationCommand::SetFinish(last)); }
            (RepairResult::Fixed { score: None }, commands)
        }
    }

    struct NeverConvergingCheck2 {
        counter: Arc<AtomicUsize>,
    }
    impl Check<SquareTessellation, MissingEndpointsIssue> for NeverConvergingCheck2 {
        fn check_type_id(&self) -> &'static str { "never_converging_check_2" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            let n = self.counter.fetch_add(1, Ordering::SeqCst);
            issues.push(
                MissingEndpointsIssue::new_from_check("unreachable_finish", true, true)
                    .with_detail("unreachable_finish", "tick", n.to_string()),
            );
        }
    }
    struct NoOpFix2;
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for NoOpFix2 {
        fn strategy_id(&self) -> &'static str { "no_op_fix_2" }

        fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            (RepairResult::Fixed { score: None }, vec![])
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = two_stages(
        (vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "ga:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
         Box::new(OneShotFix) as Box<dyn RepairStrategy<SquareTessellation, MissingEndpointsIssue>>),
        (vec![("unreachable_finish", Box::new(NeverConvergingCheck2 { counter: Arc::new(AtomicUsize::new(0)) }))],
         Box::new(NoOpFix2)),
    );

    let limits = RepairLimits::new(Some(3), None).unwrap();
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), limits, None, None, None, None);
    let limit_issue = warnings.iter().find_map(|i| as_issue::<RepairLimitReachedIssue>(i.as_ref())).expect("must surface RepairLimitReachedIssue once budget exhausts mid stage 2");
    assert_eq!(limit_issue.limit, RepairLimitKind::MaxIterations);
    // Final QC pass still ran (it's unconditional) — endpoints resolved by stage 1 remain
    // visible in the maze even though stage 2 never converged.
    assert!(warnings.iter().any(|i| as_issue::<MissingEndpointsIssue>(i.as_ref()).is_some()), "final QC must still surface stage 2's unresolved issue");
}

#[test]
fn empty_stage_list_skips_repair_and_goes_straight_to_final_qc() {
    let (field, graph) = make_generated_graph(1);
    let rule = Rule::new(
        "g".to_string(),
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
        None, HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![Box::new(rule) as Box<dyn RuleTrait<SquareTessellation>>])]);
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    assert!(warnings.iter().any(|i| as_issue::<MissingEndpointsIssue>(i.as_ref()).is_some()), "no stages means no repair, issue surfaces via the final QC pass");
}

#[test]
fn stage_with_only_no_strategy_rules_is_skipped_instantly_between_dispatchable_stages() {
    // Stage 1 resolves endpoints; stage 2 is entirely no-strategy rules (logging-only); stage 3
    // has a real strategy that requires endpoints to already be set. Stage 2 must not block or
    // delay stage 3.
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct RequiresEndpoints {
        called_with_endpoints_set: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for RequiresEndpoints {
        fn strategy_id(&self) -> &'static str { "requires_endpoints" }

        fn apply(&self, _: &MissingEndpointsIssue, maze: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            if maze.meta.start.is_some() && maze.meta.finish.is_some() {
                self.called_with_endpoints_set.fetch_add(1, Ordering::SeqCst);
            }
            (RepairResult::Fixed { score: None }, vec![])
        }
    }
    struct AlwaysIssueCheck;
    impl Check<SquareTessellation, MissingEndpointsIssue> for AlwaysIssueCheck {
        fn check_type_id(&self) -> &'static str { "stage3_check" }

        fn repair_check(&self, maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            if maze.meta.start.is_some() && maze.meta.finish.is_some() {
                issues.push(MissingEndpointsIssue::new_from_check("stage3_check", true, true));
            }
        }
    }

    let (field, graph) = make_generated_graph(1);
    let called_with_endpoints_set = Arc::new(AtomicUsize::new(0));
    let rule_1 = Rule::new(
        "g1".to_string(),
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g1:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
        Some(Box::new(FarthestEndpointsStrategy)), HashMap::new(), vec![],
    );
    let no_strategy_rule: Rule<SquareTessellation, MissingEndpointsIssue> = Rule::new("g_logging".to_string(), vec![], None, HashMap::new(), vec![]);
    let rule_3 = Rule::new(
        "g3".to_string(),
        vec![("stage3_check".to_string(), Box::new(AlwaysIssueCheck) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
        Some(Box::new(RequiresEndpoints { called_with_endpoints_set: Arc::clone(&called_with_endpoints_set) })), HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![
        Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![Box::new(rule_1) as Box<dyn RuleTrait<SquareTessellation>>]),
        Stage::new("stage_2".to_string(), "Stage 2".to_string(), vec![Box::new(no_strategy_rule) as Box<dyn RuleTrait<SquareTessellation>>]),
        Stage::new("stage_3".to_string(), "Stage 3".to_string(), vec![Box::new(rule_3) as Box<dyn RuleTrait<SquareTessellation>>]),
    ]);

    let (maze, _, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    assert!(maze.meta.start.is_some() && maze.meta.finish.is_some());
    // stage_with_only_no_strategy_rules test above proves no_strategy_rule doesn't BLOCK later
    // stages; it uses an empty checks vec so it can't tell whether the rule's own checks ran mid-loop
    // at all vs. were skipped by a filter-order bug. See no_strategy_rule_checks_run_every_iteration
    // below for that.
    assert!(called_with_endpoints_set.load(Ordering::SeqCst) > 0, "stage 3 must dispatch after stage 1, unaffected by no-strategy stage 2");
}

#[test]
fn no_strategy_rule_checks_run_every_iteration_not_just_final_report() {
    // Regression: Stage::collect_active used to filter out no-strategy rules BEFORE calling
    // run_checks, so a no-strategy rule's checks never ran during the repair fixpoint loop —
    // only once, in the final unconditional report pass. This rule's check has a real,
    // non-empty checks vec with a call counter, so it can distinguish "ran every iteration" from
    // "only ran once at the end".
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct CountingCheck {
        calls: Arc<AtomicUsize>,
    }
    impl Check<SquareTessellation, MissingEndpointsIssue> for CountingCheck {
        fn check_type_id(&self) -> &'static str { "counting_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, _issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            self.calls.fetch_add(1, Ordering::SeqCst);
        }
    }
    struct MultiIterationFix {
        counter: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for MultiIterationFix {
        fn strategy_id(&self) -> &'static str { "multi_iteration_fix" }

        fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            self.counter.fetch_add(1, Ordering::SeqCst);
            (RepairResult::Fixed { score: None }, vec![])
        }
    }
    // Ticks a shared counter into each issue's detail, same technique as `NeverConvergingCheck`
    // above — so the raw issue genuinely differs iteration to iteration, never tripping the
    // no-progress guard, letting the loop run all the way to `max_iterations`.
    struct AlwaysMissingEndpointsCheck {
        counter: Arc<AtomicUsize>,
    }
    impl Check<SquareTessellation, MissingEndpointsIssue> for AlwaysMissingEndpointsCheck {
        fn check_type_id(&self) -> &'static str { "always_missing_endpoints" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            let n = self.counter.fetch_add(1, Ordering::SeqCst);
            issues.push(
                MissingEndpointsIssue::new_from_check("always_missing_endpoints", true, true)
                    .with_detail("always_missing_endpoints", "tick", n.to_string()),
            );
        }
    }

    let (field, graph) = make_generated_graph(1);
    let no_strategy_check_calls = Arc::new(AtomicUsize::new(0));
    let strategy_calls = Arc::new(AtomicUsize::new(0));

    let dispatchable_rule = Rule::new(
        "g_dispatch".to_string(),
        vec![("always_missing_endpoints".to_string(), Box::new(AlwaysMissingEndpointsCheck { counter: Arc::new(AtomicUsize::new(0)) }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
        Some(Box::new(MultiIterationFix { counter: Arc::clone(&strategy_calls) })), HashMap::new(), vec![],
    );
    let no_strategy_rule = Rule::new(
        "g_logging".to_string(),
        vec![("counting_check".to_string(), Box::new(CountingCheck { calls: Arc::clone(&no_strategy_check_calls) }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
        None, HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![
        Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![
            Box::new(dispatchable_rule) as Box<dyn RuleTrait<SquareTessellation>>,
            Box::new(no_strategy_rule) as Box<dyn RuleTrait<SquareTessellation>>,
        ]),
    ]);

    let limits = RepairLimits::new(Some(3), None).unwrap();
    let (_, _, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), limits, None, None, None, None);

    // MultiIterationFix always returns Fixed but never actually resolves MISSING_ENDPOINTS
    // (it never sets maze.meta.start/finish), so the check fires again every iteration until
    // the 3-iteration cap — 3 strategy calls means 3 loop iterations ran.
    assert_eq!(strategy_calls.load(Ordering::SeqCst), 3, "loop must run exactly max_iterations times");
    // The no-strategy rule's check must have run once per loop iteration too, not just once in
    // the final report pass — before the fix this asserted 1 (final report only).
    assert_eq!(no_strategy_check_calls.load(Ordering::SeqCst), 4,
        "no-strategy rule's check must run every fixpoint iteration (3) plus the final report pass (1), not just the final report");
}

/// End-to-end regression for GitHub issue #170: a strategy that always proposes removing an
/// already-removed edge (so `ApplyOutcome` is always `applied == 0, proposed == 1`), paired with
/// a check whose issue content genuinely differs every iteration — the exact "no-progress guard
/// never fires" scenario the issue describes. Without any no-progress guard left, termination is
/// now guaranteed purely by `RepairLimits`.
#[test]
fn pipeline_terminates_via_repair_limits_when_content_keeps_changing_but_nothing_ever_applies() {
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct TickingCheck {
        counter: Arc<AtomicUsize>,
    }
    impl Check<SquareTessellation, MissingEndpointsIssue> for TickingCheck {
        fn check_type_id(&self) -> &'static str { "ticking_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            let n = self.counter.fetch_add(1, Ordering::SeqCst);
            issues.push(
                MissingEndpointsIssue::new_from_check("ticking_check", true, true)
                    .with_detail("ticking_check", "tick", n.to_string()),
            );
        }
    }

    struct AlwaysProposesAnAlreadyRemovedEdge {
        edge_id: maze_core::ids::EdgeId,
        calls: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for AlwaysProposesAnAlreadyRemovedEdge {
        fn strategy_id(&self) -> &'static str { "always_proposes_stale_removal" }

        fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            self.calls.fetch_add(1, Ordering::SeqCst);
            // The edge behind this id was already removed before the pipeline ever started (see
            // below) — every apply() call proposes removing it again, and apply_commands must
            // revalidate-and-drop it every single time (RemoveEdge { id } -> can_remove_edge is
            // false once the edge is gone), so applied stays 0 forever.
            (RepairResult::Fixed { score: None }, vec![MutationCommand::RemoveEdge { id: self.edge_id }])
        }
    }

    let (field, mut graph) = make_generated_graph(1);
    let edge_id = graph.edges().next().map(|e| e.id).expect("generated graph must have at least one edge");
    graph.remove_initial_edge(edge_id);

    let calls = Arc::new(AtomicUsize::new(0));
    let qc = engine_with_rule(
        vec![("ticking_check", Box::new(TickingCheck { counter: Arc::new(AtomicUsize::new(0)) }))],
        Box::new(AlwaysProposesAnAlreadyRemovedEdge { edge_id, calls: Arc::clone(&calls) }),
    );

    let limits = RepairLimits::new(Some(5), None).unwrap();
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), limits, None, None, None, None);

    assert_eq!(calls.load(Ordering::SeqCst), 5,
        "with no no-progress guard left, the loop must run the strategy every iteration up to max_iterations");
    let limit_issue = warnings.iter().find_map(|i| as_issue::<RepairLimitReachedIssue>(i.as_ref())).expect("must surface a RepairLimitReachedIssue");
    assert_eq!(limit_issue.limit, RepairLimitKind::MaxIterations);
}

/// Regression for GitHub issue #280: a rule whose strategy returns `Failed` once must not be
/// permanently blacklisted for the rest of the stage's fixpoint loop — only until the graph
/// actually mutates. Two rules share one stage: `flaky` fails on its first call, then always
/// succeeds; `mutator` always mutates the graph (toggling one edge) and always succeeds. Since
/// `mutator` bumps `Graph::version()` every pass, `flaky` must be retried on the very next
/// iteration and resolve — before the #280 fix, `flaky`'s single early failure would have
/// blacklisted it for the rest of the run, leaving its issue unresolved.
#[test]
fn failed_rule_is_retried_once_a_later_pass_mutates_the_graph() {
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct AlwaysMissingEndpointsCheck;
    impl Check<SquareTessellation, MissingEndpointsIssue> for AlwaysMissingEndpointsCheck {
        fn check_type_id(&self) -> &'static str { "always_missing_endpoints" }

        fn repair_check(&self, maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            if maze.meta.start.is_none() || maze.meta.finish.is_none() {
                issues.push(MissingEndpointsIssue::new_from_check("always_missing_endpoints", true, true));
            }
        }
    }

    // Fails exactly once (its first call), then always resolves endpoints.
    struct FlakyThenFixed {
        calls: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for FlakyThenFixed {
        fn strategy_id(&self) -> &'static str { "flaky_then_fixed" }

        fn apply(&self, _: &MissingEndpointsIssue, maze: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                return (RepairResult::Failed, vec![]);
            }
            let mut nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
            nodes.sort_unstable();
            let mut commands = Vec::new();
            if let Some(&first) = nodes.first() { commands.push(MutationCommand::SetStart(first)); }
            if let Some(&last) = nodes.last() { commands.push(MutationCommand::SetFinish(last)); }
            (RepairResult::Fixed { score: None }, commands)
        }
    }

    // Fires every pass regardless of maze state, always toggles one edge so `Graph::version()`
    // keeps bumping every single call instead of settling once mutated.
    struct AlwaysMutatorIssueCheck;
    impl Check<SquareTessellation, MissingEndpointsIssue> for AlwaysMutatorIssueCheck {
        fn check_type_id(&self) -> &'static str { "always_mutator_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            issues.push(MissingEndpointsIssue::new_from_check("always_mutator_check", true, true));
        }
    }
    struct AlwaysMutates;
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for AlwaysMutates {
        fn strategy_id(&self) -> &'static str { "always_mutates" }

        fn apply(&self, _: &MissingEndpointsIssue, maze: &Maze<SquareTessellation>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            let mut nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
            nodes.sort_unstable();
            let (a, b) = (nodes[0], nodes[1]);
            let commands = if maze.graph.edge_between(a, b).is_some() {
                vec![MutationCommand::RemoveEdgeBetween { from: a, to: b }]
            } else {
                vec![MutationCommand::AddDirectedEdge { from: a, to: b }]
            };
            (RepairResult::Fixed { score: None }, commands)
        }
    }

    let (field, graph) = make_generated_graph(1);
    let flaky_calls = Arc::new(AtomicUsize::new(0));
    let qc = two_rules(
        (vec![("always_missing_endpoints", Box::new(AlwaysMissingEndpointsCheck) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
         Box::new(FlakyThenFixed { calls: Arc::clone(&flaky_calls) }) as Box<dyn RepairStrategy<SquareTessellation, MissingEndpointsIssue>>),
        (vec![("always_mutator_check", Box::new(AlwaysMutatorIssueCheck))],
         Box::new(AlwaysMutates) as Box<dyn RepairStrategy<SquareTessellation, MissingEndpointsIssue>>),
    );

    let limits = RepairLimits::new(Some(5), None).unwrap();
    let (maze, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), limits, None, None, None, None);

    assert!(flaky_calls.load(Ordering::SeqCst) > 1,
        "flaky rule must be retried after its first Failed once the graph mutates, not permanently skipped");
    assert!(maze.meta.start.is_some() && maze.meta.finish.is_some(),
        "flaky rule's issue must eventually resolve once it is retried");
    assert!(!warnings.iter().any(|i| as_issue::<MissingEndpointsIssue>(i.as_ref()).is_some() && i.source_checks().iter().any(|s| s == "always_missing_endpoints")),
        "flaky rule's MissingEndpoints issue must not remain unresolved");
}
