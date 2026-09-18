use crate::generation::PresetState;
use crate::graph::region_class::RegionClass;
use crate::graph::scc::{ComponentId, ConnectedComponents};
use crate::ids::NodeId;
use crate::repair::draft::DraftMaze;
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::{HashMap, HashSet};

use super::convert::convert_region;
use super::{GrowContext, MAX_GROW_ATTEMPTS};

pub(super) fn try_grow<T: Tessellation>(
    outer: &mut DraftMaze<T>,
    target: RegionClass,
    locality: f64,
    min_region_size: usize,
    excess_budget: &mut HashMap<RegionClass, i32>,
    ctx: &GrowContext,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let committed_nodes = ctx.committed_nodes;
    let preset_state = ctx.preset_state;
    let scc = outer.maze.analysis.scc(&outer.maze.graph);
    let region_classes =
        outer
            .maze
            .analysis
            .region_classes(&outer.maze.graph, &outer.maze.field, &outer.maze.meta);
    let route =
        outer
            .maze
            .analysis
            .route_info(&outer.maze.graph, &outer.maze.field, &outer.maze.meta);
    let critical: HashSet<NodeId> = route
        .as_ref()
        .map(|r| r.path.iter().copied().collect())
        .unwrap_or_default();

    // Seed candidates: any node not on the critical path and not already committed this
    // `apply()` call — including nodes whose current region is `Path`, per Specs/repair.md's
    // "Region Growth" section ("seed MAY belong to the Pass region if it is not part of the
    // critical path"). Unlike reuse (which converts a whole existing region and therefore
    // can't touch a Path region at all), growth only carves a small subset out from around a
    // single seed node and then severs it (`sever_from_parent`) — so the seed's parent region
    // class is irrelevant; only the seed node itself must be off the critical path. This
    // matters in practice: a tree-shaped maze (e.g. `recursive_backtracker` with a low/zero
    // `one_way_chance`) has no cycles at all, so its single SCC covers every node and is
    // classified entirely as `Path` — without this, `try_grow` would have zero seed
    // candidates and could never create a Trap/Alternative/Unreachable region from scratch.
    let mut seed_candidates: Vec<NodeId> = scc
        .components
        .iter()
        .flat_map(|members| members.iter().copied())
        .filter(|n| !critical.contains(n) && !committed_nodes.contains(n))
        .collect();
    seed_candidates.sort_unstable();

    if seed_candidates.is_empty() {
        return None;
    }

    // Prioritize seeds that already sit on the geometric border of the reachability side the
    // target class needs a bridge to/from — e.g. a seed deep inside a large Unreachable
    // region, far from any start-reachable/finish-reachable neighbor, can grow to
    // `min_region_size` and sever cleanly but then still fail `convert_region`'s
    // membership-check (no edge can be found to the right side from anywhere in the grown
    // subset). Picking border-adjacent seeds first means the eventual `members` subset is
    // far more likely to actually border the side it needs, within the small fixed
    // `MAX_GROW_ATTEMPTS` budget. Same tie-break-by-shuffle-then-stable-sort approach as
    // `try_reuse`, for the same determinism reason.
    //
    // `inbound_requires_geometry`/`outbound_requires_geometry` come from the caller (currently
    // always `true, true` — plain inbound/outbound edges need an actual field-adjacent bridge; a
    // future teleport-based bridging mechanism, with no geometric placement requirement, would
    // pass the corresponding flag(s) as `false`, disabling that side's contribution to the
    // border score entirely — every seed then ties at score 0 and the shuffle alone decides
    // order, same as `filter_by_border`'s `false` case in `try_reuse`).
    let reachable_from_start = outer
        .maze
        .analysis
        .reachable_from_start(&outer.maze.graph, &outer.maze.meta)
        .unwrap_or_default();
    let reachable_to_finish = outer
        .maze
        .analysis
        .reachable_to_finish(&outer.maze.graph, &outer.maze.meta)
        .unwrap_or_default();
    let needs_inbound = ctx.inbound_requires_geometry
        && matches!(target, RegionClass::Trap | RegionClass::Alternative);
    let needs_outbound =
        ctx.outbound_requires_geometry && matches!(target, RegionClass::Alternative);
    let border_score = |n: NodeId| -> usize {
        if !needs_inbound && !needs_outbound {
            return 0;
        }
        outer
            .maze
            .field
            .neighbors(n)
            .into_iter()
            .filter(|nb| {
                (needs_inbound && reachable_from_start.contains(nb))
                    || (needs_outbound && reachable_to_finish.contains(nb))
            })
            .count()
    };
    for i in (1..seed_candidates.len()).rev() {
        let j = rng.random_range(0..=i);
        seed_candidates.swap(i, j);
    }
    seed_candidates.sort_by_key(|&n| std::cmp::Reverse(border_score(n)));

    let take = (MAX_GROW_ATTEMPTS as usize).min(seed_candidates.len());
    for &seed in seed_candidates.iter().take(take) {
        let Some(seed_component) = scc.component_of(seed) else {
            continue;
        };

        // Each seed gets its own nested draft (DraftMaze wraps DraftMaze, Specs/repair.md) —
        // cross-region crossing (via `try_open_excess_neighbor`) adds bridging edges before
        // `convert_region` even runs; if this seed's attempt fails at any later step, those
        // additions must not leak into the next seed's attempt or into a later seed's eventual
        // success. `excess_budget` is deliberately NOT part of this nesting — it's an in-memory
        // accounting map, not graph state, and a failed attempt's crossings already happened
        // against real candidate components; per GitHub issue #59's "Region Balance Consistency"
        // rule the spend must be undone on rollback too, so a failed attempt restores its own
        // debited budget below.
        let mut inner = DraftMaze::new(outer.maze.draft());
        let budget_before = excess_budget.clone();

        if let Some(members) = grow_front(
            &mut inner,
            seed,
            seed_component,
            &scc,
            &region_classes,
            excess_budget,
            locality,
            min_region_size,
            &critical,
            ctx,
            rng,
        ) {
            // Sever members from the rest of their parent region(s) before conversion — part of
            // this growth attempt's budget, not a separate connect step. Internal connectivity
            // of `members` is guaranteed by construction (every node was added via a real
            // bidirectional graph edge to an already-included node), so no post-hoc bridging is
            // needed here — only the boundary to the outside world needs cutting.
            if sever_from_parent(&mut inner, &members, preset_state)
                && let Some(result) =
                    convert_region(&mut inner, &members, target, preset_state, rng)
            {
                outer.absorb(inner);
                return Some(result);
            }
        }

        // Failed attempt: `inner` is simply dropped — nothing was ever applied to `outer`.
        *excess_budget = budget_before;
    }
    None
}

/// Front-expansion from `seed`, growing strictly along existing graph edges — every node added
/// to `in_region` is connected to some already-included node by a real bidirectional edge, so
/// `in_region` is guaranteed to resolve to a single SCC by construction (no post-hoc bridging
/// pass needed, unlike the old geometry-based expansion). `locality` blends breadth-first
/// (uniform pick across the whole frontier, `0`) with depth-first (always continue from the most
/// recently added node, `1`) expansion — the same DFS/DIY-vs-BFS choice classic maze-generation
/// algorithms (recursive-backtracker vs Prim's) make, applied here to graph topology rather than
/// geometry. Stops at `min_region_size` or when expansion is exhausted; the latter is a failed
/// attempt (`None`).
///
/// `excess_budget` is the per-class spendable surplus from `IssueData::MissingRegions`'s `+N`
/// balance entries (Specs/repair.md's "Region Balance" data model) — when every candidate in
/// `seed`'s own allowed component set is exhausted before reaching `min_region_size`, growth may
/// cross the border into a *different* SCC component if that neighbor's current `RegionClass`
/// still has budget remaining. Unlike the old whole-component absorption, crossing here adds one
/// bidirectional bridge edge to a single node of the neighboring component and folds that node
/// alone into the frontier — the rest of that component then becomes reachable to front-expansion
/// exactly like any other candidate, one node at a time, through its own internal edges. The
/// crossed component's class is debited its *full* size from the budget up front (matching the
/// old accounting rule) even though growth may stop before consuming every one of its nodes —
/// once a class's budget entry is spent, no more crossings into that class are allowed regardless
/// of how many of its nodes actually ended up in `members`.
/// Crossing never touches `critical`/`ctx.committed_nodes`, same as same-component growth.
#[allow(clippy::too_many_arguments)]
pub(super) fn grow_front<T: Tessellation>(
    draft: &mut DraftMaze<T>,
    seed: NodeId,
    seed_component: ComponentId,
    scc: &ConnectedComponents,
    region_classes: &HashMap<ComponentId, RegionClass>,
    excess_budget: &mut HashMap<RegionClass, i32>,
    locality: f64,
    min_region_size: usize,
    critical: &HashSet<NodeId>,
    ctx: &GrowContext,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let committed_nodes = ctx.committed_nodes;
    let mut in_region: HashSet<NodeId> = HashSet::new();
    in_region.insert(seed);
    let mut frontier: Vec<NodeId> = vec![seed];
    let mut allowed_components: HashSet<ComponentId> = HashSet::from([seed_component]);

    while in_region.len() < min_region_size {
        if frontier.is_empty() {
            // Same-component front-expansion has nowhere left to go -- try crossing into a
            // bordering component with spare excess budget before giving up entirely.
            let Some(opened) = try_open_excess_neighbor(
                draft,
                &in_region,
                scc,
                region_classes,
                excess_budget,
                critical,
                &allowed_components,
                ctx,
                rng,
            ) else {
                return None;
            };
            allowed_components.insert(opened.component);
            if in_region.insert(opened.node) {
                frontier.push(opened.node);
            }
            continue;
        }
        let fi = if rng.random::<f64>() < locality {
            frontier.len() - 1
        } else {
            rng.random_range(0..frontier.len())
        };
        let src = frontier[fi];

        let mut candidates: Vec<NodeId> = draft
            .maze
            .graph
            .outgoing_neighbors(src)
            .filter(|n| draft.maze.graph.edge_between(*n, src).is_some())
            .filter(|n| {
                !in_region.contains(n) && !critical.contains(n) && !committed_nodes.contains(n)
            })
            .filter(|n| {
                scc.component_of(*n)
                    .is_some_and(|c| allowed_components.contains(&c))
            })
            .collect();
        candidates.sort_unstable();

        if candidates.is_empty() {
            // This node is exhausted -- drop it and keep going on the rest of the frontier.
            // Crossing into a different component is only attempted once the WHOLE frontier is
            // exhausted (see the `frontier.is_empty()` check at the top of the loop), not just
            // because the one node picked this iteration happened to have no candidates left.
            frontier.remove(fi);
            continue;
        }

        let next = candidates[rng.random_range(0..candidates.len())];
        in_region.insert(next);
        frontier.push(next);
    }

    Some(in_region)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct OpenedNeighbor {
    pub(super) node: NodeId,
    pub(super) component: ComponentId,
}

/// Looks for a geometric neighbor of `in_region` belonging to a component whose `RegionClass`
/// still has `excess_budget` remaining, bridges it in with a single bidirectional edge, debits
/// that component's full size from the budget, and returns the bridged node plus its
/// `ComponentId` so the caller can fold both into `in_region`/`allowed_components`. Candidates
/// are sorted by `(NodeId, NodeId)` for determinism — same rationale as every other candidate
/// list in this file (fixed-seed reproducibility). Returns `None` if no bordering candidate
/// qualifies (no excess class touches the border, every touching class's budget is already
/// spent, or every bridging attempt is preset-blocked).
#[allow(clippy::too_many_arguments)]
pub(super) fn try_open_excess_neighbor<T: Tessellation>(
    draft: &mut DraftMaze<T>,
    in_region: &HashSet<NodeId>,
    scc: &ConnectedComponents,
    region_classes: &HashMap<ComponentId, RegionClass>,
    excess_budget: &mut HashMap<RegionClass, i32>,
    critical: &HashSet<NodeId>,
    allowed_components: &HashSet<ComponentId>,
    ctx: &GrowContext,
    rng: &mut dyn RngCore,
) -> Option<OpenedNeighbor> {
    let committed_nodes = ctx.committed_nodes;
    let preset_state = ctx.preset_state;
    let mut bordering: Vec<(NodeId, NodeId, ComponentId)> = in_region
        .iter()
        .flat_map(|&m| {
            draft
                .maze
                .field
                .neighbors(m)
                .into_iter()
                .map(move |nb| (m, nb))
        })
        .filter(|(_, nb)| !critical.contains(nb) && !committed_nodes.contains(nb))
        .filter_map(|(m, nb)| scc.component_of(nb).map(|c| (m, nb, c)))
        .filter(|(_, _, c)| !allowed_components.contains(c))
        .collect();
    bordering.sort_unstable();
    bordering.dedup();

    for i in (1..bordering.len()).rev() {
        let j = rng.random_range(0..=i);
        bordering.swap(i, j);
    }

    for (member, neighbor, component) in bordering {
        let Some(&class) = region_classes.get(&component) else {
            continue;
        };
        let Some(&budget) = excess_budget.get(&class) else {
            continue;
        };
        if budget <= 0 {
            continue;
        }
        let forward_added = draft.maze.graph.edge_between(member, neighbor).is_some()
            || draft.try_add_directed_edge(member, neighbor, preset_state);
        let bidirectional_added = forward_added
            && (draft.maze.graph.edge_between(neighbor, member).is_some()
                || draft.try_add_directed_edge(neighbor, member, preset_state));
        if !bidirectional_added {
            if forward_added && draft.maze.graph.edge_between(neighbor, member).is_none() {
                let _ = draft.try_remove_edge(member, neighbor, &PresetState::empty());
            }
            continue;
        }

        let size = scc.components[component].len() as i32;
        let remaining = budget - size;
        if remaining > 0 {
            excess_budget.insert(class, remaining);
        } else {
            excess_budget.remove(&class);
        }
        return Some(OpenedNeighbor {
            node: neighbor,
            component,
        });
    }
    None
}

/// Removes every edge (either direction) between `members` and the rest of their original SCC
/// component, so `members` becomes its own isolated (`Unreachable`) component before entering
/// `convert_region`. Returns false if any required cut is blocked by `preset_state` — caller
/// treats that as a failed growth attempt for this seed.
pub(super) fn sever_from_parent<T: Tessellation>(
    draft: &mut DraftMaze<T>,
    members: &HashSet<NodeId>,
    preset_state: &PresetState,
) -> bool {
    let mut to_cut: Vec<(NodeId, NodeId)> = Vec::new();
    for &n in members {
        for neighbor in draft.maze.field.neighbors(n) {
            if members.contains(&neighbor) {
                continue;
            }
            if draft.maze.graph.edge_between(n, neighbor).is_some() {
                to_cut.push((n, neighbor));
            }
            if draft.maze.graph.edge_between(neighbor, n).is_some() {
                to_cut.push((neighbor, n));
            }
        }
    }
    to_cut.sort_unstable();
    to_cut.dedup();
    for (from, to) in to_cut {
        if draft.maze.graph.edge_between(from, to).is_some()
            && !draft.try_remove_edge(from, to, preset_state)
        {
            return false;
        }
    }
    true
}
