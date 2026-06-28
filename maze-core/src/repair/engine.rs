use std::collections::{HashMap, HashSet};
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::issue::Issue;
use crate::generation::PresetState;
use super::rule::QcRule;
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
}

impl<T: Tessellation> RepairEngine<T> {
    /// `rules` — strategy assignments (only for rules with a strategy).
    /// `all_rules` — full rule list, including rules with no strategy. Every rule in
    /// `rules` must also appear in `all_rules` (by `id`); callers (`runner.rs::build_qc_and_repair`)
    /// are responsible for this invariant.
    pub fn new(rules: Vec<RepairRuleConfig<T>>, all_rules: Vec<QcRule>) -> Self {
        Self { rules, all_rules }
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
        );
        let map = engine.check_id_to_rule();
        assert_eq!(map.get("rule_a:0"), Some(&"rule_a".to_string()));
        assert_eq!(map.get("rule_a:1"), Some(&"rule_a".to_string()));
        assert_eq!(map.get("rule_b:0"), Some(&"rule_b".to_string()));
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn check_id_to_rule_empty_when_no_rules() {
        let engine = RepairEngine::<crate::space::SquareTessellation>::new(vec![], vec![]);
        assert!(engine.check_id_to_rule().is_empty());
    }

    #[test]
    fn strategy_rule_ids_only_includes_rules_with_a_registered_strategy() {
        let engine = RepairEngine::<crate::space::SquareTessellation>::new(
            vec![],
            vec![rule("rule_a", &["rule_a:0"]), rule("rule_b", &["rule_b:0"])],
        );
        // Neither rule has a strategy here (empty `rules` vec) — both still route via
        // `check_id_to_rule` for attribution, but neither is dispatched for repair.
        assert!(engine.strategy_rule_ids().is_empty());
    }
}
