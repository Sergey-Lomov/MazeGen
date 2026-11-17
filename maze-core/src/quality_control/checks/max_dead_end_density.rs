use super::dead_end_core::dead_end_nodes;
use crate::Maze;
use crate::graph::cycles::density_per_100;
use crate::quality_control::check::Check;
use crate::quality_control::floor_group::floor_point_count;
use crate::quality_control::{FloorScope, InvalidDeadEndGroupIssue};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;
use std::collections::HashMap;

pub const MAX_DEAD_END_DENSITY_DEFAULT: f64 = 30.0;
pub const MAX_DEAD_END_DENSITY_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;

/// Flags every dead end in each scope whose dead ends per 100 field cells exceed the maximum.
pub struct MaxDeadEndDensityCheck {
    pub instance_id: String,
    pub max_dead_end_density: f64,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, InvalidDeadEndGroupIssue> for MaxDeadEndDensityCheck {
    fn check_type_id(&self) -> &'static str {
        "max_dead_end_density"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidDeadEndGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let nodes = dead_end_nodes(maze);
        let groups = match self.floor_scope {
            FloorScope::WholeMaze => {
                let cells = maze.field.cell_count();
                let excess = Self::excess(nodes.len(), cells, self.max_dead_end_density);
                if excess > 0 {
                    vec![(nodes, excess)]
                } else {
                    Vec::new()
                }
            }
            FloorScope::PerFloor => {
                let mut by_level: HashMap<LevelId, Vec<_>> = HashMap::new();
                for node in nodes {
                    if let Some(level) = maze.field.level_of(node) {
                        by_level.entry(level).or_default().push(node);
                    }
                }
                let mut groups: Vec<_> = by_level
                    .into_iter()
                    .filter_map(|(level, mut nodes)| {
                        nodes.sort_unstable();
                        let excess = Self::excess(
                            nodes.len(),
                            floor_point_count(&maze.field, level),
                            self.max_dead_end_density,
                        );
                        (excess > 0).then_some((nodes, excess))
                    })
                    .collect();
                groups.sort_by(|a, b| a.0.cmp(&b.0));
                groups
            }
        };
        if groups.is_empty() {
            return;
        }
        issues.push(
            InvalidDeadEndGroupIssue::new_from_check(&self.instance_id, groups).with_detail(
                &self.instance_id,
                "max_dead_end_density",
                self.max_dead_end_density.to_string(),
            ),
        );
    }
}

impl MaxDeadEndDensityCheck {
    fn excess(count: usize, cells: usize, max_density: f64) -> u32 {
        if cells == 0 || density_per_100(count, cells) <= max_density {
            return 0;
        }
        // A density warning must retain at least one excess candidate whenever the continuous
        // density comparison above fires. Rounding-to-nearest could otherwise round the allowed
        // count back up to `count` (for example, 4 dead ends in 13 cells at a 30% limit),
        // silently dropping the warning. The largest whole-node count within the limit is floor.
        let allowed_count = (max_density * cells as f64 / 100.0).floor() as usize;
        count.saturating_sub(allowed_count) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::sync::Arc;

    #[test]
    fn reports_exact_density_excess_and_highlights_all_detected_dead_ends() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(13, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let a = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
        let c = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        let d = field.node_at(level, SquarePoint { x: 3, y: 0 }).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        graph.add_bidirectional_edge(a, b, EdgeKind::Basic);
        graph.add_bidirectional_edge(c, d, EdgeKind::Basic);
        let maze = Maze::new(field, graph);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        MaxDeadEndDensityCheck {
            instance_id: "density".into(),
            max_dead_end_density: 30.0,
            floor_scope: FloorScope::WholeMaze,
        }
        .repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups, vec![(vec![a, b, c, d], 1)]);
    }

    #[test]
    fn scopes_density_independently_per_floor_or_across_the_whole_maze() {
        let mut ids = IdGenerator::new();
        let mut field =
            MultiLevelField::<SquareTessellation>::new(Arc::default(), std::iter::empty());
        let bottom =
            field.add_level(Field::new(Arc::default(), square_rect(3, 1), &mut ids).unwrap());
        let top = field.add_level(Field::new(Arc::default(), square_rect(3, 1), &mut ids).unwrap());
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        for level in [bottom, top] {
            let a = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
            let b = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
            graph.add_bidirectional_edge(a, b, EdgeKind::Basic);
        }
        let maze = Maze::new(field, graph);
        let mut rng = crate::random::MazeRng::seed_from_u64(0);

        let mut issues = Vec::new();
        MaxDeadEndDensityCheck {
            instance_id: "whole".into(),
            max_dead_end_density: 50.0,
            floor_scope: FloorScope::WholeMaze,
        }
        .repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues[0].groups, vec![(vec![0, 1, 3, 4], 1)]);

        let mut issues = Vec::new();
        MaxDeadEndDensityCheck {
            instance_id: "per-floor".into(),
            max_dead_end_density: 50.0,
            floor_scope: FloorScope::PerFloor,
        }
        .repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues[0].groups, vec![(vec![0, 1], 1), (vec![3, 4], 1)]);
    }
}
