use std::collections::HashMap;
use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::repair::RepairResult;
use crate::quality_control::issue_kinds::RepairLimitKind;
use crate::quality_control::issue_payload::resolve_issue_payload;
use super::engine::RepairBudget;
use super::event::{QcEvent, RepairResultKind};
use super::issue::Issue;
use super::rule::RuleTrait;

/// No-progress guard threshold for the "commands dropped" signal (see `Stage::run_repair`'s
/// `stalled_commands` tracking, GitHub issue #118) — same cadence as the existing
/// `(rule_id, Issue)` comparison, which also stops after two identical iterations in a row.
const STALLED_COMMANDS_THRESHOLD: u32 = 2;

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
        mut event_log: Option<&mut crate::event_log::ScopeGuard<QcEvent>>,
    ) -> StageOutcome {
        let now_ms: &dyn Fn() -> f64 = &now_ms;
        let mut failed: HashSet<String> = HashSet::new();
        let mut previous_active: Option<Vec<(String, Box<dyn Issue>)>> = None;
        // Per-rule streak of consecutive iterations where the rule proposed a non-empty command
        // batch but zero commands applied — independent signal from the (rule_id, Issue) guard
        // below, covering an infinite propose-reject loop where the issue content keeps changing
        // (so the value-equality guard never fires) while nothing about the real graph ever
        // actually changes. See GitHub issue #118, Specs/repair.md's no-progress guard extension.
        let mut stalled_commands: HashMap<String, u32> = HashMap::new();
        let mut iteration: u32 = 0;
        loop {
            if let Some(limit) = budget.exhausted(now_ms) {
                if let Some(log) = event_log.as_mut() {
                    log.emit(QcEvent::IterationLimitReached(limit));
                }
                return StageOutcome::LimitReached(limit);
            }
            budget.iterations_done += 1;

            // Each fixpoint pass is its own `"iteration N"` scope — opened and dropped within this
            // block so the guard doesn't stay borrowed into the next loop pass (see
            // `Specs/event_log.md`'s `ScopeGuard::enter` caveat).
            {
                let mut iteration_scope = event_log.as_mut().map(|log| log.enter_numbered("iteration"));
                if let Some(g) = iteration_scope.as_mut() {
                    g.emit(QcEvent::IterationStarted(iteration));
                }

                let qc_start = now_ms();
                let active = self.collect_active(maze, rng, timing.per_check, now_ms, &failed, iteration_scope.as_mut());
                *timing.qc_total_ms += now_ms() - qc_start;

                if active.is_empty() {
                    return StageOutcome::Done;
                }

                if Self::check_progress(&active, &previous_active) {
                    let rule_ids = active.iter().map(|(rule, _)| rule.id().to_string()).collect();
                    if let Some(g) = iteration_scope.as_mut() {
                        g.emit(QcEvent::IterationNoProgress);
                    }
                    return StageOutcome::NoProgress(rule_ids);
                }
                previous_active = Some(active.iter().map(|(rule, issue)| (rule.id().to_string(), issue.clone_box())).collect());

                let repair_start = now_ms();
                let stalled = self.dispatch(&active, maze, rng, preset_state, timing.per_strategy, now_ms, &mut failed, &mut stalled_commands, iteration_scope.as_mut());
                *timing.repair_total_ms += now_ms() - repair_start;

                if !stalled.is_empty() {
                    if let Some(g) = iteration_scope.as_mut() {
                        g.emit(QcEvent::IterationNoProgress);
                    }
                    return StageOutcome::NoProgress(stalled);
                }
            }
            iteration += 1;
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
    /// `event_log` (GitHub issue #147): emits `QcEvent::RuleChecked` for every non-failed rule
    /// (including ones filtered out below for having no strategy or no found issue — the
    /// narration must show "rule X found nothing" too, not just active rules), directly into the
    /// current iteration scope (not a per-rule nested scope — that only opens in `dispatch`, for
    /// rules actually dispatched). Payload is resolved **here**, immediately after `run_checks`
    /// returns and before any mutation this same QC pass might make later in the iteration (via
    /// `dispatch`) — `resolve_issue_payload` reads `maze.graph`/`scc` as they stand right now, so
    /// resolving it any later could describe a graph state the issue was no longer found against.
    fn collect_active<'a>(
        &'a self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
        failed: &HashSet<String>,
        mut event_log: Option<&mut crate::event_log::ScopeGuard<QcEvent>>,
    ) -> Vec<(&'a dyn RuleTrait<T>, Box<dyn Issue>)> {
        // `run_checks` runs for every non-failed rule, including ones with no strategy — a
        // no-strategy rule's checks must still execute every iteration (matches the pre-#106
        // pipeline's stage-agnostic QC pass for such rules), not just once in the final report.
        // Only the has_strategy() filter, applied AFTER run_checks, decides what enters `active`
        // for the fixpoint/dispatch machinery below.
        let mut active: Vec<(&'a dyn RuleTrait<T>, Box<dyn Issue>)> = Vec::new();
        // Resolved lazily, at most once for the whole loop (not per rule) — `maze.graph` doesn't
        // change within `collect_active` itself (mutation only happens later, in `dispatch`), so
        // every rule that actually needs it this iteration shares the same `ConnectedComponents`
        // clone instead of each re-triggering `MazeAnalysis::scc`'s own cache-hit clone. Only ever
        // computed when `event_log` is `Some` *and* at least one rule's payload actually reads it
        // (`resolve_issue_payload` only touches `scc` for `RegionNeedsExpansionIssue` — see that
        // function's doc comment) — a rule with no issue, or an issue kind with no structural scc
        // dependency, never forces this.
        let mut scc: Option<crate::graph::scc::ConnectedComponents> = None;
        for rule in self.rules.iter().filter(|rule| !failed.contains(rule.id())) {
            let issue = rule.run_checks(maze, rng, timing, now_ms);
            if let Some(g) = event_log.as_mut() {
                let reported = issue.as_ref().map(|issue| {
                    let scc = scc.get_or_insert_with(|| maze.analysis.scc(&maze.graph));
                    let payload = resolve_issue_payload(issue.as_ref(), &maze.graph, scc);
                    (issue.kind(), payload)
                });
                g.emit(QcEvent::RuleChecked { rule_id: rule.id().to_string(), issue: reported });
            }
            if let Some(issue) = issue {
                if rule.has_strategy() {
                    active.push((rule.as_ref(), issue));
                }
            }
        }
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
    ///
    /// Also tracks the "commands dropped" no-progress signal (GitHub issue #118,
    /// `Specs/repair.md`): `stalled_commands` counts, per rule, consecutive iterations where the
    /// rule proposed a non-empty `MutationCommand` batch but zero of them applied
    /// (`ApplyOutcome.applied == 0 && proposed > 0`) — reset to 0 the moment a rule applies at
    /// least one command. Returns the ids of rules whose streak just reached
    /// `STALLED_COMMANDS_THRESHOLD`, added to `failed` the same way a `Failed` result is (both
    /// are permanent for the rest of this `run_repair` call) — `run_repair`'s caller treats a
    /// non-empty return the same as `StageOutcome::NoProgress`.
    fn dispatch(
        &self,
        active: &[(&dyn RuleTrait<T>, Box<dyn Issue>)],
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
        failed: &mut HashSet<String>,
        stalled_commands: &mut HashMap<String, u32>,
        mut event_log: Option<&mut crate::event_log::ScopeGuard<QcEvent>>,
    ) -> Vec<String> {
        let mut newly_stalled = Vec::new();
        for (rule, issue) in active {
            // Each dispatched rule gets its own `"rule <id>"` scope, opened and dropped within
            // this block — same non-trivial-`Drop`-guard caveat as `run_repair`'s per-iteration
            // scope: a guard opened inline in a loop body must live in its own block, or the
            // borrow checker won't let the parent (`iteration_scope`, forwarded in as
            // `event_log`) emit anything on the next loop pass.
            let mut rule_scope = event_log.as_mut().map(|g| g.enter(format!("rule {}", rule.id())));
            let Some((result, outcome)) = rule.dispatch_repair(issue.as_ref(), maze, rng, preset_state, timing, now_ms, rule_scope.as_mut()) else { continue };
            // Emitted after `dispatch_repair` (not before) so `proposed`/`applied` — resolved by
            // `apply_commands` inside that call — are already known; the mutating/`*Declined`
            // events `apply_commands` emitted are this rule scope's own preceding children.
            if let Some(g) = rule_scope.as_mut() {
                g.emit(QcEvent::RepairDispatched {
                    rule_id: rule.id().to_string(),
                    result: RepairResultKind::from(&result),
                    proposed: outcome.proposed as u32,
                    applied: outcome.applied as u32,
                });
            }
            match result {
                RepairResult::Failed => { failed.insert(rule.id().to_string()); }
                RepairResult::Fixed { score: Some(s) } => {
                    if maze.meta.route_score.is_none() {
                        maze.meta.route_score = Some(s);
                    }
                }
                RepairResult::Fixed { score: None } => {}
            }

            if outcome.applied > 0 {
                stalled_commands.remove(rule.id());
            } else if outcome.proposed > 0 {
                let streak = stalled_commands.entry(rule.id().to_string()).or_insert(0);
                *streak += 1;
                if *streak >= STALLED_COMMANDS_THRESHOLD {
                    failed.insert(rule.id().to_string());
                    newly_stalled.push(rule.id().to_string());
                }
            }
        }
        newly_stalled
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

/// Tests for the "commands dropped" no-progress signal (GitHub issue #118, `Specs/repair.md`) —
/// `Stage::dispatch`'s `stalled_commands` tracking, independent of the `(rule_id, Issue)` guard
/// covered by `check_progress_tests` above. A mock `RuleTrait` lets each test control exactly what
/// `ApplyOutcome` a rule reports per call, without needing a real `Check`/`RepairStrategy` pair.
#[cfg(test)]
mod stalled_commands_tests {
    use super::*;
    use std::cell::RefCell;
    use crate::space::SquareTessellation;
    use crate::quality_control::{MissingEndpointsIssue, IssueKind, MISSING_ENDPOINTS};
    use crate::quality_control::rule::ApplyOutcome;

    /// A `RuleTrait` mock that always reports one issue (so it stays in `active`) and returns a
    /// caller-scripted sequence of `ApplyOutcome`s from `dispatch_repair`, one per call, cycling
    /// the last entry if called more times than scripted.
    struct ScriptedRule {
        id: String,
        outcomes: RefCell<std::vec::IntoIter<ApplyOutcome>>,
        last: RefCell<ApplyOutcome>,
    }
    impl ScriptedRule {
        fn new(id: &str, outcomes: Vec<ApplyOutcome>) -> Self {
            Self { id: id.to_string(), outcomes: RefCell::new(outcomes.into_iter()), last: RefCell::new(ApplyOutcome::default()) }
        }
    }
    impl RuleTrait<SquareTessellation> for ScriptedRule {
        fn id(&self) -> &str { &self.id }
        fn kind(&self) -> IssueKind { MISSING_ENDPOINTS }
        fn has_strategy(&self) -> bool { true }
        fn run_checks(&self, _: &Maze<SquareTessellation>, _: &mut dyn RngCore, _: &mut HashMap<&'static str, (f64, u32)>, _: &dyn Fn() -> f64) -> Option<Box<dyn Issue>> {
            Some(Box::new(MissingEndpointsIssue::new_from_check("check")))
        }
        fn report_checks(&self, _: &Maze<SquareTessellation>, _: &mut dyn RngCore, _: &mut HashMap<&'static str, (f64, u32)>, _: &dyn Fn() -> f64) -> Vec<Box<dyn Issue>> { vec![] }
        fn dispatch_repair(&self, _: &dyn Issue, _: &mut Maze<SquareTessellation>, _: &mut dyn RngCore, _: &PresetState, _: &mut HashMap<&'static str, (f64, u32)>, _: &dyn Fn() -> f64, _: Option<&mut crate::event_log::ScopeGuard<QcEvent>>) -> Option<(RepairResult, ApplyOutcome)> {
            let next = self.outcomes.borrow_mut().next();
            let outcome = next.unwrap_or_else(|| *self.last.borrow());
            *self.last.borrow_mut() = outcome;
            Some((RepairResult::Fixed { score: None }, outcome))
        }
    }

    fn empty_maze() -> Maze<SquareTessellation> {
        let mut ids = crate::IdGenerator::new();
        let field = crate::space::Field::new(crate::space::square_rect(1, 1), &mut ids).unwrap();
        let mut g = crate::Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    fn dispatch_once(
        rule: &dyn RuleTrait<SquareTessellation>,
        maze: &mut Maze<SquareTessellation>,
        failed: &mut HashSet<String>,
        stalled_commands: &mut HashMap<String, u32>,
    ) -> Vec<String> {
        let stage = Stage::<SquareTessellation>::new("s".to_string(), "S".to_string(), vec![]);
        let issue: Box<dyn Issue> = Box::new(MissingEndpointsIssue::new_from_check("check"));
        let active: Vec<(&dyn RuleTrait<SquareTessellation>, Box<dyn Issue>)> = vec![(rule, issue)];
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        use rand::SeedableRng;
        let mut timing = HashMap::new();
        stage.dispatch(&active, maze, &mut rng, &PresetState::empty(), &mut timing, &|| 0.0, failed, stalled_commands, None)
    }

    #[test]
    fn applied_zero_with_nonzero_proposed_increments_streak_but_does_not_stall_on_first_hit() {
        let rule = ScriptedRule::new("r", vec![ApplyOutcome { proposed: 3, applied: 0 }]);
        let mut maze = empty_maze();
        let mut failed = HashSet::new();
        let mut stalled_commands = HashMap::new();
        let newly_stalled = dispatch_once(&rule, &mut maze, &mut failed, &mut stalled_commands);
        assert!(newly_stalled.is_empty(), "a single stalled iteration must not trip the guard yet");
        assert!(!failed.contains("r"));
        assert_eq!(stalled_commands.get("r"), Some(&1));
    }

    #[test]
    fn two_consecutive_stalled_iterations_trips_the_guard() {
        let rule = ScriptedRule::new("r", vec![
            ApplyOutcome { proposed: 3, applied: 0 },
            ApplyOutcome { proposed: 5, applied: 0 }, // different proposed count -- must still count as the same stall condition
        ]);
        let mut maze = empty_maze();
        let mut failed = HashSet::new();
        let mut stalled_commands = HashMap::new();

        dispatch_once(&rule, &mut maze, &mut failed, &mut stalled_commands);
        let newly_stalled = dispatch_once(&rule, &mut maze, &mut failed, &mut stalled_commands);

        assert_eq!(newly_stalled, vec!["r".to_string()], "second consecutive stall must trip the guard");
        assert!(failed.contains("r"), "a stalled rule must be added to failed, same as an explicit Failed result");
    }

    #[test]
    fn applying_at_least_one_command_resets_the_streak() {
        let rule = ScriptedRule::new("r", vec![
            ApplyOutcome { proposed: 3, applied: 0 },
            ApplyOutcome { proposed: 2, applied: 1 }, // progress -- resets the streak
            ApplyOutcome { proposed: 4, applied: 0 },
        ]);
        let mut maze = empty_maze();
        let mut failed = HashSet::new();
        let mut stalled_commands = HashMap::new();

        dispatch_once(&rule, &mut maze, &mut failed, &mut stalled_commands);
        assert_eq!(stalled_commands.get("r"), Some(&1));

        dispatch_once(&rule, &mut maze, &mut failed, &mut stalled_commands);
        assert!(!stalled_commands.contains_key("r"), "applying at least one command must reset the streak entirely");

        let newly_stalled = dispatch_once(&rule, &mut maze, &mut failed, &mut stalled_commands);
        assert!(newly_stalled.is_empty(), "streak must restart from zero after the reset, not carry over the pre-reset count");
        assert_eq!(stalled_commands.get("r"), Some(&1));
        assert!(!failed.contains("r"));
    }

    #[test]
    fn zero_proposed_and_zero_applied_does_not_count_as_a_stall() {
        // A rule whose strategy legitimately proposed nothing this call (e.g. already-idempotent)
        // must not be confused with one whose proposals keep getting dropped on revalidation.
        let rule = ScriptedRule::new("r", vec![
            ApplyOutcome { proposed: 0, applied: 0 },
            ApplyOutcome { proposed: 0, applied: 0 },
            ApplyOutcome { proposed: 0, applied: 0 },
        ]);
        let mut maze = empty_maze();
        let mut failed = HashSet::new();
        let mut stalled_commands = HashMap::new();

        for _ in 0..3 {
            let newly_stalled = dispatch_once(&rule, &mut maze, &mut failed, &mut stalled_commands);
            assert!(newly_stalled.is_empty());
        }
        assert!(!stalled_commands.contains_key("r"));
        assert!(!failed.contains("r"));
    }

    #[test]
    fn independent_rules_track_separate_streaks() {
        let rule_a = ScriptedRule::new("a", vec![ApplyOutcome { proposed: 1, applied: 0 }]);
        let rule_b = ScriptedRule::new("b", vec![ApplyOutcome { proposed: 1, applied: 1 }]);
        let mut maze = empty_maze();
        let mut failed = HashSet::new();
        let mut stalled_commands = HashMap::new();

        let stage = Stage::<SquareTessellation>::new("s".to_string(), "S".to_string(), vec![]);
        let issue_a: Box<dyn Issue> = Box::new(MissingEndpointsIssue::new_from_check("check"));
        let issue_b: Box<dyn Issue> = Box::new(MissingEndpointsIssue::new_from_check("check"));
        let active: Vec<(&dyn RuleTrait<SquareTessellation>, Box<dyn Issue>)> = vec![(&rule_a, issue_a), (&rule_b, issue_b)];
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        use rand::SeedableRng;
        let mut timing = HashMap::new();
        stage.dispatch(&active, &mut maze, &mut rng, &PresetState::empty(), &mut timing, &|| 0.0, &mut failed, &mut stalled_commands, None);

        assert_eq!(stalled_commands.get("a"), Some(&1));
        assert!(!stalled_commands.contains_key("b"), "a rule that applied a command must never gain a streak entry");
    }
}
