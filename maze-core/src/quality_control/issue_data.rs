use std::collections::HashMap;
use crate::ids::EdgeId;
use crate::graph::region_class::RegionClass;

/// Canonical key for a cycle: its edge set, sorted. Two `Vec<EdgeId>` describing the same cycle
/// (same edges, any order) produce the same key — used both to dedup cycles across merges and
/// to attribute per-cycle check provenance (`invalid_sources`) in a way that survives `all`/
/// `invalid` being re-indexed during merge.
pub fn canonical_cycle_key(cycle: &[EdgeId]) -> Vec<EdgeId> {
    let mut key = cycle.to_vec();
    key.sort_unstable();
    key
}

#[derive(Debug, Clone, PartialEq)]
pub enum IssueData {
    // TODO: temporary infra-test payload, not tied to any real IssueKind.
    // Remove/replace once the first real variant lands.
    TestPayload(Vec<u64>),
    /// Produced by any check that flags cycles invalid for a check-specific reason (currently
    /// `MinLoopLengthCheck`/`MaxLoopLengthCheck`; future checks may flag cycles invalid for other
    /// reasons and reuse this same variant). `all` holds every simple cycle found in the maze
    /// (valid and invalid alike), each as the set of base-Graph edges forming it — membership
    /// only, order carries no meaning, edge ids within one cycle never repeat. `invalid` is the
    /// subset of indices into `all` that the producing check(s) flagged (the ones a repair
    /// strategy must break). Keeping the valid cycles alongside the invalid ones lets a strategy
    /// avoid cutting an edge shared with a cycle it must not destroy, instead of only seeing the
    /// cycles it's supposed to break.
    InvalidLoops {
        all: Vec<Vec<EdgeId>>,
        invalid: Vec<usize>,
        /// Per-cycle check provenance, keyed by `canonical_cycle_key` (not by index into `all`)
        /// — indices are re-mapped on every merge, but a cycle's canonical key is stable across
        /// merges, so this map never needs remapping. A cycle absent here was flagged by no
        /// check directly tracked (shouldn't happen for entries in `invalid`, but the map is not
        /// required to cover every index — absence means "no recorded source", not an error).
        invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
    },
    /// Produced by any check that flags the maze as short on loops overall (currently only
    /// `MinLoopsCountCheck`; future checks needing more loops added may reuse this variant).
    /// `missing` is how many loops short of the requirement the maze is — lets a repair
    /// strategy know how many to add.
    Missing {
        missing: u32,
    },
    /// Carried by `REPAIR_LIMIT_REACHED` (see that const's doc comment) — identifies which
    /// `RepairLimits` bound cut the repair loop short.
    RepairLimitReached {
        limit: RepairLimitKind,
    },
    /// Carried by `QC_NO_PROGRESS` (see that const's doc comment) — the rule ids whose merged
    /// `(rule_id, Issue)` pair was byte-for-byte identical to the previous iteration's, the
    /// condition that tripped the no-progress guard. Typically surfaces a structural conflict
    /// between two active rules fighting over the same metric (e.g. a `min_loop_density` rule
    /// and a `max_loop_density` rule whose thresholds can't both be satisfied at once) rather
    /// than a transient stall.
    QcNoProgress {
        rule_ids: Vec<String>,
    },
    /// Produced by any check that flags an SCC region as needing expansion for a check-specific
    /// reason (paired with `REGION_NEEDS_EXPANSION`) — currently `MinRegionSizeCheck` (region
    /// smaller than a configured absolute tile count) and `MinRegionRatioCheck` (region smaller
    /// than a configured share of the field), though future checks may flag a region for
    /// expansion for reasons unrelated to size. `invalid` holds indices into
    /// `maze.analysis.scc(&maze.graph).components` — not a copy of the regions themselves, since
    /// that computation is already cached there and a repair strategy can re-fetch it (cache hit)
    /// rather than carry a duplicate snapshot through `Issue`.
    RegionsNeedingExpansion {
        invalid: Vec<usize>,
        /// Per-region check provenance, keyed by the same component index as `invalid` — stable
        /// within one QC pass because every check sharing this issue reads from the same single
        /// `maze.analysis.scc(&maze.graph)` cache entry, unlike cycle indices (which get
        /// remapped on merge because cycle enumeration has no equivalent stable identity).
        invalid_sources: HashMap<usize, Vec<String>>,
    },
    /// Produced by `MinRegionCountCheck` (paired with `MISSING_REGIONS`) — carries the region
    /// balance per `RegionClass` (Specs/repair.md's "Region Balance" data model): `-N` means the
    /// maze is short N regions of that class against its configured minimum (a repair strategy
    /// must create/convert regions into it), `+N` means the class has N regions *above* its
    /// minimum, a spendable surplus a repair strategy may consume (reuse or grow-through) when
    /// fixing a different class's shortfall. A class sitting exactly at its minimum, or with no
    /// minimum configured, carries no entry at all (not a `0` entry) — absence means "nothing to
    /// fix, nothing to spend" for that class. Since a single `MinRegionCountCheck` instance now
    /// evaluates all four classes in one pass (see GitHub issue #60's multi-instance design,
    /// retired in favor of this), one check call produces one `Issue` with every off-target
    /// class's balance already in `balance_by_class` — no cross-instance merge is needed in the
    /// common case, though `merge_issue` still unions two instances' output if more than one is
    /// ever active at once. `HashMap` iteration order is not stable — callers that surface this
    /// map (analytics DTOs, UI rendering) must sort by `RegionClass::as_str()` before
    /// display/comparison if order matters there.
    MissingRegions {
        balance_by_class: HashMap<RegionClass, i32>,
    },
    /// Produced by `SccCountCheck` (paired with `EXCESSIVE_SCC_COUNT`) — mandatory for this
    /// kind, same contract as `RegionsNeedingExpansion`/`InvalidLoops`: `max_scc_count` is the
    /// configured threshold the check compared against, needed by `ReduceSccCountStrategy` to
    /// compute how many regions to merge (`current_scc_count - max_scc_count`) — there is no
    /// other channel to learn it (the check's own `max_scc_count` field isn't visible to a
    /// strategy, only what it attaches to the `Issue`).
    ExcessiveSccCount {
        max_scc_count: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepairLimitKind {
    MaxIterations,
    TimeBudget,
}

impl RepairLimitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RepairLimitKind::MaxIterations => "max_iterations",
            RepairLimitKind::TimeBudget => "time_budget",
        }
    }
}
