use crate::quality_control::RepairArea;

/// A live, mutable working copy of a deficit issue's `missing: Vec<(RepairArea, u32)>` — shared by
/// every strategy that services a `min_*`/`split_count`/`split_density`-style deficit issue
/// (`MissingLoopsRandomStrategy`, `MissingLoopsSplitStrategy`, `AddOneWayFromWallBatchStrategy`,
/// `AddOneWayFromPassageBatchStrategy`, `AddTeleportBatchStrategy`, `AddSplitStrategy`).
///
/// **Why this exists** (GitHub issue #369 double-repair follow-up): a `FloorScope::PerFloor` check
/// and a `FloorScope::WholeMaze` check on the *same* rule both contribute entries to one issue's
/// `missing` (e.g. "3 per floor" + "12 whole-maze" on a 3-floor maze) — the whole-maze entry isn't
/// independent of the per-floor entries, it's the *same* underlying requirement measured a
/// different way, so satisfying a per-floor entry should count against the whole-maze entry too
/// (and vice versa isn't needed since `WholeMaze` is processed last here). Without this, a
/// strategy that just loops `issue.missing` and adds the full amount for every entry independently
/// massively over-delivers (21 instead of 12 in the example above).
///
/// `new` sorts every `Level` entry before the (at most one) `WholeMaze` entry, by `LevelId` — so a
/// strategy processes floors first and the whole-maze catch-all last, by which point every
/// per-floor need has already been satisfied and reflected in the live whole-maze count via
/// `consume`.
pub(super) struct RemainingDeficits {
    entries: Vec<(RepairArea, u32)>,
}

impl RemainingDeficits {
    pub(super) fn new(missing: &[(RepairArea, u32)]) -> Self {
        let mut entries: Vec<(RepairArea, u32)> = missing.to_vec();
        entries.sort_by_key(|&(area, _)| match area {
            RepairArea::Level(level) => (0u8, Some(level)),
            RepairArea::WholeMaze => (1u8, None),
        });
        Self { entries }
    }

    /// Areas in processing order (`Level`s first, by `LevelId`, then `WholeMaze`) — a strategy
    /// iterates this once; `live` gives the up-to-date remaining count for each as it goes.
    pub(super) fn areas(&self) -> impl Iterator<Item = RepairArea> + '_ {
        self.entries.iter().map(|&(area, _)| area)
    }

    /// Live remaining count for `area` — reflects every `consume` call made so far this call.
    pub(super) fn live(&self, area: RepairArea) -> u32 {
        self.entries.iter().find(|&&(a, _)| a == area).map_or(0, |&(_, m)| m)
    }

    /// One new entity was just added, covering `covered` (its own area plus `RepairArea::WholeMaze`
    /// — always both, since a `WholeMaze` entry represents the same requirement as every floor's
    /// own entry, not an independent one; a teleport additionally covers its exit floor if that
    /// differs from its entry floor). Every matching live entry drops by one (saturating).
    pub(super) fn consume(&mut self, covered: &[RepairArea]) {
        for (area, missing) in self.entries.iter_mut() {
            if covered.contains(area) {
                *missing = missing.saturating_sub(1);
            }
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use crate::IdGenerator;

    /// Three real, distinctly-ordered `LevelId`s to build test fixtures from.
    fn three_levels() -> (RepairArea, RepairArea, RepairArea) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([]);
        let a = mf.add_level(crate::space::Field::new(square_rect(1, 1), &mut ids).unwrap());
        let b = mf.add_level(crate::space::Field::new(square_rect(1, 1), &mut ids).unwrap());
        let c = mf.add_level(crate::space::Field::new(square_rect(1, 1), &mut ids).unwrap());
        (RepairArea::Level(a), RepairArea::Level(b), RepairArea::Level(c))
    }

    #[test]
    fn new_orders_levels_before_whole_maze_and_sorts_levels_by_id() {
        let (level_a, level_b, level_c) = three_levels();
        let missing = vec![(RepairArea::WholeMaze, 12), (level_c, 3), (level_a, 3)];
        let deficits = RemainingDeficits::new(&missing);
        let areas: Vec<_> = deficits.areas().collect();
        assert_eq!(areas, vec![level_a, level_c, RepairArea::WholeMaze]);
        let _ = level_b;
    }

    #[test]
    fn consume_decrements_every_covered_area_independently() {
        let (level_a, _, _) = three_levels();
        let missing = vec![(RepairArea::WholeMaze, 12), (level_a, 3)];
        let mut deficits = RemainingDeficits::new(&missing);
        deficits.consume(&[level_a, RepairArea::WholeMaze]);
        assert_eq!(deficits.live(level_a), 2);
        assert_eq!(deficits.live(RepairArea::WholeMaze), 11);
    }

    #[test]
    fn consume_does_not_affect_an_uncovered_area() {
        let (level_a, level_b, _) = three_levels();
        let missing = vec![(level_a, 3), (level_b, 5)];
        let mut deficits = RemainingDeficits::new(&missing);
        deficits.consume(&[level_a]);
        assert_eq!(deficits.live(level_a), 2);
        assert_eq!(deficits.live(level_b), 5);
    }

    #[test]
    fn consume_saturates_at_zero() {
        let (level_a, _, _) = three_levels();
        let missing = vec![(level_a, 0)];
        let mut deficits = RemainingDeficits::new(&missing);
        deficits.consume(&[level_a]);
        assert_eq!(deficits.live(level_a), 0);
    }

    #[test]
    fn live_is_zero_for_an_area_not_present_at_all() {
        let (level_a, _, _) = three_levels();
        let missing = vec![(level_a, 3)];
        let deficits = RemainingDeficits::new(&missing);
        assert_eq!(deficits.live(RepairArea::WholeMaze), 0);
    }
}
