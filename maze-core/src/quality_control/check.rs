use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use super::issue::Issue;

pub trait Check<T: Tessellation> {
    /// Check **type** id — matches `maze-wasm`'s `CheckInstanceConfig.type_id` / `available_checks()`'s
    /// `CheckDescriptor.id` (e.g. `"min_loop_length"`). Distinct from `instance_id` (the per-instance
    /// composite routing key, e.g. `"rule_1:a"`) — used to aggregate per-check-type timing across
    /// instances, since two instances of the same type (GitHub issue #60) should report under one type.
    fn check_type_id(&self) -> &'static str;

    /// Detection for the repair fixpoint loop — may bundle every flagged problem instance into
    /// one merged `Issue` per call (e.g. `MinLoopLengthCheck` bundles all short cycles into one
    /// `IssueData::InvalidLoops`), since the loop dispatches one repair strategy call per rule
    /// against the batch.
    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, rng: &mut dyn RngCore);

    /// Detection for the final QC report (`remaining_issues`, analytics, UI) — one `Issue` per
    /// flagged problem instance instead of one merged `Issue` per call, so a batched issue can be
    /// split into accurate per-item counts and per-item highlighting. Default delegates to
    /// `repair_check`, so overriding is opt-in and costs nothing for checks that already produce
    /// one issue per call. See GitHub issue #102.
    fn report_check(&self, maze: &Maze<T>, rng: &mut dyn RngCore) -> Vec<Issue> {
        let mut issues = Vec::new();
        self.repair_check(maze, &mut issues, rng);
        issues
    }
}
