use rand::RngCore;
use crate::Maze;
use crate::space::Field;
use crate::quality_control::Issue;
use super::result::RepairResult;

pub trait RepairStrategy<F: Field> {
    fn apply(&self, issue: &Issue, maze: &mut Maze<F>, rng: &mut dyn RngCore) -> RepairResult;
}
