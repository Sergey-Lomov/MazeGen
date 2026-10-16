use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use rand::{Rng, RngCore};

/// Which direction(s) `resolve_vertical_target` is allowed to pick, derived from the rule-level
/// `passage_type` — `RequireUp`/`RequireDown` are used when `passage_type` is `OneWayUp`/
/// `OneWayDown` (the strategy must add exactly that direction or skip the candidate entirely, never
/// silently substitute the other), `Either` otherwise (rolled via `direction_balance`).
pub enum DirectionConstraint {
    Either,
    RequireUp,
    RequireDown,
}

/// Resolves `src`'s `VerticalPassage` target: the node at `src`'s own point on an adjacent floor.
/// Mirrors `generation::vertex_based::resolve_vertical_passage_target`'s adjacency logic. Returns
/// `(from, to)` oriented low-floor-to-high-floor when going up (`src -> target`) and
/// high-floor-to-low-floor when going down (`src -> target` again, since `src` is the higher floor
/// in that case) — always `(higher, lower)` for a down edge and `(lower, higher)` for an up edge, so
/// callers building a one-way edge don't need to re-derive orientation. `None` if `src`'s level has
/// no floor in an allowed direction, or no node exists at the same point on that floor (different
/// shape/custom cells between floors).
///
/// Direction is picked per `constraint`: `Either` rolls `direction_balance` when both up and down
/// exist and the balance is a genuine 0..1 probability (a boundary floor then falls back to whichever
/// single direction is available); a balance pinned to exactly 0 or 1 is a hard choice instead, and
/// behaves like `RequireDown`/`RequireUp` -- no fallback to the other direction, `None` when the
/// chosen one is unavailable. `RequireUp`/`RequireDown` (from `passage_type`) only ever resolve that
/// one direction the same way, returning `None` when `src`'s floor has no neighbor that way.
pub fn resolve_vertical_target<T: Tessellation>(
    maze: &Maze<T>,
    src: NodeId,
    rng: &mut dyn RngCore,
    constraint: &DirectionConstraint,
    direction_balance: f64,
) -> Option<(NodeId, NodeId)> {
    let point = maze.field.cell_of(src)?;
    let src_level = maze.field.level_of(src)?;
    let levels: Vec<_> = maze.field.levels_ordered().collect();
    let idx = levels.iter().position(|&l| l == src_level)?;
    let up = levels.get(idx + 1).copied();
    let down = idx.checked_sub(1).and_then(|i| levels.get(i).copied());

    let direction_balance = direction_balance.clamp(0.0, 1.0);
    let upward = match constraint {
        DirectionConstraint::RequireUp => {
            up?;
            true
        }
        DirectionConstraint::RequireDown => {
            down?;
            false
        }
        // A balance pinned to exactly 0 or 1 is a hard direction choice, not a coin flip -- it must
        // not fall back to the other direction just because the chosen one is unavailable (that
        // fallback only makes sense for a genuine 0..1 probability, where "always" isn't promised).
        DirectionConstraint::Either if direction_balance <= 0.0 => {
            down?;
            false
        }
        DirectionConstraint::Either if direction_balance >= 1.0 => {
            up?;
            true
        }
        DirectionConstraint::Either => match (up, down) {
            (Some(_), Some(_)) => rng.random_bool(direction_balance),
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => return None,
        },
    };
    let target_level = if upward { up? } else { down? };
    let target = maze.field.node_at(target_level, point)?;
    Some((src, target))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::Graph;
    use crate::random::MazeRng;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::sync::Arc;

    fn three_level_maze(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field_a =
            crate::space::Field::new(Arc::default(), square_rect(side, side), &mut ids).unwrap();
        let field_b =
            crate::space::Field::new(Arc::default(), square_rect(side, side), &mut ids).unwrap();
        let field_c =
            crate::space::Field::new(Arc::default(), square_rect(side, side), &mut ids).unwrap();
        let mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), [field_a, field_b, field_c]);
        let g = Graph::new();
        Maze::new(mf, g)
    }

    fn two_level_maze(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field_a =
            crate::space::Field::new(Arc::default(), square_rect(side, side), &mut ids).unwrap();
        let field_b =
            crate::space::Field::new(Arc::default(), square_rect(side, side), &mut ids).unwrap();
        let mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), [field_a, field_b]);
        let g = Graph::new();
        Maze::new(mf, g)
    }

    #[test]
    fn require_up_resolves_the_next_floor_up() {
        let maze = three_level_maze(3);
        let bottom = maze.field.levels_ordered().next().unwrap();
        let middle = maze.field.levels_ordered().nth(1).unwrap();
        let src = maze
            .field
            .node_at(bottom, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut rng = MazeRng::seed_from_u64(1);
        let (from, to) =
            resolve_vertical_target(&maze, src, &mut rng, &DirectionConstraint::RequireUp, 0.5)
                .unwrap();
        assert_eq!(from, src);
        assert_eq!(maze.field.level_of(to), Some(middle));
    }

    #[test]
    fn require_up_returns_none_on_the_top_floor() {
        let maze = three_level_maze(3);
        let top = maze.field.levels_ordered().last().unwrap();
        let src = maze.field.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut rng = MazeRng::seed_from_u64(1);
        assert!(
            resolve_vertical_target(&maze, src, &mut rng, &DirectionConstraint::RequireUp, 0.5)
                .is_none()
        );
    }

    #[test]
    fn require_down_resolves_the_next_floor_down() {
        let maze = three_level_maze(3);
        let middle = maze.field.levels_ordered().nth(1).unwrap();
        let bottom = maze.field.levels_ordered().next().unwrap();
        let src = maze
            .field
            .node_at(middle, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut rng = MazeRng::seed_from_u64(1);
        let (from, to) =
            resolve_vertical_target(&maze, src, &mut rng, &DirectionConstraint::RequireDown, 0.5)
                .unwrap();
        assert_eq!(from, src);
        assert_eq!(maze.field.level_of(to), Some(bottom));
    }

    #[test]
    fn require_down_returns_none_on_the_bottom_floor() {
        let maze = three_level_maze(3);
        let bottom = maze.field.levels_ordered().next().unwrap();
        let src = maze
            .field
            .node_at(bottom, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut rng = MazeRng::seed_from_u64(1);
        assert!(
            resolve_vertical_target(&maze, src, &mut rng, &DirectionConstraint::RequireDown, 0.5)
                .is_none()
        );
    }

    #[test]
    fn either_pinned_to_zero_never_falls_back_to_the_only_available_up_direction() {
        // two_level_maze gives every node exactly one neighbor floor -- the bottom floor's only
        // neighbor is up, which a hard-pinned-to-down balance must not fall back to.
        let maze = two_level_maze(3);
        let bottom = maze.field.levels_ordered().next().unwrap();
        let src = maze
            .field
            .node_at(bottom, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut rng = MazeRng::seed_from_u64(1);
        assert!(
            resolve_vertical_target(&maze, src, &mut rng, &DirectionConstraint::Either, 0.0)
                .is_none()
        );
    }

    #[test]
    fn either_pinned_to_one_never_falls_back_to_the_only_available_down_direction() {
        let maze = two_level_maze(3);
        let top = maze.field.levels_ordered().last().unwrap();
        let src = maze.field.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut rng = MazeRng::seed_from_u64(1);
        assert!(
            resolve_vertical_target(&maze, src, &mut rng, &DirectionConstraint::Either, 1.0)
                .is_none()
        );
    }

    #[test]
    fn either_falls_back_to_the_only_available_direction_when_balance_is_not_pinned() {
        let maze = three_level_maze(3);
        let bottom = maze.field.levels_ordered().next().unwrap();
        let middle = maze.field.levels_ordered().nth(1).unwrap();
        let src = maze
            .field
            .node_at(bottom, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut rng = MazeRng::seed_from_u64(1);
        // direction_balance=0.0 is a hard pin (tested above); a genuine mid-range probability
        // must still fall back to the only available direction on a boundary floor.
        let (_, to) =
            resolve_vertical_target(&maze, src, &mut rng, &DirectionConstraint::Either, 0.3)
                .unwrap();
        assert_eq!(maze.field.level_of(to), Some(middle));
    }

    #[test]
    fn resolve_vertical_target_returns_none_on_a_single_level_field() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::<SquareTessellation>::single_level(
            Arc::default(),
            square_rect(3, 3),
            &mut ids,
        )
        .unwrap();
        let g = Graph::new();
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let src = maze
            .field
            .node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut rng = MazeRng::seed_from_u64(1);
        assert!(
            resolve_vertical_target(&maze, src, &mut rng, &DirectionConstraint::Either, 0.5)
                .is_none()
        );
    }
}
