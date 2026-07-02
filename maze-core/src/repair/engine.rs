use std::collections::{HashMap, HashSet};
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::issue::Issue;
use crate::generation::PresetState;
use super::rule::QcRule;
use super::stage::RepairStage;
use super::params::{build_params, StrategyParams};
use super::result::RepairResult;
use super::strategy::RepairStrategy;
use super::snapshot::SnapshotStack;

/// One rule's strategy assignment — `RepairEngine`'s caller-supplied configuration unit.
pub struct RepairRuleConfig<T: Tessellation> {
    pub rule: QcRule,
    pub strategy: Box<dyn RepairStrategy<T>>,
    pub param_overrides: HashMap<String, String>,
}

/// Result of running one rule's strategy. Named struct, not a tuple — keeps `rule_id`
/// (an internal wiring detail repair/pipeline use for failed-tracking) from being mistaken
/// for a meaningful part of the domain result.
pub struct RepairOutcome {
    pub rule_id: String,
    pub result: RepairResult,
}

pub struct RepairEngine<T: Tessellation> {
    /// Rules with a registered strategy — these are actually dispatched by `run`.
    rules: Vec<RepairRuleConfig<T>>,
    /// All rules, including ones with no strategy ("no_fix") — kept here so `check_id_to_rule`
    /// can route every check id, not just the repaired ones. A rule without a strategy still
    /// needs correct merge/attribution upstream in `build_maze`.
    all_rules: Vec<QcRule>,
    /// Ordered stages — `build_maze` dispatches one stage at a time, in this order. See
    /// `Specs/repair.md`'s "Stages" section.
    stages: Vec<RepairStage>,
    /// Precomputed once in `new` — stage id → (strategy_rule_ids() ∩ stage.rule_ids). Same
    /// rationale as `strategy_rule_ids()`'s own precomputation: `build_maze` calls
    /// `strategy_rule_ids_for_stage` once per fixpoint-loop iteration, not once per stage.
    strategy_rule_ids_by_stage: HashMap<String, HashSet<String>>,
}

impl<T: Tessellation> RepairEngine<T> {
    /// `rules` — strategy assignments (only for rules with a strategy).
    /// `all_rules` — full rule list, including rules with no strategy. Every rule in
    /// `rules` must also appear in `all_rules` (by `id`); callers (`runner.rs::build_qc_and_repair`)
    /// are responsible for this invariant. `stages` — every rule in `rules` (i.e. every rule with
    /// a strategy) must appear in exactly one stage's `rule_ids`; a rule with no strategy may or
    /// may not appear in a stage (its stage membership only affects UI/serialization, not repair
    /// dispatch) — callers are responsible for both invariants, core does not validate them.
    pub fn new(rules: Vec<RepairRuleConfig<T>>, all_rules: Vec<QcRule>, stages: Vec<RepairStage>) -> Self {
        let strategy_ids: HashSet<&str> = rules.iter().map(|cfg| cfg.rule.id.as_str()).collect();
        let strategy_rule_ids_by_stage = stages.iter().map(|stage| {
            let ids: HashSet<String> = stage.rule_ids.iter()
                .filter(|id| strategy_ids.contains(id.as_str()))
                .cloned()
                .collect();
            (stage.id.clone(), ids)
        }).collect();
        Self { rules, all_rules, stages, strategy_rule_ids_by_stage }
    }

    /// All check ids across every rule (strategy or not), mapped to their rule id. Used by
    /// `build_maze` (pipeline.rs) to route raw issues to their rule before merging.
    pub fn check_id_to_rule(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        for rule in &self.all_rules {
            for check_id in &rule.checks {
                map.insert(check_id.clone(), rule.id.clone());
            }
        }
        map
    }

    /// Rule ids with a registered strategy, as a lookup set. Rules without one still merge
    /// issues for attribution (see `check_id_to_rule`) but must not enter `active`/fingerprint
    /// tracking or repair dispatch in `build_maze`. Precomputed once per call (not a per-lookup
    /// scan over `self.rules`) since `build_maze` calls this once per `MAX_REPAIR_ITERATIONS`
    /// loop iteration and tests it against every active rule that iteration.
    pub fn strategy_rule_ids(&self) -> HashSet<&str> {
        self.rules.iter().map(|cfg| cfg.rule.id.as_str()).collect()
    }

    /// Ordered stages this engine dispatches, in dispatch order.
    pub fn stages(&self) -> &[RepairStage] {
        &self.stages
    }

    /// Rule ids with a registered strategy, belonging to the given stage — precomputed
    /// intersection of `strategy_rule_ids()` and `stage.rule_ids`. Returns `None` only for a
    /// `stage_id` unknown to this engine (never happens for ids obtained via `self.stages()` in
    /// the same call); a known stage with no dispatchable rules (no-strategy-only or empty)
    /// returns `Some(&empty_set)`, not `None` — that is a legitimate degenerate case, not an
    /// error (see `Specs/repair.md`). Callers should treat "no dispatchable rules" and "unknown
    /// stage" the same way (`unwrap_or_default()`), since both mean "nothing to dispatch this
    /// iteration" from the caller's perspective.
    pub fn strategy_rule_ids_for_stage(&self, stage_id: &str) -> Option<&HashSet<String>> {
        self.strategy_rule_ids_by_stage.get(stage_id)
    }

    /// `issues` are `(rule_id, Issue)` pairs — the rule-aware merge result built by
    /// `build_maze` (pipeline.rs). `rule_id` is carried alongside `Issue`, not as a field on
    /// `Issue` itself — `Issue` is a QC-level type used outside of rules too and must not know
    /// about them; the pairing is purely a wiring detail local to repair dispatch.
    pub fn run(
        &self,
        issues: &[(String, Issue)],
        maze: &mut Maze<T>,
        rng: &mut impl RngCore,
        preset_state: &PresetState,
    ) -> Vec<RepairOutcome> {
        // Precomputed once per call rather than `self.rules.iter().find(...)` per issue — same
        // rationale as `strategy_rule_ids` above: this loop runs once per repair-loop iteration
        // against every active rule that iteration, so a per-issue linear scan over `self.rules`
        // is O(rules × issues) for no reason when a HashMap lookup is O(1).
        let by_id: HashMap<&str, &RepairRuleConfig<T>> =
            self.rules.iter().map(|cfg| (cfg.rule.id.as_str(), cfg)).collect();
        let mut results = Vec::new();
        for (rule_id, issue) in issues {
            let Some(&cfg) = by_id.get(rule_id.as_str()) else { continue };
            let overrides = Some(&cfg.param_overrides);
            let params: StrategyParams = build_params(cfg.strategy.params(), overrides);
            let mut snapshots = SnapshotStack::new();
            let result = cfg.strategy.apply(issue, maze, &mut snapshots, rng, &params, preset_state);
            results.push(RepairOutcome { rule_id: rule_id.clone(), result });
        }
        results
    }

    /// Same as `run`, but also times each `RepairStrategy::apply` call, accumulating elapsed
    /// milliseconds and call count per `strategy_id` into `timing` — see
    /// `QualityControlEngine::run_timed`'s analogous role for checks (GitHub issue #56).
    /// `now_ms` is injected (not `std::time::Instant` directly) so this stays usable from
    /// `pipeline::build_maze`'s own wasm/native-aware clock.
    pub fn run_timed(
        &self,
        issues: &[(String, Issue)],
        maze: &mut Maze<T>,
        rng: &mut impl RngCore,
        preset_state: &PresetState,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: impl Fn() -> f64,
    ) -> Vec<RepairOutcome> {
        // Precomputed once per call rather than `self.rules.iter().find(...)` per issue — same
        // rationale as `strategy_rule_ids` above: this loop runs once per repair-loop iteration
        // against every active rule that iteration, so a per-issue linear scan over `self.rules`
        // is O(rules × issues) for no reason when a HashMap lookup is O(1).
        let by_id: HashMap<&str, &RepairRuleConfig<T>> =
            self.rules.iter().map(|cfg| (cfg.rule.id.as_str(), cfg)).collect();
        let mut results = Vec::new();
        for (rule_id, issue) in issues {
            let Some(&cfg) = by_id.get(rule_id.as_str()) else { continue };
            let overrides = Some(&cfg.param_overrides);
            let params: StrategyParams = build_params(cfg.strategy.params(), overrides);
            let mut snapshots = SnapshotStack::new();
            let start = now_ms();
            let result = cfg.strategy.apply(issue, maze, &mut snapshots, rng, &params, preset_state);
            let elapsed = now_ms() - start;
            let entry = timing.entry(cfg.strategy.strategy_id()).or_insert((0.0, 0));
            entry.0 += elapsed;
            entry.1 += 1;
            results.push(RepairOutcome { rule_id: rule_id.clone(), result });
        }
        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::MISSING_ENDPOINTS;

    fn rule(id: &str, checks: &[&str]) -> QcRule {
        QcRule { id: id.to_string(), kind: MISSING_ENDPOINTS, checks: checks.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn check_id_to_rule_maps_every_check_across_all_rules_strategy_or_not() {
        let engine = RepairEngine::<crate::space::SquareTessellation>::new(
            vec![],
            vec![rule("rule_a", &["rule_a:0", "rule_a:1"]), rule("rule_b", &["rule_b:0"])],
            vec![],
        );
        let map = engine.check_id_to_rule();
        assert_eq!(map.get("rule_a:0"), Some(&"rule_a".to_string()));
        assert_eq!(map.get("rule_a:1"), Some(&"rule_a".to_string()));
        assert_eq!(map.get("rule_b:0"), Some(&"rule_b".to_string()));
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn check_id_to_rule_empty_when_no_rules() {
        let engine = RepairEngine::<crate::space::SquareTessellation>::new(vec![], vec![], vec![]);
        assert!(engine.check_id_to_rule().is_empty());
    }

    #[test]
    fn strategy_rule_ids_only_includes_rules_with_a_registered_strategy() {
        let engine = RepairEngine::<crate::space::SquareTessellation>::new(
            vec![],
            vec![rule("rule_a", &["rule_a:0"]), rule("rule_b", &["rule_b:0"])],
            vec![],
        );
        // Neither rule has a strategy here (empty `rules` vec) — both still route via
        // `check_id_to_rule` for attribution, but neither is dispatched for repair.
        assert!(engine.strategy_rule_ids().is_empty());
    }

    #[test]
    fn strategy_rule_ids_for_stage_intersects_stage_and_strategy_rules() {
        let engine = RepairEngine::<crate::space::SquareTessellation>::new(
            vec![],
            vec![rule("rule_a", &["rule_a:0"]), rule("rule_b", &["rule_b:0"])],
            vec![RepairStage { id: "stage_1".to_string(), name: "Stage 1".to_string(), rule_ids: vec!["rule_a".to_string(), "rule_b".to_string()] }],
        );
        // Neither rule has a strategy (empty `rules` vec) — intersection is empty even though
        // both belong to the stage.
        assert!(engine.strategy_rule_ids_for_stage("stage_1").unwrap().is_empty());
    }

    #[test]
    fn strategy_rule_ids_for_stage_none_for_unknown_stage() {
        let engine = RepairEngine::<crate::space::SquareTessellation>::new(vec![], vec![], vec![]);
        assert!(engine.strategy_rule_ids_for_stage("no_such_stage").is_none());
    }
}
