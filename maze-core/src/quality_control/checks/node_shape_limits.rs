use crate::Maze;
use crate::graph::node_shape::{
    NodeShape, NodeShapeLimits, TypedShape, nodes_by_shape, possible_node_shapes,
};
use crate::ids::NodeId;
use crate::quality_control::check::Check;
use crate::quality_control::{
    LimitViolationKind, ShapeLimitViolation, ViolatedNodeShapeLimitsIssue,
};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::{BTreeMap, BTreeSet};

/// Flags the maze when the number of nodes of a shape falls outside its configured limit — see
/// GitHub issue #1008 and `Specs/node-shape-limits.md`. Counts over the whole maze. A limit on a
/// shape the field cannot produce is skipped: no connection change could ever satisfy it.
pub struct NodeShapeLimitsCheck {
    pub instance_id: String,
    pub limits: NodeShapeLimits,
}

impl<T: Tessellation> Check<T, ViolatedNodeShapeLimitsIssue> for NodeShapeLimitsCheck {
    fn check_type_id(&self) -> &'static str {
        "node_shape_limits"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<ViolatedNodeShapeLimitsIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        if self.limits.is_empty() {
            return;
        }
        let by_shape = nodes_by_shape(&maze.graph, &maze.field);
        let possible = possible_node_shapes(&maze.field);
        let violations = shape_violations(&self.limits, &by_shape, &possible);
        if violations.is_empty() {
            return;
        }
        // Detail values for the bubble: the violated `cell_type/shape` keys, and one
        // `cell_type/shape:excess|deficit:count:limit` entry per violation (the limit is the bound that was
        // crossed, derived from the count and the amount to move).
        let shapes = violations
            .iter()
            .map(|v| format!("{}/{}", v.shape.cell_type, v.shape.shape.key()))
            .collect::<Vec<_>>()
            .join(",");
        let entries = violations
            .iter()
            .map(|v| {
                let count = v.nodes.len() as u32;
                let shape = format!("{}/{}", v.shape.cell_type, v.shape.shape.key());
                match v.kind {
                    LimitViolationKind::Excess => {
                        format!("{shape}:excess:{count}:{}", count - v.amount)
                    }
                    LimitViolationKind::Deficit => {
                        format!("{shape}:deficit:{count}:{}", count + v.amount)
                    }
                }
            })
            .collect::<Vec<_>>()
            .join(";");
        issues.push(
            ViolatedNodeShapeLimitsIssue::new_from_check(
                &self.instance_id,
                violations,
                self.limits.clone(),
            )
            .with_detail(&self.instance_id, "shapes", shapes)
            .with_detail(&self.instance_id, "violations", entries),
        );
    }
}

fn shape_violations(
    limits: &NodeShapeLimits,
    by_shape: &BTreeMap<TypedShape, Vec<NodeId>>,
    possible: &BTreeSet<TypedShape>,
) -> Vec<ShapeLimitViolation> {
    let count_of = |shape: &TypedShape| by_shape.get(shape).map_or(0, |nodes| nodes.len() as u32);
    // Replacements stay within the violated shape's cell type: a node cannot change its cell.
    let ordered_counterparts = |shape: &TypedShape, accept: &dyn Fn(&TypedShape) -> bool| {
        let mut shapes: Vec<NodeShape> = possible
            .iter()
            .filter(|other| {
                other.cell_type == shape.cell_type && other.shape != shape.shape && accept(other)
            })
            .map(|other| other.shape)
            .collect();
        shapes.sort_by_key(|&other| (shape.shape.distance(other), other));
        shapes
    };
    let mut violations = Vec::new();
    for (shape, range) in limits.iter() {
        if !possible.contains(shape) {
            continue;
        }
        let count = count_of(shape);
        let nodes = by_shape.get(shape).cloned().unwrap_or_default();
        if let Some(max) = range.max().filter(|&max| count > max) {
            let counterparts = ordered_counterparts(shape, &|other| {
                limits
                    .get(other)
                    .max()
                    .is_none_or(|other_max| count_of(other) < other_max)
            });
            violations.push(ShapeLimitViolation {
                shape: shape.clone(),
                kind: LimitViolationKind::Excess,
                amount: count - max,
                nodes,
                counterparts,
            });
        } else if let Some(min) = range.min().filter(|&min| count < min) {
            let counterparts = ordered_counterparts(shape, &|other| {
                count_of(other) > limits.get(other).min().unwrap_or(0)
            });
            violations.push(ShapeLimitViolation {
                shape: shape.clone(),
                kind: LimitViolationKind::Deficit,
                amount: min - count,
                nodes,
                counterparts,
            });
        }
    }
    violations
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::node_shape::{CountRange, JunctionLayout};
    use crate::graph::{EdgeKind, Graph};
    use crate::space::{
        HexPoint, HexTessellation, MultiLevelField, SquarePoint, SquareTessellation, hex_hexagon,
        square_rect,
    };
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "node_shape_limits";
    const CELL: &str = "regular:4";

    fn junction(sides: usize, faces: &[usize]) -> NodeShape {
        NodeShape::Junction(JunctionLayout::from_ranks(sides, faces))
    }

    /// The square's only three-way and four-way junction layouts.
    fn junction3() -> NodeShape {
        junction(4, &[0, 1, 2])
    }

    fn junction4() -> NodeShape {
        junction(4, &[0, 1, 2, 3])
    }
    const HEX_CELL: &str = "regular:6";

    fn run<T: Tessellation>(
        maze: &Maze<T>,
        limits: NodeShapeLimits,
    ) -> Vec<ViolatedNodeShapeLimitsIssue> {
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        NodeShapeLimitsCheck {
            instance_id: TEST_ID.to_string(),
            limits,
        }
        .repair_check(maze, &mut issues, &mut rng, ());
        issues
    }

    /// A 3x3 square maze: a straight row (0,0)-(1,0)-(2,0) with a turn down at (2,0) to (2,1).
    /// Shapes: (1,0) straight, (2,0) turn 90, every other node (7) a dead end.
    fn square_maze() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 3), &mut ids).unwrap();
        let level = field.single_level_id();
        let at = |x, y| field.node_at(level, SquarePoint { x, y }).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        graph.add_bidirectional_edge(at(0, 0), at(1, 0), EdgeKind::Basic);
        graph.add_bidirectional_edge(at(1, 0), at(2, 0), EdgeKind::Basic);
        graph.add_bidirectional_edge(at(2, 0), at(2, 1), EdgeKind::Basic);
        Maze::new(field, graph)
    }

    #[test]
    fn silent_without_limits_or_within_limits() {
        let maze = square_maze();
        assert!(run(&maze, NodeShapeLimits::new()).is_empty());
        let within = NodeShapeLimits::new()
            .with(CELL, NodeShape::Straight, CountRange::exact(1))
            .with(
                CELL,
                NodeShape::Turn(90),
                CountRange::new(Some(1), Some(2)).unwrap(),
            );
        assert!(run(&maze, within).is_empty());
    }

    #[test]
    fn excess_lists_the_nodes_and_replacements_closest_first() {
        let maze = square_maze();
        let limits = NodeShapeLimits::new()
            .with(
                CELL,
                NodeShape::Straight,
                CountRange::new(None, Some(0)).unwrap(),
            )
            .with(
                CELL,
                NodeShape::Turn(90),
                CountRange::new(None, Some(1)).unwrap(),
            );
        let issues = run(&maze, limits);
        assert_eq!(issues.len(), 1);
        let violations = &issues[0].violations;
        assert_eq!(violations.len(), 1, "the turn limit of 1 is met");
        let straight = &violations[0];
        assert_eq!(straight.shape, TypedShape::new(CELL, NodeShape::Straight));
        assert_eq!(straight.kind, LimitViolationKind::Excess);
        assert_eq!(straight.amount, 1);
        assert_eq!(straight.nodes.len(), 1);
        assert_eq!(
            straight.counterparts,
            vec![NodeShape::DeadEnd, junction3(), junction4(),],
            "Turn(90) is full (1 of max 1); ties on distance fall back to the shape order"
        );
    }

    #[test]
    fn deficit_lists_shapes_with_a_surplus() {
        let maze = square_maze();
        let limits = NodeShapeLimits::new()
            .with(CELL, junction3(), CountRange::exact(2))
            .with(CELL, NodeShape::Straight, CountRange::exact(1));
        let issues = run(&maze, limits);
        let violations = &issues[0].violations;
        assert_eq!(violations.len(), 1);
        let junction = &violations[0];
        assert_eq!(junction.shape, TypedShape::new(CELL, junction3()));
        assert_eq!(junction.kind, LimitViolationKind::Deficit);
        assert_eq!(junction.amount, 2);
        assert!(junction.nodes.is_empty());
        assert_eq!(
            junction.counterparts,
            vec![NodeShape::Turn(90), NodeShape::DeadEnd],
            "Straight sits exactly at its min of 1 and cannot give a node; the four-way junction has none"
        );
    }

    #[test]
    fn a_limit_on_an_impossible_shape_is_skipped() {
        let maze = square_maze();
        let limits = NodeShapeLimits::new()
            .with(CELL, NodeShape::Turn(60), CountRange::exact(3))
            .with(CELL, junction(6, &[0, 1, 2]), CountRange::exact(1));
        assert!(run(&maze, limits).is_empty());
    }

    #[test]
    fn hex_sharp_and_soft_turns_are_limited_independently() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), hex_hexagon(2), &mut ids).unwrap();
        let level = field.single_level_id();
        let at = |q, r| field.node_at(level, HexPoint { q, r }).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        // The origin turns sharply (adjacent faces E and NE); its two neighbors are dead ends.
        graph.add_bidirectional_edge(at(0, 0), at(1, 0), EdgeKind::Basic);
        graph.add_bidirectional_edge(at(0, 0), at(1, -1), EdgeKind::Basic);
        let maze: Maze<HexTessellation> = Maze::new(field, graph);
        let limits = NodeShapeLimits::new()
            .with(
                HEX_CELL,
                NodeShape::Turn(60),
                CountRange::new(None, Some(0)).unwrap(),
            )
            .with(
                HEX_CELL,
                NodeShape::Turn(120),
                CountRange::new(None, Some(0)).unwrap(),
            );
        let issues = run(&maze, limits);
        let violations = &issues[0].violations;
        assert_eq!(violations.len(), 1, "only the sharp turn exists");
        assert_eq!(
            violations[0].shape,
            TypedShape::new(HEX_CELL, NodeShape::Turn(60))
        );
        assert_eq!(
            violations[0].counterparts[0],
            NodeShape::Straight,
            "the closest remaining shape by angle; Turn(120) is itself capped at 0"
        );
        assert!(!violations[0].counterparts.contains(&NodeShape::Turn(120)));
    }
}
