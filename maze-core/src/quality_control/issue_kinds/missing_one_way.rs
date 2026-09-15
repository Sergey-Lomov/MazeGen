use std::collections::HashSet;
use crate::ids::NodeId;
use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, MISSING_ONE_WAY};

/// Synthetic delegation-only request to add exactly one one-way passage edge growing from
/// `src`, restricted to `allowed_dsts` — never produced by a Check, never published to the QC
/// pool. Exists only as the nested slot target for `AddOneWayFromPassageBatchStrategy`/
/// `AddOneWayFromWallBatchStrategy` (GitHub issue #524, part of epic #520), mirroring
/// `MissingTeleportIssue`'s role.
///
/// `src` is the pool candidate the series (`AddOneWayFromPassageBatchStrategy`/
/// `AddOneWayFromWallBatchStrategy`) drew from its own `Pool<NodeId>` — same ownership split as
/// `AddTeleportBatchStrategy`'s `candidate`: the series owns the pool/attempts bookkeeping, the
/// nested strategy owns everything about turning one `src` into an actual edge.
///
/// `allowed_dsts` restricts which of `src`'s field neighbors the nested strategy may pick a
/// `dst` from — normally the series passes `src`'s full neighbor list unchanged (top-level
/// behavior stays identical to the pre-split monolithic strategy), but a future direct caller
/// (e.g. a region-merge strategy) can restrict this to a subset, same predefined-pool channel
/// #523 added for `AddTeleportStrategy`'s candidate. The nested strategy tries entries from
/// `allowed_dsts` itself (feasibility check + direction pick), evicting a rejected `dst` and
/// trying the next — it fails outright only once every entry has been rejected.
///
/// `excluded_pairs` is a read-only snapshot the series accumulates across attempts within one
/// `apply()` call, mirroring `MissingTeleportIssue::excluded_pairs`'s own rationale: `maze` stays
/// an immutable pre-mutation snapshot for the whole call, so two different pool candidates that
/// happen to be geometric neighbors of each other (`src = a` with `dst = b`, later `src = b` with
/// `dst = a`) would otherwise both see the same original, still-unmutated pair and could each
/// downgrade/add a different direction of it — for `AddOneWayFromPassageStrategy` specifically,
/// this can fully sever a passage (both directions removed by two separate commands) instead of
/// leaving it as a one-way. Canonicalized `(NodeId, NodeId)` (smaller id first) so `(a, b)` and
/// `(b, a)` dedup to the same entry, unordered — a one-way pair has no inherent direction to
/// preserve here, unlike `TeleportPairKey::Directed`. `AddOneWayFromWallStrategy` does not consult
/// this set: two independent directed one-ways through the same wall never conflict, so there is
/// nothing to dedup for that family.
#[derive(Debug, Clone)]
pub struct MissingOneWayIssue {
    meta: IssueMeta,
    pub src: NodeId,
    pub allowed_dsts: Vec<NodeId>,
    pub excluded_pairs: HashSet<(NodeId, NodeId)>,
}

impl MissingOneWayIssue {
    pub fn new(src: NodeId, allowed_dsts: Vec<NodeId>) -> Self {
        Self { meta: IssueMeta::new(), src, allowed_dsts, excluded_pairs: HashSet::new() }
    }

    pub fn with_excluded_pairs(src: NodeId, allowed_dsts: Vec<NodeId>, excluded_pairs: HashSet<(NodeId, NodeId)>) -> Self {
        Self { meta: IssueMeta::new(), src, allowed_dsts, excluded_pairs }
    }

    /// Canonicalizes a pair so `(a, b)` and `(b, a)` map to the same `excluded_pairs` entry.
    pub fn canonical_pair(a: NodeId, b: NodeId) -> (NodeId, NodeId) {
        if a <= b { (a, b) } else { (b, a) }
    }
}

impl IssueKindConst for MissingOneWayIssue {
    const KIND: IssueKind = MISSING_ONE_WAY;
}

impl IssueRequirement for MissingOneWayIssue {
    type Requirement = ();
}

crate::impl_issue!(MissingOneWayIssue);

impl IssueMerge for MissingOneWayIssue {
    /// Structurally unreachable: this issue is synthesized and consumed entirely inside
    /// `AddOneWayFromPassageBatchStrategy`/`AddOneWayFromWallBatchStrategy::apply`, never
    /// published to the QC pool or routed through `Rule::run_checks_typed` (the only caller of
    /// `merge`, see `issue.rs`'s own doc comment on `IssueMerge`) — so no two instances of this
    /// issue are ever merged in practice. `debug_assert!` as a defensive doc-invariant, not a
    /// release-mode guarantee.
    fn merge(&mut self, _other: Self) {
        debug_assert!(false, "MissingOneWayIssue::merge is structurally unreachable — this issue never passes through Rule::run_checks_typed");
    }
}
