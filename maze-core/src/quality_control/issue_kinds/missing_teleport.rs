use std::collections::HashSet;
use crate::ids::NodeId;
use crate::repair::command::MutationCommand;
use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, MISSING_TELEPORT};

/// Canonical key for one teleport pair, used to dedup proposals within a single `apply()` call
/// (`AddTeleportBatchStrategy`'s `excluded_pairs`) and to check a candidate exit against them
/// (`add_teleport::pick_exit`). Must preserve the same directed/bidirectional distinction the old
/// monolithic strategy's `proposed: HashSet<(NodeId, NodeId)>` did: a directed teleport only
/// blocks its own `(from, to)` direction (the reverse direction is a separate, independently
/// addable edge), while a bidirectional teleport blocks both directions as one unordered pair —
/// collapsing directed pairs onto the same unordered scheme would wrongly treat a legitimate
/// opposite-direction directed edge as a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TeleportPairKey {
    Directed(NodeId, NodeId),
    Bidirectional(NodeId, NodeId),
}

impl TeleportPairKey {
    /// Bidirectional keys are stored with the smaller `NodeId` first so `(a, b)` and `(b, a)`
    /// produce the same key — directed keys keep their given order as-is.
    fn bidirectional(a: NodeId, b: NodeId) -> Self {
        if a <= b { TeleportPairKey::Bidirectional(a, b) } else { TeleportPairKey::Bidirectional(b, a) }
    }
}

/// One logical teleport, as resolved from the `MutationCommand`s a nested `MISSING_TELEPORT`
/// strategy returned. Used both for the slot's postcondition check and to build the
/// `excluded_pairs` entry the series accumulates across attempts.
pub struct LogicalTeleport {
    pub entry: NodeId,
    pub exit: NodeId,
    pub bidirectional: bool,
}

impl LogicalTeleport {
    pub fn canonical_key(&self) -> TeleportPairKey {
        if self.bidirectional {
            TeleportPairKey::bidirectional(self.entry, self.exit)
        } else {
            TeleportPairKey::Directed(self.entry, self.exit)
        }
    }
}

/// Parses a nested `MISSING_TELEPORT` strategy's returned commands into one logical teleport.
/// `None` if the commands don't match the expected shape (empty, more than one teleport command,
/// or anything other than a single `AddDirectedTeleport`/`AddBidirectionalTeleport`) — an
/// incompatible nested strategy is a configuration error, but must not panic the whole repair
/// pipeline at runtime (old/malformed JSON config), so the caller treats `None` as an ordinary
/// failed attempt instead.
pub fn logical_teleport_from_commands(cmds: &[MutationCommand]) -> Option<LogicalTeleport> {
    let [cmd] = cmds else { return None };
    match *cmd {
        MutationCommand::AddDirectedTeleport { from, to } => Some(LogicalTeleport { entry: from, exit: to, bidirectional: false }),
        MutationCommand::AddBidirectionalTeleport { a, b } => Some(LogicalTeleport { entry: a, exit: b, bidirectional: true }),
        _ => None,
    }
}

/// Synthetic delegation-only request to add exactly one teleport starting from `candidate` — never
/// produced by a Check, never published to the QC pool. Exists only as the nested slot target for
/// `AddTeleportBatchStrategy` (GitHub issue #522, part of epic #520), mirroring
/// `InvalidVerticalPassageIssue`'s Check-less-delegation role.
///
/// `candidate` is the raw, unresolved pool pick — `entry_pick: farthest_from_random`'s resolution
/// into the actual entry node is owned by `AddTeleportStrategy` itself, not the series (GitHub
/// issue #522's explicit ownership decision).
///
/// `excluded_pairs` is a read-only snapshot the series accumulates across attempts within one
/// `apply()` call — `commands.extend(cmds)` doesn't mutate the immutable `&Maze` between attempts,
/// so without this a later attempt could re-propose a pair already queued (but not yet applied) by
/// an earlier one. Named generically, not tied to `AddTeleportBatchStrategy`'s own internal model,
/// so a future direct caller (region-merge, cycle-by-teleport) can supply its own exclusion set.
#[derive(Debug, Clone)]
pub struct MissingTeleportIssue {
    meta: IssueMeta,
    pub candidate: NodeId,
    pub excluded_pairs: HashSet<TeleportPairKey>,
}

impl MissingTeleportIssue {
    pub fn new(candidate: NodeId, excluded_pairs: HashSet<TeleportPairKey>) -> Self {
        Self { meta: IssueMeta::new(), candidate, excluded_pairs }
    }
}

impl IssueKindConst for MissingTeleportIssue {
    const KIND: IssueKind = MISSING_TELEPORT;
}

impl IssueRequirement for MissingTeleportIssue {
    type Requirement = ();
}

crate::impl_issue!(MissingTeleportIssue);

impl IssueMerge for MissingTeleportIssue {
    /// Structurally unreachable: this issue is synthesized and consumed entirely inside
    /// `AddTeleportBatchStrategy::apply`, never published to the QC pool or routed through
    /// `Rule::run_checks_typed` (the only caller of `merge`, see `issue.rs`'s own doc comment on
    /// `IssueMerge`) — so no two instances of this issue are ever merged in practice.
    /// `debug_assert!` as a defensive doc-invariant, not a release-mode guarantee.
    fn merge(&mut self, _other: Self) {
        debug_assert!(false, "MissingTeleportIssue::merge is structurally unreachable — this issue never passes through Rule::run_checks_typed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_nodes() -> (NodeId, NodeId) {
        (1, 2)
    }

    #[test]
    fn bidirectional_key_is_order_independent() {
        let (a, b) = two_nodes();
        assert_eq!(TeleportPairKey::bidirectional(a, b), TeleportPairKey::bidirectional(b, a));
    }

    #[test]
    fn logical_teleport_from_commands_parses_directed() {
        let (a, b) = two_nodes();
        let cmds = vec![MutationCommand::AddDirectedTeleport { from: a, to: b }];
        let teleport = logical_teleport_from_commands(&cmds).expect("directed teleport must parse");
        assert_eq!((teleport.entry, teleport.exit, teleport.bidirectional), (a, b, false));
        assert_eq!(teleport.canonical_key(), TeleportPairKey::Directed(a, b));
    }

    #[test]
    fn logical_teleport_from_commands_parses_bidirectional() {
        let (a, b) = two_nodes();
        let cmds = vec![MutationCommand::AddBidirectionalTeleport { a, b }];
        let teleport = logical_teleport_from_commands(&cmds).expect("bidirectional teleport must parse");
        assert_eq!((teleport.entry, teleport.exit, teleport.bidirectional), (a, b, true));
        assert_eq!(teleport.canonical_key(), TeleportPairKey::bidirectional(a, b));
    }

    #[test]
    fn logical_teleport_from_commands_rejects_empty() {
        assert!(logical_teleport_from_commands(&[]).is_none());
    }

    #[test]
    fn logical_teleport_from_commands_rejects_more_than_one_command() {
        let (a, b) = two_nodes();
        let cmds = vec![
            MutationCommand::AddDirectedTeleport { from: a, to: b },
            MutationCommand::AddDirectedTeleport { from: b, to: a },
        ];
        assert!(logical_teleport_from_commands(&cmds).is_none());
    }

    #[test]
    fn logical_teleport_from_commands_rejects_wrong_command_kind() {
        let (a, b) = two_nodes();
        let cmds = vec![MutationCommand::AddDirectedEdge { from: a, to: b }];
        assert!(logical_teleport_from_commands(&cmds).is_none());
    }
}
