use super::command::MutationCommand;
use super::params::{StrategyParams, build_params};
use super::result::RepairResult;
use super::strategy::NestedStrategyConfig;
use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::Issue;
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::HashMap;

/// Builds a nested candidate's `StrategyParams`, honoring dispatcher-owned parameters — GitHub
/// issue #486. For every id the nested strategy lists in `nested_suppressed_params()` (for an
/// element-adding strategy: `reserve_percent`, `attempts_limit`), the value comes from
/// `inherited` — the dispatcher's own resolved value, computed once for the whole dispatch — and
/// any stale explicit override the config still carries for that id is dropped (the web UI no
/// longer shows it on a nested node, so a leftover value would be invisible yet active). Every
/// other id keeps its normal precedence: the candidate's own `param_overrides` wins.
///
/// `inherited` is only consulted for suppressed ids; passing an empty map (region-merge
/// dispatchers, whose nested strategies suppress nothing) makes this identical to the old
/// `build_params(config.strategy.params(), Some(&config.param_overrides))`.
///
/// `pub(crate)` because a handful of strategies dispatch to a nested strategy directly rather
/// than through `dispatch_priority`/`dispatch_weighted` (e.g. `AddElevatorStopStrategy::try_add_new`)
/// and still need the same suppressed-param handling.
pub(crate) fn nested_params<T: Tessellation>(
    config: &NestedStrategyConfig<T>,
    inherited: &HashMap<String, String>,
) -> StrategyParams {
    let suppressed = config.strategy.nested_suppressed_params();
    if suppressed.is_empty() {
        return build_params(config.strategy.params(), Some(&config.param_overrides));
    }

    let mut overrides: HashMap<String, String> = config.param_overrides.clone();
    for &id in suppressed {
        overrides.remove(id);
        if let Some(value) = inherited.get(id) {
            overrides.insert(id.to_string(), value.clone());
        }
    }
    build_params(config.strategy.params(), Some(&overrides))
}

/// Nested candidates filling `slot_id`, in configured order. Defensive runtime filter, not the
/// primary validation: `maze-runner`'s `build_nested` already guarantees every entry in `nested`
/// fills a slot the parent actually declared, so this only protects direct `apply()` calls made
/// outside the runner (tests, future internal callers). Shared by the priority/weighted
/// dispatchers.
pub(crate) fn slot_candidates<'a, T: Tessellation>(
    nested: &'a [NestedStrategyConfig<T>],
    slot_id: &str,
) -> Vec<&'a NestedStrategyConfig<T>> {
    nested
        .iter()
        .filter(|n| n.slot.slot_id == slot_id)
        .collect()
}

/// `param_overrides` key a weighted nested candidate's selection weight is read from — see
/// `resolve_weight`. Not a declared `StrategyParam` of the nested strategy itself (it's a
/// convention the weighted dispatchers impose on top of whatever params the nested strategy
/// already has), so it never appears in any strategy's `params()`.
pub(crate) const WEIGHT_KEY: &str = "weight";

/// Fallback weight used whenever `WEIGHT_KEY` is absent, unparsable, non-finite, or `<= 0.0`.
pub(crate) const DEFAULT_WEIGHT: f64 = 1.0;

/// Resolves a nested candidate's selection weight from its `param_overrides`. Never returns a
/// non-finite or non-positive value — any missing/unparsable/non-finite/`<= 0.0` input falls
/// back to `DEFAULT_WEIGHT`, guaranteeing that as long as at least one nested candidate is
/// configured, the pool passed to `dispatch_weighted` always has a strictly positive total
/// weight.
pub(crate) fn resolve_weight(param_overrides: &HashMap<String, String>) -> f64 {
    param_overrides
        .get(WEIGHT_KEY)
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(DEFAULT_WEIGHT)
}

/// Wraps `configs` (already filtered to `slot_id`) into `WeightedCandidate`s using the shared
/// `WEIGHT_KEY` convention (`resolve_weight`). Debug-asserts no candidate strategy declares its
/// own `WEIGHT_KEY` param, which would collide with the reserved `param_overrides` key.
pub(crate) fn weighted_candidates<'a, T: Tessellation>(
    configs: &[&'a NestedStrategyConfig<T>],
    slot_id: &str,
) -> Vec<WeightedCandidate<'a, T>> {
    debug_assert!(
        configs
            .iter()
            .all(|c| !c.strategy.params().iter().any(|p| p.id == WEIGHT_KEY)),
        "a {slot_id} candidate declares its own \"{WEIGHT_KEY}\" param — this collides with \
         resolve_weight's reserved param_overrides key; rename the candidate's param"
    );
    configs
        .iter()
        .map(|&config| WeightedCandidate {
            config,
            weight: resolve_weight(&config.param_overrides),
        })
        .collect()
}

// `dispatch_weighted` operates at the erased boundary — nested candidates (`NestedStrategyConfig`)
// hold `Box<dyn ErasedRepairStrategy<T>>`, whose own kind may differ from the caller's own `I`
// (see `Specs/repair.md`'s nested-strategy contract) — so `issue` here is always `&dyn Issue`.

/// One nested-strategy candidate paired with its selection weight. The weight's meaning and
/// resolution (e.g. reading a `"weight"` key out of `config.param_overrides`) belongs entirely
/// to the caller — `dispatch_weighted` itself carries no convention for how a weight is derived,
/// only what it does with an already-resolved one.
pub struct WeightedCandidate<'a, T: Tessellation> {
    pub config: &'a NestedStrategyConfig<T>,
    pub weight: f64,
}

/// Tries `candidates` in weighted-random order, without replacement, until one succeeds
/// (`Fixed`) or every candidate has been tried and failed. See `Specs/repair.md`'s "Nested
/// strategies" section for the general nested-dispatch contract this builds on; this helper adds
/// weighted selection and failure-retry on top of it — issue #90.
///
/// **Weight contract**: every `weight` must be finite and `> 0.0` — the caller's responsibility;
/// `debug_assert!`-checked defensively on entry, never silently substituted. Empty `candidates`
/// returns `Failed` immediately without touching `rng`.
///
/// **Owns `StrategyParams` construction**: for each attempt, builds the nested strategy's
/// `StrategyParams` from `config.strategy.params()`, `config.param_overrides` and
/// `inherited_overrides` (see `nested_params` — GitHub issue #486: dispatcher-owned params like
/// `reserve_percent`/`attempts_limit` are injected here and any stale nested override for them is
/// dropped). Callers pass raw `NestedStrategyConfig`s, never pre-built `StrategyParams`. A caller
/// with nothing to inherit down passes `&HashMap::new()`.
///
/// **No rollback bookkeeping needed** (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot
/// contract): every attempt is called against the same immutable `&Maze` — nothing mutates the
/// real graph mid-call, so a `Failed` candidate's returned commands are simply discarded (never
/// concatenated); the next weighted pick tries again against the identical unmutated snapshot. A
/// `Fixed` candidate's commands are returned as-is.
///
/// **Recursion**: each attempt is called with `&config.nested` passed straight through — a
/// nested-under-nested strategy chain is not truncated here.
///
/// **Only `Fixed`/`Failed`**: `RepairResult` is a two-variant enum today (`Specs/repair.md`).
/// The `match` below has no wildcard arm on purpose — adding a third `RepairResult` variant must
/// force a compile error here rather than a silently wrong runtime fallthrough.
pub fn dispatch_weighted<T: Tessellation>(
    issue: &dyn Issue,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    candidates: &[WeightedCandidate<T>],
    inherited_overrides: &HashMap<String, String>,
) -> (RepairResult, Vec<MutationCommand>) {
    debug_assert!(
        candidates
            .iter()
            .all(|c| c.weight.is_finite() && c.weight > 0.0),
        "dispatch_weighted: every candidate weight must be finite and > 0.0"
    );

    let mut pool: Vec<&WeightedCandidate<T>> = candidates.iter().collect();

    while !pool.is_empty() {
        let total: f64 = pool.iter().map(|c| c.weight).sum();
        let mut pick = rng.random_range(0.0..total);
        let mut chosen_idx = pool.len() - 1;
        for (i, candidate) in pool.iter().enumerate() {
            if pick < candidate.weight {
                chosen_idx = i;
                break;
            }
            pick -= candidate.weight;
        }
        let entry = pool.remove(chosen_idx);

        let params = nested_params(entry.config, inherited_overrides);
        let (result, commands) = entry.config.strategy.apply(
            issue,
            maze,
            rng,
            &params,
            preset_state,
            &entry.config.nested,
        );
        match result {
            RepairResult::Fixed { .. } => {
                return (result, commands);
            }
            RepairResult::Failed => {
                // commands discarded — never applied against the real Maze in the first place.
            }
        }
    }

    (RepairResult::Failed, vec![])
}

/// Tries `candidates` in the order they're already given, until one succeeds (`Fixed`) or every
/// candidate has been tried and failed — GitHub issue #259, the priority-fallback companion to
/// `dispatch_weighted` above. Unlike weighted selection, order here carries the caller's entire
/// selection convention: `dispatch_priority` itself has no notion of priority beyond "try index 0
/// first, then 1, then 2, ...". Empty `candidates` returns `Failed` immediately without touching
/// `rng`.
///
/// **Owns `StrategyParams` construction**, **no rollback bookkeeping needed**, **recursion**, and
/// **only `Fixed`/`Failed`** — all four points from `dispatch_weighted`'s doc comment apply here
/// unchanged; see there for the rationale. `rng` is still threaded through to each candidate's own
/// `apply()` (a candidate strategy may itself be randomized), just never consulted by the dispatch
/// loop itself to pick an order.
pub fn dispatch_priority<T: Tessellation>(
    issue: &dyn Issue,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    candidates: &[&NestedStrategyConfig<T>],
    inherited_overrides: &HashMap<String, String>,
) -> (RepairResult, Vec<MutationCommand>) {
    for config in candidates {
        let params = nested_params(config, inherited_overrides);
        let (result, commands) =
            config
                .strategy
                .apply(issue, maze, rng, &params, preset_state, &config.nested);
        match result {
            RepairResult::Fixed { .. } => {
                return (result, commands);
            }
            RepairResult::Failed => {
                // commands discarded — never applied against the real Maze in the first place.
            }
        }
    }

    (RepairResult::Failed, vec![])
}

#[cfg(test)]
#[path = "nested_dispatch_tests.rs"]
mod tests;
