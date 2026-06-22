use crate::ids::EdgeId;

#[derive(Debug, Clone, PartialEq)]
pub enum IssueData {
    // TODO: temporary infra-test payload, not tied to any real IssueKind.
    // Remove/replace once the first real variant lands.
    TestPayload(Vec<u64>),
    /// Produced by MinLoopLengthCheck. Each inner Vec<EdgeId> is the set of base-Graph
    /// edges forming one simple cycle shorter than the configured threshold — membership
    /// only, order carries no meaning. Edge ids within one cycle never repeat.
    ShortLoops(Vec<Vec<EdgeId>>),
}
