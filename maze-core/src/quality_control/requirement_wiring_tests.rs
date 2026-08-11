use std::cell::RefCell;
use rand::SeedableRng;
use crate::space::SquareTessellation;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};
use crate::repair::{RepairResult, RepairStrategy, NestedStrategyConfig, MutationCommand};
use crate::repair::params::StrategyParams;
use crate::generation::PresetState;
use super::*;

/// Records every `requirement` value it's called with — lets the test assert exactly what
/// `Rule::run_checks_typed` threads through, not just that *an* issue was produced.
struct RecordingCheck {
    received: std::rc::Rc<RefCell<Vec<InvalidLoopRequirement>>>,
}
impl Check<SquareTessellation, InvalidLoopIssue> for RecordingCheck {
    fn check_type_id(&self) -> &'static str { "recording_check" }
    fn repair_check(&self, _maze: &Maze<SquareTessellation>, _issues: &mut Vec<InvalidLoopIssue>, _rng: &mut dyn RngCore, requirement: InvalidLoopRequirement) {
        self.received.borrow_mut().push(requirement);
    }
}

struct InvalidOnlyStrategy;
impl RepairStrategy<SquareTessellation, InvalidLoopIssue> for InvalidOnlyStrategy {
    fn strategy_id(&self) -> &'static str { "invalid_only_test_strategy" }
    fn requirement(&self, _params: &StrategyParams) -> InvalidLoopRequirement {
        InvalidLoopRequirement::empty()
    }
    fn apply(
        &self, _issue: &InvalidLoopIssue, _maze: &Maze<SquareTessellation>,
        _rng: &mut dyn RngCore, _params: &StrategyParams,
        _preset_state: &PresetState, _nested: &[NestedStrategyConfig<SquareTessellation>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        (RepairResult::Fixed { score: None }, vec![])
    }
}

fn empty_maze() -> Maze<SquareTessellation> {
    let mut ids = crate::IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(crate::space::square_rect(1, 1), &mut ids).unwrap();
    let mut g = crate::Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    Maze::new(field, g)
}

#[test]
fn run_checks_typed_threads_the_strategys_resolved_requirement_into_repair_check() {
    let received = std::rc::Rc::new(RefCell::new(Vec::new()));
    let check = RecordingCheck { received: received.clone() };
    let rule: Rule<SquareTessellation, InvalidLoopIssue> = Rule::new(
        "r".to_string(),
        vec![("a".to_string(), Box::new(check) as Box<dyn Check<SquareTessellation, InvalidLoopIssue>>)],
        Some(Box::new(InvalidOnlyStrategy)),
        HashMap::new(),
        vec![],
    );

    let maze = empty_maze();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    let mut timing = HashMap::new();
    rule.run_checks_typed(&maze, &mut rng, &PresetState::empty(), &mut timing, &|| 0.0, None);

    assert_eq!(received.borrow().as_slice(), &[InvalidLoopRequirement::empty()],
        "the strategy's resolved requirement must reach the check's repair_check call");
}

#[test]
fn no_fix_rule_falls_back_to_full() {
    let received = std::rc::Rc::new(RefCell::new(Vec::new()));
    let check = RecordingCheck { received: received.clone() };
    let rule: Rule<SquareTessellation, InvalidLoopIssue> = Rule::new(
        "r".to_string(),
        vec![("a".to_string(), Box::new(check) as Box<dyn Check<SquareTessellation, InvalidLoopIssue>>)],
        None,
        HashMap::new(),
        vec![],
    );

    let maze = empty_maze();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    let mut timing = HashMap::new();
    rule.run_checks_typed(&maze, &mut rng, &PresetState::empty(), &mut timing, &|| 0.0, None);

    assert_eq!(received.borrow().as_slice(), &[InvalidLoopRequirement::all()],
        "a rule with no strategy (no_fix) must still pass all() to its checks");
}
