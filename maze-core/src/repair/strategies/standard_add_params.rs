//! Shared standard parameters for repair strategies that **add** maze elements — see GitHub issue
//! #486. Every "add"/"missing" strategy (loop seeding, teleport minting, elevator/stop creation,
//! split tile minting, vertical passage adding, ...) needs the same handful of knobs: how much
//! reserve to build beyond the reported deficit, how many failed attempts to tolerate, and how to
//! order the source-node pool it grows new elements out from. Before this module each strategy
//! redeclared its own `PARAM_RESERVE_PERCENT` const, its own `StrategyParam` descriptor, its own
//! `params.get(...).as_float().unwrap_or(...)` read, and its own copy of the
//! `ceil(missing * (1 + reserve / 100))` arithmetic — with ids (`reserve_percent` vs
//! `vertical_reserve_percent`) and defaults (`0.0` vs `50.0`) that had silently diverged.
//!
//! **Canonical ids and unified defaults** (GitHub issue #486 — old project configs referencing the
//! pre-unification ids/values are intentionally not migrated):
//! - `reserve_percent`: `Float`, default **0.0**, range `[0, 500]`. Every strategy builds exactly
//!   the reported deficit unless a caller opts into over-provisioning.
//! - `attempts_limit`: `Float` (whole-number semantics), default **25**, range `[1, 10000]`.
//! - `src_mode`: the dead-end-priority source ordering — descriptor and options live in
//!   [`super::dead_end_priority`] (`SRC_MODE_PARAM`), reused verbatim here so the whole set can be
//!   appended in one call.
//!
//! **Ordering contract**: a strategy's own specific params come first, the shared set last — see
//! [`with_standard_add_params`]. This keeps the web UI layout stable (strategy-specific controls on
//! top, the standard block at the bottom of every add strategy).
//!
//! **Nested suppression**: when an add strategy runs *under a dispatcher* (`dispatch_priority` /
//! `dispatch_weighted`), `reserve_percent` and `attempts_limit` are owned by the dispatcher, not
//! the nested strategy — the dispatcher computes the target count and attempt budget once and
//! feeds them down. Such strategies list those two ids in `RepairStrategy::nested_suppressed_params`
//! so the web UI hides them on a nested node and the dispatcher strips any stale override. `src_mode`
//! is *not* suppressed — it controls geometry inside a single strategy, which the dispatcher has no
//! say over.

use crate::quality_control::RepairArea;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use std::collections::HashMap;

pub const PARAM_RESERVE_PERCENT: &str = "reserve_percent";
pub const PARAM_ATTEMPTS_LIMIT: &str = "attempts_limit";

/// Unified default for `reserve_percent` — build exactly the reported deficit, no over-provisioning
/// unless a caller asks. GitHub issue #486 unified this from the old `0.0` / `50.0` split.
pub const RESERVE_PERCENT_DEFAULT: f64 = 0.0;
/// Unified default for `attempts_limit` — GitHub issue #486 unified this from the old
/// `3` / `20` / `50` spread across strategies.
pub const ATTEMPTS_LIMIT_DEFAULT: f64 = 25.0;

pub const RESERVE_PERCENT_PARAM: StrategyParam = StrategyParam {
    id: PARAM_RESERVE_PERCENT,
    label: "Reserve percent",
    kind: StrategyParamKind::Float {
        default: RESERVE_PERCENT_DEFAULT,
        min: 0.0,
        max: 500.0,
    },
};

pub const ATTEMPTS_LIMIT_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ATTEMPTS_LIMIT,
    label: "Attempts limit",
    kind: StrategyParamKind::Float {
        default: ATTEMPTS_LIMIT_DEFAULT,
        min: 1.0,
        max: 10_000.0,
    },
};

/// The ids an add strategy hides (and a dispatcher strips) when the strategy runs nested — see the
/// module doc. `src_mode` deliberately excluded.
pub const NESTED_SUPPRESSED_ADD_PARAMS: &[&str] = &[PARAM_RESERVE_PERCENT, PARAM_ATTEMPTS_LIMIT];

/// Builds a strategy's full `static PARAMS` array: the strategy's own specific params first, then
/// the shared standard block last. Two forms:
///
/// ```ignore
/// // Node-based source pool — includes `src_mode`. Result: specific..., reserve_percent,
/// // src_mode, attempts_limit.
/// static PARAMS: [StrategyParam; 4] = add_strategy_params!(
///     StrategyParam { id: PARAM_ONE_WAY_CHANCE, label: "...", kind: ... },
/// );
///
/// // Non-node source pool (dead-end priority has no meaning) — omits `src_mode`. Result:
/// // specific..., reserve_percent, attempts_limit.
/// static PARAMS: [StrategyParam; 3] = add_strategy_params!(no_src_mode:
///     StrategyParam { id: PARAM_DESIRED_LENGTH, label: "...", kind: ... },
/// );
/// ```
///
/// The array length is written explicitly by the caller (specific count + 3, or + 2) — a mismatch
/// is a compile error, which is the point.
#[macro_export]
macro_rules! add_strategy_params {
    (no_src_mode: $($specific:expr),* $(,)?) => {
        [
            $($specific,)*
            $crate::repair::strategies::standard_add_params::RESERVE_PERCENT_PARAM,
            $crate::repair::strategies::standard_add_params::ATTEMPTS_LIMIT_PARAM,
        ]
    };
    ($($specific:expr),* $(,)?) => {
        [
            $($specific,)*
            $crate::repair::strategies::standard_add_params::RESERVE_PERCENT_PARAM,
            $crate::repair::strategies::dead_end_priority::SRC_MODE_PARAM,
            $crate::repair::strategies::standard_add_params::ATTEMPTS_LIMIT_PARAM,
        ]
    };
}

/// Reads `reserve_percent` and turns a raw deficit into the target count to build:
/// `ceil(missing * (1 + reserve / 100))`, floored at 1 when `missing > 0`. Replaces the identical
/// arithmetic copy-pasted into every add strategy.
pub fn reserve_target(params: &StrategyParams, missing: u32) -> u32 {
    if missing == 0 {
        return 0;
    }
    let reserve = params
        .get(PARAM_RESERVE_PERCENT)
        .and_then(|v| v.as_float())
        .unwrap_or(RESERVE_PERCENT_DEFAULT);
    ((missing as f64 * (1.0 + reserve / 100.0)).ceil() as u32).max(1)
}

/// Applies `reserve_percent` to every entry of a deficit issue's `missing` list — each count is
/// scaled the same way `reserve_target` scales one, so a strategy that feeds `missing` straight
/// into `RemainingDeficits` gets the reserve boost per area without touching the deficit
/// bookkeeping itself. An empty input, or the default 0% reserve, returns the list unchanged.
pub fn reserve_scaled_missing(
    params: &StrategyParams,
    missing: &[(RepairArea, u32)],
) -> Vec<(RepairArea, u32)> {
    missing
        .iter()
        .map(|&(area, count)| (area, reserve_target(params, count)))
        .collect()
}

/// The dispatcher-owned add params (`reserve_percent`, `attempts_limit`) resolved to string
/// overrides, ready to feed to `nested_dispatch::nested_params` as `inherited` — see GitHub issue
/// #486. Only the params actually present in `params` are emitted.
pub fn inherited_overrides(params: &StrategyParams) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(v) = params.get(PARAM_RESERVE_PERCENT).and_then(|v| v.as_float()) {
        out.insert(PARAM_RESERVE_PERCENT.to_string(), v.to_string());
    }
    if let Some(v) = params.get(PARAM_ATTEMPTS_LIMIT).and_then(|v| v.as_float()) {
        out.insert(PARAM_ATTEMPTS_LIMIT.to_string(), v.to_string());
    }
    out
}

/// Reads `attempts_limit` as a `usize`, rounding and flooring at 1. `unwrap_or` uses the unified
/// default.
pub fn attempts_limit(params: &StrategyParams) -> usize {
    params
        .get(PARAM_ATTEMPTS_LIMIT)
        .and_then(|v| v.as_float())
        .map(|f| f.round().max(1.0) as usize)
        .unwrap_or(ATTEMPTS_LIMIT_DEFAULT as usize)
}

/// Reads `src_mode` as a `&str`, falling back to the random default. Replaces the copy-pasted
/// `match params.get(PARAM_SRC_MODE) { Some(Enum(v)) => v.as_str(), _ => SRC_MODE_RANDOM }`.
pub fn src_mode(params: &StrategyParams) -> &str {
    match params.get(super::dead_end_priority::PARAM_SRC_MODE) {
        Some(StrategyParamValue::Enum(v)) => v.as_str(),
        _ => super::dead_end_priority::SRC_MODE_RANDOM,
    }
}

#[cfg(test)]
mod tests {
    use super::super::dead_end_priority::{
        PARAM_SRC_MODE, SRC_MODE_DEAD_END_PRIORITY, SRC_MODE_RANDOM,
    };
    use super::*;
    use crate::repair::params::build_params;
    use std::collections::HashMap;

    const ONE_WAY_CHANCE: StrategyParam = StrategyParam {
        id: "one_way_chance",
        label: "One-way chance",
        kind: StrategyParamKind::Float {
            default: 0.0,
            min: 0.0,
            max: 100.0,
        },
    };

    static WITH_SRC: [StrategyParam; 4] = crate::add_strategy_params!(ONE_WAY_CHANCE);
    static WITHOUT_SRC: [StrategyParam; 3] =
        crate::add_strategy_params!(no_src_mode: ONE_WAY_CHANCE);

    #[test]
    fn standard_set_appends_in_specific_then_shared_order() {
        let ids: Vec<&str> = WITH_SRC.iter().map(|p| p.id).collect();
        assert_eq!(
            ids,
            vec![
                "one_way_chance",
                PARAM_RESERVE_PERCENT,
                PARAM_SRC_MODE,
                PARAM_ATTEMPTS_LIMIT
            ]
        );
    }

    #[test]
    fn reserve_and_attempts_only_set_omits_src_mode() {
        let ids: Vec<&str> = WITHOUT_SRC.iter().map(|p| p.id).collect();
        assert_eq!(
            ids,
            vec![
                "one_way_chance",
                PARAM_RESERVE_PERCENT,
                PARAM_ATTEMPTS_LIMIT
            ]
        );
    }

    #[test]
    fn reserve_target_applies_ceil_of_missing_times_reserve() {
        let params = build_params(&WITH_SRC, None);
        assert_eq!(reserve_target(&params, 0), 0);
        assert_eq!(
            reserve_target(&params, 4),
            4,
            "default reserve 0 builds exactly the deficit"
        );

        let mut ov = HashMap::new();
        ov.insert(PARAM_RESERVE_PERCENT.to_string(), "50".to_string());
        let params = build_params(&WITH_SRC, Some(&ov));
        assert_eq!(reserve_target(&params, 4), 6, "4 * 1.5 = 6");
        assert_eq!(reserve_target(&params, 3), 5, "ceil(3 * 1.5) = 5");
    }

    #[test]
    fn attempts_limit_defaults_to_unified_value_and_rounds() {
        let params = build_params(&WITH_SRC, None);
        assert_eq!(attempts_limit(&params), ATTEMPTS_LIMIT_DEFAULT as usize);

        let mut ov = HashMap::new();
        ov.insert(PARAM_ATTEMPTS_LIMIT.to_string(), "2.6".to_string());
        let params = build_params(&WITH_SRC, Some(&ov));
        assert_eq!(attempts_limit(&params), 3);
    }

    #[test]
    fn src_mode_reads_enum_or_falls_back_to_random() {
        let params = build_params(&WITH_SRC, None);
        assert_eq!(src_mode(&params), SRC_MODE_RANDOM);

        let mut ov = HashMap::new();
        ov.insert(
            PARAM_SRC_MODE.to_string(),
            SRC_MODE_DEAD_END_PRIORITY.to_string(),
        );
        let params = build_params(&WITH_SRC, Some(&ov));
        assert_eq!(src_mode(&params), SRC_MODE_DEAD_END_PRIORITY);
    }
}
