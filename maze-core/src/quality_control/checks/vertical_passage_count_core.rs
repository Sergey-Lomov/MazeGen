use crate::Maze;
use crate::graph::EdgeKind;
use crate::ids::{EdgeId, NodeId};
use crate::quality_control::VerticalPassageType;
use crate::space::Tessellation;
use std::collections::HashSet;

/// A single logical vertical passage between two adjacent-floor nodes — one or two
/// `EdgeKind::VerticalPassage` edges (one-way: one edge; two-way: both directions) collapsed into
/// one countable unit, fixing the double-count bug where a two-way passage used to count as two
/// (see GitHub issue #343's follow-up). `canonical_edge` is the edge reported to callers/groups —
/// the "up" edge (`low_to_high`) when the passage is two-way or one-way-up, otherwise the "down"
/// edge (`high_to_low`); either way exactly one `EdgeId` represents the whole passage, so a group
/// built from these never lists both directions of the same passage as separate candidates.
struct LogicalVerticalPassage {
    canonical_edge: EdgeId,
    low_to_high: Option<EdgeId>,
    high_to_low: Option<EdgeId>,
}

impl LogicalVerticalPassage {
    fn is_two_way(&self) -> bool {
        self.low_to_high.is_some() && self.high_to_low.is_some()
    }
}

/// Every logical vertical passage in the maze — see `LogicalVerticalPassage`'s doc comment. Built
/// by pairing up `EdgeKind::VerticalPassage` edges that connect the same two nodes in opposite
/// directions; an edge whose reverse doesn't exist becomes a one-way logical passage on its own.
fn logical_vertical_passages<T: Tessellation>(maze: &Maze<T>) -> Vec<LogicalVerticalPassage> {
    let mut seen: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut passages = Vec::new();

    for edge in maze
        .graph
        .edges()
        .filter(|e| e.kind == EdgeKind::VerticalPassage)
    {
        let (Some(from_idx), Some(to_idx)) = (
            maze.field.level_index_of(edge.from),
            maze.field.level_index_of(edge.to),
        ) else {
            continue;
        };
        let (low_node, high_node, ascending) = if from_idx < to_idx {
            (edge.from, edge.to, true)
        } else {
            (edge.to, edge.from, false)
        };
        let key = (low_node, high_node);
        if !seen.insert(key) {
            continue;
        }
        let low_to_high = maze.graph.edge_between(low_node, high_node);
        let high_to_low = maze.graph.edge_between(high_node, low_node);
        let canonical_edge = if ascending {
            low_to_high.unwrap_or(edge.id)
        } else {
            high_to_low.unwrap_or(edge.id)
        };
        passages.push(LogicalVerticalPassage {
            canonical_edge,
            low_to_high,
            high_to_low,
        });
    }

    passages
}

/// Whether a logical passage matches `passage_type`, independent of any floor-scoping — see
/// `VerticalPassageType`'s doc comment.
fn matches_type(passage: &LogicalVerticalPassage, passage_type: VerticalPassageType) -> bool {
    match passage_type {
        VerticalPassageType::Any => true,
        VerticalPassageType::TwoWay => passage.is_two_way(),
        VerticalPassageType::OneWay => !passage.is_two_way(),
        VerticalPassageType::OneWayDown => !passage.is_two_way() && passage.high_to_low.is_some(),
        VerticalPassageType::OneWayUp => !passage.is_two_way() && passage.low_to_high.is_some(),
    }
}

/// A logical passage's own concrete type — always exactly `TwoWay`, `OneWayDown`, or `OneWayUp`
/// (never `Any`/`OneWay`, which are filter categories spanning several concrete shapes). Used by
/// `same_type_only` proximity scans, which compare two passages' actual shapes against each other
/// rather than against a filter.
fn concrete_type(passage: &LogicalVerticalPassage) -> VerticalPassageType {
    if passage.is_two_way() {
        VerticalPassageType::TwoWay
    } else if passage.high_to_low.is_some() {
        VerticalPassageType::OneWayDown
    } else {
        VerticalPassageType::OneWayUp
    }
}

/// Logical vertical passages matching `passage_type`, maze-wide — see `VerticalPassageType`'s doc
/// comment.
pub fn logical_vertical_passages_matching<T: Tessellation>(
    maze: &Maze<T>,
    passage_type: VerticalPassageType,
) -> Vec<EdgeId> {
    logical_vertical_passages(maze)
        .into_iter()
        .filter(|p| matches_type(p, passage_type))
        .map(|p| p.canonical_edge)
        .collect()
}

/// One scan-worthy entry point into a logical vertical passage — see
/// `vertical_passage_proximity_candidates`'s doc comment.
pub struct VerticalPassageProximityCandidate {
    /// The passage's own canonical edge — used for grouping/highlighting the whole passage,
    /// regardless of which of its ends this particular candidate represents.
    pub canonical_edge: EdgeId,
    /// The node this candidate scans from — a two-way passage contributes one candidate per end
    /// (both are genuine entries); a one-way passage contributes its `from` end always, and its
    /// `to` end additionally when `count_incoming` is set.
    pub node: NodeId,
    /// The passage's own concrete type (`TwoWay`/`OneWayDown`/`OneWayUp`) — see `concrete_type`.
    pub passage_type: VerticalPassageType,
}

/// Scan-worthy entry points for the 2 proximity checks (geometric/graph), filtered by
/// `passage_type` and expanded per `count_incoming` — see GitHub issue #343's follow-up.
/// `passage_type` decides which logical passages participate at all (matched via `matches_type`,
/// same as the min/max count/ratio checks). `count_incoming`, when set, adds a one-way passage's
/// `to` end as a second candidate (its `from` end always participates); a two-way passage always
/// contributes both ends regardless of `count_incoming`, since both are genuine entries on their
/// own floor.
pub fn vertical_passage_proximity_candidates<T: Tessellation>(
    maze: &Maze<T>,
    passage_type: VerticalPassageType,
    count_incoming: bool,
) -> Vec<VerticalPassageProximityCandidate> {
    let mut candidates = Vec::new();
    for passage in logical_vertical_passages(maze)
        .into_iter()
        .filter(|p| matches_type(p, passage_type))
    {
        let ptype = concrete_type(&passage);
        // The edge whose own `from` sits on `low_level` (an ascending edge, if present) gives the
        // low-floor node; the edge whose own `from` sits on `high_level` (a descending edge, if
        // present) gives the high-floor node. At least one of the two exists by construction.
        let low_node = passage
            .low_to_high
            .and_then(|id| maze.graph.edge(id))
            .map(|e| e.from)
            .or_else(|| {
                passage
                    .high_to_low
                    .and_then(|id| maze.graph.edge(id))
                    .map(|e| e.to)
            });
        let high_node = passage
            .high_to_low
            .and_then(|id| maze.graph.edge(id))
            .map(|e| e.from)
            .or_else(|| {
                passage
                    .low_to_high
                    .and_then(|id| maze.graph.edge(id))
                    .map(|e| e.to)
            });
        let (Some(low_node), Some(high_node)) = (low_node, high_node) else {
            continue;
        };

        if passage.is_two_way() {
            // Both ends are genuine entries on their own floor, regardless of count_incoming.
            candidates.push(VerticalPassageProximityCandidate {
                canonical_edge: passage.canonical_edge,
                node: low_node,
                passage_type: ptype,
            });
            candidates.push(VerticalPassageProximityCandidate {
                canonical_edge: passage.canonical_edge,
                node: high_node,
                passage_type: ptype,
            });
            continue;
        }

        // One-way: `from` is low_node for an up passage, high_node for a down passage.
        let (from_node, to_node) = if passage.low_to_high.is_some() {
            (low_node, high_node)
        } else {
            (high_node, low_node)
        };
        candidates.push(VerticalPassageProximityCandidate {
            canonical_edge: passage.canonical_edge,
            node: from_node,
            passage_type: ptype,
        });
        if count_incoming {
            candidates.push(VerticalPassageProximityCandidate {
                canonical_edge: passage.canonical_edge,
                node: to_node,
                passage_type: ptype,
            });
        }
    }
    candidates
}

pub fn count_logical_vertical_passages<T: Tessellation>(
    maze: &Maze<T>,
    passage_type: VerticalPassageType,
) -> u32 {
    logical_vertical_passages_matching(maze, passage_type).len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use std::sync::Arc;

    fn two_floor_maze() -> (
        Maze<SquareTessellation>,
        crate::ids::NodeId,
        crate::ids::NodeId,
        crate::ids::NodeId,
    ) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let b1 = mf.node_at(bottom, SquarePoint { x: 1, y: 0 }).unwrap();
        (Maze::new(mf, g), b0, t0, b1)
    }

    #[test]
    fn any_counts_a_two_way_passage_as_one_not_two() {
        let (mut maze, b0, t0, _b1) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        assert_eq!(
            count_logical_vertical_passages(&maze, VerticalPassageType::Any),
            1,
            "a two-way passage must count as one logical passage, not two"
        );
    }

    #[test]
    fn any_counts_a_one_way_passage_as_one() {
        let (mut maze, b0, t0, _b1) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        assert_eq!(
            count_logical_vertical_passages(&maze, VerticalPassageType::Any),
            1
        );
    }

    #[test]
    fn two_way_excludes_a_one_way_passage() {
        let (mut maze, b0, t0, _b1) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        assert_eq!(
            count_logical_vertical_passages(&maze, VerticalPassageType::TwoWay),
            0
        );
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        assert_eq!(
            count_logical_vertical_passages(&maze, VerticalPassageType::TwoWay),
            1
        );
    }

    #[test]
    fn one_way_excludes_a_two_way_passage() {
        let (mut maze, b0, t0, _b1) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        assert_eq!(
            count_logical_vertical_passages(&maze, VerticalPassageType::OneWay),
            1
        );
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        assert_eq!(
            count_logical_vertical_passages(&maze, VerticalPassageType::OneWay),
            0
        );
    }

    #[test]
    fn one_way_up_and_down_split_by_actual_edge_direction() {
        let (mut maze, b0, t0, _b1) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        assert_eq!(
            count_logical_vertical_passages(&maze, VerticalPassageType::OneWayUp),
            1
        );
        assert_eq!(
            count_logical_vertical_passages(&maze, VerticalPassageType::OneWayDown),
            0
        );
    }

    #[test]
    fn canonical_edge_is_stable_and_unique_per_logical_passage() {
        let (mut maze, b0, t0, _b1) = two_floor_maze();
        let up = maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        let down = maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let matching = logical_vertical_passages_matching(&maze, VerticalPassageType::Any);
        assert_eq!(matching.len(), 1);
        assert!(
            matching[0] == up || matching[0] == down,
            "canonical edge must be one of the passage's own two directed edges"
        );
    }
}
