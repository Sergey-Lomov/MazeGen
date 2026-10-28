use crate::Maze;
use crate::generation::{
    OneWayDirection, PatternVariant, SplitFaceRequirement, SplitPattern, pattern_variants,
};
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::repair::command::{SplitNodeEdge, SplitNodeEdgeDirection};
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::HashSet;

/// Shared split-tile face-planning logic used by `AddSplitStrategy` (GitHub issue #247) and
/// `MissingLoopsSplitStrategy` (GitHub issue #254) — factored out once the latter needed the same
/// pattern-variant search and existing-connection bookkeeping with one extra constraint: a
/// specific new node must end up connected to a specific pre-chosen neighbor (the loop-closing
/// bridge), and that same node must carry at least one more connection so it's a through-node, not
/// a dead end.
///
/// `required`, when `Some((neighbor, direction))`, must be satisfied by the returned plan: some
/// node of the tile has a `SplitNodeEdge { target: neighbor, direction }` **and** at least one
/// other edge (existing or newly added) of its own. `None` reproduces `AddSplitStrategy`'s original,
/// unconstrained behavior exactly.
pub(crate) struct RequiredConnection {
    pub neighbor: NodeId,
    pub direction: SplitNodeEdgeDirection,
}

/// Nodes a *new* edge (one not already present in `maze.graph`) must never target — every node
/// belonging to a point another command already committed to replace earlier in the same
/// `apply()` batch (`MissingLoopsSplitStrategy`'s own `split_points` bookkeeping). Such a node's
/// id won't exist by apply time (`ReplacePointNodes` mints a fresh id set for its point), so a
/// brand-new `SplitNodeEdge` pointing at it would make the whole proposing command decline
/// outright at apply time — silently, since `replace_point_nodes_feasible` requires every edge
/// `target` to still resolve. An *existing* edge is never affected (its target obviously still
/// exists right now, when this call is planning against an immutable snapshot) — only the "does
/// this new edge get planned at all" decisions below consult this set.
pub(crate) type ExcludedTargets<'a> = &'a HashSet<NodeId>;

/// Picks a pattern index honoring `SplitPattern::weight`, via the same shared
/// `math::weighted_index` generation's own `handle_pattern_split` (`split_logic.rs`) uses (GitHub
/// issue #275).
pub(crate) fn pick_weighted_pattern(patterns: &[SplitPattern], rng: &mut dyn RngCore) -> usize {
    let weights: Vec<f64> = patterns.iter().map(|p| p.weight).collect();
    crate::math::weighted_index(&weights, rng)
}

/// Every direction `at` (a point's slot-0 node) currently has a real connection in, resolved to
/// `(neighbor, direction-relative-to-at)` — `Passage` when both directions exist between `at` and
/// the neighbor, `Forward`/`Backward` for a single direction. One entry per distinct neighbor
/// (never per raw edge — a neighbor connected both ways collapses to one `Passage` entry).
pub(crate) fn existing_directions<T: Tessellation>(
    maze: &Maze<T>,
    at: NodeId,
) -> Vec<(NodeId, SplitNodeEdgeDirection)> {
    let neighbors: HashSet<NodeId> = maze
        .graph
        .outgoing_neighbors(at)
        .chain(maze.graph.incoming_neighbors(at))
        .collect();
    neighbors
        .into_iter()
        .map(|n| {
            let fwd = maze.graph.edge_between(at, n).is_some();
            let bwd = maze.graph.edge_between(n, at).is_some();
            let direction = match (fwd, bwd) {
                (true, true) => SplitNodeEdgeDirection::Passage,
                (true, false) => SplitNodeEdgeDirection::Forward,
                (false, true) => SplitNodeEdgeDirection::Backward,
                (false, false) => {
                    unreachable!("n came from an outgoing/incoming edge, one direction must exist")
                }
            };
            (n, direction)
        })
        .collect()
}

/// Non-pattern candidate: `node_count` new nodes (index 0 becomes the new slot-0), each of `at`'s
/// existing connections reassigned unchanged to one uniformly random node among all of them —
/// index 0 is on equal footing with every other index here, no special weighting or reservation.
/// (Split creation has no removal-eligibility rule to begin with — that only governs split
/// modification/removal, see epic #246 / issue #281.)
///
/// When `required` is set, one uniformly random node is chosen up front to carry the bridge: its
/// existing connection to `required.neighbor`, if any, is reused; otherwise a brand-new
/// `SplitNodeEdge` to it is added. That same node must end up with at least one more edge of its
/// own (a through-node, not a dead end) — if `at` has no other free geometric neighbor to draw a
/// second edge from and no other existing connection lands on that node by the random
/// redistribution, the whole candidate fails (`None`).
pub(crate) fn plan_unconstrained_split<T: Tessellation>(
    maze: &Maze<T>,
    at: NodeId,
    node_count: usize,
    required: Option<&RequiredConnection>,
    excluded: ExcludedTargets,
    rng: &mut dyn RngCore,
) -> Option<Vec<Vec<SplitNodeEdge>>> {
    let mut per_node: Vec<Vec<SplitNodeEdge>> = vec![Vec::new(); node_count];
    let existing = existing_directions(maze, at);

    let Some(required) = required else {
        for (target, direction) in existing {
            let owner = rng.random_range(0..node_count);
            per_node[owner].push(SplitNodeEdge {
                target,
                direction,
                kind: EdgeKind::Basic,
            });
        }
        return Some(per_node);
    };

    // `required.neighbor` is the one *new* edge target this whole call was asked to wire in —
    // excluded up front, since a caller must never ask for a bridge to an already-committed
    // point in the first place (checked by the caller, e.g. `MissingLoopsSplitStrategy` skips
    // such `dst` candidates before calling this at all). Reject defensively rather than silently
    // planning a doomed command.
    if excluded.contains(&required.neighbor) {
        return None;
    }

    let bridge_owner = rng.random_range(0..node_count);
    let mut bridge_satisfied = false;
    for (target, direction) in &existing {
        let owner = if *target == required.neighbor {
            bridge_owner
        } else {
            rng.random_range(0..node_count)
        };
        if *target == required.neighbor {
            bridge_satisfied = true;
        }
        per_node[owner].push(SplitNodeEdge {
            target: *target,
            direction: *direction,
            kind: EdgeKind::Basic,
        });
    }
    if !bridge_satisfied {
        per_node[bridge_owner].push(SplitNodeEdge {
            target: required.neighbor,
            direction: required.direction,
            kind: EdgeKind::Basic,
        });
    }

    if per_node[bridge_owner].len() < 2 {
        let extra = pick_free_neighbor(maze, at, required.neighbor, &per_node, excluded)?;
        per_node[bridge_owner].push(extra);
    }

    Some(per_node)
}

/// Finds a geometric neighbor of `point` not already claimed as a `SplitNodeEdge` target anywhere
/// in `per_node`, not `at` itself, and not in `excluded` (a node whose point is already committed
/// to replacement earlier in the same batch — see `ExcludedTargets`), wired as a full
/// bidirectional `Passage` — used to give the bridge-carrying node a second connection when
/// redistribution alone didn't give it one.
fn pick_free_neighbor<T: Tessellation>(
    maze: &Maze<T>,
    at: NodeId,
    exclude: NodeId,
    per_node: &[Vec<SplitNodeEdge>],
    excluded: ExcludedTargets,
) -> Option<SplitNodeEdge> {
    let claimed: HashSet<NodeId> = per_node
        .iter()
        .flat_map(|edges| edges.iter().map(|e| e.target))
        .collect();
    maze.field
        .neighbors(at)
        .into_iter()
        .find(|&n| n != exclude && n != at && !claimed.contains(&n) && !excluded.contains(&n))
        .map(|target| SplitNodeEdge {
            target,
            direction: SplitNodeEdgeDirection::Passage,
            kind: EdgeKind::Basic,
        })
}

/// Pattern-based candidate against `at`, trying every variant of `pattern` on `at`'s cell
/// (`pattern_variants`: the cell's allowed transform group, deduplicated; none when the pattern's
/// shape is not the cell's) in random order until one validates, or returns `None` if every
/// variant fails.
#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_pattern_split<T: Tessellation>(
    maze: &Maze<T>,
    at: NodeId,
    pattern: &SplitPattern,
    required: Option<&RequiredConnection>,
    excluded: ExcludedTargets,
    rng: &mut dyn RngCore,
    allow_lose: bool,
    allow_add: bool,
) -> Option<Vec<Vec<SplitNodeEdge>>> {
    let point = maze.field.cell_of(at)?;
    let shape = maze.field.tessellation().shape_of(point)?;
    if pattern.node_count < 2 {
        return None;
    }
    if required.is_some_and(|r| excluded.contains(&r.neighbor)) {
        return None;
    }

    let mut variants = pattern_variants(pattern, &shape);
    shuffle(&mut variants, rng);
    variants.iter().find_map(|variant| {
        try_pattern_adaptation(
            maze, at, point, pattern, variant, allow_lose, allow_add, required, excluded,
        )
    })
}

pub(crate) fn shuffle<X>(items: &mut [X], rng: &mut dyn RngCore) {
    for i in (1..items.len()).rev() {
        let j = rng.random_range(0..=i);
        items.swap(i, j);
    }
}

/// One pattern variant: resolves every one of the pattern's `node_count` new nodes' own
/// faces to real neighbors (`T::neighbor` off `point`) — including node 0, the new slot-0, on equal
/// footing with every other node (split creation has no removal-eligibility rule to apply here).
///
/// When `required` is set, this candidate is only accepted if some node's resolved faces include
/// an edge to `required.neighbor` in `required.direction` **and** that same node ends up with at
/// least one other edge — a variant that doesn't happen to route the bridge through a multi-face
/// node is rejected outright (a different variant, or ultimately the whole pattern, is tried
/// instead), rather than silently accepted with the required node left as a dead
/// end.
#[allow(clippy::too_many_arguments)]
pub(crate) fn try_pattern_adaptation<T: Tessellation>(
    maze: &Maze<T>,
    at: NodeId,
    point: T::CellId,
    pattern: &SplitPattern,
    variant: &PatternVariant,
    allow_lose: bool,
    allow_add: bool,
    required: Option<&RequiredConnection>,
    excluded: ExcludedTargets,
) -> Option<Vec<Vec<SplitNodeEdge>>> {
    let tessellation = maze.field.tessellation();
    let mut per_node: Vec<Vec<SplitNodeEdge>> = Vec::with_capacity(pattern.faces.len());
    let mut claimed_directions: HashSet<NodeId> = HashSet::new();

    for (node_faces, local_faces) in pattern.faces.iter().zip(&variant.local_faces) {
        let mut node_edges: Vec<SplitNodeEdge> = Vec::new();
        for (face, &local_face) in node_faces.iter().zip(local_faces) {
            if face.sibling_target.is_some() {
                continue; // inter-split edge, not an outside connection — out of scope here
            }
            match face.requirement {
                SplitFaceRequirement::Wall | SplitFaceRequirement::Unspecified => continue,
                SplitFaceRequirement::Passage | SplitFaceRequirement::OneWay(_) => {
                    let tess_face = tessellation.faces_of(point)[local_face];
                    let level = maze.field.level_of(at).expect("at must be in field");
                    let neighbor_point = maze.field.neighbor_via(level, point, tess_face)?.cell;
                    let neighbor_candidates = maze.field.nodes_at(level, neighbor_point);
                    if neighbor_candidates.is_empty() {
                        return None;
                    }
                    let neighbor = *neighbor_candidates
                        .iter()
                        .find(|&&c| {
                            maze.graph.edge_between(at, c).is_some()
                                || maze.graph.edge_between(c, at).is_some()
                        })
                        .unwrap_or(&neighbor_candidates[0]);
                    // `neighbor` is a `SplitNodeEdge::target`, existing connection or brand-new —
                    // either way this exact `NodeId` must still resolve at apply time. If its
                    // point already got a `ReplacePointNodes` command earlier in the same batch
                    // (`excluded`), this id won't exist by then — reject this variant outright
                    // rather than plan a doomed edge (a different variant, or ultimately the
                    // whole pattern, is tried instead).
                    if excluded.contains(&neighbor) {
                        return None;
                    }
                    let direction = match face.requirement {
                        SplitFaceRequirement::Passage => SplitNodeEdgeDirection::Passage,
                        SplitFaceRequirement::OneWay(OneWayDirection::Forward) => {
                            SplitNodeEdgeDirection::Forward
                        }
                        SplitFaceRequirement::OneWay(OneWayDirection::Backward) => {
                            SplitNodeEdgeDirection::Backward
                        }
                        _ => unreachable!(),
                    };
                    let already_connected = match direction {
                        SplitNodeEdgeDirection::Passage => {
                            maze.graph.edge_between(at, neighbor).is_some()
                                && maze.graph.edge_between(neighbor, at).is_some()
                        }
                        SplitNodeEdgeDirection::Forward => {
                            maze.graph.edge_between(at, neighbor).is_some()
                        }
                        SplitNodeEdgeDirection::Backward => {
                            maze.graph.edge_between(neighbor, at).is_some()
                        }
                    };
                    if !already_connected && !allow_add {
                        return None;
                    }
                    claimed_directions.insert(neighbor);
                    node_edges.push(SplitNodeEdge {
                        target: neighbor,
                        direction,
                        kind: EdgeKind::Basic,
                    });
                }
            }
        }
        per_node.push(node_edges);
    }

    if !allow_lose {
        for (neighbor, _) in existing_directions(maze, at) {
            if !claimed_directions.contains(&neighbor) {
                return None;
            }
        }
    }

    if let Some(required) = required {
        let bridge_owner = per_node.iter().position(|edges| {
            edges
                .iter()
                .any(|e| e.target == required.neighbor && e.direction == required.direction)
        })?;
        if per_node[bridge_owner].len() < 2 {
            return None;
        }
    }

    Some(per_node)
}

#[cfg(test)]
#[path = "split_core_tests.rs"]
mod tests;
