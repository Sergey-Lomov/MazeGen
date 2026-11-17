use super::dead_end_priority::apply_src_mode;
use super::remaining_deficits::RemainingDeficits;
use super::split_core::{
    RequiredConnection, pick_weighted_pattern, plan_pattern_split, plan_unconstrained_split,
};
use super::standard_add_params::{self, attempts_limit, reserve_target, src_mode};
use crate::Maze;
use crate::generation::{PresetState, SplitGenerationConfig};
use crate::graph::route_protection::is_node_on_route;
use crate::ids::NodeId;
use crate::quality_control::{MissingLoopsIssue, RepairArea};
use crate::repair::command::{MutationCommand, SplitNodeEdgeDirection};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::HashSet;

pub const PARAM_PROTECT_ROUTE: &str = "protect_route";

const PROTECT_ROUTE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_PROTECT_ROUTE,
    label: "Protect route",
    kind: StrategyParamKind::Bool { default: true },
};

static PARAMS: [StrategyParam; 4] = crate::add_strategy_params!(PROTECT_ROUTE_PARAM);

/// Handles `MISSING_LOOPS` — see GitHub issue #254, part of epic #246. Alternative to
/// `MissingLoopsRandomStrategy`'s plain new-edge seeding: instead of connecting a random
/// geometrically-adjacent pair directly, turns one side of the pair into a split tile, so the
/// bridge is carried by one of the tile's own nodes rather than being a bare new edge on an
/// otherwise-ordinary cell. As with `MissingLoopsRandomStrategy`, there is no attempt to verify the
/// new connection actually closes a cycle — it seeds a candidate bridge and expects a follow-up QC
/// pass to judge the result, same "seed and let QC re-check" contract.
///
/// Picks a random node (`src`) and a random geometric neighbor (`dst`) exactly like
/// `MissingLoopsRandomStrategy`, skipping a pair already connected (either direction) or already
/// attempted this call. `src` must additionally be split-eligible
/// (`generation::split_is_eligible` — not locked, not already multi-node) and, when
/// `protect_route` is enabled, not on the maze's current start->finish route
/// (`graph::route_protection::is_node_on_route`) — the same two gates `AddSplitStrategy` applies to
/// its own candidate points.
///
/// `src` is then replaced by a split tile (`MutationCommand::ReplacePointNodes`) built via the
/// shared `split_core` planner (see `Specs/repair.md`), always with `allow_lose`/`allow_add` both
/// forced `true` (unlike `AddSplitStrategy`, this strategy exposes no param for either choice) — it
/// freely rebuilds `src`'s other connections to fit the chosen pattern/rotation, dropping whichever
/// existing ones don't fit and adding whichever new ones do, rather than just dividing the
/// pre-existing connections between the new nodes as-is. On top of that, one hard constraint:
/// whichever new node ends up carrying the bridge to `dst` must have at least one more edge of its
/// own (a through-node, not a dead end) — drawn from `src`'s other connections if any land there,
/// otherwise a brand-new edge to any other free geometric neighbor of `src`. A candidate pair whose
/// split planning fails this way is simply abandoned in favor of a different pair — never retried
/// against the same `(src, dst)`.
///
/// Uses its own `SplitGenerationConfig` (pattern_mode/max_split_nodes/patterns), exactly like
/// `AddSplitStrategy` — independent of whichever check produced this issue.
///
/// `src_mode` (GitHub issue #254 follow-up, shared with `MissingLoopsRandomStrategy` via
/// `dead_end_priority`) — `dead_end_priority` orders the split-eligible/route-filtered candidate
/// pool so dead ends (nodes with exactly one distinct graph neighbor) are tried first, so a bridge
/// grows out from the maze's least-connected cells before an arbitrary one. Every other candidate
/// stays in the pool behind them (see GitHub issue #278's exhaustion-fallback audit — the original
/// version dropped them entirely, silently under-delivering once dead ends ran out), so exhausting
/// the dead ends falls through to the rest automatically. Default `random` reproduces the original
/// unconstrained-pool behavior exactly.
pub struct MissingLoopsSplitStrategy {
    pub config: SplitGenerationConfig,
}

impl<T: Tessellation> RepairStrategy<T, MissingLoopsIssue> for MissingLoopsSplitStrategy {
    fn strategy_id(&self) -> &'static str {
        "missing_loops_split"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
    }

    fn apply(
        &self,
        issue: &MissingLoopsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let protect_route = match params.get(PARAM_PROTECT_ROUTE) {
            Some(StrategyParamValue::Bool(v)) => *v,
            _ => true,
        };
        let max_attempts = attempts_limit(params) as u32;
        let src_mode = src_mode(params);

        let mut attempted_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
        let mut commands = Vec::new();
        let mut split_points: HashSet<NodeId> = HashSet::new();
        let mut total_added = 0u32;

        let mut deficits = RemainingDeficits::new(&issue.missing);
        let areas: Vec<RepairArea> = deficits.areas().collect();
        for area in areas {
            let missing = deficits.live(area);
            if missing == 0 {
                continue;
            }
            let target = reserve_target(params, missing);

            let eligible: Vec<NodeId> = maze
                .field
                .all_node_ids()
                .filter(|&node| {
                    crate::generation::split_is_eligible(&maze.field, preset_state, node)
                })
                .filter(|&node| !protect_route || !is_node_on_route(maze, node))
                .filter(|&node| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(node) == Some(level),
                })
                .collect();
            let mut pool = apply_src_mode(maze, eligible, src_mode, rng);

            let mut added = 0u32;
            let mut failed_attempts = 0u32;

            while added < target && failed_attempts < max_attempts && !pool.is_empty() {
                // Pop from the end, not a random index — `apply_src_mode` orders the pool so
                // dead-end candidates sit at this end when `dead_end_priority` is active (GitHub
                // issue #278's exhaustion-fallback fix); a random-index pick would destroy that
                // ordering. `src` always leaves the pool after this iteration regardless of outcome
                // (see the unconditional `swap_remove` below), so popping it up front changes nothing
                // about which candidates get tried, only the order.
                let src = pool
                    .pop()
                    .expect("pool.is_empty() already checked by the while condition");

                let mut neighbors = maze.field.neighbors(src);
                let mut planned = false;

                while !neighbors.is_empty() {
                    let n_pick = rng.random_range(0..neighbors.len());
                    let dst = neighbors.swap_remove(n_pick);

                    let already_connected = maze.graph.edge_between(src, dst).is_some()
                        || maze.graph.edge_between(dst, src).is_some()
                        || attempted_pairs.contains(&(src, dst));
                    // `dst` is a `SplitNodeEdge::target` in the command about to be proposed for
                    // `src` — resolved to this exact `NodeId` right now, not re-resolved at apply
                    // time. If `dst`'s own point already got a `ReplacePointNodes` command earlier in
                    // this same `apply()` call, that node no longer exists by the time commands are
                    // applied (`replace_point_nodes_feasible` requires `field.cell_of(edge.target)`
                    // to still resolve) — the whole command would be silently declined. Skip any `dst`
                    // whose point is already split-committed this call, rather than propose a command
                    // guaranteed to be rejected.
                    let dst_already_split = maze
                        .field
                        .level_of(dst)
                        .zip(maze.field.cell_of(dst))
                        .is_some_and(|(l, p)| {
                            maze.field
                                .nodes_at(l, p)
                                .iter()
                                .any(|n| split_points.contains(n))
                        });
                    if already_connected || dst_already_split {
                        continue;
                    }
                    attempted_pairs.insert((src, dst));

                    let required = RequiredConnection {
                        neighbor: dst,
                        direction: SplitNodeEdgeDirection::Passage,
                    };
                    if let Some(nodes) = self.plan_split(maze, src, &required, &split_points, rng) {
                        commands.push(MutationCommand::ReplacePointNodes { at: src, nodes });
                        split_points.insert(src);
                        added += 1;
                        deficits.consume(&[area, RepairArea::WholeMaze]);
                        planned = true;
                        break;
                    }
                }

                if !planned {
                    failed_attempts += 1;
                }
                // Either way `src` already left the pool via the `pop()` above — it's no longer
                // split-eligible once a successful command applies, and every one of its neighbors
                // was already tried this visit either way, mirroring `AddSplitStrategy`'s own
                // per-point once-only bookkeeping.
            }
            total_added += added;
        }

        if total_added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

impl MissingLoopsSplitStrategy {
    /// Always plans with `allow_lose`/`allow_add` both `true` — unlike `AddSplitStrategy`, this
    /// strategy has no params exposing either choice: the whole point of the bridge is a *new*
    /// connection to `dst` (so `allow_add: false` would make every candidate fail outright), and a
    /// bridge tile freely dropping whichever of `at`'s other existing connections don't fit the
    /// chosen pattern/rotation is exactly the redistribution behavior wanted here.
    fn plan_split<T: Tessellation>(
        &self,
        maze: &Maze<T>,
        at: NodeId,
        required: &RequiredConnection,
        excluded: &HashSet<NodeId>,
        rng: &mut dyn RngCore,
    ) -> Option<Vec<Vec<crate::repair::command::SplitNodeEdge>>> {
        if self.config.patterns.is_empty() {
            let node_count = self.config.max_split_nodes.max(2) as usize;
            plan_unconstrained_split(maze, at, node_count, Some(required), excluded, rng)
        } else {
            let pattern_idx = pick_weighted_pattern(&self.config.patterns, rng);
            plan_pattern_split(
                maze,
                at,
                &self.config.patterns[pattern_idx],
                Some(required),
                excluded,
                rng,
                true,
                true,
            )
        }
    }
}

crate::impl_erased_repair_strategy!(MissingLoopsSplitStrategy, MissingLoopsIssue);

#[cfg(test)]
#[path = "missing_loops_split_tests.rs"]
mod tests;
