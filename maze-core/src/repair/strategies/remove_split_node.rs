use crate::Maze;
use crate::generation::PresetState;
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::quality_control::InvalidSplitNodeIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::RngCore;

pub const PARAM_REDISTRIBUTE: &str = "redistribute";

static PARAMS: &[StrategyParam] = &[StrategyParam {
    id: PARAM_REDISTRIBUTE,
    label: "Redistribute connections to another node of the same split",
    kind: StrategyParamKind::Bool { default: true },
}];

/// Handles `INVALID_SPLIT_NODE` — see GitHub issue #250, epic #246. Removes each flagged split
/// node entirely (`MutationCommand::RemoveNode`) — never a tile's last remaining node, mirroring
/// the hard constraint every strategy in this epic shares (`remove_node_feasible` never allows it,
/// same as `RemoveSplitStrategy`); a check flagging a node that happens to be the tile's last one
/// simply has that entry declined here, rather than being special-cased out up front.
///
/// `redistribute` (default `true`): what happens to the removed node's own connections.
/// - `false`: the node's edges simply disappear along with it (`RemoveNode` already clears every
///   incident edge, both directions).
/// - `true`: before removing the node, this strategy proposes an equivalent edge/teleport (same
///   `EdgeKind`, same direction) for every one of the removed node's incident edges, each
///   independently redirected to/from a node picked uniformly at random from the other remaining
///   nodes of the same split (any node still at the point after this node is gone, on equal
///   footing regardless of slot). The candidate pool excludes every other node this same `issue`
///   flags *and* that is actually feasible to remove (`remove_node_feasible`) — those get their
///   own `RemoveNode` command later in this same batch, which would immediately wipe out any edge
///   just redistributed onto them (`RemoveNode` clears every incident edge). A node merely flagged
///   but not actually removable (the tile's last remaining node, or a preset-protected sibling) is
///   *not* excluded — it's never touched by any `RemoveNode` in this batch, so it remains a
///   perfectly safe target. Edges are grouped by (neighbor, `EdgeKind`) before picking a target —
///   a bidirectional passage (forward + reverse edge to the same neighbor) redistributes onto one
///   shared randomly-picked target, not two independently-drawn ones (GitHub issue #276), so a
///   physical two-way connection is never silently split into two one-ways to different siblings.
///   Different (neighbor, kind) groups still draw independent targets — a multi-edge removed
///   node's connections scatter across the remaining siblings rather than all landing on one. An
///   edge that would connect its target to itself (the sibling edge between the removed node and
///   that particular target, if any) is skipped — a self-loop is never proposed. Each redistribution
///   command is independently revalidated by `apply_commands` same as any other (e.g. dropped if
///   it duplicates an edge the target already has), so this is "best-effort preservation," not a
///   guarantee. An empty candidate pool (every other node at the point is both flagged and
///   feasible) simply drops that edge's redistribution — a tile always keeping at least one
///   removal-ineligible node makes this practically unreachable, but the code path (`pick_random`
///   returning `None`) is handled, not assumed impossible.
pub struct RemoveSplitNodeStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidSplitNodeIssue> for RemoveSplitNodeStrategy {
    fn strategy_id(&self) -> &'static str {
        "remove_split_node"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidSplitNodeIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let redistribute = matches!(
            params.get(PARAM_REDISTRIBUTE),
            Some(StrategyParamValue::Bool(true))
        );

        let mut commands = Vec::new();
        let mut any_removable = false;
        for &node in &issue.invalid {
            // `remove_node_feasible` is the exact predicate `try_remove_node` uses at apply time
            // (preset locks/edges, never a tile's last remaining node) -- checked here up front so
            // this strategy's own `Fixed`/`Failed` verdict agrees with whether `RemoveNode` will
            // actually be applied, same "declined command must not silently count as fixed"
            // rationale as `RemoveSplitStrategy`. This also naturally declines a flagged entry that
            // happens to be the tile's last remaining node.
            if !crate::generation::remove_node_feasible(&maze.field, preset_state, node) {
                continue;
            }
            let level = maze
                .field
                .level_of(node)
                .expect("remove_node_feasible confirmed this node exists");
            let point = maze
                .field
                .cell_of(node)
                .expect("remove_node_feasible confirmed this node exists");
            any_removable = true;

            if redistribute {
                // Exclude every other node this same issue flags *and* that will actually be
                // removed later in this batch (i.e. also passes remove_node_feasible) -- each of
                // those gets its own RemoveNode command later on, which clears all of its incident
                // edges, including one just redistributed onto it here. A node merely flagged but
                // declined (e.g. the tile's last remaining node, which a check may legitimately
                // flag like any other split node, or a preset-protected sibling) is never actually
                // removed and remains a perfectly safe target -- excluding it too would wrongly
                // shrink the candidate pool, even to empty for a 2-node split whose only other node
                // is a flagged-but-undeletable last remaining node.
                let siblings: Vec<NodeId> = maze
                    .field
                    .nodes_at(level, point)
                    .iter()
                    .copied()
                    .filter(|&n| n != node)
                    .filter(|&n| {
                        !issue.invalid.contains(&n)
                            || !crate::generation::remove_node_feasible(
                                &maze.field,
                                preset_state,
                                n,
                            )
                    })
                    .collect();
                // Edges are grouped by (neighbor, kind) before picking a target -- a bidirectional
                // passage (forward + reverse edge, same neighbor, same kind) must redistribute onto
                // one shared randomly-picked target, not two independently-drawn ones, or a single
                // physical two-way connection would silently split into two one-ways to different
                // siblings (GitHub issue #276). Different (neighbor, kind) groups still draw
                // independent targets, so a multi-edge removed node's connections still spread
                // across the remaining siblings rather than all landing on one.
                let mut groups: std::collections::BTreeMap<
                    (NodeId, EdgeKind),
                    Vec<(NodeId, NodeId)>,
                > = std::collections::BTreeMap::new();
                for edge in maze
                    .graph
                    .edges()
                    .filter(|e| e.from == node || e.to == node)
                {
                    let neighbor = if edge.from == node {
                        edge.to
                    } else {
                        edge.from
                    };
                    groups
                        .entry((neighbor, edge.kind))
                        .or_default()
                        .push((edge.from, edge.to));
                }
                for ((_, kind), dirs) in groups {
                    let Some(&target) = pick_random(&siblings, rng) else {
                        continue;
                    };
                    for (from, to) in dirs {
                        let (from, to) = if from == node {
                            (target, to)
                        } else {
                            (from, target)
                        };
                        if from == to {
                            continue;
                        } // the sibling edge to/from the chosen target itself
                        // VerticalPassage/Elevator redistribution isn't supported yet (GitHub
                        // issue #337 scopes generation only — QC/repair for vertical connections
                        // is #343/#344) — a split node's own edge of that kind is simply dropped
                        // rather than relocated onto a sibling.
                        let command = match kind {
                            EdgeKind::Basic => Some(MutationCommand::AddDirectedEdge { from, to }),
                            EdgeKind::Teleport => {
                                Some(MutationCommand::AddDirectedTeleport { from, to })
                            }
                            EdgeKind::VerticalPassage | EdgeKind::Elevator => None,
                        };
                        if let Some(command) = command {
                            commands.push(command);
                        }
                    }
                }
            }
            commands.push(MutationCommand::RemoveNode { node });
        }

        // Every flagged node failed remove_node_feasible (already removed by an earlier command in
        // this same batch, a stale issue, the tile's last remaining node, or preset-protected) --
        // nothing could be fixed, same "Failed if nothing could be fixed" rationale as
        // RemoveSplitStrategy/OneWayToWallStrategy.
        let result = if issue.invalid.is_empty() || any_removable {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

/// Picks one element uniformly at random from `slice`, or `None` if empty.
fn pick_random<'a, X>(slice: &'a [X], rng: &mut dyn RngCore) -> Option<&'a X> {
    if slice.is_empty() {
        return None;
    }
    let idx = (rng.next_u32() as usize) % slice.len();
    slice.get(idx)
}

crate::impl_erased_repair_strategy!(RemoveSplitNodeStrategy, InvalidSplitNodeIssue);

#[cfg(test)]
#[path = "remove_split_node_tests.rs"]
mod tests;
