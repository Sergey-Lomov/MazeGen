// A `Rule<T, InvalidLoopIssue>` must not accept a check that produces a different Issue type
// (here `MinLoopsCountCheck: Check<T, MissingLoopsIssue>`) — see GitHub issue #113.
use maze_core::quality_control::{Rule, InvalidLoopIssue, MinLoopsCountCheck};
use maze_core::space::SquareTessellation;
use std::collections::HashMap;

fn main() {
    let checks: Vec<(String, Box<dyn maze_core::quality_control::Check<SquareTessellation, InvalidLoopIssue>>)> = vec![
        ("a".to_string(), Box::new(MinLoopsCountCheck { instance_id: "a".to_string(), min_loops: 1 })),
    ];
    let _rule: Rule<SquareTessellation, InvalidLoopIssue> = Rule::new("r".to_string(), checks, None, HashMap::new(), vec![]);
}
