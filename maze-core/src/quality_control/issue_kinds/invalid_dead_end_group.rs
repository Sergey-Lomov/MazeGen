use crate::ids::NodeId;
use crate::quality_control::issue::{INVALID_DEAD_END_GROUP, IssueKind};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};

/// Marker for the grouped dead-end warning. The checks are intentionally warning-only, so no
/// strategy dispatches the nested slot; retaining the standard grouped issue shape still keeps
/// count/density attribution and the affected-scope candidates consistent with other max checks.
pub struct DeadEndGroupKind;

impl InvalidGroupIssueKind for DeadEndGroupKind {
    type Element = NodeId;
    const KIND: IssueKind = INVALID_DEAD_END_GROUP;
    const NESTED_KIND: IssueKind = INVALID_DEAD_END_GROUP;
    const NESTED_SLOT_ID: &'static str = "fix_target";
}

/// Warning-only aggregate of dead ends exceeding a configured count or density budget.
pub type InvalidDeadEndGroupIssue = InvalidGroupIssue<DeadEndGroupKind>;
