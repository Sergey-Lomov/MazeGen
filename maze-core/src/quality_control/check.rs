use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use super::issue::{Issue, IssueRequirement};

pub trait Check<T: Tessellation, I: IssueRequirement> {
    /// Check **type** id — matches `maze-wasm`'s `CheckInstanceConfig.type_id` / `available_checks()`'s
    /// `CheckDescriptor.id` (e.g. `"min_loop_length"`). Distinct from `instance_id` (the per-instance
    /// composite routing key, e.g. `"rule_1:a"`) — used to aggregate per-check-type timing across
    /// instances, since two instances of the same type (GitHub issue #60) should report under one type.
    fn check_type_id(&self) -> &'static str;

    /// Detection for the repair fixpoint loop — may bundle every flagged problem instance into
    /// one merged issue per call (e.g. `MinLoopLengthCheck` bundles all short cycles into one
    /// `InvalidLoopIssue`), since the loop dispatches one repair strategy call per rule against
    /// the batch. `requirement` is the bound rule's strategy's `RepairStrategy::requirement()`,
    /// resolved once by `Rule::new` — see GitHub issue #105. A check is free to ignore it and
    /// always compute the maximal `I` (the correct default for an unmigrated check).
    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<I>, rng: &mut dyn RngCore, requirement: I::Requirement);

    /// Detection for the final QC report (`remaining_issues`, analytics, UI) — one issue per
    /// flagged problem instance instead of one merged issue per call. Default implementation
    /// delegates to `repair_check` with `I::Requirement::default()` (calls it into a temporary
    /// `Vec` and returns it) — this path has no strategy to consult, so it always asks for
    /// everything (see `IssueRequirement`'s contract). No behavior change for a check that
    /// doesn't override it.
    fn report_check(&self, maze: &Maze<T>, rng: &mut dyn RngCore) -> Vec<I> {
        let mut issues = Vec::new();
        self.repair_check(maze, &mut issues, rng, I::Requirement::default());
        issues
    }
}
