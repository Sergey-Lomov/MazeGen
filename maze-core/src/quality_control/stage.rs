use std::collections::HashMap;
use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::repair::RepairResult;
use crate::quality_control::issue_kinds::RepairLimitKind;
use super::engine::RepairBudget;
use super::event::QcEvent;
use super::issue::Issue;
use super::rule::{RuleTrait, RuleIterationOutcome};

/// Result of one `Stage::run_repair` call — what happened to this stage's own fixpoint loop.
/// `QualityControlEngine::run_repair_stages` decides what to do next (advance, or stop the whole
/// stage sequence) based on this — a `Stage` never knows whether it is the last one or not.
pub(crate) enum StageOutcome {
    Done,
    LimitReached(RepairLimitKind),
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
    /// rules' checks (stage-scoped QC — the wasteful stage-agnostic pass issue #106 replaces) and
    /// dispatches repair for every rule that found an issue, in `self.rules`' own configured
    /// order, until convergence (no rule found anything) or the shared `budget` is exhausted.
    /// Termination is guaranteed entirely by `budget` (see `RepairLimits`'s construction-time
    /// requirement that at least one bound is set) — there is no separate no-progress guard (see
    /// GitHub issue #170: the old value-equality/"commands dropped" guards were unreliable and
    /// easily defeated, e.g. two rules whose issue content differs every iteration while never
    /// actually converging).
    pub(crate) fn run_repair(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        budget: &mut RepairBudget,
        timing: &mut TimingSink,
        now_ms: impl Fn() -> f64,
        mut event_log: Option<&mut crate::event_log::ScopeGuard<QcEvent>>,
        mut debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
    ) -> StageOutcome {
        let now_ms: &dyn Fn() -> f64 = &now_ms;
        let mut failed: HashSet<String> = HashSet::new();
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

                let found_any = self.check_and_dispatch(maze, rng, preset_state, timing, now_ms, &mut failed, iteration_scope.as_mut(), debug_state.as_deref_mut());

                if !found_any {
                    return StageOutcome::Done;
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

    /// For each rule in this stage, in `self.rules`' own configured order, skipping ids already
    /// in `failed`: runs `RuleTrait::check_and_repair` — the check→strategy pipeline is now fully
    /// internal to `Rule` (GitHub issue #170), so this loop never sees the issue itself, only the
    /// `RuleIterationOutcome` describing what happened. Returns whether any rule actually
    /// dispatched repair this pass (`Repaired`, regardless of its `RepairResult`) —
    /// `run_repair`'s convergence check. A no-strategy rule's `NoStrategy` outcome does **not**
    /// count, matching the pre-#170 behavior where such a rule was filtered out of `active` before
    /// the convergence check ran — a rule that can never make progress must not keep the stage's
    /// fixpoint loop spinning just because its check keeps finding something. No sorting: with no
    /// no-progress guard left to compare snapshots across iterations, dispatch order is simply
    /// `self.rules`' own configured order, not re-derived from rule id.
    ///
    /// A `Failed` result adds the rule's id to `failed` so future iterations of this stage's loop
    /// skip it; a `Fixed` result with a route score sets `maze.meta.route_score` if not already
    /// set (first strategy to report a score wins, matching the original flat pipeline).
    fn check_and_dispatch(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        timing: &mut TimingSink,
        now_ms: &dyn Fn() -> f64,
        failed: &mut HashSet<String>,
        mut event_log: Option<&mut crate::event_log::ScopeGuard<QcEvent>>,
        mut debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
    ) -> bool {
        let mut found_any = false;
        for rule in self.rules.iter() {
            if failed.contains(rule.id()) {
                continue;
            }
            let mut rule_scope = event_log.as_mut().map(|g| g.enter(format!("rule {}", rule.id())));
            let outcome = rule.check_and_repair(
                maze, rng, preset_state, timing.per_check, timing.per_strategy,
                timing.qc_total_ms, timing.repair_total_ms, now_ms, rule_scope.as_mut(),
                debug_state.as_deref_mut(),
            );
            match outcome {
                // Neither counts toward convergence: a no-strategy ("no_fix") rule can never make
                // progress, so it must not keep the stage's fixpoint loop spinning just because
                // its check keeps finding something — matches the pre-#170 behavior, where such a
                // rule was filtered out of `active` before the "any active rule" convergence check
                // ran at all (see `Specs/repair.md`'s `check_and_dispatch` write-up).
                RuleIterationOutcome::NoIssue | RuleIterationOutcome::NoStrategy => {}
                RuleIterationOutcome::Repaired(result, _outcome) => {
                    found_any = true;
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
        found_any
    }
}
