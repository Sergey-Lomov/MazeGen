use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::quality_control::InvalidTeleportIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;

/// Flags a teleport edge as invalid when a regular (`EdgeKind::Basic`) connection already exists
/// between the same pair of vertices in the same direction — see GitHub issue #74. Redundant: a
/// teleport that duplicates a passage the maze already has adds no new connectivity, only visual/
/// navigational noise.
///
/// `protect_route` (GitHub issue #78, default `true`): a teleport lying on the maze's current
/// start->finish route (`is_teleport_route_protected` — covers both directions of a two-way
/// teleport) is never included in `invalid`, regardless of whether it would otherwise qualify.
/// Route protection lives here, on the producing check, not on `RemoveTeleportStrategy` — the
/// strategy stays a pure "remove everything flagged" executor.
pub struct TeleportDuplicatesConnectionCheck {
    pub instance_id: String,
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, InvalidTeleportIssue> for TeleportDuplicatesConnectionCheck {
    fn check_type_id(&self) -> &'static str {
        "teleport_duplicates_connection"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidTeleportIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let invalid: Vec<_> = maze
            .graph
            .edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .filter(|teleport| {
                maze.graph.edges().any(|other| {
                    other.kind == EdgeKind::Basic
                        && other.from == teleport.from
                        && other.to == teleport.to
                })
            })
            .filter(|teleport| {
                !self.protect_route || !is_teleport_route_protected(maze, teleport.id)
            })
            .map(|e| e.id)
            .collect();

        if invalid.is_empty() {
            return;
        }
        issues.push(InvalidTeleportIssue::new_from_check(
            &self.instance_id,
            invalid,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "teleport_duplicates_connection";

    fn maze_with_teleport(add_duplicate_basic: bool) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        if add_duplicate_basic {
            g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        }
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_no_teleport() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = TeleportDuplicatesConnectionCheck {
            instance_id: TEST_ID.to_string(),
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_teleport_has_no_duplicate() {
        let maze = maze_with_teleport(false);
        let check = TeleportDuplicatesConnectionCheck {
            instance_id: TEST_ID.to_string(),
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_when_teleport_duplicates_basic_connection() {
        let maze = maze_with_teleport(true);
        let check = TeleportDuplicatesConnectionCheck {
            instance_id: TEST_ID.to_string(),
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let teleport_id = maze
            .graph
            .edges()
            .find(|e| e.kind == EdgeKind::Teleport)
            .unwrap()
            .id;
        assert_eq!(issues[0].invalid, vec![teleport_id]);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
    }

    #[test]
    fn fires_for_both_directions_of_a_two_way_teleport_duplicating_a_two_way_basic_passage() {
        // Two-way teleport (both directions) exactly duplicating a two-way Basic passage between
        // the same pair — each direction is its own Teleport edge and must be flagged
        // independently, since the check operates per-edge, not per-pair.
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Teleport);
        g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportDuplicatesConnectionCheck {
            instance_id: TEST_ID.to_string(),
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());

        assert_eq!(
            issues.len(),
            1,
            "both directions merge into one issue from a single check call"
        );
        let mut teleport_ids: Vec<_> = maze
            .graph
            .edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .map(|e| e.id)
            .collect();
        teleport_ids.sort_unstable();
        let mut flagged = issues[0].invalid.clone();
        flagged.sort_unstable();
        assert_eq!(
            flagged, teleport_ids,
            "both teleport directions must be flagged, not just one"
        );
    }

    #[test]
    fn protect_route_excludes_a_route_critical_duplicate_teleport() {
        // start=0, finish=2, and the teleport 0->2 is the maze's only start->finish route (the
        // duplicate Basic 0->2 alone wouldn't matter here -- what matters is that the teleport
        // itself sits on the route). With protect_route enabled it must not be flagged at all.
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);

        let check = TeleportDuplicatesConnectionCheck {
            instance_id: TEST_ID.to_string(),
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "route-critical teleport must not be flagged when protect_route is enabled"
        );
    }

    #[test]
    fn protect_route_disabled_flags_the_route_teleport_as_before() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);

        let check = TeleportDuplicatesConnectionCheck {
            instance_id: TEST_ID.to_string(),
            protect_route: false,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "protect_route disabled must flag the teleport exactly like before #78"
        );
    }

    #[test]
    fn does_not_flag_teleport_with_only_reverse_basic() {
        // A Basic edge in the opposite direction is not a duplicate — direction matters.
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportDuplicatesConnectionCheck {
            instance_id: TEST_ID.to_string(),
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }
}
