use super::event::QcEvent;
use super::issue::Issue;
use super::stage::{RuleTimingAcc, Stage, StageOutcome, stage_node};
use crate::Maze;
use crate::event_log::EventLog;
use crate::generation::PresetState;
use crate::generation::pipeline::{GenerationTiming, RepairLimits};
use crate::quality_control::issue_kinds::{RepairLimitKind, RepairLimitReachedIssue};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

/// Shared repair budget across every stage in one `QualityControlEngine::run_full` call —
/// `iterations_done`/`start_ms` are NOT reset per stage (see `Specs/repair.md`'s "Stages and the
/// repair budget"). `limit_reached` is written by `run_repair_stages`, not by `Stage::run_repair`
/// itself — a `Stage` reports what happened in its own loop via `StageOutcome`, but deciding
/// whether that should stop the whole stage sequence is the engine's call, not the stage's.
pub(crate) struct RepairBudget {
    limits: RepairLimits,
    pub(crate) iterations_done: usize,
    start_ms: f64,
    pub(crate) limit_reached: Option<RepairLimitKind>,
}

impl RepairBudget {
    fn new(limits: RepairLimits, now_ms: &impl Fn() -> f64) -> Self {
        Self {
            limits,
            iterations_done: 0,
            start_ms: now_ms(),
            limit_reached: None,
        }
    }

    /// `Some(kind)` for the first bound that has already been exhausted (max_iterations checked
    /// before time_budget, matching the pre-#106 flat pipeline's check order), `None` if neither
    /// bound is configured or both still have room.
    pub(crate) fn exhausted(
        &self,
        now_ms: &(impl Fn() -> f64 + ?Sized),
    ) -> Option<RepairLimitKind> {
        if let Some(max) = self.limits.max_iterations() {
            if self.iterations_done >= max {
                return Some(RepairLimitKind::MaxIterations);
            }
        }
        if let Some(budget_secs) = self.limits.time_budget_secs() {
            if now_ms() - self.start_ms >= budget_secs * 1000.0 {
                return Some(RepairLimitKind::TimeBudget);
            }
        }
        None
    }
}

/// The single orchestrator for the whole check+repair process — or check-only, when no repair is
/// requested (see GitHub issue #106). Owns an ordered list of `Stage`s; each `Stage` drives its
/// own `Rule`s; each `Rule` drives its own checks plus its one strategy. Control mirrors storage:
/// `QualityControlEngine` calls into `Stage`, `Stage` calls into `Rule`, rather than a flat loop
/// reaching into all three levels at once.
///
/// Repair is not a separate orchestrator (there is no more `RepairEngine`) — in this model repair
/// is never an independent operation over an arbitrary issue set, it always happens in the
/// context of one `Rule`, which already owns both what to check and how to fix it. The split
/// existed only because checks and strategy-bearing rules used to be two independent flat lists
/// pipeline.rs re-matched every iteration; once a `Rule` owns both, that matching is no longer a
/// separate concern. `QualityControlEngine`'s name still fits: it is
/// entirely about quality — detection and repair — never about generation, which runs before it
/// and is out of its scope.
pub struct QualityControlEngine<T: Tessellation> {
    stages: Vec<Stage<T>>,
}

impl<T: Tessellation> QualityControlEngine<T> {
    pub fn new(stages: Vec<Stage<T>>) -> Self {
        Self { stages }
    }

    pub fn stages(&self) -> &[Stage<T>] {
        &self.stages
    }

    /// Runs the full check+repair process: a fixpoint repair loop per stage (in order, sharing
    /// one `RepairBudget`), then an unconditional final report pass over every stage. Replaces
    /// both `QualityControlEngine`+`RepairEngine`'s combined role in the pre-#106 `build_maze`.
    pub fn run_full(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        limits: RepairLimits,
        now_ms: impl Fn() -> f64,
        mut event_log: Option<&mut EventLog<QcEvent>>,
        mut debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
    ) -> (Vec<Box<dyn Issue>>, GenerationTiming) {
        let mut timing = GenerationTiming::default();
        let (budget, mut repair_timing, iterations) = self.run_repair_stages(
            maze,
            rng,
            preset_state,
            limits,
            &now_ms,
            event_log.as_deref_mut(),
            debug_state.as_deref_mut(),
        );

        let mut remaining = self.collect_final_report(maze, rng, &mut repair_timing, &now_ms);
        if let Some(limit) = budget.limit_reached {
            remaining.push(Box::new(RepairLimitReachedIssue::new(limit)));
        }
        timing.qc = self
            .stages
            .iter()
            .filter_map(|stage| {
                let rules = repair_timing.remove(&stage.id)?;
                stage_node(
                    &stage.id,
                    rules,
                    iterations.get(&stage.id).copied().unwrap_or(0),
                )
            })
            .collect();
        (remaining, timing)
    }

    /// Check-only mode — no repair, `report_check` semantics everywhere (one `Issue` per flagged
    /// problem instance). Replaces both the pre-#106 final-report pass inside `build_maze`
    /// (`run_report_timed`) and `build_analytics_snapshot`'s plain `run` call — issue #106
    /// unifies these into one code path with one semantics.
    pub fn run_check_only(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        now_ms: impl Fn() -> f64,
    ) -> Vec<Box<dyn Issue>> {
        let mut timing_out = HashMap::new();
        self.collect_final_report(maze, rng, &mut timing_out, &now_ms)
    }

    /// Drives every stage's own fixpoint repair loop in order, sharing one `RepairBudget` across
    /// all of them. A stage reporting `Done` simply advances to the next; `LimitReached`/
    /// `NoProgress` stops the whole sequence (mirrors the pre-#106 `break 'stages'` — no-progress
    /// or a spent budget in one stage means later stages never get a chance to run against a
    /// maze whose current stage never reached a clean state). No `'stages` label is needed here:
    /// the inner fixpoint loop lives entirely inside `Stage::run_repair`, which simply returns a
    /// `StageOutcome` instead of breaking out through a label — this function sees only one loop
    /// level.
    fn run_repair_stages(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        limits: RepairLimits,
        now_ms: &impl Fn() -> f64,
        mut event_log: Option<&mut EventLog<QcEvent>>,
        mut debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
    ) -> (
        RepairBudget,
        HashMap<String, HashMap<String, RuleTimingAcc>>,
        HashMap<String, u32>,
    ) {
        let mut budget = RepairBudget::new(limits, now_ms);
        let mut timing: HashMap<String, HashMap<String, RuleTimingAcc>> = HashMap::new();
        let mut iterations: HashMap<String, u32> = HashMap::new();
        for stage in &self.stages {
            let stage_timing = timing.entry(stage.id.clone()).or_default();
            let outcome = {
                let mut stage_scope = event_log
                    .as_deref_mut()
                    .map(|log| log.enter(format!("stage {}", stage.id)));
                stage.run_repair(
                    maze,
                    rng,
                    preset_state,
                    &mut budget,
                    stage_timing,
                    now_ms,
                    stage_scope.as_mut(),
                    debug_state.as_deref_mut(),
                )
            };
            match outcome {
                StageOutcome::Done { iterations: n } => {
                    iterations.insert(stage.id.clone(), n);
                    continue;
                }
                StageOutcome::LimitReached {
                    kind,
                    iterations: n,
                } => {
                    iterations.insert(stage.id.clone(), n);
                    budget.limit_reached = Some(kind);
                    break;
                }
            }
        }
        (budget, timing, iterations)
    }

    /// Unconditional report pass over every stage's every rule (`report_check` semantics) —
    /// not a flat pass over all checks like the pre-#106 code, but the same effective check set,
    /// now reached by walking the same stage/rule hierarchy as the repair loop. `timing` is the
    /// same per-stage/per-rule accumulator map `run_repair_stages` built — a final-report check
    /// call folds straight into the same rule entry the repair loop already timed, so one rule's
    /// `TimingNode` reflects its total time across both passes.
    fn collect_final_report(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<String, HashMap<String, RuleTimingAcc>>,
        now_ms: &impl Fn() -> f64,
    ) -> Vec<Box<dyn Issue>> {
        let mut issues = Vec::new();
        for stage in &self.stages {
            let stage_timing = timing.entry(stage.id.clone()).or_default();
            issues.append(&mut stage.run_report(maze, rng, stage_timing, now_ms));
        }
        issues
    }
}

#[cfg(test)]
mod repair_budget_tests {
    use super::*;

    fn clock_at(ms: f64) -> impl Fn() -> f64 {
        move || ms
    }

    #[test]
    fn max_iterations_not_yet_reached_is_not_exhausted() {
        let limits = RepairLimits::new(Some(3), None).unwrap();
        let mut budget = RepairBudget::new(limits, &clock_at(0.0));
        budget.iterations_done = 2;
        assert_eq!(budget.exhausted(&clock_at(0.0)), None);
    }

    #[test]
    fn max_iterations_reached_is_exhausted() {
        let limits = RepairLimits::new(Some(3), None).unwrap();
        let mut budget = RepairBudget::new(limits, &clock_at(0.0));
        budget.iterations_done = 3;
        assert_eq!(
            budget.exhausted(&clock_at(0.0)),
            Some(RepairLimitKind::MaxIterations)
        );
    }

    #[test]
    fn time_budget_not_yet_elapsed_is_not_exhausted() {
        let limits = RepairLimits::new(None, Some(1.0)).unwrap();
        let budget = RepairBudget::new(limits, &clock_at(0.0));
        assert_eq!(budget.exhausted(&clock_at(500.0)), None);
    }

    #[test]
    fn time_budget_elapsed_is_exhausted() {
        let limits = RepairLimits::new(None, Some(1.0)).unwrap();
        let budget = RepairBudget::new(limits, &clock_at(0.0));
        assert_eq!(
            budget.exhausted(&clock_at(1000.0)),
            Some(RepairLimitKind::TimeBudget)
        );
    }

    #[test]
    fn max_iterations_checked_before_time_budget_when_both_configured() {
        // Both bounds already exhausted at once — max_iterations must win (matches the
        // pre-#106 flat pipeline's check order).
        let limits = RepairLimits::new(Some(1), Some(1.0)).unwrap();
        let mut budget = RepairBudget::new(limits, &clock_at(0.0));
        budget.iterations_done = 1;
        assert_eq!(
            budget.exhausted(&clock_at(2000.0)),
            Some(RepairLimitKind::MaxIterations)
        );
    }

    #[test]
    fn time_budget_fires_when_only_it_is_exhausted_and_both_are_configured() {
        // Both bounds configured, but only time_budget has actually run out this time —
        // max_iterations being checked first (see test above) must not mask a genuine
        // TimeBudget result when max_iterations itself still has room.
        let limits = RepairLimits::new(Some(100), Some(1.0)).unwrap();
        let mut budget = RepairBudget::new(limits, &clock_at(0.0));
        budget.iterations_done = 1;
        assert_eq!(
            budget.exhausted(&clock_at(2000.0)),
            Some(RepairLimitKind::TimeBudget)
        );
    }

    #[test]
    fn new_rejects_both_bounds_none() {
        assert!(RepairLimits::new(None, None).is_err());
    }
}
