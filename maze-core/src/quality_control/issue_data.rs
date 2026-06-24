use std::collections::HashMap;
use crate::ids::EdgeId;

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
        invalid_sources: HashMap<Vec<EdgeId>, Vec<&'static str>>,
    },
}
