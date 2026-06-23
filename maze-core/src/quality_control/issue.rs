use crate::quality_control::issue_data::IssueData;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IssueKind {
    MissingEndpoints,
    UnreachableFinish,
    MinLoopsCount,
    MinLoopLength,
    CycleAnalysisOverflowed,
}

pub const MISSING_ENDPOINTS: IssueKind = IssueKind::MissingEndpoints;
pub const UNREACHABLE_FINISH: IssueKind = IssueKind::UnreachableFinish;
pub const MIN_LOOPS_COUNT: IssueKind = IssueKind::MinLoopsCount;
pub const MIN_LOOP_LENGTH: IssueKind = IssueKind::MinLoopLength;
/// Not a toggleable QC check — raised directly by `build_analytics_snapshot`
/// (maze-wasm/src/analytics.rs) whenever `GraphAnalytics::cycle_analysis_overflowed` is true.
/// Unlike the other kinds here, no `Check<T>` implementation produces this; it surfaces a
/// condition from the always-on analytics computation, not a user-selected check.
pub const CYCLE_ANALYSIS_OVERFLOWED: IssueKind = IssueKind::CycleAnalysisOverflowed;

impl IssueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueKind::MissingEndpoints => "missing_endpoints",
            IssueKind::UnreachableFinish => "unreachable_finish",
            IssueKind::MinLoopsCount => "min_loops_count",
            IssueKind::MinLoopLength => "min_loop_length",
            IssueKind::CycleAnalysisOverflowed => "cycle_analysis_overflowed",
        }
    }

    /// Round-trips every variant including `CycleAnalysisOverflowed`, even though the latter
    /// can never have a registered `RepairStrategy` (it's not a toggleable QC check — see
    /// `CYCLE_ANALYSIS_OVERFLOWED`'s doc comment). `IssueKind::from_str` is also used by
    /// `maze-wasm/src/runner.rs` to validate `config.strategies` keys; a config naming this
    /// kind will parse here, then fail downstream with "unknown strategy" the same way any
    /// other kind with no matching strategy registration would — there is no dedicated
    /// rejection at this layer, by design, since strategy availability is the repair engine's
    /// concern, not `IssueKind`'s.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "missing_endpoints"  => Some(IssueKind::MissingEndpoints),
            "unreachable_finish" => Some(IssueKind::UnreachableFinish),
            "min_loops_count"    => Some(IssueKind::MinLoopsCount),
            "min_loop_length"    => Some(IssueKind::MinLoopLength),
            "cycle_analysis_overflowed" => Some(IssueKind::CycleAnalysisOverflowed),
            _ => None,
        }
    }
}

impl std::fmt::Display for IssueKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub kind: IssueKind,
    pub data: Option<IssueData>,
}

impl Issue {
    pub fn new(kind: IssueKind) -> Self {
        Self { kind, data: None }
    }

    pub fn with_data(kind: IssueKind, data: IssueData) -> Self {
        Self { kind, data: Some(data) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue_data::IssueData;

    #[test]
    fn with_data_round_trip() {
        let issue = Issue::with_data(MIN_LOOPS_COUNT, IssueData::TestPayload(vec![1, 2, 3]));
        assert_eq!(issue.kind, MIN_LOOPS_COUNT);
        assert_eq!(issue.data, Some(IssueData::TestPayload(vec![1, 2, 3])));
        let cloned = issue.clone();
        assert_eq!(issue, cloned);
    }

    #[test]
    fn new_has_no_data() {
        let issue = Issue::new(MISSING_ENDPOINTS);
        assert_eq!(issue.data, None);
    }

    #[test]
    fn as_str_from_str_round_trip_for_every_variant() {
        let kinds = [
            IssueKind::MissingEndpoints,
            IssueKind::UnreachableFinish,
            IssueKind::MinLoopsCount,
            IssueKind::MinLoopLength,
            IssueKind::CycleAnalysisOverflowed,
        ];
        for kind in kinds {
            assert_eq!(IssueKind::from_str(kind.as_str()), Some(kind));
        }
    }

    #[test]
    fn from_str_rejects_unknown_string() {
        assert_eq!(IssueKind::from_str("not_a_real_kind"), None);
    }
}
