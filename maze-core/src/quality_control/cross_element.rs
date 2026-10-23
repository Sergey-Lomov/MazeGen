//! Cross-element identity and occurrence model — see GitHub issue #376.
//!
//! The generic multi-type proximity checks (`CrossElementGeometricProximityCheck` /
//! `CrossElementGraphProximityCheck`) let a user pick a set of special maze element types
//! (teleports, one-ways, vertical passages, elevators, split tiles, start, finish) and flag any
//! two elements from that set placed closer than a threshold.
//!
//! Some of these elements are multi-location: a teleport has two ends, an elevator has N stops,
//! a vertical passage touches two floors. They cannot be reduced to a single `(point, level)`.
//! So identity and physical location are split:
//!
//! - [`CrossElement`] — the logical element. Stable canonical id, used for grouping, equality,
//!   the repair reverse-index, and re-resolving the entity from the maze.
//! - [`CrossElementOccurrence`] — one physical presence of an element (one endpoint / one
//!   floor-stop). An element contributes one or more occurrences; the proximity scan runs over
//!   occurrences and aggregates results back by logical element.

use std::collections::HashSet;

use crate::Maze;
use crate::graph::nav::NavNodeId;
use crate::graph::{EdgeKind, nav::NavGraph};
use crate::ids::{EdgeId, NodeId};
use crate::quality_control::SplitTileNodes;
use crate::quality_control::checks::elevator_core::elevator_groups;
use crate::quality_control::checks::one_way_core::one_way_edges_with_endpoints;
use crate::quality_control::checks::vertical_passage_count_core::vertical_passage_proximity_candidates;
use crate::quality_control::vertical_passage_type::VerticalPassageType;
use crate::space::{ScaledPoint, Tessellation, cell_position, edge_position};

/// Canonical unordered node pair identifying one teleport portal — `(min(a, b), max(a, b))`, so a
/// portal is the same id no matter which direction happens to iterate first in `Graph::edges`.
pub type TeleportId = (NodeId, NodeId);

/// A logical special maze element, with a stable canonical identity — see the module docs.
///
/// `Ord`/`Hash` are derived purely to give `canonical_group_key` / the repair reverse-index a
/// stable key. The variant order and the wrapped ids carry no business meaning.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CrossElement {
    Teleport(TeleportId),
    OneWay(EdgeId),
    /// The passage's canonical edge (see `LogicalVerticalPassage::canonical_edge`).
    VerticalPassage(EdgeId),
    /// One stop node of an elevator — not the whole elevator. The proximity checks flag an
    /// individual stop that sits too close to another element, and the repair removes just that
    /// stop from its elevator's fan (`RemoveElevatorStopStrategy`), leaving the rest of the
    /// elevator intact. Two stops of the *same* elevator are never a proximity pair (they are
    /// connected by design) — the scan excludes them.
    ElevatorStop(NodeId),
    Split(SplitTileNodes),
    Start(NodeId),
    Finish(NodeId),
}

/// Which element types a cross-element proximity check considers — one bool flag per type (there
/// is no multi-select param kind in the check-descriptor UI).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CrossElementSet {
    pub teleport: bool,
    pub one_way: bool,
    pub vertical_passage: bool,
    pub elevator_stop: bool,
    pub split: bool,
    pub start: bool,
    pub finish: bool,
}

impl CrossElementSet {
    /// How many types are enabled. A set with zero enabled types can never produce a pair, so the
    /// check is a silent no-op (see GitHub issue #376's D7). One enabled type is a valid
    /// same-type scan (two distinct elements of that type close to each other) — it subsumes the
    /// per-type `*_group_*_proximity` checks.
    pub fn enabled_count(&self) -> usize {
        [
            self.teleport,
            self.one_way,
            self.vertical_passage,
            self.elevator_stop,
            self.split,
            self.start,
            self.finish,
        ]
        .into_iter()
        .filter(|&b| b)
        .count()
    }

    fn includes(&self, element: &CrossElement) -> bool {
        match element {
            CrossElement::Teleport(_) => self.teleport,
            CrossElement::OneWay(_) => self.one_way,
            CrossElement::VerticalPassage(_) => self.vertical_passage,
            CrossElement::ElevatorStop(_) => self.elevator_stop,
            CrossElement::Split(_) => self.split,
            CrossElement::Start(_) => self.start,
            CrossElement::Finish(_) => self.finish,
        }
    }
}

/// One physical presence of a [`CrossElement`] — a single endpoint / floor-stop. The proximity
/// scan's candidates are occurrences; found pairs are aggregated back by `element`.
pub struct CrossElementOccurrence<T: Tessellation> {
    pub element: CrossElement,
    /// The node this occurrence sits at.
    pub node: NodeId,
    /// `field.level_index_of(node)`.
    pub level_index: usize,
    /// `field.cell_of(node)`.
    pub point: T::CellId,
    /// Position the geometric metric measures from — `space::cell_position(point)` for every
    /// occurrence, except a one-way's two occurrences, which both carry the one-way edge's own
    /// `space::edge_position(from, to)` (its face's contact point) instead (GitHub issue #376's follow-up: a one-way renders on
    /// the tile border it crosses, not at either endpoint node, so its geometric distance is
    /// measured the same way `OneWayGroupGeometricProximityCheck` measures it, from the edge's own
    /// position rather than from either of its two endpoint nodes). Both of a one-way's occurrences
    /// carrying the identical `xy` is harmless — `aggregate_pairs` already collapses duplicate
    /// close-pairs back to one group per logical element.
    pub xy: ScaledPoint,
    /// `nav.nav_node_for(node)` — `None` when the node is absent from the nav graph.
    pub nav_node: Option<NavNodeId>,
}

/// Every enabled cross-element in the maze, each carrying every underlying edge it owns (for the
/// route-protection check and for re-resolving during repair). Split/Start/Finish own no edges.
pub fn cross_element_edges<T: Tessellation>(maze: &Maze<T>, element: &CrossElement) -> Vec<EdgeId> {
    match element {
        CrossElement::Teleport((a, b)) => [
            maze.graph.edge_between(*a, *b),
            maze.graph.edge_between(*b, *a),
        ]
        .into_iter()
        .flatten()
        .filter(|&id| {
            maze.graph
                .edge(id)
                .is_some_and(|e| e.kind == EdgeKind::Teleport)
        })
        .collect(),
        CrossElement::OneWay(id) | CrossElement::VerticalPassage(id) => {
            let Some(edge) = maze.graph.edge(*id) else {
                return Vec::new();
            };
            let mut edges = vec![*id];
            // A two-way vertical passage: include the reverse so `element_invalidated` sees the
            // whole passage gone only when both directions are removed.
            if edge.kind == EdgeKind::VerticalPassage
                && let Some(rev) = maze.graph.edge_between(edge.to, edge.from)
                && maze
                    .graph
                    .edge(rev)
                    .is_some_and(|e| e.kind == EdgeKind::VerticalPassage)
            {
                edges.push(rev);
            }
            edges
        }
        CrossElement::ElevatorStop(stop) => {
            // Every `Elevator` edge with `stop` as an endpoint (either direction) — the fan edges
            // `RemoveElevatorStopStrategy` would cut. The rest of the elevator's fan is not this
            // element's concern.
            let mut edges: Vec<EdgeId> = maze
                .graph
                .edges()
                .filter(|e| e.kind == EdgeKind::Elevator && (e.from == *stop || e.to == *stop))
                .map(|e| e.id)
                .collect();
            edges.sort_unstable();
            edges.dedup();
            edges
        }
        CrossElement::Split(_) | CrossElement::Start(_) | CrossElement::Finish(_) => Vec::new(),
    }
}

/// Whether `element` is protected by the current start->finish route — `Start` / `Finish` always
/// are (they *are* the route's endpoints), an edge-owning element is when any of its underlying
/// edges lies on the route, a `Split` never is (it owns no edge and is not an endpoint). Mirrors
/// `TeleportGroupProximityCheck` / `OneWayGroupGeometricProximityCheck`'s per-edge
/// `is_edge_on_route` test, lifted to the cross-element identity level. Used by both cross-element
/// proximity checks to drop a pair whose *both* elements are route-protected (GitHub issue #376
/// follow-up), the same "only exclude when both sides are on the route" rule the same-type checks
/// use — a pair with one protected and one free element is still a legitimate repair target.
pub fn cross_element_route_protected<T: Tessellation>(
    maze: &Maze<T>,
    element: &CrossElement,
) -> bool {
    match element {
        CrossElement::Start(_) | CrossElement::Finish(_) => true,
        _ => cross_element_edges(maze, element)
            .into_iter()
            .any(|id| crate::graph::route_protection::is_edge_on_route(maze, id)),
    }
}

/// Collects every enabled cross-element in the maze paired with its occurrences.
///
/// `nav` is used only to attach a `NavNodeId` to each occurrence for the graph metric; the
/// geometric metric ignores it.
pub fn cross_element_occurrences<T: Tessellation>(
    maze: &Maze<T>,
    set: &CrossElementSet,
    nav: &NavGraph,
) -> Vec<CrossElementOccurrence<T>> {
    let mut out = Vec::new();
    let tessellation = maze.field.tessellation();
    let push_at =
        |out: &mut Vec<CrossElementOccurrence<T>>, element: CrossElement, node: NodeId| {
            let (Some(level_index), Some(point)) =
                (maze.field.level_index_of(node), maze.field.cell_of(node))
            else {
                return;
            };
            out.push(CrossElementOccurrence {
                element,
                node,
                level_index,
                point,
                xy: cell_position(tessellation, point),
                nav_node: nav.nav_node_for(node),
            });
        };

    if set.teleport {
        let mut seen: HashSet<TeleportId> = HashSet::new();
        for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
            let id = teleport_id(edge.from, edge.to);
            if !seen.insert(id) {
                continue;
            }
            push_at(&mut out, CrossElement::Teleport(id), id.0);
            push_at(&mut out, CrossElement::Teleport(id), id.1);
        }
    }

    if set.one_way {
        // Geometric position is the edge's own `edge_position` (the tile border it crosses), not
        // either endpoint node — see `CrossElementOccurrence::xy`'s doc comment. Still one
        // occurrence per endpoint node (`push_at` needs a `NodeId` for `.node`/`.nav_node`, which
        // the graph metric measures from per-endpoint, same as before), just with `xy` overwritten
        // on both after the fact.
        for (id, from, to) in one_way_edges_with_endpoints(maze) {
            let (Some(from_point), Some(to_point)) =
                (maze.field.cell_of(from), maze.field.cell_of(to))
            else {
                continue;
            };
            let edge_xy = edge_position(tessellation, from_point, to_point);
            let before = out.len();
            push_at(&mut out, CrossElement::OneWay(id), from);
            push_at(&mut out, CrossElement::OneWay(id), to);
            for occ in &mut out[before..] {
                occ.xy = edge_xy;
            }
        }
    }

    if set.vertical_passage {
        for c in vertical_passage_proximity_candidates(maze, VerticalPassageType::Any, true) {
            push_at(
                &mut out,
                CrossElement::VerticalPassage(c.canonical_edge),
                c.node,
            );
        }
    }

    if set.elevator_stop {
        for elevator in elevator_groups(maze) {
            for &stop in &elevator.stops {
                push_at(&mut out, CrossElement::ElevatorStop(stop), stop);
            }
        }
    }

    if set.split {
        for (level, point) in maze.field.split_cells() {
            let nodes = maze.field.nodes_at(level, point);
            let element = CrossElement::Split(SplitTileNodes::new(nodes.to_vec()));
            // One occurrence per node of the tile. They all share the same point/level, so the
            // geometric metric sees no difference and aggregation collapses the duplicates; the
            // graph metric needs every node, since only some may be wired into the nav graph.
            for &node in nodes {
                push_at(&mut out, element.clone(), node);
            }
        }
    }

    if set.start
        && let Some(start) = maze.meta.start
    {
        push_at(&mut out, CrossElement::Start(start), start);
    }
    if set.finish
        && let Some(finish) = maze.meta.finish
    {
        push_at(&mut out, CrossElement::Finish(finish), finish);
    }

    out.retain(|o| set.includes(&o.element));
    out
}

/// Whether a cross-element still physically exists in the maze after a repair mutation — used by
/// the strategy to decide when a nested fix has invalidated an element (and thus every group it
/// was in). Element-specific: a removed edge, a collapsed tile, a vanished elevator fan.
pub fn cross_element_still_violates<T: Tessellation>(
    maze: &Maze<T>,
    element: &CrossElement,
) -> bool {
    match element {
        CrossElement::Teleport(_) | CrossElement::OneWay(_) | CrossElement::VerticalPassage(_) => {
            !cross_element_edges(maze, element).is_empty()
        }
        CrossElement::ElevatorStop(stop) => elevator_groups(maze)
            .iter()
            .any(|e| e.stops.len() >= 2 && e.stops.contains(stop)),
        CrossElement::Split(tile) => {
            let Some(&node) = tile.0.first() else {
                return false;
            };
            let (Some(level), Some(point)) = (maze.field.level_of(node), maze.field.cell_of(node))
            else {
                return false;
            };
            maze.field.nodes_at(level, point).len() >= 2
        }
        // Start/Finish are never removed by repair.
        CrossElement::Start(_) | CrossElement::Finish(_) => true,
    }
}

/// Whether every underlying edge of an edge-owning `element` (teleport / one-way / vertical
/// passage / elevator) was planted by a preset connection, so repair must not remove it. Checked
/// per `EdgeId` against `preset_edge_ids` -- the same per-edge, kind-agnostic set
/// `try_remove_edge_by_id` consults, so a *different* edge on a pair a preset also occupies (e.g. a
/// user teleport parallel to a preset `Basic` passage) is not treated as locked. `false` for
/// split / start / finish -- a split's preset-lock is enforced by `RemoveSplitStrategy`'s own
/// `replace_point_nodes_feasible` check, and start / finish are unremovable regardless.
///
/// The same-type proximity checks never surface a preset element in the first place (their
/// selectors skip preset connections), but the cross-element checks deliberately do -- the user
/// should see that "teleport not within N of an elevator" is violated even when the teleport is a
/// preset. `apply_commands` would decline the removal anyway (`try_remove_edge_by_id` guards every
/// kind via `preset_edge_ids`), but skipping the candidate here fails fast instead of counting a
/// declined command as a fix. So the "don't remove it" decision is made here, at repair time.
pub fn cross_element_preset_locked<T: Tessellation>(
    maze: &Maze<T>,
    preset_state: &crate::generation::PresetState,
    element: &CrossElement,
) -> bool {
    match element {
        CrossElement::Teleport(_)
        | CrossElement::OneWay(_)
        | CrossElement::VerticalPassage(_)
        | CrossElement::ElevatorStop(_) => {
            let edges = cross_element_edges(maze, element);
            !edges.is_empty() && edges.iter().all(|&id| preset_state.is_preset_edge_id(id))
        }
        CrossElement::Split(_) | CrossElement::Start(_) | CrossElement::Finish(_) => false,
    }
}

/// The live node set at the split tile that `cached` referred to, re-resolved from the maze by
/// whichever of its nodes still maps to a point — or an empty vec if that tile no longer has two
/// or more nodes. The repair strategy uses this instead of trusting the cached `SplitTileNodes`,
/// since an earlier fix in the same pass may have changed the tile.
pub fn split_tile_nodes_of<T: Tessellation>(maze: &Maze<T>, cached: &[NodeId]) -> Vec<NodeId> {
    for &anchor in cached {
        let (Some(level), Some(point)) = (maze.field.level_of(anchor), maze.field.cell_of(anchor))
        else {
            continue;
        };
        let nodes = maze.field.nodes_at(level, point);
        if nodes.len() >= 2 {
            return nodes.to_vec();
        }
        return Vec::new();
    }
    Vec::new()
}

fn teleport_id(a: NodeId, b: NodeId) -> TeleportId {
    if a <= b { (a, b) } else { (b, a) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use std::sync::Arc;

    fn all_types() -> CrossElementSet {
        CrossElementSet {
            teleport: true,
            one_way: true,
            vertical_passage: true,
            elevator_stop: true,
            split: true,
            start: true,
            finish: true,
        }
    }

    fn nav_of(maze: &Maze<SquareTessellation>) -> NavGraph {
        maze.analysis.nav_graph(&maze.graph, &maze.meta)
    }

    #[test]
    fn enabled_count_reflects_flags() {
        let mut set = all_types();
        assert_eq!(set.enabled_count(), 7);
        set.teleport = false;
        set.one_way = false;
        assert_eq!(set.enabled_count(), 5);
    }

    #[test]
    fn teleport_id_is_order_independent() {
        assert_eq!(teleport_id(5, 2), teleport_id(2, 5));
    }

    #[test]
    fn teleport_contributes_two_occurrences_for_one_portal_regardless_of_direction() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for n in field.all_node_ids() {
            g.add_node(n);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(3), EdgeKind::Teleport);
        g.add_edge(p(3), p(0), EdgeKind::Teleport);
        let maze = Maze::new(field, g);

        let nav = nav_of(&maze);
        let occ = cross_element_occurrences(&maze, &all_types(), &nav);
        let teleports: Vec<_> = occ
            .iter()
            .filter(|o| matches!(o.element, CrossElement::Teleport(_)))
            .collect();
        assert_eq!(
            teleports.len(),
            2,
            "one portal, two ends, deduped across both directions"
        );
        assert!(
            teleports.iter().all(|o| o.element == teleports[0].element),
            "same canonical id"
        );
    }

    #[test]
    fn each_elevator_stop_is_its_own_element_with_the_stop_node_as_id() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| {
                mf.add_level(
                    Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids)
                        .unwrap(),
                )
            })
            .collect();
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        let nodes: Vec<NodeId> = floors
            .iter()
            .map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
            .collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        let maze = Maze::new(mf, g);

        let nav = nav_of(&maze);
        let occ = cross_element_occurrences(&maze, &all_types(), &nav);
        let mut stops: Vec<NodeId> = occ
            .iter()
            .filter_map(|o| match o.element {
                CrossElement::ElevatorStop(n) => Some(n),
                _ => None,
            })
            .collect();
        assert_eq!(
            stops.len(),
            3,
            "3 stops -> 3 occurrences, one distinct element each"
        );
        stops.sort_unstable();
        let mut expected = nodes.clone();
        expected.sort_unstable();
        assert_eq!(stops, expected, "each element's id is its own stop node");
    }

    #[test]
    fn set_excludes_disabled_types_from_occurrences() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for n in field.all_node_ids() {
            g.add_node(n);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic);
        let maze = Maze::new(field, g);

        let nav = nav_of(&maze);
        let mut set = all_types();
        set.one_way = false;
        let occ = cross_element_occurrences(&maze, &set, &nav);
        assert!(
            occ.iter()
                .all(|o| !matches!(o.element, CrossElement::OneWay(_)))
        );
    }

    #[test]
    fn still_violates_tracks_edge_removal() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for n in field.all_node_ids() {
            g.add_node(n);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        let e = g.add_edge(p(0), p(1), EdgeKind::Basic);
        let mut maze = Maze::new(field, g);

        let element = CrossElement::OneWay(e);
        assert!(cross_element_still_violates(&maze, &element));
        maze.graph.remove_edge(e);
        assert!(!cross_element_still_violates(&maze, &element));
    }

    #[test]
    fn still_violates_split_arm_tracks_the_tile_collapsing_below_two_nodes() {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let extra = field.add_node_at(level, SquarePoint { x: 1, y: 0 }, &mut ids);
        let mut g = Graph::new();
        for n in field.all_node_ids() {
            g.add_node(n);
        }
        let mut maze = Maze::new(field, g);
        let tile_nodes = maze
            .field
            .nodes_at(level, SquarePoint { x: 1, y: 0 })
            .to_vec();
        assert_eq!(tile_nodes.len(), 2);
        let element = CrossElement::Split(SplitTileNodes::new(tile_nodes));
        assert!(
            cross_element_still_violates(&maze, &element),
            "two nodes at the tile -> still a split"
        );

        maze.field.remove_node_at(extra);
        assert!(
            !cross_element_still_violates(&maze, &element),
            "tile back to one node -> no longer a split"
        );
    }

    #[test]
    fn still_violates_elevator_stop_arm_tracks_the_fan_dropping_below_two_stops() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| {
                mf.add_level(
                    Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids)
                        .unwrap(),
                )
            })
            .collect();
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        let stops: Vec<NodeId> = floors
            .iter()
            .map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
            .collect();
        for i in 0..stops.len() {
            for j in (i + 1)..stops.len() {
                g.add_edge(stops[i], stops[j], EdgeKind::Elevator);
                g.add_edge(stops[j], stops[i], EdgeKind::Elevator);
            }
        }
        let mut maze = Maze::new(mf, g);
        let element = CrossElement::ElevatorStop(stops[0]);
        assert!(
            cross_element_still_violates(&maze, &element),
            "3-stop fan -> stop is live"
        );

        // Strip every Elevator edge touching stops[0]. The remaining fan {stops[1], stops[2]} still
        // exists, but stops[0] is no longer part of any elevator -> its element no longer violates.
        let to_cut: Vec<EdgeId> = maze
            .graph
            .edges()
            .filter(|e| e.kind == EdgeKind::Elevator && (e.from == stops[0] || e.to == stops[0]))
            .map(|e| e.id)
            .collect();
        for id in to_cut {
            maze.graph.remove_edge(id);
        }
        assert!(
            !cross_element_still_violates(&maze, &CrossElement::ElevatorStop(stops[0])),
            "stop detached from the fan -> no longer violates"
        );
    }

    #[test]
    fn cross_element_edges_two_way_vertical_passage_includes_the_reverse_edge() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let g0 = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let g1 = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        let a = mf.node_at(g0, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = mf.node_at(g1, SquarePoint { x: 0, y: 0 }).unwrap();
        let fwd = g.add_edge(a, b, EdgeKind::VerticalPassage);
        g.add_edge(b, a, EdgeKind::VerticalPassage);
        let maze = Maze::new(mf, g);

        let edges = cross_element_edges(&maze, &CrossElement::VerticalPassage(fwd));
        assert_eq!(
            edges.len(),
            2,
            "a two-way vertical passage owns both directed edges"
        );
    }
}
