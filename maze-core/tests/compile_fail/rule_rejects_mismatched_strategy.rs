// A `Rule<T, InvalidLoopIssue>` must not accept a strategy for a different Issue type (here
// `MissingLoopsRandomStrategy: RepairStrategy<T, MissingLoopsIssue>`) — see GitHub issue #113.
use maze_core::quality_control::InvalidLoopIssue;
use maze_core::quality_control::Rule;
use maze_core::repair::MissingLoopsRandomStrategy;
use maze_core::space::SquareTessellation;
use std::collections::HashMap;

fn main() {
    let checks: Vec<(String, Box<dyn maze_core::quality_control::Check<SquareTessellation, InvalidLoopIssue>>)> = vec![];
    let _rule: Rule<SquareTessellation, InvalidLoopIssue> = Rule::new(
        "r".to_string(), checks, Some(Box::new(MissingLoopsRandomStrategy)), HashMap::new(), vec![],
    );
}
