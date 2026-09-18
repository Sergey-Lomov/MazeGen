use crate::Maze;
use crate::generation::PresetState;
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::quality_control::InvalidSplitTileIssue;
use crate::repair::command::{MutationCommand, SplitNodeEdge, SplitNodeEdgeDirection};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::RngCore;
use rand::seq::SliceRandom;
use std::collections::HashMap;

pub const PARAM_SELECTION: &str = "selection";

pub const SELECTION_RANDOM: &str = "random";
pub const SELECTION_LEAST_CONNECTED: &str = "least_connected";
pub const SELECTION_MOST_CONNECTED: &str = "most_connected";
pub const SELECTION_MERGE: &str = "merge";

pub static SELECTION_OPTIONS: &[&str] = &[
    SELECTION_RANDOM,
    SELECTION_LEAST_CONNECTED,
    SELECTION_MOST_CONNECTED,
    SELECTION_MERGE,
];

static PARAMS: &[StrategyParam] = &[StrategyParam {
    id: PARAM_SELECTION,
    label: "Connection selection",
    kind: StrategyParamKind::Enum {
        options: SELECTION_OPTIONS,
        default: SELECTION_MOST_CONNECTED,
    },
}];

/// Handles `INVALID_SPLIT_TILE` — see GitHub issue #248, epic #246 (issue #260: the issue's unit
/// of work is a whole tile, `SplitTileNodes`). Collapses each flagged tile back into a single
/// node via `MutationCommand::ReplacePointNodes` — an atomic, all-or-nothing replacement of every
/// node currently at the tile's point (issue #281: slot-0 is no longer special, so this strategy
/// no longer singles it out as "the" survivor; any node of the tile may end up minted anew as the
/// point's sole node).
///
/// **All-or-nothing per tile**: unlike the old per-node `RemoveNode` loop, a single preset-locked
/// node anywhere in the tile now blocks the whole tile's collapse (`replace_point_nodes_feasible`
/// declines the entire command) rather than only that one node surviving — accepted trade-off for
/// switching to `ReplacePointNodes`'s atomic contract (see issue #281's discussion).
///
/// `selection` (default `most_connected`) decides which connections the tile's one
/// surviving (freshly-minted) node ends up with:
/// - `random`/`least_connected`/`most_connected`: picks one node of the tile — uniformly at
///   random, or by lowest/highest total incident-edge degree (a bidirectional pair between the
///   same two nodes counts once, not twice) — and carries over only that node's own edges. Every
///   other node's edges are simply dropped (mirrors the old `redistribute: false` outcome, but
///   now for every non-survivor instead of only the ones `RemoveNode` happened to target).
/// - `merge`: unions every node's edges across the whole tile into the one surviving node,
///   deduplicated by `(target, EdgeKind)` — if two nodes each had a connection to the same target
///   (in either direction) the pair collapses to one entry; if one had it forward and another
///   backward, the merged entry becomes a full bidirectional `Passage`.
///
/// A self-loop (an old sibling-to-sibling edge whose target is the tile's own point) is never
/// carried over — `ReplacePointNodes`'s new node only ever wires to nodes outside the tile.
pub struct RemoveSplitStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidSplitTileIssue> for RemoveSplitStrategy {
    fn strategy_id(&self) -> &'static str {
        "remove_split"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidSplitTileIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let selection = match params.get(PARAM_SELECTION) {
            Some(StrategyParamValue::Enum(v)) => v.as_str(),
            _ => SELECTION_MOST_CONNECTED,
        };

        let mut commands = Vec::new();
        let mut any_fixed = false;
        for tile in &issue.invalid {
            let Some(&at) = tile.0.first() else { continue };
            // Already collapsed to a single node by an earlier command in this same batch, or a
            // stale issue -- already in the target shape, nothing to do, but not a failure either.
            if tile.0.len() < 2 {
                any_fixed = true;
                continue;
            }

            let tile_nodes: std::collections::HashSet<NodeId> = tile.0.iter().copied().collect();
            let edges = tile_edges(maze, &tile_nodes);

            let node_edges = if selection == SELECTION_MERGE {
                merged_edges(&edges)
            } else {
                let survivor = pick_survivor(&tile.0, &edges, selection, rng);
                edges
                    .iter()
                    .filter(|e| e.owner == survivor)
                    .map(|e| e.edge)
                    .collect()
            };

            // Checked here up front, mirroring `replace_point_nodes_feasible`'s own all-or-nothing
            // contract, so this strategy's own `Fixed`/`Failed` verdict agrees with whether
            // `ReplacePointNodes` will actually be applied by `apply_commands` -- same "declined
            // command must not silently count as fixed" rationale as `OneWayToWallStrategy`
            // (GitHub issue #230) and the old per-node loop's `remove_node_feasible` check. Without
            // this, a preset-locked tile would report `Fixed` every iteration despite the command
            // always being declined, spinning the repair fixpoint loop until the iteration/time
            // budget is exhausted instead of failing fast.
            let nodes = vec![node_edges];
            if !crate::generation::replace_point_nodes_feasible(
                &maze.field,
                preset_state,
                at,
                &nodes,
            ) {
                continue;
            }
            commands.push(MutationCommand::ReplacePointNodes { at, nodes });
            any_fixed = true;
        }

        // Every flagged tile was already collapsed (stale issue) or preset-locked -- nothing could
        // be fixed, same "Failed if nothing could be fixed" rationale as `OneWayToWallStrategy`
        // (GitHub issue #230).
        let result = if issue.invalid.is_empty() || any_fixed {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

/// One tile node's own edge, resolved to a `SplitNodeEdge` relative to that node, tagged with
/// which node of the tile it came from (`owner`) -- a self-loop (edge whose target is another
/// node of the same tile) is filtered out entirely, never carried over to the new node.
struct TileEdge {
    owner: NodeId,
    edge: SplitNodeEdge,
}

/// Every incident edge of every node in `tile_nodes`, each resolved to the owning node's own
/// `SplitNodeEdge` (direction relative to that node) -- a bidirectional pair between two nodes of
/// the tile (impossible in practice today, since sibling edges are never bidirectional by
/// construction, but not assumed) and any edge whose other end is itself a tile node are both
/// dropped as self-loops.
fn tile_edges<T: Tessellation>(
    maze: &Maze<T>,
    tile_nodes: &std::collections::HashSet<NodeId>,
) -> Vec<TileEdge> {
    let mut out = Vec::new();
    for &owner in tile_nodes {
        for edge in maze
            .graph
            .edges()
            .filter(|e| e.from == owner || e.to == owner)
        {
            let target = if edge.from == owner {
                edge.to
            } else {
                edge.from
            };
            if tile_nodes.contains(&target) {
                continue; // self-loop onto another node of the same tile
            }
            let direction = if edge.from == owner {
                SplitNodeEdgeDirection::Forward
            } else {
                SplitNodeEdgeDirection::Backward
            };
            out.push(TileEdge {
                owner,
                edge: SplitNodeEdge {
                    target,
                    direction,
                    kind: edge.kind,
                },
            });
        }
    }
    out
}

/// Picks which tile node's own edges survive, per `selection`:
/// `random` picks uniformly; `least_connected`/`most_connected` picks by total incident-edge
/// degree (a bidirectional pair to the same target counts once, not twice — see `node_degree`).
/// Ties (including every node having zero edges) resolve by shuffling `tile` first, so the winner
/// among equals is still random, not first-in-list.
fn pick_survivor(
    tile: &[NodeId],
    edges: &[TileEdge],
    selection: &str,
    rng: &mut dyn RngCore,
) -> NodeId {
    let mut candidates = tile.to_vec();
    candidates.shuffle(rng);
    if selection == SELECTION_LEAST_CONNECTED || selection == SELECTION_MOST_CONNECTED {
        let degree = node_degree(edges);
        let deg_of = |n: &NodeId| -> usize { degree.get(n).copied().unwrap_or(0) };
        if selection == SELECTION_MOST_CONNECTED {
            candidates.sort_by_key(|n| std::cmp::Reverse(deg_of(n)));
        } else {
            candidates.sort_by_key(deg_of);
        }
    }
    candidates[0]
}

/// Each tile node's own connection count, a bidirectional pair to the same outside target *of the
/// same `EdgeKind`* counted once (not twice) -- a `Basic` and a `Teleport` connection to the same
/// target are still two distinct connections, kept separate. Distinct from
/// `split_node_group_select.rs`'s `node_degree_map`, which counts both directions separately; this
/// strategy picks a *survivor to keep whole*, so a passage and a one-way to the same neighbor of
/// the same kind should weigh the same, one connection each.
fn node_degree(edges: &[TileEdge]) -> HashMap<NodeId, usize> {
    let mut seen: std::collections::HashSet<(NodeId, NodeId, EdgeKind)> =
        std::collections::HashSet::new();
    let mut degree: HashMap<NodeId, usize> = HashMap::new();
    for e in edges {
        let key = (e.owner, e.edge.target, e.edge.kind);
        if seen.contains(&key) {
            continue; // the other direction of a bidirectional pair already counted
        }
        seen.insert(key);
        *degree.entry(e.owner).or_insert(0) += 1;
    }
    degree
}

/// Unions every tile node's edges into one edge list for the surviving node, deduplicated by
/// `(target, EdgeKind)` -- if two owners both had a connection to the same target of the same
/// kind, only one entry survives; if one had `Forward` and another `Backward` to the same
/// `(target, kind)`, the merged entry becomes `Passage` (per issue #281's discussion: a forward
/// and a backward to the same neighbor merge into a full passage, not one arbitrarily winning).
fn merged_edges(edges: &[TileEdge]) -> Vec<SplitNodeEdge> {
    let mut merged: HashMap<(NodeId, EdgeKind), SplitNodeEdgeDirection> = HashMap::new();
    for e in edges {
        let key = (e.edge.target, e.edge.kind);
        merged
            .entry(key)
            .and_modify(|dir| *dir = union_direction(*dir, e.edge.direction))
            .or_insert(e.edge.direction);
    }
    merged
        .into_iter()
        .map(|((target, kind), direction)| SplitNodeEdge {
            target,
            direction,
            kind,
        })
        .collect()
}

/// `Passage` if the two directions disagree (one `Forward`, one `Backward`) or either already is
/// `Passage`; otherwise the shared direction.
fn union_direction(a: SplitNodeEdgeDirection, b: SplitNodeEdgeDirection) -> SplitNodeEdgeDirection {
    use SplitNodeEdgeDirection::*;
    match (a, b) {
        (Passage, _) | (_, Passage) => Passage,
        (Forward, Backward) | (Backward, Forward) => Passage,
        (Forward, Forward) => Forward,
        (Backward, Backward) => Backward,
    }
}

crate::impl_erased_repair_strategy!(RemoveSplitStrategy, InvalidSplitTileIssue);

#[cfg(test)]
#[path = "remove_split_tests.rs"]
mod tests;
