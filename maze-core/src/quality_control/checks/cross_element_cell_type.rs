use crate::Maze;
use crate::quality_control::InvalidCrossElementIssue;
use crate::quality_control::check::Check;
use crate::quality_control::cross_element::{CrossElementSet, cross_element_occurrences};
use crate::quality_control::issue_kinds::CrossElementCellViolation;
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashSet;

/// Prefix of the per-cell-type boolean params of the check: `forbid_cell_type_<key>` set to `true`
/// forbids the cell type with that key (GitHub issue #824).
pub const FORBID_CELL_TYPE_PARAM_PREFIX: &str = "forbid_cell_type_";

/// Flags every element of the selected kinds (`set`, the same element-group selection the
/// cross-element proximity checks use) that sits on a cell whose type is in `forbidden` — GitHub
/// issue #824. Cell types come from the tessellation (`Tessellation::cell_types`) and are named by
/// key; the browser config forbids each one through its own `forbid_cell_type_<key>` bool param. An element with several ends (teleport, vertical passage, elevator stops, split nodes) is
/// checked at every end: a match on any of them is a violation, reported per offending occurrence.
///
/// An empty `forbidden` list or an empty `set` is a silent no-op, and so is a tessellation with a
/// single cell type unless that type is forbidden. A key the tessellation does not have never
/// matches here; it is rejected as a config error when the run is set up (`maze-runner`'s
/// `validate_cell_type_params`).
pub struct CrossElementCellTypeCheck {
    pub instance_id: String,
    pub set: CrossElementSet,
    pub forbidden: Vec<String>,
}

impl<T: Tessellation> Check<T, InvalidCrossElementIssue> for CrossElementCellTypeCheck {
    fn check_type_id(&self) -> &'static str {
        "cross_element_cell_type"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidCrossElementIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        if self.forbidden.is_empty() || self.set.enabled_count() < 1 {
            return;
        }
        let forbidden: HashSet<&str> = self.forbidden.iter().map(String::as_str).collect();
        let tessellation = maze.field.tessellation();
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let violations: Vec<CrossElementCellViolation> =
            cross_element_occurrences(maze, &self.set, &nav)
                .into_iter()
                .filter_map(|occ| {
                    let cell_type = tessellation.cell_type_key_of(occ.point);
                    forbidden
                        .contains(cell_type)
                        .then_some(CrossElementCellViolation {
                            element: occ.element,
                            node: occ.node,
                            cell_type,
                        })
                })
                .collect();
        if violations.is_empty() {
            return;
        }
        issues.push(
            InvalidCrossElementIssue::new_from_check(&self.instance_id, violations).with_detail(
                &self.instance_id,
                "cell_types",
                self.forbidden.join(", "),
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::quality_control::cross_element::CrossElement;
    use crate::space::{
        MultiLevelField, SquareOctagonPoint, SquareOctagonTessellation, SquarePoint,
        SquareTessellation, square_rect,
    };
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "cross_element_cell_type";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn set_of(teleport: bool, start: bool, finish: bool) -> CrossElementSet {
        CrossElementSet {
            teleport,
            one_way: false,
            vertical_passage: false,
            elevator_stop: false,
            split: false,
            start,
            finish,
        }
    }

    fn check(set: CrossElementSet, forbidden: &[&str]) -> CrossElementCellTypeCheck {
        CrossElementCellTypeCheck {
            instance_id: TEST_ID.to_string(),
            set,
            forbidden: forbidden.iter().map(|k| k.to_string()).collect(),
        }
    }

    fn run<T: Tessellation>(
        maze: &Maze<T>,
        check: &CrossElementCellTypeCheck,
    ) -> Vec<InvalidCrossElementIssue> {
        let mut issues = Vec::new();
        check.repair_check(maze, &mut issues, &mut rng(), ());
        issues
    }

    /// Octagon cells (0,0) and (2,0), square cell (1,1). Teleport (0,0) <-> (1,1) has one end on
    /// each type; start sits on the octagon (2,0), finish on the square (1,1).
    fn octagon_maze() -> Maze<SquareOctagonTessellation> {
        let mut ids = IdGenerator::new();
        let cells = [(0, 0), (2, 0), (1, 1)].map(|(x, y)| SquareOctagonPoint { x, y });
        let mf = MultiLevelField::single_level(Arc::default(), cells, &mut ids).unwrap();
        let level = mf.single_level_id();
        let node = |x, y| mf.node_at(level, SquareOctagonPoint { x, y }).unwrap();
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        g.add_edge(node(0, 0), node(1, 1), EdgeKind::Teleport);
        g.add_edge(node(1, 1), node(0, 0), EdgeKind::Teleport);
        let (start, finish) = (node(2, 0), node(1, 1));
        let mut maze = Maze::new(mf, g);
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);
        maze
    }

    fn violation_cell_types(issue: &InvalidCrossElementIssue) -> Vec<&'static str> {
        let mut types: Vec<_> = issue.violations.iter().map(|v| v.cell_type).collect();
        types.sort_unstable();
        types
    }

    #[test]
    fn multi_end_element_is_flagged_when_any_end_is_on_a_forbidden_type() {
        let maze = octagon_maze();
        let issues = run(&maze, &check(set_of(true, false, false), &["square"]));
        assert_eq!(issues.len(), 1);
        // Only the square end of the teleport violates; the octagon end does not.
        assert_eq!(violation_cell_types(&issues[0]), vec!["square"]);
        assert!(matches!(
            issues[0].violations[0].element,
            CrossElement::Teleport(..)
        ));
    }

    #[test]
    fn every_end_is_reported_when_all_ends_are_forbidden() {
        let maze = octagon_maze();
        let issues = run(
            &maze,
            &check(set_of(true, false, false), &["square", "octagon"]),
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(violation_cell_types(&issues[0]), vec!["octagon", "square"]);
    }

    #[test]
    fn multiple_selected_kinds_are_checked_together() {
        let maze = octagon_maze();
        // Forbidden octagon: teleport end (0,0) and start (2,0) violate; finish is on a square.
        let issues = run(&maze, &check(set_of(true, true, true), &["octagon"]));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].violations.len(), 2);
        assert!(
            issues[0]
                .violations
                .iter()
                .all(|v| v.cell_type == "octagon")
        );
        assert!(
            issues[0]
                .violations
                .iter()
                .any(|v| matches!(v.element, CrossElement::Start(..)))
        );
    }

    #[test]
    fn unselected_kinds_are_ignored() {
        let maze = octagon_maze();
        // Octagons are forbidden and the teleport/start sit on them, but only finish (on a
        // square) is selected.
        let issues = run(&maze, &check(set_of(false, false, true), &["octagon"]));
        assert!(issues.is_empty());
    }

    #[test]
    fn element_on_an_allowed_type_passes() {
        let maze = octagon_maze();
        let issues = run(&maze, &check(set_of(true, true, true), &["hexagon"]));
        assert!(issues.is_empty());
    }

    #[test]
    fn empty_forbidden_list_never_fires() {
        let maze = octagon_maze();
        assert!(run(&maze, &check(set_of(true, true, true), &[])).is_empty());
    }

    #[test]
    fn empty_element_selection_never_fires() {
        let maze = octagon_maze();
        let issues = run(&maze, &check(set_of(false, false, false), &["octagon"]));
        assert!(issues.is_empty());
    }

    fn square_maze() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mf =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = mf.single_level_id();
        let start = mf.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut maze = Maze::new(mf.clone(), {
            let mut g = Graph::new();
            for n in mf.all_node_ids() {
                g.add_node(n);
            }
            g
        });
        maze.meta.start = Some(start);
        maze
    }

    #[test]
    fn single_type_tessellation_fires_only_when_its_type_is_forbidden() {
        let maze = square_maze();
        let set = set_of(false, true, false);
        let cell_key = maze.field.tessellation().cell_types()[0].key();

        let issues = run(&maze, &check(set, &[cell_key]));
        assert_eq!(issues.len(), 1);
        assert_eq!(violation_cell_types(&issues[0]), vec![cell_key]);

        assert!(run(&maze, &check(set, &["octagon"])).is_empty());
        assert!(run(&maze, &check(set, &[])).is_empty());
    }
}
