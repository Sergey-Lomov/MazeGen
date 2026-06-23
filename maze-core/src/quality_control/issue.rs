use crate::quality_control::issue_data::IssueData;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IssueKind {
    MissingEndpoints,
    UnreachableFinish,
    MinLoopsCount,
    InvalidLoop,
    CycleAnalysisOverflowed,
}

pub const MISSING_ENDPOINTS: IssueKind = IssueKind::MissingEndpoints;
pub const UNREACHABLE_FINISH: IssueKind = IssueKind::UnreachableFinish;
pub const MIN_LOOPS_COUNT: IssueKind = IssueKind::MinLoopsCount;
/// A cycle is invalid for some check-specific reason (currently: shorter than a configured
/// minimum tile-length — see `MinLoopLengthCheck`). Future checks may flag cycles invalid for
/// other reasons entirely (e.g. too long) and reuse this same kind — see `IssueData::InvalidLoops`
/// and `Issue.source_checks` for how multiple checks contributing to one kind are distinguished.
pub const INVALID_LOOP: IssueKind = IssueKind::InvalidLoop;
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
            IssueKind::InvalidLoop => "invalid_loop",
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
            "invalid_loop"       => Some(IssueKind::InvalidLoop),
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
    /// Check id(s) (the wasm `available_checks()` id, e.g. `"min_loop_length"`) that produced
    /// or contributed to this issue. Empty for issues not raised by a toggleable `Check<T>` —
    /// currently only `CYCLE_ANALYSIS_OVERFLOWED`, pushed directly by `build_analytics_snapshot`
    /// (see its doc comment). Populated by `new_from_check`/`with_data_from_check`; merging two
    /// issues of the same kind (pipeline dedup) unions this list without duplicates.
    pub source_checks: Vec<&'static str>,
}

impl Issue {
    /// For issues not raised by a toggleable `Check<T>` (currently only
    /// `CYCLE_ANALYSIS_OVERFLOWED`) — `source_checks` is empty since there is no check id to
    /// attribute this to. Checks should use `new_from_check` instead.
    pub fn new(kind: IssueKind) -> Self {
        Self { kind, data: None, source_checks: Vec::new() }
    }

    pub fn with_data(kind: IssueKind, data: IssueData) -> Self {
        Self { kind, data: Some(data), source_checks: Vec::new() }
    }

    pub fn new_from_check(kind: IssueKind, source_check: &'static str) -> Self {
        Self { kind, data: None, source_checks: vec![source_check] }
    }

    pub fn with_data_from_check(kind: IssueKind, data: IssueData, source_check: &'static str) -> Self {
        Self { kind, data: Some(data), source_checks: vec![source_check] }
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
        assert!(issue.source_checks.is_empty());
    }

    #[test]
    fn new_from_check_records_source() {
        let issue = Issue::new_from_check(MISSING_ENDPOINTS, "missing_endpoints");
        assert_eq!(issue.source_checks, vec!["missing_endpoints"]);
    }

    #[test]
    fn as_str_from_str_round_trip_for_every_variant() {
        let kinds = [
            IssueKind::MissingEndpoints,
            IssueKind::UnreachableFinish,
            IssueKind::MinLoopsCount,
            IssueKind::InvalidLoop,
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
