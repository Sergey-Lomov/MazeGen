use crate::ids::EdgeId;

#[derive(Debug, Clone, PartialEq)]
pub enum IssueData {
    // TODO: temporary infra-test payload, not tied to any real IssueKind.
    // Remove/replace once the first real variant lands.
    TestPayload(Vec<u64>),
    /// Produced by MinLoopLengthCheck. `all` holds every simple cycle found in the maze
    /// (short and long alike), each as the set of base-Graph edges forming it — membership
    /// only, order carries no meaning, edge ids within one cycle never repeat. `short` is
    /// the subset of indices into `all` whose tile-length is below the configured threshold
    /// (the ones a repair strategy must break). Keeping the long, valid cycles alongside the
    /// short ones lets a strategy avoid cutting an edge shared with a cycle it must not
    /// destroy, instead of only seeing the cycles it's supposed to break.
    ShortLoops {
        all: Vec<Vec<EdgeId>>,
        short: Vec<usize>,
    },
}
