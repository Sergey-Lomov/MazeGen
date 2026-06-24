use std::collections::{HashMap, HashSet};
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::issue::Issue;
use crate::generation::PresetState;
use super::rule::{QcRule, CheckId};
use super::params::{build_params, StrategyParams};
use super::result::RepairResult;
use super::strategy::RepairStrategy;

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
    pub fn check_id_to_rule(&self) -> HashMap<CheckId, String> {
        let mut map = HashMap::new();
        for rule in &self.all_rules {
            for &check_id in &rule.checks {
                map.insert(check_id, rule.id.clone());
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
            let result = cfg.strategy.apply(issue, maze, rng, &params, preset_state);
            results.push(RepairOutcome { rule_id: rule_id.clone(), result });
        }
        results
    }
}
