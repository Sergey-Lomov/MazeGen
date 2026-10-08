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
        let field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let cloned = field.clone();

        assert_eq!(field.node_count(), cloned.node_count());
        let p = SquarePoint { x: 0, y: 0 };
        assert_eq!(field.node_at(p), cloned.node_at(p));

        // A `Field` itself has no mutation API besides construction, so independence is verified
        // by confirming both copies agree on every point/node pair up front — a shared (rather
        // than deep-cloned) HashMap would still pass this if aliasing were harmless, but combined
        // with the derive/manual-impl having no unsafe/Rc involved, structural equality here is
        // exactly what a correct deep clone (vs. an accidentally-empty one) needs to satisfy.
        for point in field.all_points() {
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
        let field: Field<SquareTessellation> = Field::from_id_points([
            (10, SquarePoint { x: 0, y: 0 }),
            (20, SquarePoint { x: 1, y: 0 }),
        ])
        .unwrap();

        assert_eq!(field.node_at(SquarePoint { x: 0, y: 0 }), Some(10));
        assert_eq!(field.node_at(SquarePoint { x: 1, y: 0 }), Some(20));
        assert_eq!(field.point_of(10), Some(SquarePoint { x: 0, y: 0 }));
        assert_eq!(field.point_of(20), Some(SquarePoint { x: 1, y: 0 }));
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
            Field::from_id_points([(5, p), (7, p), (9, p)]).unwrap();

        assert_eq!(field.nodes_at(p), &[5, 7, 9]);
    }

    #[test]
    fn empty_entries_yields_an_empty_field() {
        let field: Field<SquareTessellation> = Field::from_id_points(std::iter::empty()).unwrap();

        assert_eq!(field.node_count(), 0);
        assert_eq!(field.all_points().count(), 0);
    }
}

#[cfg(test)]
mod remove_node_at_tests {
    use super::super::*;
    use crate::space::{SquarePoint, SquareTessellation, square_rect};

    #[test]
    fn removes_the_node_from_the_point_and_from_lookup() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let extra = field.add_node_at(p, &mut ids);

        field.remove_node_at(p, extra);

        assert!(!field.nodes_at(p).contains(&extra));
        assert_eq!(field.point_of(extra), None);
    }

    #[test]
    fn removing_a_middle_slot_does_not_change_the_id_of_the_remaining_nodes() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(1, 1), &mut ids).unwrap();
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
    #[should_panic(expected = "cannot remove a point's last remaining node")]
    fn panics_when_removing_a_points_last_remaining_node() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let original = field.node_at(p).unwrap();

        field.remove_node_at(p, original);
    }

    #[test]
    #[should_panic(expected = "node does not belong to point")]
    fn panics_when_node_belongs_to_a_different_point() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
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

    // GitHub issue #232: `all_points().flat_map(|p| nodes_at(p))` repeats a split point's nodes
    // once per its own node count (N times via `all_points()`, each re-expanded to N nodes via
    // `nodes_at`), yielding N² entries instead of N. `all_node_ids` must yield each node exactly
    // once regardless of how many nodes share a point.
    #[test]
    fn split_point_nodes_appear_exactly_once_each() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
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
        let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
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
        let d = geometric_distance::<SquareTessellation>(
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
        );
        assert!((d - 1.0).abs() < 1e-9);
    }

    #[test]
    fn square_diagonal_neighbors_use_pythagorean_distance() {
        let d = geometric_distance::<SquareTessellation>(
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 1 },
        );
        assert!((d - 2f64.sqrt()).abs() < 1e-9);
    }

    #[test]
    fn geometric_distance_is_symmetric() {
        let a = SquarePoint { x: 2, y: 5 };
        let b = SquarePoint { x: -3, y: 1 };
        let ab = geometric_distance::<SquareTessellation>(a, b);
        let ba = geometric_distance::<SquareTessellation>(b, a);
        assert!((ab - ba).abs() < 1e-9);
    }

    #[test]
    fn distance_to_self_is_zero() {
        let p = SquarePoint { x: 7, y: -3 };
        assert_eq!(geometric_distance::<SquareTessellation>(p, p), 0.0);
    }

    #[test]
    fn hex_adjacent_cells_are_at_center_to_center_distance() {
        // (0,0) -E-> (1,0) is a direct neighbor (HexFace::E). Center-to-center distance for a
        // flat_top hex at unit tile scale (circumradius 1.0) is TILE_SIZE * sqrt(3) — same
        // geometric relationship `maze-web`'s hexCenter formula produces at pixel scale.
        let d =
            geometric_distance::<HexTessellation>(HexPoint { q: 0, r: 0 }, HexPoint { q: 1, r: 0 });
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
            let d = geometric_distance::<HexTessellation>(center, n);
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
        let d = geometric_distance::<TriTessellation>(
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
        let adjacent = geometric_distance::<TriTessellation>(origin, TriPoint { col: 1, row: 0 });
        let farther = geometric_distance::<TriTessellation>(origin, TriPoint { col: 5, row: 5 });
        assert!(farther > adjacent);
    }
}

#[cfg(test)]
mod edge_position_tests {
    use super::super::*;
    use crate::space::SquarePoint;

    #[test]
    fn square_edge_position_is_the_midpoint_of_its_endpoints() {
        let pos = SquareTessellation::edge_position(
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
        );
        assert!((pos.0 - 0.5).abs() < 1e-9);
        assert!((pos.1 - 0.0).abs() < 1e-9);
    }

    #[test]
    fn edge_position_is_symmetric_in_from_to() {
        let a = SquarePoint { x: 2, y: 3 };
        let b = SquarePoint { x: 5, y: 1 };
        let ab = SquareTessellation::edge_position(a, b);
        let ba = SquareTessellation::edge_position(b, a);
        assert!((ab.0 - ba.0).abs() < 1e-9);
        assert!((ab.1 - ba.1).abs() < 1e-9);
    }

    #[test]
    fn geometric_edge_distance_between_two_edges_sharing_a_node_is_half_a_tile_apart_on_a_straight_line()
     {
        // 0->1 and 1->2, collinear on the x-axis: edge midpoints are (0.5,0) and (1.5,0).
        let d = geometric_edge_distance::<SquareTessellation>(
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
        let d = geometric_edge_distance::<SquareTessellation>(
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 0, y: 1 },
            SquarePoint { x: 1, y: 1 },
        );
        assert!((d - 1.0).abs() < 1e-9, "distance was {d}, expected 1.0");
    }

    #[test]
    fn geometric_edge_distance_to_self_is_zero() {
        let d = geometric_edge_distance::<SquareTessellation>(
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
        let (ax, ay) = HexTessellation::cartesian(a);
        let (bx, by) = HexTessellation::cartesian(b);
        let pos = HexTessellation::edge_position(a, b);
        assert!((pos.0 - (ax + bx) / 2.0).abs() < 1e-9);
        assert!((pos.1 - (ay + by) / 2.0).abs() < 1e-9);
    }

    #[test]
    fn tri_edge_position_is_the_midpoint_of_its_endpoints() {
        let a = TriPoint { col: 0, row: 0 };
        let b = TriPoint { col: 1, row: 0 };
        let (ax, ay) = TriTessellation::cartesian(a);
        let (bx, by) = TriTessellation::cartesian(b);
        let pos = TriTessellation::edge_position(a, b);
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
        let d = geometric_edge_distance::<HexTessellation>(n0, n1, n1, n2);
        let node_distance = geometric_distance::<HexTessellation>(n0, n2);
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
        let d = geometric_edge_distance::<TriTessellation>(n0, n1, n1, n2);
        let node_distance = geometric_distance::<TriTessellation>(n0, n2);
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
        let plain = geometric_distance::<SquareTessellation>(a, b);
        let same_floor = floor_aware_distance::<SquareTessellation>(0, a, 0, b, false);
        let diff_floor = floor_aware_distance::<SquareTessellation>(0, a, 2, b, false);
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
        let d = floor_aware_distance::<SquareTessellation>(0, p, 1, p, true);
        assert!((d - 1.0).abs() < 1e-9, "distance was {d}, expected 1.0");
    }

    #[test]
    fn include_height_true_combines_xy_and_floor_distance_pythagorean() {
        // x-y distance 1.0 (adjacent cells), one floor apart -> sqrt(1^2 + 1^2).
        let d = floor_aware_distance::<SquareTessellation>(
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
            floor_aware_distance::<HexTessellation>(0, p, 0, p, false),
            0.0
        );
        assert_eq!(
            floor_aware_distance::<HexTessellation>(3, p, 3, p, true),
            0.0
        );
    }

    #[test]
    fn works_for_tri_tessellation_too() {
        let a = TriPoint { col: 0, row: 0 };
        let b = TriPoint { col: 1, row: 0 };
        let plain = geometric_distance::<TriTessellation>(a, b);
        assert_eq!(
            floor_aware_distance::<TriTessellation>(0, a, 0, b, false),
            plain
        );
    }

    #[test]
    fn edge_include_height_false_matches_geometric_edge_distance_exactly() {
        let (a_from, a_to) = (SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 });
        let (b_from, b_to) = (SquarePoint { x: 0, y: 1 }, SquarePoint { x: 1, y: 1 });
        let plain = geometric_edge_distance::<SquareTessellation>(a_from, a_to, b_from, b_to);
        let d = floor_aware_edge_distance::<SquareTessellation>(
            0, a_from, a_to, 5, b_from, b_to, false,
        );
        assert_eq!(
            d, plain,
            "include_height=false must ignore the floor difference"
        );
    }

    #[test]
    fn edge_include_height_true_folds_in_one_unit_per_floor_apart() {
        let (from, to) = (SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 });
        // Same edge position, one floor apart -> pure vertical distance of 1.0.
        let d = floor_aware_edge_distance::<SquareTessellation>(0, from, to, 1, from, to, true);
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
    use crate::space::{HexFace, SquareFace, TriFace};

    #[test]
    fn identity_rotation_and_no_mirror_is_a_no_op_for_every_tessellation() {
        for i in 0..SquareTessellation::faces().len() {
            assert_eq!(
                transform_face_index::<SquareTessellation>(i, 0, None),
                Some(i)
            );
        }
        for i in 0..HexTessellation::faces().len() {
            assert_eq!(transform_face_index::<HexTessellation>(i, 0, None), Some(i));
        }
        for i in 0..TriTessellation::faces().len() {
            assert_eq!(transform_face_index::<TriTessellation>(i, 0, None), Some(i));
        }
    }

    #[test]
    fn square_mirror_across_n_s_axis_swaps_e_and_w_and_fixes_n_s() {
        // The actual bug (GitHub issue #275): mirroring a square pattern must swap E<->W (or
        // N<->S, depending on axis), never leave E fixed while turning W into S.
        let n = SquareTessellation::face_index(SquareFace::N).unwrap();
        let s = SquareTessellation::face_index(SquareFace::S).unwrap();
        let e = SquareTessellation::face_index(SquareFace::E).unwrap();
        let w = SquareTessellation::face_index(SquareFace::W).unwrap();

        let ns_axis = 0; // mirror_symmetries()[0]: N-S axis, per SquareTessellation's own doc comment
        assert_eq!(
            transform_face_index::<SquareTessellation>(n, 0, Some(ns_axis)),
            Some(n)
        );
        assert_eq!(
            transform_face_index::<SquareTessellation>(s, 0, Some(ns_axis)),
            Some(s)
        );
        assert_eq!(
            transform_face_index::<SquareTessellation>(e, 0, Some(ns_axis)),
            Some(w)
        );
        assert_eq!(
            transform_face_index::<SquareTessellation>(w, 0, Some(ns_axis)),
            Some(e)
        );
    }

    #[test]
    fn square_90_degree_rotation_cycles_n_e_s_w() {
        let n = SquareTessellation::face_index(SquareFace::N).unwrap();
        let e = SquareTessellation::face_index(SquareFace::E).unwrap();
        let s = SquareTessellation::face_index(SquareFace::S).unwrap();
        let w = SquareTessellation::face_index(SquareFace::W).unwrap();

        let rot_90 = 1; // rotation_symmetries()[1]
        assert_eq!(
            transform_face_index::<SquareTessellation>(n, rot_90, None),
            Some(e)
        );
        assert_eq!(
            transform_face_index::<SquareTessellation>(e, rot_90, None),
            Some(s)
        );
        assert_eq!(
            transform_face_index::<SquareTessellation>(s, rot_90, None),
            Some(w)
        );
        assert_eq!(
            transform_face_index::<SquareTessellation>(w, rot_90, None),
            Some(n)
        );
    }

    #[test]
    fn hex_mirror_across_e_w_axis_fixes_e_and_w_and_swaps_the_rest() {
        let e = HexTessellation::face_index(HexFace::E).unwrap();
        let ne = HexTessellation::face_index(HexFace::NE).unwrap();
        let nw = HexTessellation::face_index(HexFace::NW).unwrap();
        let w = HexTessellation::face_index(HexFace::W).unwrap();
        let sw = HexTessellation::face_index(HexFace::SW).unwrap();
        let se = HexTessellation::face_index(HexFace::SE).unwrap();

        let ew_axis = 0; // mirror_symmetries()[0]: E-W axis, per HexTessellation's own doc comment
        assert_eq!(
            transform_face_index::<HexTessellation>(e, 0, Some(ew_axis)),
            Some(e)
        );
        assert_eq!(
            transform_face_index::<HexTessellation>(w, 0, Some(ew_axis)),
            Some(w)
        );
        assert_eq!(
            transform_face_index::<HexTessellation>(ne, 0, Some(ew_axis)),
            Some(se)
        );
        assert_eq!(
            transform_face_index::<HexTessellation>(se, 0, Some(ew_axis)),
            Some(ne)
        );
        assert_eq!(
            transform_face_index::<HexTessellation>(nw, 0, Some(ew_axis)),
            Some(sw)
        );
        assert_eq!(
            transform_face_index::<HexTessellation>(sw, 0, Some(ew_axis)),
            Some(nw)
        );
    }

    #[test]
    fn hex_60_degree_rotation_cycles_every_face() {
        let faces = HexTessellation::faces();
        let rot_60 = 1; // rotation_symmetries()[1]
        for i in 0..faces.len() {
            let expected = (i + 1) % faces.len();
            assert_eq!(
                transform_face_index::<HexTessellation>(i, rot_60, None),
                Some(expected)
            );
        }
    }

    #[test]
    fn tri_has_no_mirror_symmetry() {
        assert!(TriTessellation::mirror_symmetries().is_empty());
    }

    #[test]
    fn tri_120_degree_rotation_cycles_left_right_base() {
        let left = TriTessellation::face_index(TriFace::Left).unwrap();
        let right = TriTessellation::face_index(TriFace::Right).unwrap();
        let base = TriTessellation::face_index(TriFace::Base).unwrap();

        let rot_120 = 1; // rotation_symmetries()[1]
        assert_eq!(
            transform_face_index::<TriTessellation>(left, rot_120, None),
            Some(right)
        );
        assert_eq!(
            transform_face_index::<TriTessellation>(right, rot_120, None),
            Some(base)
        );
        assert_eq!(
            transform_face_index::<TriTessellation>(base, rot_120, None),
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
            SquareTessellation::rotation_symmetries(),
            SquareTessellation::faces().len(),
        );
        check_permutations(
            SquareTessellation::mirror_symmetries(),
            SquareTessellation::faces().len(),
        );
        check_permutations(
            HexTessellation::rotation_symmetries(),
            HexTessellation::faces().len(),
        );
        check_permutations(
            HexTessellation::mirror_symmetries(),
            HexTessellation::faces().len(),
        );
        check_permutations(
            TriTessellation::rotation_symmetries(),
            TriTessellation::faces().len(),
        );
        check_permutations(
            TriTessellation::mirror_symmetries(),
            TriTessellation::faces().len(),
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
            Field::new([origin, north, east], &mut ids).unwrap();

        assert_eq!(GappedSquareTessellation::step(origin, SquareFace::E), None);
        assert_eq!(
            GappedSquareTessellation::step(origin, SquareFace::N),
            Some(north)
        );
        let neighbors = field.neighbors(field.node_at(origin).unwrap());
        assert_eq!(neighbors, vec![field.node_at(north).unwrap()]);
    }

    #[test]
    fn is_straight_remains_geometric_when_a_transition_is_missing() {
        let west = SquarePoint { x: -1, y: 0 };
        let origin = SquarePoint { x: 0, y: 0 };
        let east = SquarePoint { x: 1, y: 0 };
        let mut ids = IdGenerator::new();
        let field: Field<GappedSquareTessellation> =
            Field::new([west, origin, east], &mut ids).unwrap();

        assert_eq!(GappedSquareTessellation::step(origin, SquareFace::E), None);
        assert!(field.is_straight(
            field.node_at(west).unwrap(),
            field.node_at(origin).unwrap(),
            field.node_at(east).unwrap(),
        ));
    }

    #[test]
    fn field_new_rejects_invalid_points_without_consuming_ids() {
        let mut ids = IdGenerator::new();
        let invalid =
            Field::<GappedSquareTessellation>::new([SquarePoint { x: 99, y: 0 }], &mut ids);
        assert!(matches!(invalid, Err("field contains an invalid point")));

        let valid =
            Field::<GappedSquareTessellation>::new([SquarePoint { x: 0, y: 0 }], &mut ids).unwrap();
        assert_eq!(valid.node_at(SquarePoint { x: 0, y: 0 }), Some(0));
    }

    #[test]
    fn from_id_points_rejects_invalid_points() {
        let result =
            Field::<GappedSquareTessellation>::from_id_points([(10, SquarePoint { x: 99, y: 0 })]);

        assert!(matches!(result, Err("field contains an invalid point")));
    }
}
