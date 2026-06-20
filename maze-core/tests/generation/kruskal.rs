use maze_core::generation::generate_maze;
use maze_core::validation::is_connected;
use super::helpers::*;

#[test]
fn kruskal_visits_all_nodes() {
    let (mut graph, field, start) = build(5, 5);
    let node_count = graph.nodes().count();
    generate_maze(&mut graph, &field, 42, start, kruskal_config(), &empty_preset());
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn kruskal_is_connected() {
    for seed in [1, 42, 99, 1234, 9999] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, kruskal_config(), &empty_preset());
        assert!(is_connected(&graph, start), "seed={seed}: kruskal maze is not connected");
    }
}

#[test]
fn kruskal_edges_only_connect_field_neighbors() {
    for seed in [42, 1, 99] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, kruskal_config(), &empty_preset());
        for edge in graph.edges() {
            let neighbors = field.neighbors(edge.from);
            assert!(
                neighbors.contains(&edge.to),
                "seed={seed}: kruskal edge connects non-adjacent nodes: {} -> {}",
                edge.from, edge.to
            );
        }
    }
}

#[test]
fn kruskal_same_seed_same_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 42, start1, kruskal_config(), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, kruskal_config(), &empty_preset());
    assert_eq!(collect_edges(&g1), collect_edges(&g2));
}
