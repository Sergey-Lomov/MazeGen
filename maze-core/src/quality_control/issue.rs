#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IssueKind {
    MissingEndpoints,
    UnreachableFinish,
}

pub const MISSING_ENDPOINTS: IssueKind = IssueKind::MissingEndpoints;
pub const UNREACHABLE_FINISH: IssueKind = IssueKind::UnreachableFinish;

impl IssueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueKind::MissingEndpoints => "missing_endpoints",
            IssueKind::UnreachableFinish => "unreachable_finish",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "missing_endpoints"  => Some(IssueKind::MissingEndpoints),
            "unreachable_finish" => Some(IssueKind::UnreachableFinish),
            _ => None,
        }
    }
}

impl std::fmt::Display for IssueKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub kind: IssueKind,
}

impl Issue {
    pub fn new(kind: IssueKind) -> Self {
        Self { kind }
    }
}
