use super::dead_end_core::dead_end_nodes;
use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::{FloorScope, InvalidDeadEndGroupIssue};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;
use std::collections::HashMap;

pub const MAX_DEAD_END_COUNT_DEFAULT: u32 = 20;
pub const MAX_DEAD_END_COUNT_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::WholeMaze;

/// Flags every dead end in each over-budget scope. The group retains all candidates and its
/// `to_remove` communicates the exact excess for UI/debug consumers.
pub struct MaxDeadEndCountCheck {
    pub instance_id: String,
    pub max_dead_end_count: u32,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, InvalidDeadEndGroupIssue> for MaxDeadEndCountCheck {
    fn check_type_id(&self) -> &'static str {
        "max_dead_end_count"
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
                let count = nodes.len() as u32;
                (count > self.max_dead_end_count)
                    .then(|| vec![(nodes, count - self.max_dead_end_count)])
                    .unwrap_or_default()
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
                    .filter_map(|(_, mut nodes)| {
                        nodes.sort_unstable();
                        let count = nodes.len() as u32;
                        (count > self.max_dead_end_count)
                            .then_some((nodes, count - self.max_dead_end_count))
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
                "max_dead_end_count",
                self.max_dead_end_count.to_string(),
            ),
        );
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

    fn two_floor_maze() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field = MultiLevelField::new(Arc::default(), std::iter::empty());
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
        Maze::new(field, graph)
    }

    #[test]
    fn scopes_count_independently_per_floor_or_across_the_whole_maze() {
        let maze = two_floor_maze();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        let mut issues = Vec::new();
        MaxDeadEndCountCheck {
            instance_id: "whole".into(),
            max_dead_end_count: 2,
            floor_scope: FloorScope::WholeMaze,
        }
        .repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups, vec![(vec![0, 1, 3, 4], 2)]);

        let mut issues = Vec::new();
        MaxDeadEndCountCheck {
            instance_id: "per-floor".into(),
            max_dead_end_count: 1,
            floor_scope: FloorScope::PerFloor,
        }
        .repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups, vec![(vec![0, 1], 1), (vec![3, 4], 1)]);
    }
}
