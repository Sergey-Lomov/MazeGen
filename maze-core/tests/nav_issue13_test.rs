use maze_core::graph::EdgeKind;
use maze_core::graph::Graph;
use maze_core::graph::nav::build_nav_graph;
use maze_core::ids::IdGenerator;

// Exact directed edges captured from browser DIAG after adding passage [-4,-5]↔[-4,-4]
// in post-edit on an 11×11 seed=42 maze (issue-13).
const ISSUE13_EDGES: &[(u64, u64)] = &[
    (0, 1),
    (0, 11),
    (1, 0),
    (1, 12),
    (2, 3),
    (2, 13),
    (3, 2),
    (3, 4),
    (4, 3),
    (4, 5),
    (4, 15),
    (5, 4),
    (5, 16),
    (6, 7),
    (6, 17),
    (7, 6),
    (7, 8),
    (8, 7),
    (8, 19),
    (9, 10),
    (9, 20),
    (10, 9),
    (10, 21),
    (11, 0),
    (11, 12),
    (11, 22),
    (12, 1),
    (12, 11),
    (12, 13),
    (13, 2),
    (13, 12),
    (13, 14),
    (14, 13),
    (15, 4),
    (15, 26),
    (16, 5),
    (16, 17),
    (17, 6),
    (17, 16),
    (18, 19),
    (19, 8),
    (19, 18),
    (20, 9),
    (20, 31),
    (21, 10),
    (21, 32),
    (22, 11),
    (22, 33),
    (23, 24),
    (24, 23),
    (24, 35),
    (25, 26),
    (25, 36),
    (26, 15),
    (26, 25),
    (27, 28),
    (28, 27),
    (28, 29),
    (29, 28),
    (29, 30),
    (30, 29),
    (30, 41),
    (31, 20),
    (31, 42),
    (32, 21),
    (32, 43),
    (33, 22),
    (33, 44),
    (34, 35),
    (34, 45),
    (35, 24),
    (35, 34),
    (36, 25),
    (36, 37),
    (37, 36),
    (37, 38),
    (38, 27),
    (38, 37),
    (38, 39),
    (39, 38),
    (39, 40),
    (40, 39),
    (41, 30),
    (41, 42),
    (41, 52),
    (42, 31),
    (42, 41),
    (43, 32),
    (43, 54),
    (44, 33),
    (45, 34),
    (45, 46),
    (45, 56),
    (46, 45),
    (46, 47),
    (47, 46),
    (47, 48),
    (47, 58),
    (48, 47),
    (48, 49),
    (48, 59),
    (49, 48),
    (50, 51),
    (50, 61),
    (51, 50),
    (51, 62),
    (52, 41),
    (53, 54),
    (53, 64),
    (54, 43),
    (54, 53),
    (55, 44),
    (55, 66),
    (56, 45),
    (56, 57),
    (57, 56),
    (57, 68),
    (58, 47),
    (58, 69),
    (59, 48),
    (59, 70),
    (60, 71),
    (61, 50),
    (61, 72),
    (62, 51),
    (62, 63),
    (63, 62),
    (63, 64),
    (64, 53),
    (64, 63),
    (65, 76),
    (66, 55),
    (66, 67),
    (67, 66),
    (67, 78),
    (68, 57),
    (69, 58),
    (69, 80),
    (70, 59),
    (70, 81),
    (71, 60),
    (71, 72),
    (72, 61),
    (72, 71),
    (73, 74),
    (73, 84),
    (74, 73),
    (74, 75),
    (74, 85),
    (75, 74),
    (75, 86),
    (76, 65),
    (76, 87),
    (77, 88),
    (78, 67),
    (78, 79),
    (79, 78),
    (79, 80),
    (80, 69),
    (80, 79),
    (81, 70),
    (81, 92),
    (82, 83),
    (83, 82),
    (83, 84),
    (84, 73),
    (84, 83),
    (84, 95),
    (85, 74),
    (85, 96),
    (86, 75),
    (86, 87),
    (87, 76),
    (87, 86),
    (88, 77),
    (88, 89),
    (88, 99),
    (89, 88),
    (89, 90),
    (90, 89),
    (90, 101),
    (91, 102),
    (92, 81),
    (92, 93),
    (93, 92),
    (93, 94),
    (94, 93),
    (94, 105),
    (95, 84),
    (96, 85),
    (96, 97),
    (97, 96),
    (97, 98),
    (98, 97),
    (98, 109),
    (99, 88),
    (99, 100),
    (99, 110),
    (100, 99),
    (100, 111),
    (101, 90),
    (101, 102),
    (102, 91),
    (102, 101),
    (102, 103),
    (103, 102),
    (103, 104),
    (104, 103),
    (105, 94),
    (105, 106),
    (106, 105),
    (106, 107),
    (107, 106),
    (107, 108),
    (108, 107),
    (108, 109),
    (109, 98),
    (109, 108),
    (109, 120),
    (110, 99),
    (111, 100),
    (111, 112),
    (112, 111),
    (112, 113),
    (113, 112),
    (113, 114),
    (114, 113),
    (114, 115),
    (115, 114),
    (115, 116),
    (116, 115),
    (116, 117),
    (117, 116),
    (117, 118),
    (118, 117),
    (118, 119),
    (119, 118),
    (119, 120),
    (120, 109),
    (120, 119),
];

fn graph_from_edges(node_count: u64, edges: &[(u64, u64)]) -> Graph {
    let mut g = Graph::new();
    let mut ids = IdGenerator::new();
    for _ in 0..=node_count {
        g.add_node(ids.next_id());
    }
    for &(from, to) in edges {
        g.build_initial_edge(from, to, EdgeKind::Basic);
    }
    g
}

// Regression: issue-13 — adding passage [-4,-5]↔[-4,-4] in post-edit on 11×11 seed=42
// caused extra nav nodes (corridor nodes promoted to junctions).
#[test]
fn issue13_post_edit_no_extra_nav_nodes() {
    let g = graph_from_edges(120, ISSUE13_EDGES);
    let nav = build_nav_graph(&g);

    // Nodes 0, 2, 9 are corridor nodes (exactly 2 symmetric bidirectional neighbors).
    // They must NOT appear as nav nodes.
    let nav_node_ids: std::collections::HashSet<u64> =
        nav.nodes.iter().map(|n| n.node_id).collect();
    for &corridor in &[0u64, 2, 9] {
        assert!(
            !nav_node_ids.contains(&corridor),
            "node {corridor} is a corridor node but was promoted to nav node"
        );
    }

    // All graph nodes must appear either as nav nodes or in nav edge paths
    let mut covered: std::collections::HashSet<u64> = nav_node_ids.clone();
    for e in nav.edges() {
        for &n in &e.path {
            covered.insert(n);
        }
    }
    assert_eq!(
        covered.len(),
        121,
        "all 121 nodes must be covered by nav graph"
    );
}

// Issue-13 regression: verify ALL corridor nodes are absorbed, not just the 3 known offenders.
// Any corridor node appearing as a nav node is a bug.
#[test]
fn issue13_no_corridor_nodes_as_nav_nodes() {
    let g = graph_from_edges(120, ISSUE13_EDGES);
    let nav = build_nav_graph(&g);

    // Every nav node must be a true junction (not a corridor node)
    for nav_node in &nav.nodes {
        let id = nav_node.node_id;
        let out: Vec<u64> = g.outgoing_neighbors(id).collect();
        let inc: Vec<u64> = g.incoming_neighbors(id).collect();
        let out_set: std::collections::HashSet<u64> = out.iter().copied().collect();
        let inc_set: std::collections::HashSet<u64> = inc.iter().copied().collect();
        let is_corridor = out.len() == 2 && inc.len() == 2 && out_set == inc_set;
        assert!(
            !is_corridor,
            "node {id} is a corridor but was promoted to nav node"
        );
    }
}
