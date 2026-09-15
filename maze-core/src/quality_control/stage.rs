use std::collections::HashMap;
use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::generation::pipeline::{TimingEntry, TimingNode};
use crate::repair::RepairResult;
use crate::quality_control::issue_kinds::RepairLimitKind;
use super::engine::RepairBudget;
use super::event::QcEvent;
use super::issue::Issue;
use super::rule::{RuleTrait, RuleIterationOutcome};

/// Result of one `Stage::run_repair` call — what happened to this stage's own fixpoint loop.
/// `QualityControlEngine::run_repair_stages` decides what to do next (advance, or stop the whole
/// stage sequence) based on this — a `Stage` never knows whether it is the last one or not.
/// `iterations` (both variants) is the number of repair-dispatching passes this stage actually
/// ran — see GitHub issue #285's timing tree, where it becomes the stage `TimingNode`'s own
/// `calls` count. Not the same as the loop's total pass count: the final convergence check (the
/// pass that finds nothing and returns `Done`) doesn't increment it, matching `run_repair`'s own
/// `iteration` counter semantics.
pub(crate) enum StageOutcome {
    Done { iterations: u32 },
    LimitReached { kind: RepairLimitKind, iterations: u32 },
}

/// Per-rule timing accumulated across an entire fixpoint loop (all iterations summed) — see
/// GitHub issue #285. Keyed by rule id in `Stage::run_repair`'s `HashMap<String, RuleTimingAcc>`,
/// one entry per rule that actually ran at least once. Folded into a `TimingNode` tree by
/// `into_node` once the loop (or the final report pass) is done.
#[derive(Default)]
pub(crate) struct RuleTimingAcc {
    pub per_check: HashMap<&'static str, (f64, u32)>,
    pub per_strategy: HashMap<&'static str, (f64, u32)>,
}

impl RuleTimingAcc {
    fn into_node(self, rule_id: &str) -> TimingNode {
        let mut children: Vec<TimingNode> = self.per_check.into_iter()
            .map(|(id, (total_ms, calls))| TimingNode::new(id, TimingEntry { total_ms, calls }, Vec::new()))
            .collect();
        children.extend(self.per_strategy.into_iter()
            .map(|(id, (total_ms, calls))| TimingNode::new(id, TimingEntry { total_ms, calls }, Vec::new())));
        let entry = TimingEntry {
            total_ms: children.iter().map(|c| c.entry.total_ms).sum(),
            calls: 0,
        };
        TimingNode::new(rule_id, entry, children)
    }
}

/// Folds a per-rule accumulator map into one stage-level `TimingNode`, one child per rule that
/// actually ran. `None` (not an empty `TimingNode`) when no rule in this stage ran at all — a
/// stage never dispatched during this pass has nothing to show in the tree. `iterations` becomes
/// this node's own `calls` — see `StageOutcome`'s doc comment.
pub(crate) fn stage_node(stage_id: &str, rules: HashMap<String, RuleTimingAcc>, iterations: u32) -> Option<TimingNode> {
    if rules.is_empty() {
        return None;
    }
    let children: Vec<TimingNode> = rules.into_iter()
        .map(|(rule_id, acc)| acc.into_node(&rule_id))
        .collect();
    let entry = TimingEntry {
        total_ms: children.iter().map(|c| c.entry.total_ms).sum(),
        calls: iterations,
    };
    Some(TimingNode::new(stage_id, entry, children))
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
    /// actually converging). A rule whose strategy returns `Failed` is skipped on later passes
    /// only until the graph next mutates (GitHub issue #280) — see `check_and_dispatch`'s doc
    /// comment for why a graph mutation, not just elapsed time, is what clears it.
    pub(crate) fn run_repair(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        budget: &mut RepairBudget,
        timing: &mut HashMap<String, RuleTimingAcc>,
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
                return StageOutcome::LimitReached { kind: limit, iterations: iteration };
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
                    return StageOutcome::Done { iterations: iteration };
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
        timing: &mut HashMap<String, RuleTimingAcc>,
        now_ms: impl Fn() -> f64,
    ) -> Vec<Box<dyn Issue>> {
        let now_ms: &dyn Fn() -> f64 = &now_ms;
        let mut issues = Vec::new();
        for rule in &self.rules {
            let rule_acc = timing.entry(rule.id().to_string()).or_default();
            issues.append(&mut rule.report_checks(maze, rng, &mut rule_acc.per_check, now_ms));
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
    /// A `Failed` result adds the rule's id to `failed` so it is skipped for the rest of this
    /// pass and any later pass — until the graph actually mutates (see GitHub issue #280): once
    /// `maze.graph.version()` changes, `failed` is cleared entirely, since `Failed` only means
    /// "couldn't fix the issue instance just given" (`Specs/repair.md`'s `RepairResult` doc), not
    /// "broken for the rest of the stage run" — a graph mutation may reshape or remove the very
    /// issue that made a previously failed rule fail. A `Fixed` result's own `score` (if any) is
    /// otherwise unused here — a route's score is computed independently of repair dispatch via
    /// `MazeAnalysis::route_score` (GitHub issue #532), not accumulated from strategy results.
    fn check_and_dispatch(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        timing: &mut HashMap<String, RuleTimingAcc>,
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
            let version_before = maze.graph.version();
            let mut rule_scope = event_log.as_mut().map(|g| g.enter(format!("rule {}", rule.id())));
            let rule_acc = timing.entry(rule.id().to_string()).or_default();
            let outcome = rule.check_and_repair(
                maze, rng, preset_state, &mut rule_acc.per_check, &mut rule_acc.per_strategy,
                now_ms, rule_scope.as_mut(),
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
                        RepairResult::Fixed { .. } => {}
                    }
                }
            }
            // GitHub issue #280: `Failed` only means "this strategy can't fix the issue instance
            // it was just given" (see `Specs/repair.md`'s `RepairResult` doc), not "this strategy
            // is broken for the rest of the stage's fixpoint loop". Once the graph has actually
            // mutated (`Graph::version()` bumped — the same signal `MazeAnalysis` uses to detect
            // stale caches), every previously failed rule may face a genuinely different issue
            // next time it runs, so `failed` is cleared entirely rather than kept as a permanent
            // per-rule blacklist for the whole run.
            if maze.graph.version() != version_before {
                failed.clear();
            }
        }
        found_any
    }
}

/// Pure unit tests for the timing-tree fold logic (`RuleTimingAcc::into_node`/`stage_node`) — see
/// GitHub issue #285. No `Maze`/`RngCore`/`Tessellation` setup needed since both functions are
/// plain data transformations over already-collected `(f64, u32)` accumulators.
#[cfg(test)]
mod timing_tree_tests {
    use super::*;

    #[test]
    fn stage_node_is_none_when_no_rule_ran() {
        assert!(stage_node("s1", HashMap::new(), 3).is_none());
    }

    #[test]
    fn into_node_sums_check_and_strategy_totals_into_the_rule_entry() {
        let mut acc = RuleTimingAcc::default();
        acc.per_check.insert("check_a", (10.0, 2));
        acc.per_check.insert("check_b", (5.0, 1));
        acc.per_strategy.insert("strategy_a", (7.0, 3));
        let node = acc.into_node("rule_1");
        assert_eq!(node.id, "rule_1");
        assert_eq!(node.entry.total_ms, 22.0);
        assert_eq!(node.entry.calls, 0);
        assert_eq!(node.children.len(), 3);
        let child = |id: &str| node.children.iter().find(|c| c.id == id).unwrap();
        assert_eq!(child("check_a").entry, TimingEntry { total_ms: 10.0, calls: 2 });
        assert_eq!(child("check_b").entry, TimingEntry { total_ms: 5.0, calls: 1 });
        assert_eq!(child("strategy_a").entry, TimingEntry { total_ms: 7.0, calls: 3 });
    }

    #[test]
    fn into_node_with_no_strategy_has_only_check_children() {
        let mut acc = RuleTimingAcc::default();
        acc.per_check.insert("check_a", (4.0, 1));
        let node = acc.into_node("rule_1");
        assert_eq!(node.children.len(), 1);
        assert_eq!(node.children[0].id, "check_a");
    }

    #[test]
    fn stage_node_sums_rule_totals_and_carries_iterations_as_calls() {
        let mut rule_acc = RuleTimingAcc::default();
        rule_acc.per_check.insert("check_a", (10.0, 1));
        let mut rules = HashMap::new();
        rules.insert("rule_1".to_string(), rule_acc);
        let node = stage_node("stage_1", rules, 5).unwrap();
        assert_eq!(node.id, "stage_1");
        assert_eq!(node.entry.total_ms, 10.0);
        assert_eq!(node.entry.calls, 5);
        assert_eq!(node.children.len(), 1);
        assert_eq!(node.children[0].id, "rule_1");
    }

    #[test]
    fn stage_node_sums_across_multiple_rules() {
        let mut acc_a = RuleTimingAcc::default();
        acc_a.per_check.insert("check_a", (10.0, 1));
        let mut acc_b = RuleTimingAcc::default();
        acc_b.per_strategy.insert("strategy_b", (3.0, 1));
        let mut rules = HashMap::new();
        rules.insert("rule_a".to_string(), acc_a);
        rules.insert("rule_b".to_string(), acc_b);
        let node = stage_node("stage_1", rules, 0).unwrap();
        assert_eq!(node.entry.total_ms, 13.0);
        assert_eq!(node.children.len(), 2);
    }
}
