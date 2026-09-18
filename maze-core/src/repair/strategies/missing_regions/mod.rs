use crate::Maze;
use crate::generation::PresetState;
use crate::graph::region_class::RegionClass;
use crate::ids::NodeId;
use crate::quality_control::MissingRegionsIssue;
use crate::repair::command::MutationCommand;
use crate::repair::draft::DraftMaze;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::{HashMap, HashSet};

mod convert;
mod grow;
mod reuse;

use grow::try_grow;
use reuse::try_reuse;

#[cfg(test)]
mod tests;

pub const PARAM_LOCALITY: &str = "locality";
pub const PARAM_MIN_REGION_SIZE: &str = "min_region_size";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_LOCALITY,
        label: "Growth directionality",
        kind: StrategyParamKind::Float {
            default: 0.5,
            min: 0.0,
            max: 1.0,
        },
    },
    StrategyParam {
        id: PARAM_MIN_REGION_SIZE,
        // Value is a node count — rounded to usize before use (see `min_region_size`).
        label: "Minimum grown region size",
        kind: StrategyParamKind::Float {
            default: 2.0,
            min: 1.0,
            max: 64.0,
        },
    },
];

// Internal attempt-budget caps — not user-configurable (see Specs/repair.md's rationale for
// `MissingRegionsStrategy`): they exist purely as a circuit breaker against an unconvergeable
// graph/preset combination, not as an algorithm parameter like `locality`/`min_region_size`.
const MAX_REUSE_ATTEMPTS: u32 = 5;
const MAX_GROW_ATTEMPTS: u32 = 3;
const MAX_TOTAL_FAILURES: u32 = 10;

// Orchestrator-level flags, not user-configurable `StrategyParam`s: whether an inbound/outbound
// bridge requires an actual geometric (field-adjacent) placement. Currently always `true` for
// both — plain edges can only be added between field-neighbors. Once a non-geometric bridging
// mechanism (e.g. teleports) exists, the orchestrator would decide per-attempt whether a
// geometry-free path is available and pass `false` for that side instead, so `try_reuse`/
// `try_grow` stop filtering/prioritizing candidates by field-adjacency on it.
const INBOUND_REQUIRES_GEOMETRY: bool = true;
const OUTBOUND_REQUIRES_GEOMETRY: bool = true;

/// Bundles the read-only, per-`apply`-call context shared by `try_reuse`/`try_grow` and their
/// helpers — nodes already committed to an earlier region this call, the preset guard, and the
/// (currently fixed) geometry-requirement flags. Cuts the shared param tail from every function
/// signature in this module down to one reference; each function still takes its own
/// mutable/hot-changing params (`maze`, `snapshots`, `rng`, `excess_budget`, `target`,
/// `min_region_size`, ...) separately.
pub(super) struct GrowContext<'a> {
    pub(super) committed_nodes: &'a HashSet<NodeId>,
    pub(super) preset_state: &'a PresetState,
    pub(super) inbound_requires_geometry: bool,
    pub(super) outbound_requires_geometry: bool,
}

/// Handles `MISSING_REGIONS` — see GitHub issue #59. For each region class short of its
/// configured minimum (`issue.data`'s `missing_by_class`), tries to either reuse an existing
/// region or grow a new one (front-expansion from a seed inside an existing non-critical-path
/// region) and convert it into the target `RegionClass` by adding/removing one-way edges.
///
/// **`issue.data` is mandatory for this kind**, same contract as `InvalidLoopRandomStrategy`/
/// `ExpandRegionPassageStrategy`: `missing_by_class` is the producing check's result, there is
/// no other channel to learn it.
pub struct MissingRegionsStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingRegionsIssue> for MissingRegionsStrategy {
    fn strategy_id(&self) -> &'static str {
        "missing_regions"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn is_experimental(&self) -> bool {
        true
    }

    fn apply(
        &self,
        issue: &MissingRegionsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let balance_by_class = &issue.balance_by_class;
        if maze.meta.start.is_none() || maze.meta.finish.is_none() {
            return (RepairResult::Failed, vec![]);
        }

        let locality = params
            .get(PARAM_LOCALITY)
            .and_then(|v| v.as_float())
            .unwrap_or(0.5);
        let min_region_size = params
            .get(PARAM_MIN_REGION_SIZE)
            .and_then(|v| v.as_float())
            .unwrap_or(2.0)
            .round()
            .max(1.0) as usize;

        // Sorted by class name for determinism — HashMap iteration order is randomized
        // per-process, same rationale as `expand_region_passage.rs`'s key-sorting. Only negative
        // (shortfall) entries are creation targets; positive (surplus) entries are spendable
        // budget for cross-region growth (`try_open_excess_neighbor`), not targets themselves.
        let mut classes: Vec<RegionClass> = balance_by_class
            .keys()
            .filter(|&&c| balance_by_class.get(&c).copied().unwrap_or(0) < 0)
            .copied()
            .collect();
        classes.sort_by_key(|c| c.as_str());

        // Per GitHub issue #59's "Region Balance Consistency" rule: this counter is derived from
        // the issue balance and only ever debited on a fully committed cross-region absorption
        // (`try_open_excess_neighbor`); a rolled-back attempt restores its own debit (see
        // `try_grow`'s `budget_before` snapshot/restore), so this map always reflects only
        // successfully spent surplus, never a failed attempt's speculative spend.
        let mut excess_budget: HashMap<RegionClass, i32> = balance_by_class
            .iter()
            .filter(|&(_, &balance)| balance > 0)
            .map(|(&class, &balance)| (class, balance))
            .collect();

        let mut committed_nodes: HashSet<NodeId> = HashSet::new();
        let mut total_failures: u32 = 0;
        let mut any_fixed = false;

        // Running draft (DraftMaze wraps DraftMaze, Specs/repair.md) — starts as `maze.draft()`,
        // then updated after each successfully committed region so the *next* shortfall item
        // sees prior items' committed changes, mirroring the original in-place mutation
        // sequencing while keeping every mutation off the real `Maze` until `apply()` returns.
        let mut current = DraftMaze::new(maze.draft());

        'classes: for class in classes {
            // `Path` is never a valid creation target (see Specs/repair.md) — skipped without
            // consuming attempt budget, doesn't block other classes.
            if class == RegionClass::Path {
                continue;
            }
            let mut remaining = balance_by_class
                .get(&class)
                .copied()
                .unwrap_or(0)
                .unsigned_abs();

            while remaining > 0 {
                if total_failures >= MAX_TOTAL_FAILURES {
                    break 'classes;
                }

                let ctx = GrowContext {
                    committed_nodes: &committed_nodes,
                    preset_state,
                    inbound_requires_geometry: INBOUND_REQUIRES_GEOMETRY,
                    outbound_requires_geometry: OUTBOUND_REQUIRES_GEOMETRY,
                };
                let mut attempt = DraftMaze::new(current.maze.draft());
                let outcome = attempt_one_region(
                    &mut attempt,
                    class,
                    locality,
                    min_region_size,
                    &mut excess_budget,
                    &ctx,
                    rng,
                );

                match outcome {
                    Some(members) => {
                        current.absorb(attempt);
                        committed_nodes.extend(members);
                        remaining -= 1;
                        any_fixed = true;
                    }
                    None => {
                        // Failed attempt: `attempt` is simply dropped — nothing was ever applied
                        // to `current`.
                        total_failures += 1;
                    }
                }
            }
        }

        if any_fixed {
            (RepairResult::Fixed { score: None }, current.into_commands())
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(MissingRegionsStrategy, MissingRegionsIssue);

/// One full region-item attempt: try reuse first, fall back to growth. Returns the committed
/// region's `members` on success — the caller (`apply`) is responsible for absorbing `attempt`
/// into its running draft in that case — or `None` on failure (caller drops `attempt`).
fn attempt_one_region<T: Tessellation>(
    attempt: &mut DraftMaze<T>,
    target: RegionClass,
    locality: f64,
    min_region_size: usize,
    excess_budget: &mut HashMap<RegionClass, i32>,
    ctx: &GrowContext,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    if let Some(members) = try_reuse(attempt, target, min_region_size, excess_budget, ctx, rng) {
        return Some(members);
    }
    try_grow(
        attempt,
        target,
        locality,
        min_region_size,
        excess_budget,
        ctx,
        rng,
    )
}
