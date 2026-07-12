// `RepairStrategy<T, I>::apply` must not accept an `Issue` of a different concrete type — here
// `MissingLoopsRandomStrategy: RepairStrategy<T, MissingLoopsIssue>` called with an
// `InvalidLoopIssue` — see GitHub issue #113.
use maze_core::quality_control::InvalidLoopIssue;
use maze_core::repair::{MissingLoopsRandomStrategy, RepairStrategy};
use maze_core::space::SquareTessellation;

fn assert_apply<T: maze_core::space::Tessellation, I: maze_core::quality_control::IssueRequirement, S: RepairStrategy<T, I>>(
    strategy: &S,
    issue: &I,
    maze: &mut maze_core::Maze<T>,
    snapshots: &mut maze_core::repair::SnapshotStack,
    rng: &mut dyn rand::RngCore,
    params: &maze_core::repair::StrategyParams,
    preset_state: &maze_core::generation::PresetState,
) {
    let _ = strategy.apply(issue, maze, snapshots, rng, params, preset_state, &[]);
}

fn call<T: maze_core::space::Tessellation>(
    maze: &mut maze_core::Maze<T>,
    snapshots: &mut maze_core::repair::SnapshotStack,
    rng: &mut dyn rand::RngCore,
    params: &maze_core::repair::StrategyParams,
    preset_state: &maze_core::generation::PresetState,
) {
    let strategy = MissingLoopsRandomStrategy;
    let issue = InvalidLoopIssue::new_from_check("check", 0, vec![], vec![], vec![]);
    assert_apply::<T, _, _>(&strategy, &issue, maze, snapshots, rng, params, preset_state);
}

fn main() {
    let _ = call::<SquareTessellation>;
}
