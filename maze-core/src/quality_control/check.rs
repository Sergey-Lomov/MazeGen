use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use super::issue::Issue;

pub trait Check<T: Tessellation> {
    /// Check **type** id — matches `maze-wasm`'s `CheckInstanceConfig.type_id` / `available_checks()`'s
    /// `CheckDescriptor.id` (e.g. `"min_loop_length"`). Distinct from `instance_id` (the per-instance
    /// composite routing key, e.g. `"rule_1:a"`) — used to aggregate per-check-type timing across
    /// instances, since two instances of the same type (GitHub issue #60) should report under one type.
    fn check_type_id(&self) -> &'static str;

    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, rng: &mut dyn RngCore);
}
