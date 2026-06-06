pub type IssueKind = &'static str;

pub const MISSING_ENDPOINTS: IssueKind = "missing_endpoints";
pub const UNREACHABLE_FINISH: IssueKind = "unreachable_finish";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub kind: IssueKind,
}

impl Issue {
    pub fn new(kind: IssueKind) -> Self {
        Self { kind }
    }
}
