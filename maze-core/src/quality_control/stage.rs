use std::collections::HashMap;
use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::repair::RepairResult;
use crate::quality_control::issue_kinds::RepairLimitKind;
use super::engine::RepairBudget;
use super::issue::Issue;
use super::rule::RuleTrait;

/// Result of one `Stage::run_repair` call — what happened to this stage's own fixpoint loop.
/// `QualityControlEngine::run_repair_stages` decides what to do next (advance, or stop the whole
/// stage sequence) based on this — a `Stage` never knows whether it is the last one or not.
pub(crate) enum StageOutcome {
    Done,
    LimitReached(RepairLimitKind),
    NoProgress(Vec<String>),
}

/// Bundles the timing accumulators `Stage::run_repair` threads through one fixpoint loop —
/// `per_check`/`per_strategy` in the same `(total_ms, calls)` tuple form the pre-#106 `run_timed`
/// used, `qc_total_ms`/`repair_total_ms` the stage-level totals. The caller
/// (`QualityControlEngine::run_repair_stages`) folds `per_check`/`per_strategy` into
/// `GenerationTiming`'s `TimingEntry` maps once, after every stage has run. Bundled into one
/// struct rather than four separate `&mut` parameters purely to keep `run_repair`'s signature
/// from growing every time a new timing dimension is added.
pub(crate) struct TimingSink<'a> {
    pub per_check: &'a mut HashMap<&'static str, (f64, u32)>,
    pub per_strategy: &'a mut HashMap<&'static str, (f64, u32)>,
    pub qc_total_ms: &'a mut f64,
    pub repair_total_ms: &'a mut f64,
}

/// A user-defined, named, ordered group of `Rule`s — drives its own fixpoint repair loop over
/// only its own rules' checks (stage-scoped QC, see GitHub issue #106), sharing a single
/// `RepairBudget` with every other stage in the same `QualityControlEngine::run_full` call.
pub struct Stage<T: Tessellation> {
    pub id: String,
    pub name: String,
    rules: Vec<Box<dyn RuleTrait<T>>>,
}

impl<T: Tessellation> Stage<T> {
    pub fn new(id: String, name: String, rules: Vec<Box<dyn RuleTrait<T>>>) -> Self {
        Self { id, name, rules }
    }

    pub fn rules(&self) -> &[Box<dyn RuleTrait<T>>] {
        &self.rules
    }

    /// Drives this stage's own fixpoint repair loop: each iteration runs only this stage's own
    /// rules' checks (stage-scoped QC — the wasteful stage-agnostic pass issue #106 replaces),
    /// merges per-rule via `Rule::run_checks`, dispatches repair for rules whose issue changed
    /// since the last iteration, until convergence (no active issues), no-progress (same active
    /// set twice), or the shared `budget` is exhausted.
    pub(crate) fn run_repair(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        budget: &mut RepairBudget,
        timing: &mut TimingSink,
        now_ms: impl Fn() -> f64,
    ) -> StageOutcome {
        let now_ms: &dyn Fn() -> f64 = &now_ms;
        let mut failed: HashSet<String> = HashSet::new();
        let mut previous_active: Option<Vec<(String, Box<dyn Issue>)>> = None;
        loop {
            if let Some(limit) = budget.exhausted(now_ms) {
                return StageOutcome::LimitReached(limit);
            }
            budget.iterations_done += 1;

            let qc_start = now_ms();
            let active = self.collect_active(maze, rng, timing.per_check, now_ms, &failed);
            *timing.qc_total_ms += now_ms() - qc_start;

            if active.is_empty() {
                return StageOutcome::Done;
            }

            if Self::check_progress(&active, &previous_active) {
                let rule_ids = active.iter().map(|(rule, _)| rule.id().to_string()).collect();
                return StageOutcome::NoProgress(rule_ids);
            }
            previous_active = Some(active.iter().map(|(rule, issue)| (rule.id().to_string(), issue.clone_box())).collect());

            let repair_start = now_ms();
            self.dispatch(&active, maze, rng, preset_state, timing.per_strategy, now_ms, &mut failed);
            *timing.repair_total_ms += now_ms() - repair_start;
        }
    }

    /// One report pass over every rule in this stage — `Rule::report_checks` semantics (one
    /// `Issue` per flagged problem instance, no merge). Used both by the final `build_maze`
    /// report and by `QualityControlEngine::run_check_only`.
    pub(crate) fn run_report(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: impl Fn() -> f64,
    ) -> Vec<Box<dyn Issue>> {
        let now_ms: &dyn Fn() -> f64 = &now_ms;
        let mut issues = Vec::new();
        for rule in &self.rules {
            issues.append(&mut rule.report_checks(maze, rng, timing, now_ms));
        }
        issues
    }

    /// For each rule in this stage (in `Vec` order), skipping ids already in `failed`, runs its
    /// checks and keeps only rules that found something **and** have a registered strategy —
    /// rules with no strategy still ran their checks (needed for the no-progress fingerprint to
    /// stay accurate across iterations) but can never be dispatched, so they're filtered out
    /// here rather than in `dispatch`. Sorted by `rule.id` once, immediately — the same order is
    /// then used unchanged by both `check_progress` and `dispatch`, matching the deterministic
    /// dispatch order the original flat pipeline used (`active.sort_unstable_by` by rule id).
    fn collect_active<'a>(
        &'a self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
        failed: &HashSet<String>,
    ) -> Vec<(&'a dyn RuleTrait<T>, Box<dyn Issue>)> {
        // `run_checks` runs for every non-failed rule, including ones with no strategy — a
        // no-strategy rule's checks must still execute every iteration (matches the pre-#106
        // pipeline's stage-agnostic QC pass for such rules), not just once in the final report.
        // Only the has_strategy() filter, applied AFTER run_checks, decides what enters `active`
        // for the fixpoint/dispatch machinery below.
        let mut active: Vec<(&'a dyn RuleTrait<T>, Box<dyn Issue>)> = self.rules.iter()
            .filter(|rule| !failed.contains(rule.id()))
            .filter_map(|rule| rule.run_checks(maze, rng, timing, now_ms).map(|issue| (rule.as_ref(), issue)))
            .filter(|(rule, _)| rule.has_strategy())
            .collect();
        active.sort_unstable_by(|(a, _), (b, _)| a.id().cmp(b.id()));
        active
    }

    /// `true` if `active` (already sorted by `collect_active`) is identical in content to
    /// `previous` — the no-progress guard. Compares the full `(rule_id, Issue)` pair by value,
    /// including `Issue`'s `data`/`source_checks`/`details` — deliberately, not a lightweight
    /// fingerprint: two iterations producing the same rule id with genuinely different issue
    /// content (e.g. a different cycle flagged invalid) must not be mistaken for a stall. This
    /// mirrors the exact comparison the pre-#106 flat pipeline already performed.
    fn check_progress(active: &[(&dyn RuleTrait<T>, Box<dyn Issue>)], previous: &Option<Vec<(String, Box<dyn Issue>)>>) -> bool {
        let Some(previous) = previous else { return false };
        if active.len() != previous.len() {
            return false;
        }
        active.iter().zip(previous.iter()).all(|((rule, issue), (prev_id, prev_issue))| {
            rule.id() == prev_id && issue.eq_dyn(prev_issue.as_ref())
        })
    }

    /// Dispatches repair for each `(rule, issue)` pair in `active`'s order (already sorted by
    /// `collect_active`, not re-sorted here). A `Failed` outcome adds the rule's id to `failed`
    /// so future iterations of this stage's loop skip it; a `Fixed` outcome with a route score
    /// sets `maze.meta.route_score` if not already set (first strategy to report a score wins,
    /// matching the original flat pipeline).
    fn dispatch(
        &self,
        active: &[(&dyn RuleTrait<T>, Box<dyn Issue>)],
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
        failed: &mut HashSet<String>,
    ) {
        for (rule, issue) in active {
            let Some(result) = rule.dispatch_repair(issue.as_ref(), maze, rng, preset_state, timing, now_ms) else { continue };
            match result {
                RepairResult::Failed => { failed.insert(rule.id().to_string()); }
                RepairResult::Fixed { score: Some(s) } => {
                    if maze.meta.route_score.is_none() {
                        maze.meta.route_score = Some(s);
                    }
                }
                RepairResult::Fixed { score: None } => {}
            }
        }
    }
}

#[cfg(test)]
mod check_progress_tests {
    use super::*;
    use crate::space::SquareTessellation;
    use crate::quality_control::MissingEndpointsIssue;
    use crate::quality_control::rule::Rule;

    fn rule(id: &str) -> Rule<SquareTessellation, MissingEndpointsIssue> {
        Rule::new(id.to_string(), vec![], None, HashMap::new(), vec![])
    }

    fn issue() -> Box<dyn Issue> {
        Box::new(MissingEndpointsIssue::new_from_check("check"))
    }

    #[test]
    fn no_previous_is_never_progress() {
        let r = rule("a");
        let active: Vec<(&dyn RuleTrait<SquareTessellation>, Box<dyn Issue>)> = vec![(&r, issue())];
        assert!(!Stage::<SquareTessellation>::check_progress(&active, &None));
    }

    #[test]
    fn identical_single_rule_and_issue_is_no_progress() {
        let r = rule("a");
        let active: Vec<(&dyn RuleTrait<SquareTessellation>, Box<dyn Issue>)> = vec![(&r, issue())];
        let previous = Some(vec![("a".to_string(), issue())]);
        assert!(Stage::<SquareTessellation>::check_progress(&active, &previous));
    }

    #[test]
    fn different_rule_id_is_progress() {
        let r = rule("b");
        let active: Vec<(&dyn RuleTrait<SquareTessellation>, Box<dyn Issue>)> = vec![(&r, issue())];
        let previous = Some(vec![("a".to_string(), issue())]);
        assert!(!Stage::<SquareTessellation>::check_progress(&active, &previous));
    }

    #[test]
    fn different_issue_content_for_same_rule_is_progress() {
        // Regression for GitHub issue #27: same rule id, genuinely different issue content
        // (a detail that changed) must NOT look like no-progress.
        let r = rule("a");
        let active_issue: Box<dyn Issue> = Box::new(
            MissingEndpointsIssue::new_from_check("check")
        );
        let previous_issue: Box<dyn Issue> = Box::new({
            let mut i = MissingEndpointsIssue::new_from_check("check");
            i.meta_mut().push_source("other");
            i
        });
        let active: Vec<(&dyn RuleTrait<SquareTessellation>, Box<dyn Issue>)> = vec![(&r, active_issue)];
        let previous = Some(vec![("a".to_string(), previous_issue)]);
        assert!(!Stage::<SquareTessellation>::check_progress(&active, &previous));
    }

    #[test]
    fn different_length_is_progress() {
        let r_a = rule("a");
        let r_b = rule("b");
        let active: Vec<(&dyn RuleTrait<SquareTessellation>, Box<dyn Issue>)> = vec![(&r_a, issue()), (&r_b, issue())];
        let previous = Some(vec![("a".to_string(), issue())]);
        assert!(!Stage::<SquareTessellation>::check_progress(&active, &previous));
    }

    #[test]
    fn empty_active_against_empty_previous_is_no_progress() {
        let active: Vec<(&dyn RuleTrait<SquareTessellation>, Box<dyn Issue>)> = vec![];
        let previous = Some(vec![]);
        assert!(Stage::<SquareTessellation>::check_progress(&active, &previous));
    }
}
