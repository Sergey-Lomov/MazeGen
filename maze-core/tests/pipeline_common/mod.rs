#![allow(dead_code)]

use maze_core::generation::{GenerationConfig, PresetState, generate_maze};
use maze_core::quality_control::{
    Check, Issue, IssueMerge, IssueRequirement, MissingEndpointsCheck, MissingEndpointsIssue,
    QualityControlEngine, Rule, RuleTrait, Stage, UnreachableFinishCheck,
};
use maze_core::repair::{
    FarthestEndpointsStrategy, MutationCommand, RepairStrategy, StrategyParams,
};
use maze_core::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use maze_core::{Graph, IdGenerator, Maze};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

pub type BoxedCheck<T, I> = Box<dyn Check<T, I>>;

/// Downcasts a `&dyn Issue` (a `remaining_issues`/`warnings` entry) to a concrete `I`, `None` if
/// it's a different kind — the erased-boundary equivalent of the old `issue.kind == KIND` check.
pub fn as_issue<I: Issue>(issue: &dyn Issue) -> Option<&I> {
    issue.as_any().downcast_ref::<I>()
}

/// Builds a single-rule, single-stage `QualityControlEngine`: one rule owning all of `checks`,
/// dispatching to `strategy`. Covers the common single-strategy-per-kind test shape without
/// repeating the `Rule`/`Stage` boilerplate at every call site — replaces the pre-#106
/// `engine_with_rule` (which built a separate `QualityControlEngine`+`RepairEngine` pair; checks
/// now live physically inside the `Rule`).
pub fn engine_with_rule<
    T: maze_core::space::Tessellation + 'static,
    I: IssueRequirement + IssueMerge + 'static,
>(
    checks: Vec<(&str, BoxedCheck<T, I>)>,
    strategy: Box<dyn RepairStrategy<T, I>>,
) -> QualityControlEngine<T> {
    let checks: Vec<(String, BoxedCheck<T, I>)> = checks
        .into_iter()
        .map(|(id, c)| (id.to_string(), c))
        .collect();
    let rule = Rule::new(
        "g".to_string(),
        checks,
        Some(strategy),
        HashMap::new(),
        vec![],
    );
    QualityControlEngine::new(vec![Stage::new(
        "stage_1".to_string(),
        "Stage 1".to_string(),
        vec![Box::new(rule) as Box<dyn RuleTrait<T>>],
    )])
}

/// Builds a `QualityControlEngine` with two independent single-check rules, each with its own
/// strategy and own Issue type, both in the same single stage (same rationale as
/// `engine_with_rule`).
pub fn two_rules<
    T: maze_core::space::Tessellation + 'static,
    IA: IssueRequirement + IssueMerge + 'static,
    IB: IssueRequirement + IssueMerge + 'static,
>(
    a: (
        Vec<(&str, BoxedCheck<T, IA>)>,
        Box<dyn RepairStrategy<T, IA>>,
    ),
    b: (
        Vec<(&str, BoxedCheck<T, IB>)>,
        Box<dyn RepairStrategy<T, IB>>,
    ),
) -> QualityControlEngine<T> {
    let (checks_a, strategy_a) = a;
    let (checks_b, strategy_b) = b;
    let checks_a: Vec<(String, BoxedCheck<T, IA>)> = checks_a
        .into_iter()
        .map(|(id, c)| (id.to_string(), c))
        .collect();
    let checks_b: Vec<(String, BoxedCheck<T, IB>)> = checks_b
        .into_iter()
        .map(|(id, c)| (id.to_string(), c))
        .collect();
    let rule_a = Rule::new(
        "ga".to_string(),
        checks_a,
        Some(strategy_a),
        HashMap::new(),
        vec![],
    );
    let rule_b = Rule::new(
        "gb".to_string(),
        checks_b,
        Some(strategy_b),
        HashMap::new(),
        vec![],
    );
    QualityControlEngine::new(vec![Stage::new(
        "stage_1".to_string(),
        "Stage 1".to_string(),
        vec![
            Box::new(rule_a) as Box<dyn RuleTrait<T>>,
            Box::new(rule_b) as Box<dyn RuleTrait<T>>,
        ],
    )])
}

/// Builds a two-stage `QualityControlEngine`: stage 1 has `rule_a` (strategy `strategy_a`),
/// stage 2 has `rule_b` (strategy `strategy_b`) — same shape `two_rules` uses, but split across
/// two `Stage`s instead of one.
pub fn two_stages<
    T: maze_core::space::Tessellation + 'static,
    IA: IssueRequirement + IssueMerge + 'static,
    IB: IssueRequirement + IssueMerge + 'static,
>(
    a: (
        Vec<(&str, BoxedCheck<T, IA>)>,
        Box<dyn RepairStrategy<T, IA>>,
    ),
    b: (
        Vec<(&str, BoxedCheck<T, IB>)>,
        Box<dyn RepairStrategy<T, IB>>,
    ),
) -> QualityControlEngine<T> {
    let (checks_a, strategy_a) = a;
    let (checks_b, strategy_b) = b;
    let checks_a: Vec<(String, BoxedCheck<T, IA>)> = checks_a
        .into_iter()
        .map(|(id, c)| (id.to_string(), c))
        .collect();
    let checks_b: Vec<(String, BoxedCheck<T, IB>)> = checks_b
        .into_iter()
        .map(|(id, c)| (id.to_string(), c))
        .collect();
    let rule_a = Rule::new(
        "ga".to_string(),
        checks_a,
        Some(strategy_a),
        HashMap::new(),
        vec![],
    );
    let rule_b = Rule::new(
        "gb".to_string(),
        checks_b,
        Some(strategy_b),
        HashMap::new(),
        vec![],
    );
    QualityControlEngine::new(vec![
        Stage::new(
            "stage_1".to_string(),
            "Stage 1".to_string(),
            vec![Box::new(rule_a) as Box<dyn RuleTrait<T>>],
        ),
        Stage::new(
            "stage_2".to_string(),
            "Stage 2".to_string(),
            vec![Box::new(rule_b) as Box<dyn RuleTrait<T>>],
        ),
    ])
}

/// Mirrors the pre-#106 `make_engines`: a `missing_endpoints` rule dispatching
/// `FarthestEndpointsStrategy`, plus an `unreachable_finish` check that runs (and can surface via
/// the final report) but has no strategy of its own — the old flat `qc`/`repair` split let a
/// check run unrouted; here that's a `Rule` with `strategy: None`.
pub fn make_engines() -> QualityControlEngine<SquareTessellation> {
    let missing_endpoints_rule = Rule::new(
        "g".to_string(),
        vec![(
            "missing_endpoints".to_string(),
            Box::new(MissingEndpointsCheck {
                instance_id: "g:missing_endpoints".to_string(),
            }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>,
        )],
        Some(Box::new(FarthestEndpointsStrategy)),
        HashMap::new(),
        vec![],
    );
    let unreachable_finish_rule = Rule::new(
        "u".to_string(),
        vec![(
            "unreachable_finish".to_string(),
            Box::new(UnreachableFinishCheck {
                instance_id: "u:unreachable_finish".to_string(),
            }),
        )],
        None,
        HashMap::new(),
        vec![],
    );
    QualityControlEngine::new(vec![Stage::new(
        "stage_1".to_string(),
        "Stage 1".to_string(),
        vec![
            Box::new(missing_endpoints_rule) as Box<dyn RuleTrait<SquareTessellation>>,
            Box::new(unreachable_finish_rule) as Box<dyn RuleTrait<SquareTessellation>>,
        ],
    )])
}

pub fn make_generated_graph(seed: u64) -> (MultiLevelField<SquareTessellation>, Graph) {
    let mut ids = IdGenerator::new();
    let mut field = MultiLevelField::single_level(square_rect(5, 5), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let start = field
        .nodes_at(level, SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();
    generate_maze(
        &mut graph,
        &mut field,
        &mut ids,
        seed,
        start,
        GenerationConfig::default(),
        &PresetState::empty(),
    );
    (field, graph)
}

/// A `Check` that always reports the same `MissingEndpointsIssue` but with a `detail` value that
/// flips every call (via a shared counter) — so the raw issue (and, after merge, the
/// `(rule_id, Issue)` pair the progress guard compares) genuinely differs iteration to iteration,
/// never triggering the no-progress break. Paired with a strategy that always returns `Fixed`
/// without resolving anything, the loop only ever stops via `RepairLimits`, never convergence or
/// no-progress — letting `pipeline_stops_at_max_iterations_cap` and `pipeline_stops_at_time_budget`
/// exercise the cap in isolation.
struct NeverConvergingCheck {
    counter: Arc<AtomicUsize>,
}
impl Check<SquareTessellation, MissingEndpointsIssue> for NeverConvergingCheck {
    fn check_type_id(&self) -> &'static str {
        "never_converging_check"
    }

    fn repair_check(
        &self,
        _maze: &Maze<SquareTessellation>,
        issues: &mut Vec<MissingEndpointsIssue>,
        _rng: &mut dyn rand::RngCore,
        _requirement: (),
    ) {
        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        issues.push(
            MissingEndpointsIssue::new_from_check("missing_endpoints", true, true).with_detail(
                "missing_endpoints",
                "tick",
                n.to_string(),
            ),
        );
    }
}

pub fn never_converging_setup(
    on_apply: impl Fn() + Send + Sync + 'static,
) -> (
    MultiLevelField<SquareTessellation>,
    Graph,
    QualityControlEngine<SquareTessellation>,
) {
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct NoOpFix<F> {
        on_apply: F,
    }
    impl<F: Fn() + Send + Sync> RepairStrategy<SquareTessellation, MissingEndpointsIssue>
        for NoOpFix<F>
    {
        fn strategy_id(&self) -> &'static str {
            "no_op_fix"
        }

        fn apply(
            &self,
            _: &MissingEndpointsIssue,
            _: &Maze<SquareTessellation>,
            _: &mut dyn rand::RngCore,
            _: &StrategyParams,
            _: &PresetState,
            _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            (self.on_apply)();
            (RepairResult::Fixed { score: None }, vec![])
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = engine_with_rule(
        vec![(
            "missing_endpoints",
            Box::new(NeverConvergingCheck {
                counter: Arc::new(AtomicUsize::new(0)),
            }),
        )],
        Box::new(NoOpFix { on_apply }),
    );
    (field, graph, qc)
}
