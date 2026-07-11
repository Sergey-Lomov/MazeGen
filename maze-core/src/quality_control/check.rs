use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use super::issue::Issue;

pub trait Check<T: Tessellation, I: Issue> {
    /// Check **type** id — matches `maze-wasm`'s `CheckInstanceConfig.type_id` / `available_checks()`'s
    /// `CheckDescriptor.id` (e.g. `"min_loop_length"`). Distinct from `instance_id` (the per-instance
    /// composite routing key, e.g. `"rule_1:a"`) — used to aggregate per-check-type timing across
    /// instances, since two instances of the same type (GitHub issue #60) should report under one type.
    fn check_type_id(&self) -> &'static str;

    /// Detection for the repair fixpoint loop — may bundle every flagged problem instance into
    /// one merged issue per call (e.g. `MinLoopLengthCheck` bundles all short cycles into one
    /// `InvalidLoopIssue`), since the loop dispatches one repair strategy call per rule against
    /// the batch.
    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<I>, rng: &mut dyn RngCore);

    /// Detection for the final QC report (`remaining_issues`, analytics, UI) — one issue per
    /// flagged problem instance instead of one merged issue per call. Default implementation
    /// delegates to `repair_check` (calls it into a temporary `Vec` and returns it) — no behavior
    /// change for a check that doesn't override it.
    fn report_check(&self, maze: &Maze<T>, rng: &mut dyn RngCore) -> Vec<I> {
        let mut issues = Vec::new();
        self.repair_check(maze, &mut issues, rng);
        issues
    }
}
