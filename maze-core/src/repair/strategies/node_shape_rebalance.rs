//! Repairs `ViolatedNodeShapeLimits` by moving nodes between shapes — see
//! `Specs/node-shape-limits.md` ("Repair strategy", GitHub issue #1025).

use crate::Maze;
use crate::generation::PresetState;
use crate::generation::edge_ops::{bidirectional_edge_feasible, remove_edge_between_feasible};
use crate::graph::node_shape::{
    NodeShapeLimits, TypedShape, classify_typed_shape, nodes_by_shape, possible_node_shapes,
};
use crate::graph::scc::{ConnectedComponents, build_scc};
use crate::graph::{EdgeKind, Graph};
use crate::ids::NodeId;
use crate::quality_control::{LimitViolationKind, ViolatedNodeShapeLimitsIssue};
use crate::repair::command::MutationCommand;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::RngCore;
use rand::seq::SliceRandom;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

/// Pivot nodes the local phase examines at most (the rest of a huge excess waits for the next
/// iteration — every apply fixes at least one step anyway).
const LOCAL_PIVOT_CAP: usize = 2000;
/// Most passages one local move flips around its pivot.
const LOCAL_MAX_FLIPS: usize = 2;
/// Configurations the local phase evaluates in one apply.
const LOCAL_EVALUATION_BUDGET: usize = 50_000;
/// Region search levels, `(region nodes, most passages flipped)`: small regions first, wider ones
/// only when the smaller found nothing.
const REGION_LEVELS: [(usize, usize); 3] = [(4, 4), (8, 4), (16, 3)];
/// Regions tried per level, each around another pivot.
const REGIONS_PER_LEVEL: usize = 8;
/// Configurations one region search evaluates at most.
const REGION_EVALUATION_BUDGET: usize = 20_000;
/// Improving configurations kept for the connectivity check, best first. Generous, because in a
/// tree-like maze the best-scoring ones are often pure closings that all split it.
const CANDIDATES_KEPT: usize = 128;
/// Connectivity checks spent on joining further moves to the first valid one.
const EXTENSION_CHECKS: usize = 64;

/// Rebalances node shapes toward the limits of a `ViolatedNodeShapeLimitsIssue`.
///
/// One apply makes an all-or-nothing set of passage flips (a passage opened where a wall stands, or
/// closed) that strictly lowers the total shortfall of every limit at once — so it never breaks a
/// limit that holds, and repeated applies cannot oscillate. The set is the best improving move plus
/// every further move that touches other nodes and still lowers the shortfall, so a large excess
/// does not cost one repair iteration per node. Moves are found by a local search around the
/// violating nodes and, when it finds nothing, by a search over every flip combination inside a
/// small connected region (which may pass through worse intermediate shapes). A set never splits a
/// strongly connected component and respects `PresetState`.
pub struct NodeShapeRebalanceStrategy;

impl<T: Tessellation> RepairStrategy<T, ViolatedNodeShapeLimitsIssue>
    for NodeShapeRebalanceStrategy
{
    fn strategy_id(&self) -> &'static str {
        "node_shape_rebalance"
    }

    fn apply(
        &self,
        issue: &ViolatedNodeShapeLimitsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.limits.is_empty() {
            return (RepairResult::Failed, vec![]);
        }
        let by_shape = nodes_by_shape(&maze.graph, &maze.field);
        if limits_unsatisfiable(&issue.limits, &by_shape, &possible_node_shapes(&maze.field)) {
            return (RepairResult::Failed, vec![]);
        }
        let mut search = Search::new(maze, &issue.limits, &by_shape, preset_state);
        if search.base_score == 0 {
            return (RepairResult::Failed, vec![]);
        }
        let mut pivots = pivots(issue, &by_shape);
        pivots.shuffle(rng);

        let found = search
            .local_move(&pivots)
            .or_else(|| search.region_move(&pivots));
        match found {
            Some(flips) => (RepairResult::Fixed { score: None }, search.commands(&flips)),
            None => (RepairResult::Failed, vec![]),
        }
    }
}

crate::impl_erased_repair_strategy!(NodeShapeRebalanceStrategy, ViolatedNodeShapeLimitsIssue);

/// A pair of adjacent nodes whose passage a move may flip: `is_open` is whether a two-way `Basic`
/// passage connects them now (the flip closes it), otherwise no `Basic` edge does (the flip opens
/// one). Pairs touched by one-way edges, or protected by the preset, are never flippable.
#[derive(Debug, Clone, Copy)]
struct Passage {
    a: NodeId,
    b: NodeId,
    is_open: bool,
}

/// An improving set of flips and the total shortfall that would remain after it.
#[derive(Debug, Clone)]
struct Candidate {
    score: u64,
    flips: Vec<Passage>,
}

/// The passages of a move as sorted node pairs — equal for the same move found from either end.
fn move_key(flips: &[Passage]) -> Vec<(NodeId, NodeId)> {
    let mut key: Vec<(NodeId, NodeId)> =
        flips.iter().map(|p| (p.a.min(p.b), p.a.max(p.b))).collect();
    key.sort_unstable();
    key
}

/// Inserts an improving move into `found`, kept sorted by (score, flips) and at most
/// `CANDIDATES_KEPT` long, without duplicates.
fn record(found: &mut Vec<Candidate>, score: u64, flips: &[Passage]) {
    let rank = (score, flips.len());
    let at = found.partition_point(|c| (c.score, c.flips.len()) <= rank);
    if at >= CANDIDATES_KEPT {
        return;
    }
    let key = move_key(flips);
    let duplicate = found[..at]
        .iter()
        .rev()
        .take_while(|c| (c.score, c.flips.len()) == rank)
        .any(|c| move_key(&c.flips) == key);
    if duplicate {
        return;
    }
    found.insert(
        at,
        Candidate {
            score,
            flips: flips.to_vec(),
        },
    );
    found.truncate(CANDIDATES_KEPT);
}

/// Shortfall of one limit: how far `count` is outside its range (zero when within, or unlimited).
fn shortfall(limits: &NodeShapeLimits, shape: &TypedShape, count: u32) -> i64 {
    let range = limits.get(shape);
    let excess = range.max().map_or(0, |max| count.saturating_sub(max));
    let deficit = range.min().map_or(0, |min| min.saturating_sub(count));
    i64::from(excess) + i64::from(deficit)
}

/// Whether the limits of some cell type cannot hold at once: its mins need more nodes than it has,
/// or every shape its nodes can take is capped and the caps hold fewer nodes than it has. A limit
/// on a shape the field cannot produce is skipped, like in the check.
fn limits_unsatisfiable(
    limits: &NodeShapeLimits,
    by_shape: &BTreeMap<TypedShape, Vec<NodeId>>,
    possible: &BTreeSet<TypedShape>,
) -> bool {
    let mut nodes: BTreeMap<&str, u64> = BTreeMap::new();
    // `None` once some shape of the cell type is uncapped (or a node has a shape outside `possible`).
    let mut capacity: BTreeMap<&str, Option<u64>> = BTreeMap::new();
    for (shape, found) in by_shape {
        *nodes.entry(shape.cell_type.as_str()).or_default() += found.len() as u64;
        if !possible.contains(shape) {
            capacity.insert(shape.cell_type.as_str(), None);
        }
    }
    for shape in possible {
        let slot = capacity.entry(shape.cell_type.as_str()).or_insert(Some(0));
        *slot = match (*slot, limits.get(shape).max()) {
            (Some(sum), Some(max)) => Some(sum + u64::from(max)),
            _ => None,
        };
    }
    let mut required: BTreeMap<&str, u64> = BTreeMap::new();
    for (shape, range) in limits.iter() {
        if let Some(min) = range.min().filter(|_| possible.contains(shape)) {
            *required.entry(shape.cell_type.as_str()).or_default() += u64::from(min);
        }
    }
    let have = |cell_type: &str| nodes.get(cell_type).copied().unwrap_or(0);
    required
        .iter()
        .any(|(cell_type, &min)| min > have(cell_type))
        || capacity
            .iter()
            .any(|(cell_type, cap)| cap.is_some_and(|cap| cap < have(cell_type)))
}

/// The nodes worth changing: the nodes of every excess shape, and for a deficit the nodes of the
/// shapes that may give one up. Sorted and unique (the caller shuffles).
fn pivots(
    issue: &ViolatedNodeShapeLimitsIssue,
    by_shape: &BTreeMap<TypedShape, Vec<NodeId>>,
) -> Vec<NodeId> {
    let mut nodes: BTreeSet<NodeId> = BTreeSet::new();
    for violation in &issue.violations {
        match violation.kind {
            LimitViolationKind::Excess => nodes.extend(violation.nodes.iter().copied()),
            LimitViolationKind::Deficit => {
                for &counterpart in &violation.counterparts {
                    let typed = TypedShape::new(violation.shape.cell_type.clone(), counterpart);
                    nodes.extend(by_shape.get(&typed).into_iter().flatten().copied());
                }
            }
        }
    }
    nodes.into_iter().collect()
}

/// Flips `passage` in `graph`, by looking the edges up now — an earlier flip and its undo may have
/// re-created them under new ids.
fn flip(graph: &mut Graph, passage: Passage) {
    if passage.is_open {
        for (from, to) in [(passage.a, passage.b), (passage.b, passage.a)] {
            if let Some(id) = graph.edge_between_kind(from, to, &EdgeKind::Basic) {
                graph.remove_edge(id);
            }
        }
    } else {
        graph.add_bidirectional_edge(passage.a, passage.b, EdgeKind::Basic);
    }
}

fn unflip(graph: &mut Graph, passage: Passage) {
    flip(
        graph,
        Passage {
            is_open: !passage.is_open,
            ..passage
        },
    );
}

struct Search<'a, T: Tessellation> {
    maze: &'a Maze<T>,
    limits: &'a NodeShapeLimits,
    preset_state: &'a PresetState,
    /// Node count per typed shape in the maze as it is.
    counts: BTreeMap<TypedShape, u32>,
    /// The typed shape of every node in the maze as it is.
    shapes: HashMap<NodeId, TypedShape>,
    /// Total shortfall of the maze as it is.
    base_score: u64,
    /// Working copy the flips are tried on; always restored to the maze's graph between tries.
    scratch: Graph,
    /// Strongly connected components of the maze as it is, built on first use.
    base_components: Option<ConnectedComponents>,
    evaluations: usize,
}

impl<'a, T: Tessellation> Search<'a, T> {
    fn new(
        maze: &'a Maze<T>,
        limits: &'a NodeShapeLimits,
        by_shape: &BTreeMap<TypedShape, Vec<NodeId>>,
        preset_state: &'a PresetState,
    ) -> Self {
        let counts: BTreeMap<TypedShape, u32> = by_shape
            .iter()
            .map(|(shape, nodes)| (shape.clone(), nodes.len() as u32))
            .collect();
        let shapes: HashMap<NodeId, TypedShape> = by_shape
            .iter()
            .flat_map(|(shape, nodes)| nodes.iter().map(move |&node| (node, shape.clone())))
            .collect();
        let base_score = limits
            .iter()
            .map(|(shape, _)| {
                shortfall(limits, shape, counts.get(shape).copied().unwrap_or(0)) as u64
            })
            .sum();
        Self {
            maze,
            limits,
            preset_state,
            counts,
            shapes,
            base_score,
            scratch: maze.graph.clone(),
            base_components: None,
            evaluations: 0,
        }
    }

    /// The flippable passage between two adjacent nodes, if there is one.
    fn passage(&self, a: NodeId, b: NodeId) -> Option<Passage> {
        let graph = &self.maze.graph;
        let forward = graph.edge_between_kind(a, b, &EdgeKind::Basic);
        let backward = graph.edge_between_kind(b, a, &EdgeKind::Basic);
        let preset = self.preset_state;
        match (forward, backward) {
            (Some(forward), Some(backward)) => (!preset.is_preset_edge_id(forward)
                && !preset.is_preset_edge_id(backward)
                && remove_edge_between_feasible(preset, a, b)
                && remove_edge_between_feasible(preset, b, a))
            .then_some(Passage {
                a,
                b,
                is_open: true,
            }),
            (None, None) => bidirectional_edge_feasible(preset, a, b).then_some(Passage {
                a,
                b,
                is_open: false,
            }),
            _ => None,
        }
    }

    /// Flippable passages between `node` and its neighbors.
    fn incident_passages(&self, node: NodeId) -> Vec<Passage> {
        self.maze
            .field
            .neighbors(node)
            .into_iter()
            .filter_map(|other| self.passage(node, other))
            .collect()
    }

    /// Flippable passages between the nodes of `region`.
    fn internal_passages(&self, region: &[NodeId]) -> Vec<Passage> {
        let members: HashSet<NodeId> = region.iter().copied().collect();
        let mut passages = Vec::new();
        for &node in region {
            for other in self.maze.field.neighbors(node) {
                if node < other
                    && members.contains(&other)
                    && let Some(passage) = self.passage(node, other)
                {
                    passages.push(passage);
                }
            }
        }
        passages
    }

    /// Up to `size` nodes connected around `seed`, nearest first.
    fn region(&self, seed: NodeId, size: usize) -> Vec<NodeId> {
        let mut region = vec![seed];
        let mut seen: HashSet<NodeId> = HashSet::from([seed]);
        let mut queue = VecDeque::from([seed]);
        while let Some(node) = queue.pop_front() {
            for other in self.maze.field.neighbors(node) {
                if region.len() >= size {
                    return region;
                }
                if seen.insert(other) {
                    region.push(other);
                    queue.push_back(other);
                }
            }
        }
        region
    }

    /// Total shortfall once the flips already applied to `scratch` are in effect; only the nodes
    /// at the ends of the flipped passages (`touched`) can have changed shape.
    fn score_touched(&self, touched: &BTreeSet<NodeId>) -> u64 {
        let field = &self.maze.field;
        let mut delta: BTreeMap<TypedShape, i64> = BTreeMap::new();
        for &node in touched {
            let before = self
                .shapes
                .get(&node)
                .cloned()
                .unwrap_or_else(|| classify_typed_shape(&self.maze.graph, node, field));
            *delta.entry(before).or_default() -= 1;
            *delta
                .entry(classify_typed_shape(&self.scratch, node, field))
                .or_default() += 1;
        }
        let mut score = self.base_score as i64;
        for (shape, change) in delta.into_iter().filter(|(_, change)| *change != 0) {
            let before = self.counts.get(&shape).copied().unwrap_or(0);
            let after = (i64::from(before) + change) as u32;
            score += shortfall(self.limits, &shape, after) - shortfall(self.limits, &shape, before);
        }
        score as u64
    }

    /// Tries every combination of at most `max_flips` of `passages` on `scratch` and records those
    /// that lower the total shortfall, best (then smallest) first, in `found`.
    fn explore(
        &mut self,
        passages: &[Passage],
        max_flips: usize,
        budget: usize,
        found: &mut Vec<Candidate>,
    ) {
        self.evaluations = 0;
        self.explore_from(passages, 0, max_flips, budget, &mut Vec::new(), found);
    }

    fn explore_from(
        &mut self,
        passages: &[Passage],
        start: usize,
        max_flips: usize,
        budget: usize,
        flips: &mut Vec<Passage>,
        found: &mut Vec<Candidate>,
    ) {
        for index in start..passages.len() {
            if self.evaluations >= budget || crate::deadline::expired() {
                return;
            }
            let passage = passages[index];
            flip(&mut self.scratch, passage);
            flips.push(passage);
            self.evaluations += 1;
            let touched: BTreeSet<NodeId> = flips.iter().flat_map(|p| [p.a, p.b]).collect();
            let score = self.score_touched(&touched);
            if score < self.base_score {
                record(found, score, flips);
            }
            if flips.len() < max_flips {
                self.explore_from(passages, index + 1, max_flips, budget, flips, found);
            }
            flips.pop();
            unflip(&mut self.scratch, passage);
        }
    }

    /// Whether applying `flips` keeps every strongly connected component of the maze whole (a
    /// component may still grow by merging with another).
    fn keeps_connectivity(&mut self, flips: &[Passage]) -> bool {
        for &passage in flips {
            flip(&mut self.scratch, passage);
        }
        let after = build_scc(&self.scratch);
        for &passage in flips.iter().rev() {
            unflip(&mut self.scratch, passage);
        }
        let before = self
            .base_components
            .get_or_insert_with(|| build_scc(&self.maze.graph));
        before.components.iter().all(|component| {
            let mut ids = component.iter().map(|&node| after.component_of(node));
            ids.next()
                .is_none_or(|first| first.is_some() && ids.all(|id| id == first))
        })
    }

    /// Total shortfall once all of `flips` are applied.
    fn score_of(&mut self, flips: &[Passage]) -> u64 {
        for &passage in flips {
            flip(&mut self.scratch, passage);
        }
        let touched: BTreeSet<NodeId> = flips.iter().flat_map(|p| [p.a, p.b]).collect();
        let score = self.score_touched(&touched);
        for &passage in flips.iter().rev() {
            unflip(&mut self.scratch, passage);
        }
        score
    }

    /// The best candidate that keeps connectivity, joined by the further candidates that touch
    /// other nodes, lower the shortfall again and keep connectivity together with it.
    fn best_valid(&mut self, found: Vec<Candidate>) -> Option<Vec<Passage>> {
        let mut rest = found.into_iter();
        let first = rest.find(|candidate| self.keeps_connectivity(&candidate.flips))?;
        let (mut flips, mut score) = (first.flips, first.score);
        let mut checks = 0;
        for candidate in rest {
            if checks >= EXTENSION_CHECKS || score == 0 || crate::deadline::expired() {
                break;
            }
            let used: BTreeSet<NodeId> = flips.iter().flat_map(|p| [p.a, p.b]).collect();
            if candidate
                .flips
                .iter()
                .any(|p| used.contains(&p.a) || used.contains(&p.b))
            {
                continue;
            }
            let mut joined = flips.clone();
            joined.extend_from_slice(&candidate.flips);
            let joined_score = self.score_of(&joined);
            if joined_score >= score {
                continue;
            }
            checks += 1;
            if self.keeps_connectivity(&joined) {
                flips = joined;
                score = joined_score;
            }
        }
        Some(flips)
    }

    /// Local search: combinations of the passages around the pivots.
    fn local_move(&mut self, pivots: &[NodeId]) -> Option<Vec<Passage>> {
        let mut found = Vec::new();
        let mut spent = 0;
        for &pivot in pivots.iter().take(LOCAL_PIVOT_CAP) {
            if spent >= LOCAL_EVALUATION_BUDGET || crate::deadline::expired() {
                break;
            }
            let passages = self.incident_passages(pivot);
            self.explore(
                &passages,
                LOCAL_MAX_FLIPS,
                LOCAL_EVALUATION_BUDGET - spent,
                &mut found,
            );
            spent += self.evaluations;
        }
        self.best_valid(found)
    }

    /// Region search: every combination of the passages inside a small connected region.
    fn region_move(&mut self, pivots: &[NodeId]) -> Option<Vec<Passage>> {
        for (size, max_flips) in REGION_LEVELS {
            let mut found = Vec::new();
            for &seed in pivots.iter().take(REGIONS_PER_LEVEL) {
                if crate::deadline::expired() {
                    return None;
                }
                let region = self.region(seed, size);
                let passages = self.internal_passages(&region);
                self.explore(&passages, max_flips, REGION_EVALUATION_BUDGET, &mut found);
            }
            if let Some(flips) = self.best_valid(found) {
                return Some(flips);
            }
        }
        None
    }

    /// The commands of a move: one command, or one all-or-nothing group when the move flips several
    /// passages (closings first).
    fn commands(&self, flips: &[Passage]) -> Vec<MutationCommand> {
        let closings = flips.iter().filter(|p| p.is_open).filter_map(|p| {
            self.maze
                .graph
                .edge_between_kind(p.a, p.b, &EdgeKind::Basic)
                .map(|id| MutationCommand::RemoveEdgeWithReverse { id })
        });
        let openings = flips
            .iter()
            .filter(|p| !p.is_open)
            .map(|p| MutationCommand::AddBidirectionalEdge { a: p.a, b: p.b });
        let mut commands: Vec<MutationCommand> = closings.chain(openings).collect();
        if commands.len() > 1 {
            commands = vec![MutationCommand::Atomic { commands }];
        }
        commands
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::node_shape::{CountRange, NodeShape};
    use crate::quality_control::apply_commands::apply_commands;
    use crate::quality_control::check::Check;
    use crate::quality_control::checks::node_shape_limits::NodeShapeLimitsCheck;
    use crate::random::MazeRng;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::sync::Arc;

    const CELL: &str = "regular:4";

    /// A `width` x `height` square maze with the given passages, as `(x, y)` pairs.
    fn maze(
        width: usize,
        height: usize,
        passages: &[((i32, i32), (i32, i32))],
    ) -> (Maze<SquareTessellation>, impl Fn(i32, i32) -> NodeId) {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(width, height), &mut ids)
                .unwrap();
        let level = field.single_level_id();
        let at = {
            let nodes: BTreeMap<(i32, i32), NodeId> = (0..width as i32)
                .flat_map(|x| (0..height as i32).map(move |y| (x, y)))
                .map(|(x, y)| {
                    (
                        (x, y),
                        field
                            .node_at(
                                level,
                                SquarePoint {
                                    x: x as _,
                                    y: y as _,
                                },
                            )
                            .unwrap(),
                    )
                })
                .collect();
            move |x, y| nodes[&(x, y)]
        };
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        for &((ax, ay), (bx, by)) in passages {
            graph.add_bidirectional_edge(at(ax, ay), at(bx, by), EdgeKind::Basic);
        }
        (Maze::new(field, graph), at)
    }

    fn issue(
        maze: &Maze<SquareTessellation>,
        limits: &NodeShapeLimits,
    ) -> Option<ViolatedNodeShapeLimitsIssue> {
        let mut issues = Vec::new();
        let mut rng = MazeRng::seed_from_u64(0);
        NodeShapeLimitsCheck {
            instance_id: "node_shape_limits".to_string(),
            limits: limits.clone(),
        }
        .repair_check(maze, &mut issues, &mut rng, ());
        issues.pop()
    }

    /// Runs check and strategy until the check is silent or the strategy gives up (at most 30
    /// rounds); returns whether the limits ended up satisfied.
    fn rebalance(
        maze: &mut Maze<SquareTessellation>,
        limits: &NodeShapeLimits,
        preset_state: &PresetState,
    ) -> bool {
        let mut rng = MazeRng::seed_from_u64(7);
        for _ in 0..30 {
            let Some(issue) = issue(maze, limits) else {
                return true;
            };
            let (result, commands) = NodeShapeRebalanceStrategy.apply(
                &issue,
                maze,
                &mut rng,
                &StrategyParams::new(),
                preset_state,
                &[],
            );
            if matches!(result, RepairResult::Failed) {
                assert!(commands.is_empty(), "a failed apply proposes nothing");
                return false;
            }
            apply_commands(maze, preset_state, commands, None, None);
        }
        issue(maze, limits).is_none()
    }

    /// A snake through a 3x2 grid: ends (0,0) and (0,1), straights (1,0) and (1,1), turns at the
    /// right edge. The rung (1,0)-(1,1) is blocked by the preset, so losing a straight takes
    /// closing one passage and opening another.
    fn snake() -> (Maze<SquareTessellation>, PresetState) {
        let (maze, at) = maze(
            3,
            2,
            &[
                ((0, 0), (1, 0)),
                ((1, 0), (2, 0)),
                ((2, 0), (2, 1)),
                ((2, 1), (1, 1)),
                ((1, 1), (0, 1)),
            ],
        );
        let mut preset = PresetState::empty();
        preset.blocked.insert((at(1, 0), at(1, 1)));
        preset.blocked.insert((at(1, 1), at(1, 0)));
        (maze, preset)
    }

    fn count(maze: &Maze<SquareTessellation>, shape: NodeShape) -> usize {
        nodes_by_shape(&maze.graph, &maze.field)
            .get(&TypedShape::new(CELL, shape))
            .map_or(0, Vec::len)
    }

    fn component_count(maze: &Maze<SquareTessellation>) -> usize {
        build_scc(&maze.graph).components.len()
    }

    fn at_most(shape: NodeShape, max: u32) -> NodeShapeLimits {
        NodeShapeLimits::new().with(CELL, shape, CountRange::new(None, Some(max)).unwrap())
    }

    #[test]
    fn opens_a_passage_to_turn_a_surplus_dead_end_into_a_turn() {
        // (0,0)-(1,0)-(1,1) plus the isolated (0,1): three dead ends, one turn.
        let (mut maze, _) = maze(2, 2, &[((0, 0), (1, 0)), ((1, 0), (1, 1))]);
        let limits = at_most(NodeShape::DeadEnd, 2);
        let before = component_count(&maze);
        assert!(rebalance(&mut maze, &limits, &PresetState::empty()));
        assert!(count(&maze, NodeShape::DeadEnd) <= 2);
        assert!(component_count(&maze) <= before);
    }

    #[test]
    fn a_move_that_would_split_the_maze_is_refused() {
        // A straight corridor of three: the only way to lose the straight is to cut it.
        let (mut maze, _) = maze(3, 1, &[((0, 0), (1, 0)), ((1, 0), (2, 0))]);
        let limits = at_most(NodeShape::Straight, 0);
        assert!(!rebalance(&mut maze, &limits, &PresetState::empty()));
        assert_eq!(count(&maze, NodeShape::Straight), 1);
        assert_eq!(component_count(&maze), 1);
    }

    #[test]
    fn preset_blocked_passages_are_never_opened() {
        let (mut maze, at) = maze(2, 2, &[((0, 0), (1, 0)), ((1, 0), (1, 1))]);
        let mut preset = PresetState::empty();
        for other in [at(0, 0), at(1, 1)] {
            preset.blocked.insert((at(0, 1), other));
            preset.blocked.insert((other, at(0, 1)));
        }
        let limits = at_most(NodeShape::DeadEnd, 2);
        assert!(!rebalance(&mut maze, &limits, &preset));
        assert_eq!(count(&maze, NodeShape::DeadEnd), 3);
    }

    #[test]
    fn a_region_search_reroutes_a_passage_to_lose_a_straight_without_splitting() {
        let (mut maze, preset) = snake();
        let limits = at_most(NodeShape::Straight, 1);
        assert!(rebalance(&mut maze, &limits, &preset));
        assert!(count(&maze, NodeShape::Straight) <= 1);
        assert_eq!(component_count(&maze), 1);
    }

    #[test]
    fn limits_that_need_more_nodes_than_exist_fail_at_once() {
        let (maze, _) = maze(3, 3, &[((0, 0), (1, 0))]);
        let limits = NodeShapeLimits::new()
            .with(CELL, NodeShape::DeadEnd, CountRange::exact(6))
            .with(CELL, NodeShape::Straight, CountRange::exact(6));
        let issue = issue(&maze, &limits).expect("both limits are violated");
        let (result, commands) = NodeShapeRebalanceStrategy.apply(
            &issue,
            &maze,
            &mut MazeRng::seed_from_u64(1),
            &StrategyParams::new(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
    }

    #[test]
    fn caps_that_hold_fewer_nodes_than_exist_fail_at_once() {
        // A 2x2 field only has dead ends and turns: 1 + 2 caps hold 3 of its 4 nodes.
        let (maze, _) = maze(
            2,
            2,
            &[((0, 0), (1, 0)), ((1, 0), (1, 1)), ((1, 1), (0, 1))],
        );
        let limits = NodeShapeLimits::new()
            .with(
                CELL,
                NodeShape::DeadEnd,
                CountRange::new(None, Some(1)).unwrap(),
            )
            .with(
                CELL,
                NodeShape::Turn(90),
                CountRange::new(None, Some(2)).unwrap(),
            );
        let issue = issue(&maze, &limits).expect("two dead ends exceed the cap of one");
        let (result, commands) = NodeShapeRebalanceStrategy.apply(
            &issue,
            &maze,
            &mut MazeRng::seed_from_u64(1),
            &StrategyParams::new(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
    }

    #[test]
    fn one_apply_joins_moves_that_touch_other_nodes() {
        // Two separate blocks (three dead ends each, one of them isolated and one turn) and four
        // isolated columns between them: 10 dead ends. One move changes four nodes at most, so
        // losing five dead ends in one apply takes joined moves.
        let passages = [
            ((0, 0), (1, 0)),
            ((1, 0), (1, 1)),
            ((4, 0), (5, 0)),
            ((5, 0), (5, 1)),
        ];
        let (mut maze, _) = maze(6, 2, &passages);
        let limits = at_most(NodeShape::DeadEnd, 4);
        let preset = PresetState::empty();
        let issue = issue(&maze, &limits).expect("ten dead ends exceed four");
        assert_eq!(count(&maze, NodeShape::DeadEnd), 10);
        let (result, commands) = NodeShapeRebalanceStrategy.apply(
            &issue,
            &maze,
            &mut MazeRng::seed_from_u64(5),
            &StrategyParams::new(),
            &preset,
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(
            apply_commands(&mut maze, &preset, commands, None, None).applied,
            1
        );
        assert!(count(&maze, NodeShape::DeadEnd) <= 5);
    }

    #[test]
    fn a_deficit_is_met_by_turning_a_counterpart_shape_into_the_missing_one() {
        // (0,0)-(1,0)-(1,1) plus the isolated (0,1): one turn; two are required.
        let (mut maze, _) = maze(2, 2, &[((0, 0), (1, 0)), ((1, 0), (1, 1))]);
        let limits = NodeShapeLimits::new().with(
            CELL,
            NodeShape::Turn(90),
            CountRange::new(Some(2), None).unwrap(),
        );
        assert_eq!(count(&maze, NodeShape::Turn(90)), 1);
        assert!(rebalance(&mut maze, &limits, &PresetState::empty()));
        assert!(count(&maze, NodeShape::Turn(90)) >= 2);
    }

    #[test]
    fn the_incremental_score_matches_a_full_recount() {
        let (maze, preset) = snake();
        let limits = NodeShapeLimits::new()
            .with(CELL, NodeShape::Straight, CountRange::exact(0))
            .with(
                CELL,
                NodeShape::DeadEnd,
                CountRange::new(None, Some(1)).unwrap(),
            )
            .with(
                CELL,
                NodeShape::Turn(90),
                CountRange::new(Some(5), None).unwrap(),
            );
        let by_shape = nodes_by_shape(&maze.graph, &maze.field);
        let mut search = Search::new(&maze, &limits, &by_shape, &preset);
        let all: Vec<NodeId> = maze.field.all_node_ids().collect();
        let passages: Vec<Passage> = all
            .iter()
            .flat_map(|&node| search.incident_passages(node))
            .filter(|p| p.a < p.b)
            .collect();
        assert!(passages.len() > 4, "the fixture offers flippable passages");
        let full_score = |graph: &Graph| -> u64 {
            let counts = nodes_by_shape(graph, &maze.field);
            limits
                .iter()
                .map(|(shape, _)| {
                    let count = counts.get(shape).map_or(0, Vec::len) as u32;
                    shortfall(&limits, shape, count) as u64
                })
                .sum()
        };
        assert_eq!(search.base_score, full_score(&maze.graph));
        for (i, &first) in passages.iter().enumerate() {
            for flips in std::iter::once(vec![first]).chain(
                passages[i + 1..]
                    .iter()
                    .filter(|p| ![p.a, p.b].contains(&first.a) && ![p.a, p.b].contains(&first.b))
                    .map(|&second| vec![first, second]),
            ) {
                let mut graph = maze.graph.clone();
                for &passage in &flips {
                    flip(&mut graph, passage);
                }
                assert_eq!(search.score_of(&flips), full_score(&graph), "{flips:?}");
            }
        }
    }

    #[test]
    fn recorded_moves_stay_sorted_unique_and_bounded() {
        let passage = |a, b| Passage {
            a,
            b,
            is_open: false,
        };
        let mut found = Vec::new();
        record(&mut found, 5, &[passage(1, 2)]);
        record(&mut found, 3, &[passage(3, 4), passage(5, 6)]);
        record(&mut found, 3, &[passage(7, 8)]);
        // The same move found from its other end, and again with the passages swapped.
        record(&mut found, 3, &[passage(4, 3), passage(6, 5)]);
        record(&mut found, 3, &[passage(5, 6), passage(3, 4)]);
        let ranks: Vec<(u64, usize)> = found.iter().map(|c| (c.score, c.flips.len())).collect();
        assert_eq!(ranks, vec![(3, 1), (3, 2), (5, 1)]);

        for node in 0..(2 * CANDIDATES_KEPT as NodeId) {
            record(&mut found, 1, &[passage(100 + node, 1000 + node)]);
        }
        assert_eq!(found.len(), CANDIDATES_KEPT);
        assert!(found.iter().all(|c| c.score == 1));
    }

    #[test]
    fn an_issue_without_limits_fails() {
        let (maze, _) = maze(2, 2, &[((0, 0), (1, 0))]);
        let limits = at_most(NodeShape::DeadEnd, 0);
        let mut issue = issue(&maze, &limits).expect("dead ends exceed the limit");
        issue.limits = NodeShapeLimits::new();
        let (result, commands) = NodeShapeRebalanceStrategy.apply(
            &issue,
            &maze,
            &mut MazeRng::seed_from_u64(1),
            &StrategyParams::new(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
    }

    #[test]
    fn a_multi_passage_move_is_one_atomic_command() {
        let (maze, preset) = snake();
        let issue = issue(&maze, &at_most(NodeShape::Straight, 1)).unwrap();
        let (result, commands) = NodeShapeRebalanceStrategy.apply(
            &issue,
            &maze,
            &mut MazeRng::seed_from_u64(3),
            &StrategyParams::new(),
            &preset,
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(
            matches!(commands.as_slice(), [MutationCommand::Atomic { commands }] if commands.len() > 1)
        );
    }
}
