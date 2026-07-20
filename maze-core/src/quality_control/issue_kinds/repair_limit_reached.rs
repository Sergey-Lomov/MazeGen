use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, REPAIR_LIMIT_REACHED};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepairLimitKind {
    MaxIterations,
    TimeBudget,
}

impl RepairLimitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RepairLimitKind::MaxIterations => "max_iterations",
            RepairLimitKind::TimeBudget => "time_budget",
        }
    }
}

/// Carried by `REPAIR_LIMIT_REACHED` (see that const's doc comment) — identifies which
/// `RepairLimits` bound cut the repair loop short. Not produced by any `Check<T, I>`, so it's
/// always constructed via `IssueMeta::new()` (no source check).
#[derive(Debug, Clone, PartialEq)]
pub struct RepairLimitReachedIssue {
    meta: IssueMeta,
    pub limit: RepairLimitKind,
}

impl RepairLimitReachedIssue {
    pub fn new(limit: RepairLimitKind) -> Self {
        Self { meta: IssueMeta::new(), limit }
    }
}

impl IssueKindConst for RepairLimitReachedIssue {
    const KIND: IssueKind = REPAIR_LIMIT_REACHED;
}

impl IssueRequirement for RepairLimitReachedIssue {
    type Requirement = ();
}

crate::impl_issue!(RepairLimitReachedIssue);

impl IssueMerge for RepairLimitReachedIssue {
    /// Never actually merged in practice — `build_maze` pushes this at most once per `run_full`
    /// call, outside any `Rule`, so `self.limit`/`other.limit` never legitimately disagree here.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
    }
}
