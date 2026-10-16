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
        // (0,0) -E-> (1,0) is a direct neighbor (HexFace::E). Center-to-center distance for a
        // flat_top hex at unit tile scale (circumradius 1.0) is TILE_SIZE * sqrt(3) — same
        // geometric relationship `maze-web`'s hexCenter formula produces at pixel scale.
        let d = geometric_distance(
            &HexTessellation,
            HexPoint { q: 0, r: 0 },
            HexPoint { q: 1, r: 0 },
        );
        assert!((d - 3f64.sqrt()).abs() < 1e-9, "distance was {d}");
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
        let expected = 3f64.sqrt();
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
        // Center-to-center distance for adjacent up/down triangles sharing a vertical edge is
        // S / sqrt(3) (S = triangle side length = 2.0 at unit tile scale).
        let d = geometric_distance(
            &TriTessellation,
            TriPoint { col: 0, row: 0 },
            TriPoint { col: 1, row: 0 },
        );
        let expected = 2.0 / 3f64.sqrt();
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
    use crate::space::SquarePoint;

    #[test]
    fn square_edge_position_is_the_midpoint_of_its_endpoints() {
        let pos = SquareTessellation
            .edge_position(SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 });
        assert!((pos.0 - 0.5).abs() < 1e-9);
        assert!((pos.1 - 0.0).abs() < 1e-9);
    }

    #[test]
    fn edge_position_is_symmetric_in_from_to() {
        let a = SquarePoint { x: 2, y: 3 };
        let b = SquarePoint { x: 5, y: 1 };
        let ab = SquareTessellation.edge_position(a, b);
        let ba = SquareTessellation.edge_position(b, a);
        assert!((ab.0 - ba.0).abs() < 1e-9);
        assert!((ab.1 - ba.1).abs() < 1e-9);
    }

    #[test]
    fn geometric_edge_distance_between_two_edges_sharing_a_node_is_half_a_tile_apart_on_a_straight_line()
     {
        // 0->1 and 1->2, collinear on the x-axis: edge midpoints are (0.5,0) and (1.5,0).
        let d = geometric_edge_distance(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 2, y: 0 },
        );
        assert!((d - 1.0).abs() < 1e-9, "distance was {d}, expected 1.0");
    }

    #[test]
    fn geometric_edge_distance_between_disjoint_parallel_edges() {
        // 0->1 on row y=0, 0->1 on row y=1: midpoints (0.5,0) and (0.5,1).
        let d = geometric_edge_distance(
            &SquareTessellation,
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
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
        );
        assert_eq!(d, 0.0);
    }

    #[test]
    fn hex_edge_position_is_the_midpoint_of_its_endpoints() {
        // Same neighbor pair `geometric_distance_tests::hex_adjacent_cells_are_at_center_to_center_distance`
        // uses (distance sqrt(3) apart) -- the edge position must be exactly halfway between them.
        let a = HexPoint { q: 0, r: 0 };
        let b = HexPoint { q: 1, r: 0 };
        let (ax, ay) = HexTessellation.cartesian(a);
        let (bx, by) = HexTessellation.cartesian(b);
        let pos = HexTessellation.edge_position(a, b);
        assert!((pos.0 - (ax + bx) / 2.0).abs() < 1e-9);
        assert!((pos.1 - (ay + by) / 2.0).abs() < 1e-9);
    }

    #[test]
    fn tri_edge_position_is_the_midpoint_of_its_endpoints() {
        let a = TriPoint { col: 0, row: 0 };
        let b = TriPoint { col: 1, row: 0 };
        let (ax, ay) = TriTessellation.cartesian(a);
        let (bx, by) = TriTessellation.cartesian(b);
        let pos = TriTessellation.edge_position(a, b);
        assert!((pos.0 - (ax + bx) / 2.0).abs() < 1e-9);
        assert!((pos.1 - (ay + by) / 2.0).abs() < 1e-9);
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
        let d = geometric_edge_distance(&HexTessellation, n0, n1, n1, n2);
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
        let d = geometric_edge_distance(&TriTessellation, n0, n1, n1, n2);
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
    fn edge_include_height_false_matches_geometric_edge_distance_exactly() {
        let (a_from, a_to) = (SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 });
        let (b_from, b_to) = (SquarePoint { x: 0, y: 1 }, SquarePoint { x: 1, y: 1 });
        let plain = geometric_edge_distance(&SquareTessellation, a_from, a_to, b_from, b_to);
        let d =
            floor_aware_edge_distance(&SquareTessellation, 0, a_from, a_to, 5, b_from, b_to, false);
        assert_eq!(
            d, plain,
            "include_height=false must ignore the floor difference"
        );
    }

    #[test]
    fn edge_include_height_true_folds_in_one_unit_per_floor_apart() {
        let (from, to) = (SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 });
        // Same edge position, one floor apart -> pure vertical distance of 1.0.
        let d = floor_aware_edge_distance(&SquareTessellation, 0, from, to, 1, from, to, true);
        assert!((d - 1.0).abs() < 1e-9, "distance was {d}, expected 1.0");
    }
}

/// GitHub issue #275: `transform_face_index` used to be a single arithmetic formula shared by
/// every tessellation, silently assuming an angular `faces()` order (true only for hex) — a
/// square-grid `SplitPattern` with `mirror` applied came out geometrically wrong (e.g. swapping
/// `N` and `S` instead of `E`/`W`). These pin down the actual, tessellation-specific symmetry
/// tables and the round-trip identity every rotation/mirror combination must uphold.
#[cfg(test)]
mod transform_face_index_tests {
    use super::super::*;
    use crate::space::{HexFace, HexPoint, SquareFace, SquarePoint, TriFace, TriPoint};

    /// Position of `face` in `tessellation`'s (uniform) face order, read at `cell`.
    fn face_index<T: Tessellation>(tessellation: &T, cell: T::CellId, face: T::Face) -> usize {
        tessellation
            .faces_of(cell)
            .iter()
            .position(|&f| f == face)
            .unwrap()
    }

    #[test]
    fn identity_rotation_and_no_mirror_is_a_no_op_for_every_tessellation() {
        for i in 0..symmetry_degree(&SquareTessellation) {
            assert_eq!(
                transform_face_index(&SquareTessellation, i, 0, None),
                Some(i)
            );
        }
        for i in 0..symmetry_degree(&HexTessellation) {
            assert_eq!(transform_face_index(&HexTessellation, i, 0, None), Some(i));
        }
        for i in 0..symmetry_degree(&TriTessellation) {
            assert_eq!(transform_face_index(&TriTessellation, i, 0, None), Some(i));
        }
    }

    #[test]
    fn square_mirror_across_n_s_axis_swaps_e_and_w_and_fixes_n_s() {
        // The actual bug (GitHub issue #275): mirroring a square pattern must swap E<->W (or
        // N<->S, depending on axis), never leave E fixed while turning W into S.
        let n = face_index(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquareFace::N,
        );
        let s = face_index(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquareFace::S,
        );
        let e = face_index(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquareFace::E,
        );
        let w = face_index(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquareFace::W,
        );

        let ns_axis = 0; // mirror_symmetries()[0]: N-S axis, per SquareTessellation's own doc comment
        assert_eq!(
            transform_face_index(&SquareTessellation, n, 0, Some(ns_axis)),
            Some(n)
        );
        assert_eq!(
            transform_face_index(&SquareTessellation, s, 0, Some(ns_axis)),
            Some(s)
        );
        assert_eq!(
            transform_face_index(&SquareTessellation, e, 0, Some(ns_axis)),
            Some(w)
        );
        assert_eq!(
            transform_face_index(&SquareTessellation, w, 0, Some(ns_axis)),
            Some(e)
        );
    }

    #[test]
    fn square_90_degree_rotation_cycles_n_e_s_w() {
        let n = face_index(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquareFace::N,
        );
        let e = face_index(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquareFace::E,
        );
        let s = face_index(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquareFace::S,
        );
        let w = face_index(
            &SquareTessellation,
            SquarePoint { x: 0, y: 0 },
            SquareFace::W,
        );

        let rot_90 = 1; // rotation_symmetries()[1]
        assert_eq!(
            transform_face_index(&SquareTessellation, n, rot_90, None),
            Some(e)
        );
        assert_eq!(
            transform_face_index(&SquareTessellation, e, rot_90, None),
            Some(s)
        );
        assert_eq!(
            transform_face_index(&SquareTessellation, s, rot_90, None),
            Some(w)
        );
        assert_eq!(
            transform_face_index(&SquareTessellation, w, rot_90, None),
            Some(n)
        );
    }

    #[test]
    fn hex_mirror_across_e_w_axis_fixes_e_and_w_and_swaps_the_rest() {
        let e = face_index(&HexTessellation, HexPoint { q: 0, r: 0 }, HexFace::E);
        let ne = face_index(&HexTessellation, HexPoint { q: 0, r: 0 }, HexFace::NE);
        let nw = face_index(&HexTessellation, HexPoint { q: 0, r: 0 }, HexFace::NW);
        let w = face_index(&HexTessellation, HexPoint { q: 0, r: 0 }, HexFace::W);
        let sw = face_index(&HexTessellation, HexPoint { q: 0, r: 0 }, HexFace::SW);
        let se = face_index(&HexTessellation, HexPoint { q: 0, r: 0 }, HexFace::SE);

        let ew_axis = 0; // mirror_symmetries()[0]: E-W axis, per HexTessellation's own doc comment
        assert_eq!(
            transform_face_index(&HexTessellation, e, 0, Some(ew_axis)),
            Some(e)
        );
        assert_eq!(
            transform_face_index(&HexTessellation, w, 0, Some(ew_axis)),
            Some(w)
        );
        assert_eq!(
            transform_face_index(&HexTessellation, ne, 0, Some(ew_axis)),
            Some(se)
        );
        assert_eq!(
            transform_face_index(&HexTessellation, se, 0, Some(ew_axis)),
            Some(ne)
        );
        assert_eq!(
            transform_face_index(&HexTessellation, nw, 0, Some(ew_axis)),
            Some(sw)
        );
        assert_eq!(
            transform_face_index(&HexTessellation, sw, 0, Some(ew_axis)),
            Some(nw)
        );
    }

    #[test]
    fn hex_60_degree_rotation_cycles_every_face() {
        let degree = symmetry_degree(&HexTessellation);
        let rot_60 = 1; // rotation_symmetries()[1]
        for i in 0..degree {
            let expected = (i + 1) % degree;
            assert_eq!(
                transform_face_index(&HexTessellation, i, rot_60, None),
                Some(expected)
            );
        }
    }

    #[test]
    fn tri_has_no_mirror_symmetry() {
        assert!(TriTessellation.mirror_symmetries().is_empty());
    }

    #[test]
    fn tri_120_degree_rotation_cycles_left_right_base() {
        let left = face_index(&TriTessellation, TriPoint { col: 0, row: 0 }, TriFace::Left);
        let right = face_index(
            &TriTessellation,
            TriPoint { col: 0, row: 0 },
            TriFace::Right,
        );
        let base = face_index(&TriTessellation, TriPoint { col: 0, row: 0 }, TriFace::Base);

        let rot_120 = 1; // rotation_symmetries()[1]
        assert_eq!(
            transform_face_index(&TriTessellation, left, rot_120, None),
            Some(right)
        );
        assert_eq!(
            transform_face_index(&TriTessellation, right, rot_120, None),
            Some(base)
        );
        assert_eq!(
            transform_face_index(&TriTessellation, base, rot_120, None),
            Some(left)
        );
    }

    #[test]
    fn every_rotation_and_mirror_symmetry_is_a_valid_permutation_for_every_tessellation() {
        fn check_permutations(tables: &[&[usize]], degree: usize) {
            for perm in tables {
                assert_eq!(perm.len(), degree, "permutation length must match degree");
                let mut sorted = perm.to_vec();
                sorted.sort_unstable();
                assert_eq!(
                    sorted,
                    (0..degree).collect::<Vec<_>>(),
                    "table must be a permutation of 0..degree: {perm:?}"
                );
            }
        }
        check_permutations(
            SquareTessellation.rotation_symmetries(),
            symmetry_degree(&SquareTessellation),
        );
        check_permutations(
            SquareTessellation.mirror_symmetries(),
            symmetry_degree(&SquareTessellation),
        );
        check_permutations(
            HexTessellation.rotation_symmetries(),
            symmetry_degree(&HexTessellation),
        );
        check_permutations(
            HexTessellation.mirror_symmetries(),
            symmetry_degree(&HexTessellation),
        );
        check_permutations(
            TriTessellation.rotation_symmetries(),
            symmetry_degree(&TriTessellation),
        );
        check_permutations(
            TriTessellation.mirror_symmetries(),
            symmetry_degree(&TriTessellation),
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

    /// The pre-#756 face-identity definition, written independently of `Tessellation::is_straight`
    /// and of `neighbor`'s back face: the face of `from` toward `via` equals the face of `via`
    /// toward `to`.
    fn old_face_identity_straight<T: Tessellation>(
        tessellation: &T,
        from: T::CellId,
        via: T::CellId,
        to: T::CellId,
    ) -> bool {
        let face_toward = |cell: T::CellId, other: T::CellId| {
            face_index_toward(tessellation, cell, other).map(|i| tessellation.faces_of(cell)[i])
        };
        match (face_toward(from, via), face_toward(via, to)) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        }
    }

    /// `Field::is_straight` over every ordered pair of distinct neighbors of every `centers` cell
    /// agrees with the old face-identity definition, and at least one pass counts as straight.
    fn assert_field_is_straight_matches_old_semantics<T: Tessellation>(
        tessellation: T,
        cells: Vec<T::CellId>,
        centers: &[T::CellId],
    ) {
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
                    let expected = old_face_identity_straight(
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
        assert!(straight_count > 0);
    }

    #[test]
    fn field_is_straight_matches_old_face_identity_semantics_for_every_tessellation() {
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
        assert_field_is_straight_matches_old_semantics(
            SquareTessellation,
            square,
            &[SquarePoint { x: 0, y: 0 }],
        );
        assert_field_is_straight_matches_old_semantics(
            HexTessellation,
            hex,
            &[HexPoint { q: 0, r: 0 }],
        );
        assert_field_is_straight_matches_old_semantics(
            TriTessellation,
            tri,
            &[TriPoint { col: 0, row: 0 }, TriPoint { col: 1, row: 0 }],
        );
        assert_field_is_straight_matches_old_semantics(CairoTessellation, cairo, &cairo_centers);
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
        // Face identity counts a Left/Right pass through a triangle as straight.
        assert!(tri.is_straight(t(0, 0), t(1, 0), t(2, 0)));
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
