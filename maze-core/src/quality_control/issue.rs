pub type IssueKind = &'static str;

pub const MISSING_START: IssueKind = "missing_start";
pub const MISSING_FINISH: IssueKind = "missing_finish";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub kind: IssueKind,
}

impl Issue {
    pub fn new(kind: IssueKind) -> Self {
        Self { kind }
    }
}
