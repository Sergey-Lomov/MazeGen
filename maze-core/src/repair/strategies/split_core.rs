use rand::{Rng, RngCore};
use std::collections::HashSet;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::generation::{SplitPattern, SplitFaceRequirement, OneWayDirection};
use crate::repair::command::{SplitNodeEdge, SplitNodeEdgeDirection};
use crate::graph::EdgeKind;

/// Shared split-tile face-planning logic used by `AddSplitStrategy` (GitHub issue #247) and
/// `MissingLoopsSplitStrategy` (GitHub issue #254) — factored out once the latter needed the same
/// rotation/mirror search and existing-connection bookkeeping with one extra constraint: a
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
pub(crate) fn existing_directions<T: Tessellation>(maze: &Maze<T>, at: NodeId) -> Vec<(NodeId, SplitNodeEdgeDirection)> {
    let neighbors: HashSet<NodeId> = maze.graph.outgoing_neighbors(at)
        .chain(maze.graph.incoming_neighbors(at))
        .collect();
    neighbors.into_iter().map(|n| {
        let fwd = maze.graph.edge_between(at, n).is_some();
        let bwd = maze.graph.edge_between(n, at).is_some();
        let direction = match (fwd, bwd) {
            (true, true) => SplitNodeEdgeDirection::Passage,
            (true, false) => SplitNodeEdgeDirection::Forward,
            (false, true) => SplitNodeEdgeDirection::Backward,
            (false, false) => unreachable!("n came from an outgoing/incoming edge, one direction must exist"),
        };
        (n, direction)
    }).collect()
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
            per_node[owner].push(SplitNodeEdge { target, direction, kind: EdgeKind::Basic });
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
        let owner = if *target == required.neighbor { bridge_owner } else { rng.random_range(0..node_count) };
        if *target == required.neighbor {
            bridge_satisfied = true;
        }
        per_node[owner].push(SplitNodeEdge { target: *target, direction: *direction, kind: EdgeKind::Basic });
    }
    if !bridge_satisfied {
        per_node[bridge_owner].push(SplitNodeEdge { target: required.neighbor, direction: required.direction, kind: EdgeKind::Basic });
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
    let claimed: HashSet<NodeId> = per_node.iter().flat_map(|edges| edges.iter().map(|e| e.target)).collect();
    maze.field.neighbors(at).into_iter()
        .find(|&n| n != exclude && n != at && !claimed.contains(&n) && !excluded.contains(&n))
        .map(|target| SplitNodeEdge { target, direction: SplitNodeEdgeDirection::Passage, kind: EdgeKind::Basic })
}

/// Pattern-based candidate against `at`, trying every `rotation`/`mirror` combination in random
/// order until one validates, or returns `None` if every combination fails.
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
    let Some(point) = maze.field.point_of(at) else { return None; };
    let degree = T::faces().len();
    if degree == 0 || pattern.node_count < 2 {
        return None;
    }
    if required.is_some_and(|r| excluded.contains(&r.neighbor)) {
        return None;
    }

    let mut rotations: Vec<usize> = (0..T::rotation_symmetries().len()).collect();
    shuffle(&mut rotations, rng);
    let mut mirrors: Vec<Option<usize>> = std::iter::once(None).chain((0..T::mirror_symmetries().len()).map(Some)).collect();
    shuffle(&mut mirrors, rng);

    for &rotation in &rotations {
        for &mirror in &mirrors {
            if let Some(nodes) = try_pattern_adaptation(maze, at, point, pattern, rotation, mirror, allow_lose, allow_add, required, excluded) {
                return Some(nodes);
            }
        }
    }
    None
}

pub(crate) fn shuffle<X>(items: &mut [X], rng: &mut dyn RngCore) {
    for i in (1..items.len()).rev() {
        let j = rng.random_range(0..=i);
        items.swap(i, j);
    }
}

/// One rotation/mirror candidate: resolves every one of the pattern's `node_count` new nodes' own
/// faces to real neighbors (`T::step` off `point`) — including node 0, the new slot-0, on equal
/// footing with every other node (split creation has no removal-eligibility rule to apply here).
///
/// When `required` is set, this candidate is only accepted if some node's resolved faces include
/// an edge to `required.neighbor` in `required.direction` **and** that same node ends up with at
/// least one other edge — a pattern rotation that doesn't happen to route the bridge through a
/// multi-face node is rejected outright (a different rotation/mirror, or ultimately the whole
/// pattern, is tried instead), rather than silently accepted with the required node left as a dead
/// end.
#[allow(clippy::too_many_arguments)]
pub(crate) fn try_pattern_adaptation<T: Tessellation>(
    maze: &Maze<T>,
    at: NodeId,
    point: T::Point,
    pattern: &SplitPattern,
    rotation: usize,
    mirror: Option<usize>,
    allow_lose: bool,
    allow_add: bool,
    required: Option<&RequiredConnection>,
    excluded: ExcludedTargets,
) -> Option<Vec<Vec<SplitNodeEdge>>> {
    let mut per_node: Vec<Vec<SplitNodeEdge>> = Vec::with_capacity(pattern.faces.len());
    let mut claimed_directions: HashSet<NodeId> = HashSet::new();

    for node_faces in pattern.faces.iter() {
        let mut node_edges: Vec<SplitNodeEdge> = Vec::new();
        for face in node_faces {
            let resolved_index = crate::space::transform_face_index::<T>(face.face_index, rotation, mirror)?;
            if face.sibling_target.is_some() {
                continue; // inter-split edge, not an outside connection — out of scope here
            }
            match face.requirement {
                SplitFaceRequirement::Wall | SplitFaceRequirement::Unspecified => continue,
                SplitFaceRequirement::Passage | SplitFaceRequirement::OneWay(_) => {
                    let Some(tess_face) = T::face_at(resolved_index) else { return None; };
                    let neighbor_point = T::step(point, tess_face);
                    let neighbor_candidates = maze.field.nodes_at(neighbor_point);
                    if neighbor_candidates.is_empty() {
                        return None;
                    }
                    let neighbor = *neighbor_candidates.iter()
                        .find(|&&c| maze.graph.edge_between(at, c).is_some() || maze.graph.edge_between(c, at).is_some())
                        .unwrap_or(&neighbor_candidates[0]);
                    // `neighbor` is a `SplitNodeEdge::target`, existing connection or brand-new —
                    // either way this exact `NodeId` must still resolve at apply time. If its
                    // point already got a `ReplacePointNodes` command earlier in the same batch
                    // (`excluded`), this id won't exist by then — reject this rotation/mirror
                    // candidate outright rather than plan a doomed edge (a different
                    // rotation/mirror, or ultimately the whole pattern, is tried instead).
                    if excluded.contains(&neighbor) {
                        return None;
                    }
                    let direction = match face.requirement {
                        SplitFaceRequirement::Passage => SplitNodeEdgeDirection::Passage,
                        SplitFaceRequirement::OneWay(OneWayDirection::Forward) => SplitNodeEdgeDirection::Forward,
                        SplitFaceRequirement::OneWay(OneWayDirection::Backward) => SplitNodeEdgeDirection::Backward,
                        _ => unreachable!(),
                    };
                    let already_connected = match direction {
                        SplitNodeEdgeDirection::Passage => maze.graph.edge_between(at, neighbor).is_some() && maze.graph.edge_between(neighbor, at).is_some(),
                        SplitNodeEdgeDirection::Forward => maze.graph.edge_between(at, neighbor).is_some(),
                        SplitNodeEdgeDirection::Backward => maze.graph.edge_between(neighbor, at).is_some(),
                    };
                    if !already_connected && !allow_add {
                        return None;
                    }
                    claimed_directions.insert(neighbor);
                    node_edges.push(SplitNodeEdge { target: neighbor, direction, kind: EdgeKind::Basic });
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
            edges.iter().any(|e| e.target == required.neighbor && e.direction == required.direction)
        })?;
        if per_node[bridge_owner].len() < 2 {
            return None;
        }
    }

    Some(per_node)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, SquarePoint, square_rect, Field};

    fn maze_line(len: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    /// SquareFace order [N, S, E, W] — node 1 gets an East face (index 2) and a North face
    /// (index 0), matching `at`'s real East and North neighbors on a 3x3 grid centered at (1,1).
    fn two_face_pattern() -> crate::generation::SplitPattern {
        use crate::generation::{SplitPattern, SplitPatternFace, SplitFaceRequirement};
        SplitPattern {
            node_count: 2,
            faces: vec![
                vec![],
                vec![
                    SplitPatternFace { face_index: 2, requirement: SplitFaceRequirement::Passage, sibling_target: None },
                    SplitPatternFace { face_index: 0, requirement: SplitFaceRequirement::Passage, sibling_target: None },
                ],
            ],
            weight: 1.0,
        }
    }

    /// Same shape as `two_face_pattern` but node 1 has only the single East face — no second edge
    /// available from the pattern itself.
    fn one_face_pattern() -> crate::generation::SplitPattern {
        use crate::generation::{SplitPattern, SplitPatternFace, SplitFaceRequirement};
        SplitPattern {
            node_count: 2,
            faces: vec![
                vec![],
                vec![SplitPatternFace { face_index: 2, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
            ],
            weight: 1.0,
        }
    }

    fn maze_grid(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(side, side), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    #[test]
    fn try_pattern_adaptation_satisfies_required_bridge_when_pattern_grants_a_second_edge() {
        // `at` starts fully isolated; the pattern's node 1 has both an East face (the required
        // bridge target) and a North face (the mandatory second edge) — both resolve to real
        // neighbors on a 3x3 grid, so the candidate must be accepted.
        let maze = maze_grid(3);
        let at = maze.field.node_at(SquarePoint { x: 1, y: 1 }).unwrap();
        let point = maze.field.point_of(at).unwrap();
        let east_neighbor = maze.field.node_at(SquarePoint { x: 2, y: 1 }).unwrap();
        let required = RequiredConnection { neighbor: east_neighbor, direction: SplitNodeEdgeDirection::Passage };

        let plan = try_pattern_adaptation(&maze, at, point, &two_face_pattern(), 0, None, true, true, Some(&required), &HashSet::new())
            .expect("pattern grants the bridge node both required and second edges");
        let bridge_owner = plan.iter().position(|edges| edges.iter().any(|e| e.target == east_neighbor)).unwrap();
        assert!(plan[bridge_owner].len() >= 2, "bridge-carrying node must not be left a dead end");
    }

    #[test]
    fn try_pattern_adaptation_rejects_required_bridge_when_pattern_leaves_it_a_dead_end() {
        // Same setup, but the pattern's node 1 only has the East (bridge) face — no second edge
        // anywhere in the pattern for that node, so the candidate must be rejected outright.
        let maze = maze_grid(3);
        let at = maze.field.node_at(SquarePoint { x: 1, y: 1 }).unwrap();
        let point = maze.field.point_of(at).unwrap();
        let east_neighbor = maze.field.node_at(SquarePoint { x: 2, y: 1 }).unwrap();
        let required = RequiredConnection { neighbor: east_neighbor, direction: SplitNodeEdgeDirection::Passage };

        let plan = try_pattern_adaptation(&maze, at, point, &one_face_pattern(), 0, None, true, true, Some(&required), &HashSet::new());
        assert!(plan.is_none(), "bridge node left with only the required edge must be rejected, not silently accepted as a dead end");
    }

    #[test]
    fn plan_unconstrained_split_without_required_matches_original_behavior() {
        let mut maze = maze_line(3);
        let nodes: Vec<NodeId> = (0..3).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        maze.graph.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut rng = MazeRng::seed_from_u64(1);
        let plan = plan_unconstrained_split(&maze, nodes[1], 2, None, &HashSet::new(), &mut rng).unwrap();
        let total_edges: usize = plan.iter().map(|n| n.len()).sum();
        assert_eq!(total_edges, 1);
    }

    #[test]
    fn plan_unconstrained_split_with_required_adds_bridge_and_second_edge() {
        // 1x5 line: node at x=2 is isolated (no existing edges at all). Bridge to node at x=0
        // (not a geometric neighbor, but required doesn't need it to be) plus a second edge drawn
        // from a real free neighbor (x=1 or x=3).
        let mut maze = maze_line(5);
        let nodes: Vec<NodeId> = (0..5).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        let at = nodes[2];
        let bridge_target = nodes[0];
        let required = RequiredConnection { neighbor: bridge_target, direction: SplitNodeEdgeDirection::Passage };
        let mut rng = MazeRng::seed_from_u64(3);
        let plan = plan_unconstrained_split(&maze, at, 2, Some(&required), &HashSet::new(), &mut rng).unwrap();
        let bridge_owner = plan.iter().position(|edges| edges.iter().any(|e| e.target == bridge_target)).unwrap();
        assert!(plan[bridge_owner].len() >= 2, "bridge-carrying node must have a second edge");
        assert!(plan[bridge_owner].iter().any(|e| e.target != bridge_target), "second edge must go elsewhere");
    }

    #[test]
    fn plan_unconstrained_split_reuses_an_existing_edge_to_satisfy_the_required_bridge() {
        // `at` already has a real edge to the required neighbor — the bridge must be satisfied by
        // redistributing that existing connection (not by adding a redundant new one).
        let mut maze = maze_line(3);
        let nodes: Vec<NodeId> = (0..3).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        let at = nodes[1];
        let bridge_target = nodes[0];
        maze.graph.add_bidirectional_edge(at, bridge_target, EdgeKind::Basic);
        maze.graph.add_bidirectional_edge(at, nodes[2], EdgeKind::Basic);
        let required = RequiredConnection { neighbor: bridge_target, direction: SplitNodeEdgeDirection::Passage };
        let mut rng = MazeRng::seed_from_u64(1);
        let plan = plan_unconstrained_split(&maze, at, 2, Some(&required), &HashSet::new(), &mut rng).unwrap();

        let total_edges: usize = plan.iter().map(|n| n.len()).sum();
        assert_eq!(total_edges, 2, "both pre-existing edges must be redistributed, none added or dropped");
        let bridge_owner = plan.iter().position(|edges| edges.iter().any(|e| e.target == bridge_target)).unwrap();
        assert_eq!(plan[bridge_owner].iter().filter(|e| e.target == bridge_target).count(), 1, "bridge target must appear exactly once, not duplicated");
    }

    #[test]
    fn plan_unconstrained_split_fails_when_no_second_edge_available() {
        // 1x1 field: the only point has no geometric neighbor at all, so a bridge-only node can
        // never gain a second edge.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let at = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        // A synthetic "elsewhere" neighbor id that isn't geometrically real — required connection
        // itself is always satisfiable (any NodeId), only the *second* edge needs a real neighbor.
        let fake_neighbor = at; // stand-in; the important part is the field has no other neighbor
        let required = RequiredConnection { neighbor: fake_neighbor, direction: SplitNodeEdgeDirection::Passage };
        let mut rng = MazeRng::seed_from_u64(1);
        let result = plan_unconstrained_split(&maze, at, 2, Some(&required), &HashSet::new(), &mut rng);
        assert!(result.is_none());
    }

    #[test]
    fn plan_unconstrained_split_rejects_a_required_neighbor_already_excluded() {
        // A caller must never plan a bridge to a point another command in the same batch already
        // committed to replace — that node's id won't exist by apply time.
        let mut maze = maze_line(3);
        let nodes: Vec<NodeId> = (0..3).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        let at = nodes[1];
        let bridge_target = nodes[0];
        let required = RequiredConnection { neighbor: bridge_target, direction: SplitNodeEdgeDirection::Passage };
        let mut excluded = HashSet::new();
        excluded.insert(bridge_target);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = plan_unconstrained_split(&maze, at, 2, Some(&required), &excluded, &mut rng);
        assert!(result.is_none());
    }

    #[test]
    fn plan_unconstrained_split_never_picks_an_excluded_node_for_the_second_edge() {
        // 1x5 line, node at x=2 isolated. Bridge to x=0 (required), but x=1 (the only real
        // geometric neighbor that could supply a second edge on one side) is excluded — the only
        // remaining free neighbor is x=3.
        let mut maze = maze_line(5);
        let nodes: Vec<NodeId> = (0..5).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        let at = nodes[2];
        let bridge_target = nodes[0];
        let required = RequiredConnection { neighbor: bridge_target, direction: SplitNodeEdgeDirection::Passage };
        let mut excluded = HashSet::new();
        excluded.insert(nodes[1]);
        let mut rng = MazeRng::seed_from_u64(3);
        let plan = plan_unconstrained_split(&maze, at, 2, Some(&required), &excluded, &mut rng).unwrap();
        let bridge_owner = plan.iter().position(|edges| edges.iter().any(|e| e.target == bridge_target)).unwrap();
        assert!(plan[bridge_owner].iter().all(|e| e.target != nodes[1]), "excluded node must never be picked as the second edge");
        assert!(plan[bridge_owner].iter().any(|e| e.target == nodes[3]), "must fall back to the other free neighbor");
    }
}
