use rand::{Rng, RngCore};
use std::collections::HashSet;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::generation::{PresetState, SplitGenerationConfig, SplitPattern, SplitFaceRequirement, OneWayDirection};
use crate::quality_control::MissingSplitTilesIssue;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::{MutationCommand, SplitNodeEdge, SplitNodeEdgeDirection};

pub const PARAM_ALLOW_LOSE_CONNECTIONS: &str = "allow_lose_connections";
pub const PARAM_ALLOW_ADD_CONNECTIONS: &str = "allow_add_connections";
pub const PARAM_MAX_ATTEMPTS: &str = "max_attempts";
pub const MAX_ATTEMPTS_DEFAULT: u32 = 50;

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_ALLOW_LOSE_CONNECTIONS,
        label: "Allow losing connections",
        kind: StrategyParamKind::Bool { default: true },
    },
    StrategyParam {
        id: PARAM_ALLOW_ADD_CONNECTIONS,
        label: "Allow adding connections",
        kind: StrategyParamKind::Bool { default: true },
    },
    StrategyParam {
        id: PARAM_MAX_ATTEMPTS,
        label: "Max failed attempts",
        kind: StrategyParamKind::Float { default: MAX_ATTEMPTS_DEFAULT as f64, min: 1.0, max: 10_000.0 },
    },
];

/// Handles `MISSING_SPLIT_TILES` — see GitHub issue #247, epic #246. Mints new split tiles at
/// randomly chosen eligible points (`generation::split_is_eligible` — not locked, point not
/// already multi-node) until `issue.missing` is satisfied or `max_attempts` **failed** attempts
/// have been spent (successful attempts don't count against the budget). Never removes or alters
/// any existing tile's slot-0 node — this strategy only ever adds.
///
/// Has its own pattern-selection configuration, independent from the producing check's own
/// pattern-list filter (see GitHub issue #247's known limitation, tracked for a fix in #253):
/// `config` is a plain `generation::SplitGenerationConfig` (the same type generation's own
/// `split_generation` field carries), reused as-is rather than duplicating its
/// `pattern_mode`/`max_split_nodes`/`patterns` fields onto this strategy directly. Each candidate
/// mints every new sibling in one atomic `MutationCommand::AddSplitNode` (all siblings share the
/// same all-or-nothing feasibility outcome).
///
/// **`pattern_mode` (via `patterns`, non-empty) — pattern-based candidate**: a candidate point,
/// pattern, and rotation/mirror are picked at random, then every one of the pattern's `node_count
/// - 1` new siblings (node 0 is slot-0, never touched) has its own faces resolved against the
/// point's actual neighbors (`try_pattern_adaptation` below — independent of generation's own
/// `enumerate_adaptations`, since there is no frontier/visited state here; every neighbor is
/// already part of the built maze). Each of the point's existing connections is matched against
/// whichever new sibling's face points that direction:
/// - A direction with an existing connection but **no** sibling claiming it: dropped if
///   `allow_lose_connections` is `true`, otherwise the whole candidate fails.
/// - A direction with **no** existing connection but a sibling's face requires one (Passage/
///   OneWay): added if `allow_add_connections` is `true`, otherwise the whole candidate fails.
/// - A direction with an existing connection matched by one or more siblings' faces: the
///   connection is preserved onto every claiming sibling (GitHub issue #247's design — the
///   original neighbor is never itself split, it simply gains one edge per claiming sibling).
///
/// **Non-pattern (`patterns` empty) candidate**: `max_split_nodes` (at least 2) total nodes;
/// every one of the point's existing connections is reassigned, unchanged (same direction), to
/// one uniformly random node among slot-0 and the `max_split_nodes - 1` new siblings —
/// `allow_lose_connections`/`allow_add_connections` don't apply here (no connection is ever lost
/// or invented, only reassigned).
pub struct AddSplitStrategy {
    pub config: SplitGenerationConfig,
}

impl<T: Tessellation> RepairStrategy<T, MissingSplitTilesIssue> for AddSplitStrategy {
    fn strategy_id(&self) -> &'static str { "add_split" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &MissingSplitTilesIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let missing = issue.missing;
        if missing == 0 {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let allow_lose = matches!(params.get(PARAM_ALLOW_LOSE_CONNECTIONS), Some(StrategyParamValue::Bool(v)) if *v);
        let allow_add = matches!(params.get(PARAM_ALLOW_ADD_CONNECTIONS), Some(StrategyParamValue::Bool(v)) if *v);
        let max_attempts = params.get(PARAM_MAX_ATTEMPTS).and_then(|v| v.as_float())
            .map(|v| v.max(1.0) as u32)
            .unwrap_or(MAX_ATTEMPTS_DEFAULT);

        let candidates: Vec<NodeId> = maze.field.all_node_ids()
            .filter(|&node| crate::generation::split_is_eligible(&maze.field, preset_state, node))
            .collect();

        let mut commands = Vec::new();
        let mut added = 0u32;
        let mut failed_attempts = 0u32;
        let mut pool = candidates;

        while added < missing && failed_attempts < max_attempts && !pool.is_empty() {
            let pick_idx = rng.random_range(0..pool.len());
            let at = pool[pick_idx];

            let outcome = if self.config.patterns.is_empty() {
                let sibling_count = self.config.max_split_nodes.max(2) as usize - 1;
                plan_unconstrained_split(maze, at, sibling_count, rng)
            } else {
                let pattern_idx = rng.random_range(0..self.config.patterns.len());
                plan_pattern_split(maze, at, &self.config.patterns[pattern_idx], rng, allow_lose, allow_add)
            };

            match outcome {
                Some(nodes) => {
                    commands.push(MutationCommand::AddSplitNode { at, nodes });
                    added += 1;
                    // Eligibility is per-point — once `at` has a command pending, it must not be
                    // picked again this call (the point would no longer be `split_is_eligible`
                    // after this command actually applies).
                    pool.swap_remove(pick_idx);
                }
                None => {
                    failed_attempts += 1;
                    pool.swap_remove(pick_idx);
                }
            }
        }

        if added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(AddSplitStrategy, MissingSplitTilesIssue);

/// Non-pattern candidate: `sibling_count` new nodes, each of `at`'s existing connections
/// reassigned unchanged to one uniformly random node among slot-0 and the new siblings. Returns
/// one `Vec<SplitNodeEdge>` per sibling (slot-0 itself needs no entry — a connection landing on
/// it requires no command at all, since `at` is never touched by `AddSplitNode`).
fn plan_unconstrained_split<T: Tessellation>(
    maze: &Maze<T>,
    at: NodeId,
    sibling_count: usize,
    rng: &mut dyn RngCore,
) -> Option<Vec<Vec<SplitNodeEdge>>> {
    let mut per_sibling: Vec<Vec<SplitNodeEdge>> = vec![Vec::new(); sibling_count];
    for (target, direction) in existing_directions(maze, at) {
        // 0 = keeps it on slot-0 (no command needed), 1..=sibling_count = that sibling's edge.
        let owner = rng.random_range(0..=sibling_count);
        if owner > 0 {
            per_sibling[owner - 1].push(SplitNodeEdge { target, direction });
        }
    }
    Some(per_sibling)
}

/// Every direction `at` (a point's slot-0 node) currently has a real connection in, resolved to
/// `(neighbor, direction-relative-to-at)` — `Passage` when both directions exist between `at` and
/// the neighbor, `Forward`/`Backward` for a single direction. One entry per distinct neighbor
/// (never per raw edge — a neighbor connected both ways collapses to one `Passage` entry).
fn existing_directions<T: Tessellation>(maze: &Maze<T>, at: NodeId) -> Vec<(NodeId, SplitNodeEdgeDirection)> {
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

/// Pattern-based candidate against `at`, trying every `rotation`/`mirror` combination in random
/// order (mirrors `enumerate_adaptations`'s exhaustive-but-order-independent search, minus the
/// generation-only visited/bridge/parent/cyclic bookkeeping — every neighbor here is either
/// already connected or not, there is no "unvisited" concept post-generation) until one validates
/// under `allow_lose`/`allow_add`, or returns `None` if every combination fails. Never resolves
/// `sibling_target` faces to a real neighbor — mirrors generation's own inter-split-node edges,
/// added directly between the pattern's new nodes without touching `at`'s existing connections
/// (out of scope for `SplitNodeEdge`, which only ever describes a sibling's *outside* edges; a
/// sibling_target-only pattern face simply contributes no `SplitNodeEdge` here, same as it would
/// get no resolvable-to-neighbor face in `enumerate_adaptations`).
fn plan_pattern_split<T: Tessellation>(
    maze: &Maze<T>,
    at: NodeId,
    pattern: &SplitPattern,
    rng: &mut dyn RngCore,
    allow_lose: bool,
    allow_add: bool,
) -> Option<Vec<Vec<SplitNodeEdge>>> {
    let Some(point) = maze.field.point_of(at) else { return None; };
    let degree = T::faces().len();
    if degree == 0 || pattern.node_count < 2 {
        return None;
    }

    let mut rotations: Vec<usize> = (0..degree).collect();
    shuffle(&mut rotations, rng);
    let mirrors = if rng.random::<bool>() { [true, false] } else { [false, true] };

    for &rotation in &rotations {
        for &mirror in &mirrors {
            if let Some(nodes) = try_pattern_adaptation(maze, at, point, pattern, degree, rotation, mirror, allow_lose, allow_add) {
                return Some(nodes);
            }
        }
    }
    None
}

/// Whether `at`'s actual existing connections match `pattern.faces[0]` (slot-0's own requirement)
/// under this `rotation`/`mirror`, face-index by face-index. `Wall`/`Unspecified` both mean "no
/// connection expected in this direction" (mirrors `split_pattern_match::reconstruct_tile_faces`'s
/// own "no way to tell an intentional Wall from Unspecified after the fact" — here, before the
/// fact, `Unspecified` is just as unconstrained-on-slot-0 as an explicit `Wall`, since slot-0
/// itself can never be rewired to satisfy either).
fn slot0_faces_match<T: Tessellation>(
    maze: &Maze<T>,
    at: NodeId,
    point: T::Point,
    pattern: &SplitPattern,
    degree: usize,
    rotation: usize,
    mirror: bool,
) -> bool {
    let mut expected = vec![SplitFaceRequirement::Wall; degree];
    let Some(slot0_faces) = pattern.faces.first() else { return false; };
    for face in slot0_faces {
        let Some(resolved) = transform_face_index(face.face_index, rotation, mirror, degree) else { return false; };
        if resolved >= degree {
            return false;
        }
        expected[resolved] = face.requirement;
    }

    (0..degree).all(|face_index| {
        let requirement = expected[face_index];
        let Some(tess_face) = T::face_at(face_index) else { return false; };
        let neighbor_point = T::step(point, tess_face);
        let neighbor = maze.field.nodes_at(neighbor_point).first().copied();

        let (fwd, bwd) = match neighbor {
            Some(n) => (maze.graph.edge_between(at, n).is_some(), maze.graph.edge_between(n, at).is_some()),
            None => (false, false),
        };

        match requirement {
            SplitFaceRequirement::Wall | SplitFaceRequirement::Unspecified => !fwd && !bwd,
            SplitFaceRequirement::Passage => fwd && bwd,
            SplitFaceRequirement::OneWay(OneWayDirection::Forward) => fwd && !bwd,
            SplitFaceRequirement::OneWay(OneWayDirection::Backward) => bwd && !fwd,
        }
    })
}

fn shuffle(items: &mut [usize], rng: &mut dyn RngCore) {
    for i in (1..items.len()).rev() {
        let j = rng.random_range(0..=i);
        items.swap(i, j);
    }
}

/// One rotation/mirror candidate: resolves every one of the pattern's `node_count - 1` new
/// siblings' own faces to real neighbors (`T::step` off `point`), **and** checks the pattern's
/// `faces[0]` (slot-0's own requirements) against `at`'s actual existing connections. Since
/// `AddSplitNode` never touches `at` itself (slot-0 can never be rewired by this command), a
/// `faces[0]` mismatch cannot be fixed by adding/dropping an edge the way a sibling's face can —
/// it can only ever mean this rotation/mirror doesn't actually describe `at`'s current state, so
/// the whole candidate is rejected outright (`None`) rather than silently applied around the
/// mismatch. This is what guarantees the resulting tile always structurally matches the pattern
/// (see `quality_control::split_pattern_match::split_tile_matches_any`, which the resulting tile
/// must always satisfy) instead of merely resolving siblings while ignoring slot-0's own shape.
/// `allow_lose`/`allow_add` gate the two possible mismatches between `at`'s existing connections
/// and the *siblings'* own face requirements — see `AddSplitStrategy`'s own doc comment.
#[allow(clippy::too_many_arguments)]
fn try_pattern_adaptation<T: Tessellation>(
    maze: &Maze<T>,
    at: NodeId,
    point: T::Point,
    pattern: &SplitPattern,
    degree: usize,
    rotation: usize,
    mirror: bool,
    allow_lose: bool,
    allow_add: bool,
) -> Option<Vec<Vec<SplitNodeEdge>>> {
    if !slot0_faces_match(maze, at, point, pattern, degree, rotation, mirror) {
        return None;
    }

    let mut per_sibling: Vec<Vec<SplitNodeEdge>> = Vec::with_capacity(pattern.faces.len().saturating_sub(1));
    let mut claimed_directions: HashSet<NodeId> = HashSet::new();

    for node_faces in &pattern.faces[1..] {
        let mut sibling_edges: Vec<SplitNodeEdge> = Vec::new();
        for face in node_faces {
            let resolved_index = transform_face_index(face.face_index, rotation, mirror, degree)?;
            if face.sibling_target.is_some() {
                continue; // inter-split edge, not an outside connection — out of scope here
            }
            match face.requirement {
                SplitFaceRequirement::Wall | SplitFaceRequirement::Unspecified => continue,
                SplitFaceRequirement::Passage | SplitFaceRequirement::OneWay(_) => {
                    let Some(tess_face) = T::face_at(resolved_index) else { return None; };
                    let neighbor_point = T::step(point, tess_face);
                    let Some(&neighbor) = maze.field.nodes_at(neighbor_point).first() else {
                        // Face points off-field or at an empty point — a real connection can
                        // never land there, so this is effectively a forbidden "add" if the field
                        // has nothing there at all.
                        if !allow_add { return None; }
                        continue;
                    };
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
                    sibling_edges.push(SplitNodeEdge { target: neighbor, direction });
                }
            }
        }
        per_sibling.push(sibling_edges);
    }

    // Every direction `at` already has a real connection in, but no sibling claimed — dropped
    // (kept implicitly on slot-0 by doing nothing) if allowed, otherwise the whole candidate fails.
    if !allow_lose {
        for (neighbor, _) in existing_directions(maze, at) {
            if !claimed_directions.contains(&neighbor) {
                return None;
            }
        }
    }

    Some(per_sibling)
}

/// `(face_index + rotation) mod degree`, mirrored first via `(degree - face_index) % degree` when
/// `mirror` is set — same transform generation's own `split_logic.rs`/`quality_control`'s
/// `split_pattern_match.rs` use, duplicated here for the same reason `split_pattern_match.rs`
/// duplicates it (a private helper in a `fn`-private module, not worth sharing beyond copy).
fn transform_face_index(face_index: usize, rotation: usize, mirror: bool, degree: usize) -> Option<usize> {
    if face_index >= degree {
        return None;
    }
    let base = if mirror { (degree - face_index) % degree } else { face_index };
    Some((base + rotation) % degree)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, SquarePoint, square_rect, Field};
    use crate::generation::SplitPatternFace;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<AddSplitStrategy as RepairStrategy<SquareTessellation, MissingSplitTilesIssue>>::params(&AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] } }), None)
    }

    fn maze_line(len: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    fn missing_issue(missing: u32) -> MissingSplitTilesIssue {
        MissingSplitTilesIssue::new_from_check("split_count", missing)
    }

    fn strategy_unconstrained() -> AddSplitStrategy {
        AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] } }
    }

    #[test]
    fn apply_succeeds_immediately_when_nothing_missing() {
        let mut maze = maze_line(3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(1);
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before);
    }

    #[test]
    fn apply_adds_split_tiles_in_unconstrained_mode() {
        let mut maze = maze_line(5);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(7);
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 2, "2 split tiles must each mint exactly one new node (max_split_nodes=2)");
    }

    #[test]
    fn apply_mints_configured_sibling_count_per_tile() {
        let mut maze = maze_line(3);
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(3);
        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: false, max_split_nodes: 4, patterns: vec![] } };
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 3, "max_split_nodes=4 must mint 3 new siblings for the one tile");
    }

    #[test]
    fn apply_never_alters_an_existing_slot0() {
        // Wire a bidirectional passage across the whole line, then add splits — every original
        // node must remain in the field as its point's slot-0 (first) node.
        let mut maze = maze_line(5);
        let nodes: Vec<NodeId> = (0..5).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        for w in nodes.windows(2) {
            maze.graph.add_bidirectional_edge(w[0], w[1], EdgeKind::Basic);
        }
        let slot0s = nodes.clone();

        let issue = missing_issue(3);
        let mut rng = MazeRng::seed_from_u64(42);
        apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);

        for (x, &slot0) in slot0s.iter().enumerate() {
            let point = SquarePoint { x: x as i32, y: 0 };
            assert_eq!(maze.field.nodes_at(point).first(), Some(&slot0), "slot-0 at x={x} must remain the point's first node");
        }
    }

    #[test]
    fn apply_reports_failed_when_no_eligible_point_exists() {
        // A single-node field where the only point is locked — no eligible candidate at all.
        let mut maze = maze_line(1);
        let node = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(node);
        preset_state.locked_in.insert(node);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = maze_line(5);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit(&strategy_unconstrained(), &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &[]);

        let mut maze_b = maze_line(5);
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit(&strategy_unconstrained(), &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &[]);

        assert_eq!(maze_a.field.node_count(), maze_b.field.node_count());
    }

    fn two_node_passage_pattern() -> SplitPattern {
        // SquareFace order [N, S, E, W] — node 1 gets an East face (index 2), matching node 0's
        // real East neighbor.
        SplitPattern {
            node_count: 2,
            faces: vec![
                vec![],
                vec![SplitPatternFace { face_index: 2, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
            ],
            weight: 1.0,
        }
    }

    #[test]
    fn pattern_mode_adds_a_split_tile_matching_the_configured_pattern() {
        // `at` (the middle point) starts fully isolated — the pattern's `faces[0]` is empty
        // (Wall on every side), so slot-0 must have zero real connections for this rotation/
        // mirror to match at all (`slot0_faces_match`). Only the sibling's East face adds the
        // new connection (via `allow_add`).
        let mut maze = maze_line(3);

        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![two_node_passage_pattern()] } };
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(5);
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 1);
    }

    #[test]
    fn pattern_mode_fails_when_no_pattern_can_ever_match_and_lose_is_forbidden() {
        // A fully-isolated point (no connections at all) can never satisfy a pattern requiring an
        // East passage without adding a new connection — with allow_add forbidden, every rotation
        // fails.
        let mut maze = maze_line(3);
        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![two_node_passage_pattern()] } };
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(PARAM_ALLOW_ADD_CONNECTIONS.to_string(), "false".to_string());
        let params = build_params(<AddSplitStrategy as RepairStrategy<SquareTessellation, MissingSplitTilesIssue>>::params(&strategy), Some(&overrides));

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(9);
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed), "no rotation of this pattern can match without adding a connection, which is forbidden here");
    }

    #[test]
    fn pattern_mode_never_applies_a_pattern_that_mismatches_slot0s_own_faces() {
        // `at` (middle point) is connected both West and East. `two_node_passage_pattern`'s
        // `faces[0]` is empty (Wall on every side for slot-0), which no rotation/mirror of this
        // 4-degree square tessellation can satisfy while `at` keeps two real connections — the
        // strategy must reject every candidate rather than silently drop one connection onto an
        // unclaimed direction (the bug this test guards against: a resulting tile that doesn't
        // structurally match the pattern at all).
        let mut maze = maze_line(3);
        let nodes: Vec<NodeId> = (0..3).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        maze.graph.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        maze.graph.add_bidirectional_edge(nodes[1], nodes[2], EdgeKind::Basic);

        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![two_node_passage_pattern()] } };
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(5);
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed), "slot-0 already has two real connections, which can never match this pattern's empty faces[0]");
        assert_eq!(maze.field.node_count(), nodes_before, "no split tile must be minted when no candidate structurally matches the pattern");
    }
}
