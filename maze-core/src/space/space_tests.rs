#[cfg(test)]
mod field_clone_tests {
    use super::super::*;
    use crate::space::{SquarePoint, SquareTessellation, square_rect};

    /// `Field<T>`'s manual `Clone` impl (GitHub issue #118, needed by `Maze::draft()`) must
    /// produce an independent copy of both internal maps — mutating one `Field`'s node/point
    /// state must never be reflected in a clone taken earlier.
    #[test]
    fn clone_is_independent_of_the_original() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> =
            Field::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let cloned = field.clone();

        assert_eq!(field.node_count(), cloned.node_count());
        let p = SquarePoint { x: 0, y: 0 };
        assert_eq!(field.node_at(p), cloned.node_at(p));

        // A `Field` itself has no mutation API besides construction, so independence is verified
        // by confirming both copies agree on every point/node pair up front — a shared (rather
        // than deep-cloned) HashMap would still pass this if aliasing were harmless, but combined
        // with the derive/manual-impl having no unsafe/Rc involved, structural equality here is
        // exactly what a correct deep clone (vs. an accidentally-empty one) needs to satisfy.
        for point in field.all_cells() {
            assert_eq!(field.node_at(point), cloned.node_at(point));
        }
    }
}

#[cfg(test)]
mod from_id_points_tests {
    use super::super::*;
    use crate::space::{SquarePoint, SquareTessellation};

    #[test]
    fn preserves_the_given_ids_instead_of_minting_new_ones() {
        let field: Field<SquareTessellation> = Field::from_id_cells(
            Arc::default(),
            [
                (10, SquarePoint { x: 0, y: 0 }),
                (20, SquarePoint { x: 1, y: 0 }),
            ],
        )
        .unwrap();

        assert_eq!(field.node_at(SquarePoint { x: 0, y: 0 }), Some(10));
        assert_eq!(field.node_at(SquarePoint { x: 1, y: 0 }), Some(20));
        assert_eq!(field.cell_of(10), Some(SquarePoint { x: 0, y: 0 }));
        assert_eq!(field.cell_of(20), Some(SquarePoint { x: 1, y: 0 }));
        assert_eq!(field.node_count(), 2);
    }

    /// A point's *first* entry in the given order becomes its original node (`nodes_at[0]`), each
    /// subsequent entry an extra slot in that order — mirrors `add_node_at`'s own "original first,
    /// then creation order" contract, which `apply_split_points`/`build_analytics_snapshot` in
    /// `maze-wasm` rely on.
    #[test]
    fn groups_entries_by_point_preserving_given_order_as_creation_order() {
        let p = SquarePoint { x: 0, y: 0 };
        let field: Field<SquareTessellation> =
            Field::from_id_cells(Arc::default(), [(5, p), (7, p), (9, p)]).unwrap();

        assert_eq!(field.nodes_at(p), &[5, 7, 9]);
    }

    #[test]
    fn empty_entries_yields_an_empty_field() {
        let field: Field<SquareTessellation> =
            Field::from_id_cells(Arc::default(), std::iter::empty()).unwrap();

        assert_eq!(field.node_count(), 0);
        assert_eq!(field.all_cells().count(), 0);
    }
}

#[cfg(test)]
mod remove_node_at_tests {
    use super::super::*;
    use crate::space::{SquarePoint, SquareTessellation, square_rect};

    #[test]
    fn removes_the_node_from_the_point_and_from_lookup() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> =
            Field::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let extra = field.add_node_at(p, &mut ids);

        field.remove_node_at(p, extra);

        assert!(!field.nodes_at(p).contains(&extra));
        assert_eq!(field.cell_of(extra), None);
    }

    #[test]
    fn removing_a_middle_slot_does_not_change_the_id_of_the_remaining_nodes() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> =
            Field::new(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let s1 = field.add_node_at(p, &mut ids);
        let s2 = field.add_node_at(p, &mut ids);
        let s3 = field.add_node_at(p, &mut ids);

        field.remove_node_at(p, s2);

        let remaining = field.nodes_at(p);
        assert!(remaining.contains(&s1));
        assert!(remaining.contains(&s3));
        assert!(!remaining.contains(&s2));
    }

    #[test]
    #[should_panic(expected = "cannot remove a cell's last remaining node")]
    fn panics_when_removing_a_points_last_remaining_node() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> =
            Field::new(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let original = field.node_at(p).unwrap();

        field.remove_node_at(p, original);
    }

    #[test]
    #[should_panic(expected = "node does not belong to cell")]
    fn panics_when_node_belongs_to_a_different_point() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> =
            Field::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let p0 = SquarePoint { x: 0, y: 0 };
        let p1 = SquarePoint { x: 1, y: 0 };
        let extra_at_p1 = field.add_node_at(p1, &mut ids);

        field.remove_node_at(p0, extra_at_p1);
    }
}

#[cfg(test)]
mod all_node_ids_tests {
    use super::super::*;
    use crate::space::{SquarePoint, SquareTessellation, square_rect};

    // GitHub issue #232: `all_cells().flat_map(|p| nodes_at(p))` repeats a split point's nodes
    // once per its own node count (N times via `all_cells()`, each re-expanded to N nodes via
    // `nodes_at`), yielding N² entries instead of N. `all_node_ids` must yield each node exactly
    // once regardless of how many nodes share a point.
    #[test]
    fn split_point_nodes_appear_exactly_once_each() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> =
            Field::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let extra1 = field.add_node_at(p, &mut ids);
        let extra2 = field.add_node_at(p, &mut ids);

        let all: Vec<NodeId> = field.all_node_ids().collect();

        assert_eq!(
            all.len(),
            4,
            "2 plain points + 2 extra split nodes = 4 total, not 2*3=6"
        );
        assert!(all.contains(&extra1));
        assert!(all.contains(&extra2));
        let mut sorted = all.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), all.len(), "no duplicate NodeIds");
    }

    #[test]
    fn matches_node_count() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> =
            Field::new(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        field.add_node_at(SquarePoint { x: 1, y: 0 }, &mut ids);

        assert_eq!(field.all_node_ids().count(), field.node_count());
    }
}

#[cfg(test)]
mod geometric_distance_tests {
    use super::super::*;
    use crate::space::{HexPoint, SquarePoint, TriPoint};

    #[test]
    fn square_adjacent_cells_are_one_tile_apart() {
        let d = geometric_distance(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
        );
        assert!((d - 1.0).abs() < 1e-9);
    }

    #[test]
    fn square_diagonal_neighbors_use_pythagorean_distance() {
        let d = geometric_distance(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 1 },
        );
        assert!((d - 2f64.sqrt()).abs() < 1e-9);
    }

    #[test]
    fn geometric_distance_is_symmetric() {
        let a = SquarePoint { x: 2, y: 5 };
        let b = SquarePoint { x: -3, y: 1 };
        let ab = geometric_distance(&SquareTessellation, a, b);
        let ba = geometric_distance(&SquareTessellation, b, a);
        assert!((ab - ba).abs() < 1e-9);
    }

    #[test]
    fn distance_to_self_is_zero() {
        let p = SquarePoint { x: 7, y: -3 };
        assert_eq!(geometric_distance(&SquareTessellation, p, p), 0.0);
    }

    #[test]
    fn hex_adjacent_cells_are_at_center_to_center_distance() {
        // (0,0) -E-> (1,0) is a direct neighbor (HexFace::E). An area-1 hexagon has side
        // s = sqrt(2 / (3·sqrt(3))); centers of adjacent cells are s·sqrt(3) = sqrt(2 / sqrt(3))
        // apart.
        let d = geometric_distance(
            &HexTessellation,
            HexPoint { q: 0, r: 0 },
            HexPoint { q: 1, r: 0 },
        );
        assert!(
            (d - (2.0 / 3f64.sqrt()).sqrt()).abs() < 1e-9,
            "distance was {d}"
        );
    }

    #[test]
    fn hex_all_six_neighbors_are_equidistant() {
        let center = HexPoint { q: 0, r: 0 };
        let neighbors = [
            HexPoint { q: 1, r: 0 },
            HexPoint { q: 1, r: -1 },
            HexPoint { q: 0, r: -1 },
            HexPoint { q: -1, r: 0 },
            HexPoint { q: -1, r: 1 },
            HexPoint { q: 0, r: 1 },
        ];
        let expected = (2.0 / 3f64.sqrt()).sqrt();
        for n in neighbors {
            let d = geometric_distance(&HexTessellation, center, n);
            assert!(
                (d - expected).abs() < 1e-9,
                "neighbor {n:?} at distance {d}, expected {expected}"
            );
        }
    }

    #[test]
    fn tri_adjacent_cells_via_left_right_face_are_at_center_to_center_distance() {
        // (0,0) pointing-up, (1,0) pointing-down (Left/Right neighbors share a vertical edge).
        // Centroids of two triangles sharing an edge are S / sqrt(3) apart; an area-1 triangle has
        // side S = 2 / 3^(1/4).
        let d = geometric_distance(
            &TriTessellation,
            TriPoint { col: 0, row: 0 },
            TriPoint { col: 1, row: 0 },
        );
        let expected = 2.0 / 3f64.sqrt().sqrt() / 3f64.sqrt();
        assert!(
            (d - expected).abs() < 1e-9,
            "distance was {d}, expected {expected}"
        );
    }

    #[test]
    fn tri_non_adjacent_cell_is_farther_than_adjacent() {
        let origin = TriPoint { col: 0, row: 0 };
        let adjacent = geometric_distance(&TriTessellation, origin, TriPoint { col: 1, row: 0 });
        let farther = geometric_distance(&TriTessellation, origin, TriPoint { col: 5, row: 5 });
        assert!(farther > adjacent);
    }
}

#[cfg(test)]
mod edge_position_tests {
    use super::super::*;
    use crate::space::{HexPoint, SquarePoint, TriPoint};

    /// A field over `cells` on `tessellation` (no folds).
    pub(super) fn field_over<T: Tessellation>(tessellation: T, cells: &[T::CellId]) -> Field<T> {
        let mut cells = cells.to_vec();
        cells.sort();
        cells.dedup();
        Field::new(Arc::new(tessellation), cells, &mut IdGenerator::new()).unwrap()
    }

    fn geometric_edge_distance<T: Tessellation>(
        tessellation: T,
        a_from: T::CellId,
        a_to: T::CellId,
        b_from: T::CellId,
        b_to: T::CellId,
    ) -> f64 {
        let field = field_over(tessellation, &[a_from, a_to, b_from, b_to]);
        floor_aware_xy_distance(
            0,
            edge_position(&field, a_from, a_to),
            0,
            edge_position(&field, b_from, b_to),
            false,
        )
    }

    #[test]
    fn square_edge_position_is_the_contact_point_of_the_shared_face() {
        let field = field_over(
            SquareTessellation,
            &[SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 }],
        );
        let pos = edge_position(
            &field,
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
        );
        assert_eq!(pos.point, Point::new(1.0, 0.5));
        assert_eq!(pos.scale, 1.0);
    }

    #[test]
    fn edge_position_is_symmetric_in_from_to() {
        let a = SquarePoint { x: 2, y: 3 };
        let b = SquarePoint { x: 5, y: 1 };
        let field = field_over(SquareTessellation, &[a, b]);
        let ab = edge_position(&field, a, b);
        let ba = edge_position(&field, b, a);
        assert_eq!(ab, ba);
    }

    #[test]
    fn geometric_edge_distance_between_two_edges_sharing_a_node_is_half_a_tile_apart_on_a_straight_line()
     {
        // 0->1 and 1->2, collinear on the x-axis: contact points are (1, 0.5) and (2, 0.5).
        let d = geometric_edge_distance(
            SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 2, y: 0 },
        );
        assert!((d - 1.0).abs() < 1e-9, "distance was {d}, expected 1.0");
    }

    #[test]
    fn geometric_edge_distance_between_disjoint_parallel_edges() {
        // 0->1 on row y=0, 0->1 on row y=1: contact points (1, 0.5) and (1, 1.5).
        let d = geometric_edge_distance(
            SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 0, y: 1 },
            SquarePoint { x: 1, y: 1 },
        );
        assert!((d - 1.0).abs() < 1e-9, "distance was {d}, expected 1.0");
    }

    #[test]
    fn geometric_edge_distance_to_self_is_zero() {
        let d = geometric_edge_distance(
            SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
        );
        assert_eq!(d, 0.0);
    }

    /// Hex and triangle neighbors are mirror images across their shared face, so its contact
    /// point is the midpoint of the two centers.
    fn assert_edge_position_is_the_centers_midpoint<T: Tessellation>(
        tessellation: T,
        a: T::CellId,
        b: T::CellId,
    ) {
        let field = field_over(tessellation, &[a, b]);
        let midpoint = (field.tessellation().center(a) + field.tessellation().center(b)) * 0.5;
        assert!(edge_position(&field, a, b).point.distance(midpoint) < 1e-9);
    }

    #[test]
    fn hex_and_tri_edge_position_is_the_midpoint_of_the_centers() {
        assert_edge_position_is_the_centers_midpoint(
            HexTessellation,
            HexPoint { q: 0, r: 0 },
            HexPoint { q: 1, r: 0 },
        );
        assert_edge_position_is_the_centers_midpoint(
            TriTessellation,
            TriPoint { col: 0, row: 0 },
            TriPoint { col: 1, row: 0 },
        );
    }

    #[test]
    fn distance_is_measured_in_cell_scale_units() {
        use crate::space::test_support::ScaledSquareTessellation;
        let tessellation = ScaledSquareTessellation { scale: 2.0 };
        let (a, b) = (SquarePoint { x: 0, y: 0 }, SquarePoint { x: 3, y: 4 });
        assert!((tessellation.cell_scale(a) - 2.0).abs() < 1e-12);
        assert!((geometric_distance(&tessellation, a, b) - 5.0).abs() < 1e-9);
    }

    #[test]
    fn geometric_edge_distance_between_two_hex_edges_sharing_a_node() {
        // Center (0,0)-E->(1,0) and (1,0)-E->(2,0): both edges' midpoints sit at their own
        // from/to average -- distance between the two midpoints must be half the node-to-node
        // hex distance (sqrt(3)), same "half a tile apart on a straight line" shape the square
        // test above verifies.
        let n0 = HexPoint { q: 0, r: 0 };
        let n1 = HexPoint { q: 1, r: 0 };
        let n2 = HexPoint { q: 2, r: 0 };
        let d = geometric_edge_distance(HexTessellation, n0, n1, n1, n2);
        let node_distance = geometric_distance(&HexTessellation, n0, n2);
        assert!(
            (d - node_distance / 2.0).abs() < 1e-9,
            "distance was {d}, expected {}",
            node_distance / 2.0
        );
    }

    #[test]
    fn geometric_edge_distance_between_two_tri_edges_sharing_a_node() {
        let n0 = TriPoint { col: 0, row: 0 };
        let n1 = TriPoint { col: 1, row: 0 };
        let n2 = TriPoint { col: 2, row: 0 };
        let d = geometric_edge_distance(TriTessellation, n0, n1, n1, n2);
        let node_distance = geometric_distance(&TriTessellation, n0, n2);
        assert!(
            (d - node_distance / 2.0).abs() < 1e-9,
            "distance was {d}, expected {}",
            node_distance / 2.0
        );
    }
}

#[cfg(test)]
mod floor_aware_distance_tests {
    use super::super::*;
    use crate::space::{HexPoint, SquarePoint, TriPoint};

    #[test]
    fn include_height_false_matches_geometric_distance_exactly() {
        let a = SquarePoint { x: 0, y: 0 };
        let b = SquarePoint { x: 3, y: 4 };
        let plain = geometric_distance(&SquareTessellation, a, b);
        let same_floor = floor_aware_distance(&SquareTessellation, 0, a, 0, b, false);
        let diff_floor = floor_aware_distance(&SquareTessellation, 0, a, 2, b, false);
        assert_eq!(same_floor, plain);
        assert_eq!(
            diff_floor, plain,
            "include_height=false must ignore the floor difference"
        );
    }

    #[test]
    fn include_height_true_folds_in_one_unit_per_floor_apart() {
        let p = SquarePoint { x: 0, y: 0 };
        // Same x-y point, one floor apart -> pure vertical distance of 1.0.
        let d = floor_aware_distance(&SquareTessellation, 0, p, 1, p, true);
        assert!((d - 1.0).abs() < 1e-9, "distance was {d}, expected 1.0");
    }

    #[test]
    fn include_height_true_combines_xy_and_floor_distance_pythagorean() {
        // x-y distance 1.0 (adjacent cells), one floor apart -> sqrt(1^2 + 1^2).
        let d = floor_aware_distance(
            &SquareTessellation,
            0,
            SquarePoint { x: 0, y: 0 },
            1,
            SquarePoint { x: 1, y: 0 },
            true,
        );
        assert!(
            (d - 2f64.sqrt()).abs() < 1e-9,
            "distance was {d}, expected {}",
            2f64.sqrt()
        );
    }

    #[test]
    fn same_floor_and_point_is_zero_regardless_of_include_height() {
        let p = HexPoint { q: 2, r: -1 };
        assert_eq!(
            floor_aware_distance(&HexTessellation, 0, p, 0, p, false),
            0.0
        );
        assert_eq!(
            floor_aware_distance(&HexTessellation, 3, p, 3, p, true),
            0.0
        );
    }

    #[test]
    fn works_for_tri_tessellation_too() {
        let a = TriPoint { col: 0, row: 0 };
        let b = TriPoint { col: 1, row: 0 };
        let plain = geometric_distance(&TriTessellation, a, b);
        assert_eq!(
            floor_aware_distance(&TriTessellation, 0, a, 0, b, false),
            plain
        );
    }

    #[test]
    fn edge_positions_fold_in_one_unit_per_floor_apart() {
        let field = super::edge_position_tests::field_over(
            SquareTessellation,
            &[SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 }],
        );
        let position = edge_position(
            &field,
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
        );
        // Same edge position, one floor apart -> pure vertical distance of 1.0; ignored without
        // height.
        assert_eq!(floor_aware_xy_distance(0, position, 1, position, true), 1.0);
        assert_eq!(
            floor_aware_xy_distance(0, position, 5, position, false),
            0.0
        );
    }
}

#[cfg(test)]
mod coordinate_gap_tests {
    use super::super::*;
    use crate::space::SquarePoint;
    use crate::space::test_support::GappedSquareTessellation;

    #[test]
    fn field_neighbors_skip_faces_without_a_coordinate() {
        let origin = SquarePoint { x: 0, y: 0 };
        let north = SquarePoint { x: 0, y: 1 };
        let east = SquarePoint { x: 1, y: 0 };
        let mut ids = IdGenerator::new();
        let field: Field<GappedSquareTessellation> =
            Field::new(Arc::default(), [origin, north, east], &mut ids).unwrap();

        assert_eq!(
            GappedSquareTessellation.neighbor(origin, SquareFace::E),
            None
        );
        assert_eq!(
            GappedSquareTessellation.neighbor(origin, SquareFace::N),
            Some((north, SquareFace::S))
        );
        let neighbors = field.neighbors(field.node_at(origin).unwrap());
        assert_eq!(neighbors, vec![field.node_at(north).unwrap()]);
    }

    #[test]
    fn is_straight_is_false_through_a_missing_edge() {
        let west = SquarePoint { x: -1, y: 0 };
        let origin = SquarePoint { x: 0, y: 0 };
        let east = SquarePoint { x: 1, y: 0 };
        let mut ids = IdGenerator::new();
        let field: Field<GappedSquareTessellation> =
            Field::new(Arc::default(), [west, origin, east], &mut ids).unwrap();

        assert_eq!(
            GappedSquareTessellation.neighbor(origin, SquareFace::E),
            None
        );
        assert!(!field.is_straight(
            field.node_at(west).unwrap(),
            field.node_at(origin).unwrap(),
            field.node_at(east).unwrap(),
        ));
    }

    #[test]
    fn field_new_rejects_invalid_points_without_consuming_ids() {
        let mut ids = IdGenerator::new();
        let invalid = Field::<GappedSquareTessellation>::new(
            Arc::default(),
            [SquarePoint { x: 99, y: 0 }],
            &mut ids,
        );
        assert!(matches!(invalid, Err("field contains an invalid cell")));

        let valid = Field::<GappedSquareTessellation>::new(
            Arc::default(),
            [SquarePoint { x: 0, y: 0 }],
            &mut ids,
        )
        .unwrap();
        assert_eq!(valid.node_at(SquarePoint { x: 0, y: 0 }), Some(0));
    }

    #[test]
    fn from_id_points_rejects_invalid_points() {
        let result = Field::<GappedSquareTessellation>::from_id_cells(
            Arc::default(),
            [(10, SquarePoint { x: 99, y: 0 })],
        );

        assert!(matches!(result, Err("field contains an invalid cell")));
    }
}

/// GitHub issue #756: the per-cell neighbor contract — `neighbor` is reciprocal for every
/// tessellation, and a cell's neighbors through distinct faces are pairwise distinct.
#[cfg(test)]
mod neighbor_contract_tests {
    use super::super::*;
    use crate::space::test_support::GappedSquareTessellation;

    fn assert_neighbor_contract<T: Tessellation>(
        tessellation: &T,
        cells: impl IntoIterator<Item = T::CellId>,
    ) {
        for cell in cells {
            assert!(tessellation.is_valid_cell(cell));
            let mut reached = Vec::new();
            for &face in tessellation.faces_of(cell) {
                let Some((other, other_face)) = tessellation.neighbor(cell, face) else {
                    continue;
                };
                assert!(
                    tessellation.faces_of(other).contains(&other_face),
                    "{cell:?}: back face is not a face of {other:?}"
                );
                assert!(
                    tessellation.neighbor(other, other_face) == Some((cell, face)),
                    "{cell:?}: neighbor through a face is not reciprocal (via {other:?})"
                );
                assert!(
                    !reached.contains(&other),
                    "{cell:?}: {other:?} reached twice"
                );
                reached.push(other);
            }
        }
    }

    fn grid(radius: i32) -> impl Iterator<Item = (i32, i32)> {
        (-radius..=radius).flat_map(move |a| (-radius..=radius).map(move |b| (a, b)))
    }

    #[test]
    fn neighbor_is_reciprocal_for_square() {
        assert_neighbor_contract(
            &SquareTessellation,
            grid(4).map(|(x, y)| SquarePoint { x, y }),
        );
    }

    #[test]
    fn neighbor_is_reciprocal_for_hex() {
        assert_neighbor_contract(&HexTessellation, grid(4).map(|(q, r)| HexPoint { q, r }));
    }

    #[test]
    fn neighbor_is_reciprocal_for_tri() {
        assert_neighbor_contract(
            &TriTessellation,
            grid(4).map(|(col, row)| TriPoint { col, row }),
        );
    }

    #[test]
    fn neighbor_is_reciprocal_for_cairo() {
        let cells: Vec<CairoPoint> = grid(16)
            .map(|(x, y)| CairoPoint::new(x, y))
            .filter(|&p| CairoTessellation::is_valid_cell(p))
            .collect();
        assert!(!cells.is_empty());
        assert_neighbor_contract(&CairoTessellation, cells);
    }

    #[test]
    fn neighbor_is_reciprocal_for_gapped_square() {
        assert_neighbor_contract(
            &GappedSquareTessellation,
            grid(3).map(|(x, y)| SquarePoint { x, y }),
        );
    }

    /// The geometric definition through `via`, resolving its faces toward `from` and `to`
    /// independently of `Field::is_straight`.
    fn geometric_straight<T: Tessellation>(
        tessellation: &T,
        from: T::CellId,
        via: T::CellId,
        to: T::CellId,
    ) -> bool {
        let face_toward = |other: T::CellId| {
            face_index_toward(tessellation, via, other).map(|i| tessellation.faces_of(via)[i])
        };
        match (face_toward(from), face_toward(to)) {
            (Some(a), Some(b)) => is_straight_geometric(tessellation, via, a, b),
            _ => false,
        }
    }

    /// `Field::is_straight` over every ordered pair of distinct neighbors of every `centers` cell
    /// agrees with the geometric definition. Returns how many passes are straight.
    fn assert_field_is_straight_is_geometric<T: Tessellation>(
        tessellation: T,
        cells: Vec<T::CellId>,
        centers: &[T::CellId],
    ) -> usize {
        let tessellation = Arc::new(tessellation);
        let mut ids = IdGenerator::new();
        let field = Field::new(Arc::clone(&tessellation), cells, &mut ids).unwrap();
        let mut straight_count = 0;
        for &center in centers {
            let via = field.node_at(center).unwrap();
            let neighbors = field.neighbors(via);
            for &from in &neighbors {
                for &to in &neighbors {
                    if from == to {
                        continue;
                    }
                    let expected = geometric_straight(
                        &*tessellation,
                        field.cell_of(from).unwrap(),
                        center,
                        field.cell_of(to).unwrap(),
                    );
                    assert_eq!(field.is_straight(from, via, to), expected);
                    straight_count += usize::from(expected);
                }
            }
        }
        straight_count
    }

    #[test]
    fn field_is_straight_matches_the_geometric_definition_for_every_tessellation() {
        let square: Vec<_> = grid(2).map(|(x, y)| SquarePoint { x, y }).collect();
        let hex: Vec<_> = grid(2).map(|(q, r)| HexPoint { q, r }).collect();
        let tri: Vec<_> = grid(2).map(|(col, row)| TriPoint { col, row }).collect();
        let cairo: Vec<_> = grid(16)
            .map(|(x, y)| CairoPoint::new(x, y))
            .filter(|&p| CairoTessellation::is_valid_cell(p))
            .collect();
        let cairo_centers: Vec<_> = grid(4)
            .map(|(x, y)| CairoPoint::new(x, y))
            .filter(|&p| CairoTessellation::is_valid_cell(p))
            .collect();
        let square_straight = assert_field_is_straight_is_geometric(
            SquareTessellation,
            square,
            &[SquarePoint { x: 0, y: 0 }],
        );
        assert_eq!(square_straight, 4);
        let hex_straight =
            assert_field_is_straight_is_geometric(HexTessellation, hex, &[HexPoint { q: 0, r: 0 }]);
        assert_eq!(hex_straight, 6);
        let tri_straight = assert_field_is_straight_is_geometric(
            TriTessellation,
            tri,
            &[TriPoint { col: 0, row: 0 }, TriPoint { col: 1, row: 0 }],
        );
        assert_eq!(tri_straight, 0, "every pass through a triangle turns");
        assert_field_is_straight_is_geometric(CairoTessellation, cairo, &cairo_centers);
    }

    #[test]
    fn field_is_straight_explicit_square_and_tri_cases() {
        let mut ids = IdGenerator::new();
        let square =
            Field::<SquareTessellation>::new(Arc::default(), square_rect(3, 3), &mut ids).unwrap();
        let s = |x, y| square.node_at(SquarePoint { x, y }).unwrap();
        assert!(square.is_straight(s(0, 1), s(1, 1), s(2, 1)));
        assert!(square.is_straight(s(1, 0), s(1, 1), s(1, 2)));
        assert!(!square.is_straight(s(0, 1), s(1, 1), s(1, 2)));
        // `from` is not a neighbor of `via`.
        assert!(!square.is_straight(s(0, 0), s(1, 1), s(2, 1)));
        // Unknown node.
        assert!(!square.is_straight(999, s(1, 1), s(2, 1)));

        let tri = Field::<TriTessellation>::new(Arc::default(), tri_rect(3, 2), &mut ids).unwrap();
        let t = |col, row| tri.node_at(TriPoint { col, row }).unwrap();
        // A Left/Right pass through a triangle turns by 60°.
        assert!(!tri.is_straight(t(0, 0), t(1, 0), t(2, 0)));
        assert!(!tri.is_straight(t(0, 0), t(1, 0), t(1, 1)));
    }

    #[test]
    fn neighbor_is_none_at_coordinate_overflow() {
        let max = i32::MAX;
        assert_eq!(
            SquareTessellation.neighbor(SquarePoint { x: max, y: 0 }, SquareFace::E),
            None
        );
        assert_eq!(
            HexTessellation.neighbor(HexPoint { q: max, r: 0 }, HexFace::NE),
            None
        );
        assert_eq!(
            TriTessellation.neighbor(TriPoint { col: max, row: 0 }, TriFace::Right),
            None
        );
    }
}
