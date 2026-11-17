use crate::ids::NodeId;
use crate::quality_control::issue::{INVALID_DEAD_END, INVALID_DEAD_END_GROUP, IssueKind};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};

/// Marker for grouped dead-end violations. `DeadEndGroupSelectStrategy` delegates each selected
/// node to an `INVALID_DEAD_END` nested repair.
pub struct DeadEndGroupKind;

impl InvalidGroupIssueKind for DeadEndGroupKind {
    type Element = NodeId;
    const KIND: IssueKind = INVALID_DEAD_END_GROUP;
    const NESTED_KIND: IssueKind = INVALID_DEAD_END;
    const NESTED_SLOT_ID: &'static str = "fix_target";
}

/// Aggregate of dead ends exceeding a configured count or density budget.
pub type InvalidDeadEndGroupIssue = InvalidGroupIssue<DeadEndGroupKind>;
