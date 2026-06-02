use maze_core::IdGenerator;
use std::collections::HashSet;

#[test]
fn generated_ids_are_unique() {
    let mut id_gen = IdGenerator::new();
    let ids: Vec<_> = (0..100).map(|_| id_gen.next_id()).collect();
    let unique: HashSet<_> = ids.iter().collect();
    assert_eq!(ids.len(), unique.len());
}
