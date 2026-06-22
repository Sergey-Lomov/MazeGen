use crate::quality_control::issue_data::IssueData;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IssueKind {
    MissingEndpoints,
    UnreachableFinish,
    MinLoopsCount,
    MinLoopLength,
}

pub const MISSING_ENDPOINTS: IssueKind = IssueKind::MissingEndpoints;
pub const UNREACHABLE_FINISH: IssueKind = IssueKind::UnreachableFinish;
pub const MIN_LOOPS_COUNT: IssueKind = IssueKind::MinLoopsCount;
pub const MIN_LOOP_LENGTH: IssueKind = IssueKind::MinLoopLength;

impl IssueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueKind::MissingEndpoints => "missing_endpoints",
            IssueKind::UnreachableFinish => "unreachable_finish",
            IssueKind::MinLoopsCount => "min_loops_count",
            IssueKind::MinLoopLength => "min_loop_length",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "missing_endpoints"  => Some(IssueKind::MissingEndpoints),
            "unreachable_finish" => Some(IssueKind::UnreachableFinish),
            "min_loops_count"    => Some(IssueKind::MinLoopsCount),
            "min_loop_length"    => Some(IssueKind::MinLoopLength),
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
}
