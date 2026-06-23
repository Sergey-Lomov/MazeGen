use crate::ids::EdgeId;

#[derive(Debug, Clone, PartialEq)]
pub enum IssueData {
    // TODO: temporary infra-test payload, not tied to any real IssueKind.
    // Remove/replace once the first real variant lands.
    TestPayload(Vec<u64>),
    /// Produced by any check that flags cycles invalid for a check-specific reason (currently
    /// only MinLoopLengthCheck — shorter than a configured threshold; future checks may flag
    /// cycles invalid for other reasons and reuse this same variant). `all` holds every simple
    /// cycle found in the maze (valid and invalid alike), each as the set of base-Graph edges
    /// forming it — membership only, order carries no meaning, edge ids within one cycle never
    /// repeat. `invalid` is the subset of indices into `all` that the producing check(s) flagged
    /// (the ones a repair strategy must break). Keeping the valid cycles alongside the invalid
    /// ones lets a strategy avoid cutting an edge shared with a cycle it must not destroy,
    /// instead of only seeing the cycles it's supposed to break.
    InvalidLoops {
        all: Vec<Vec<EdgeId>>,
        invalid: Vec<usize>,
    },
}
