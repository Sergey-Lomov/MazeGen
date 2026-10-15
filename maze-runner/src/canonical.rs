//! Canonical, implementation-independent snapshots of a pipeline run (GitHub issue #753).
//!
//! Everything here is expressed in terms of *cells* — `"<level>:<x>,<y>/<slot>"`, built from the
//! wire coordinates of a node's point, its `levels_ordered()` index and its position within
//! `nodes_at` — never raw `NodeId`s, face indices or symmetry indices, so a baseline survives
//! refactors of the tessellation API that keep observable behavior unchanged. Every collection is
//! sorted, so baselines compare order-independently.

use crate::config::GenerateConfig;
use crate::runner::build_check_types;
use crate::runner::prepare::{Prepared, PreparedVisitor, dispatch};
use crate::runner::stages::{
    Checked, Repaired, Seeded, run_check_only, run_generation, run_repair, seed_graph,
};
use maze_core::{
    GenerationTiming,
    generation::{
        OneWayDirection, PresetState, ResolvedFace, SplitFaceRequirement,
        split_adaptation_candidates,
    },
    graph::{EdgeKind, Graph},
    ids::NodeId,
    quality_control::{
        Issue, IssueEdgeGroupPayload, IssuePayload, IssueRegionPayload, IssueSplitTilePayload,
        resolve_issue_payload,
    },
    space::{MultiLevelField, Tessellation},
};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Every `SPLIT_SAMPLE_STRIDE`-th point (in canonical cell order) is probed for split-pattern
/// adaptation candidates — probing every point would make baselines needlessly large.
const SPLIT_SAMPLE_STRIDE: usize = 20;

/// Computes the canonical baseline of one fixture run. A generation fixture records only
/// `generation` — the generated graph, start node and start reassignment. A QC experiment fixture
/// (its preset connections *are* a fixed graph, independent of generation) records:
/// - `qc` — issues every configured check reports on the fixed graph, without repair;
/// - `repair` — the post-repair graph, endpoints and remaining issues;
/// - `split_candidates` — split-pattern adaptation candidate sets on the fixed graph (only when
///   the config declares split patterns).
pub fn canonical_baseline(config: &GenerateConfig, seed: u64) -> Result<Value, String> {
    dispatch(seed, config, BaselineRun { config })
}

struct BaselineRun<'a> {
    config: &'a GenerateConfig,
}

impl PreparedVisitor for BaselineRun<'_> {
    type Output = Value;

    fn visit<T: Tessellation>(self, prepared: Prepared<T>) -> Result<Value, String> {
        let config = self.config;
        let mut seeded = seed_graph(prepared, config)?;
        if !config.qc_experiment {
            let start_reassignment = run_generation(&mut seeded, config);
            let cells = CellIndex::new(&seeded.field, seeded.point_to_xy);
            return Ok(json!({
                "generation": {
                    "start": cells.cell(seeded.start_id),
                    "start_reassigned_to": start_reassignment.map(|r| cells.cell(r.reassigned_to)),
                    "edges": canonical_edges(&seeded.graph, &cells),
                }
            }));
        }

        // QC experiment mode runs checks and repair without presets.
        let no_presets = PresetState::empty();
        let mut out = Map::new();
        if !seeded.gen_config.split_generation.patterns.is_empty() {
            out.insert(
                "split_candidates".to_string(),
                canonical_split_candidates(&seeded, &no_presets),
            );
        }

        let check_types = build_check_types(config);
        let Checked { maze, issues } = run_check_only(&seeded, config)?;
        let cells = CellIndex::new(&maze.field, seeded.point_to_xy);
        let scc = maze.analysis.scc(&maze.graph);
        out.insert(
            "qc".to_string(),
            json!({
                "issues": canonical_issues(&issues, &maze.graph, &maze.field, &scc, &no_presets, &check_types, &cells),
            }),
        );

        let point_to_xy = seeded.point_to_xy;
        let Repaired {
            maze,
            remaining_issues,
            preset_state,
            timing,
        } = run_repair(seeded, config, None, None)?;
        let cells = CellIndex::new(&maze.field, point_to_xy);
        let scc = maze.analysis.scc(&maze.graph);
        out.insert(
            "repair".to_string(),
            json!({
                "start": maze.meta.start.map(|n| cells.cell(n)),
                "finish": maze.meta.finish.map(|n| cells.cell(n)),
                "edges": canonical_edges(&maze.graph, &cells),
                "dispatched": strategy_dispatches(config, &timing),
                "remaining_issues": canonical_issues(&remaining_issues, &maze.graph, &maze.field, &scc, &preset_state, &check_types, &cells),
            }),
        );

        Ok(Value::Object(out))
    }
}

/// How many times each rule's top-level strategy was dispatched during repair, keyed by rule id
/// (rules without a strategy, or whose strategy never ran, are absent). Read from the timing tree,
/// whose leaf `calls` are deterministic. Records the repair trajectory coarsely: an issue a
/// strategy fixed mid-repair leaves no trace in the remaining issues, but does here.
pub fn strategy_dispatches(config: &GenerateConfig, timing: &GenerationTiming) -> Value {
    let mut out: BTreeMap<&str, u32> = BTreeMap::new();
    for stage in &config.stages {
        let Some(stage_node) = timing.qc.iter().find(|n| n.id == stage.id) else {
            continue;
        };
        for rule in &stage.rules {
            let Some(strategy) = &rule.strategy else {
                continue;
            };
            let calls = stage_node
                .children
                .iter()
                .find(|n| n.id == rule.id)
                .and_then(|rule_node| rule_node.children.iter().find(|n| n.id == strategy.id))
                .map_or(0, |leaf| leaf.entry.calls);
            if calls > 0 {
                out.insert(&rule.id, calls);
            }
        }
    }
    json!(out)
}

/// `NodeId` → canonical cell id, for every node of a field.
pub struct CellIndex {
    cells: HashMap<NodeId, String>,
}

impl CellIndex {
    pub fn new<T: Tessellation>(
        field: &MultiLevelField<T>,
        point_to_xy: fn(T::Point) -> (i32, i32),
    ) -> Self {
        let level_index: HashMap<_, usize> = field
            .levels_ordered()
            .enumerate()
            .map(|(i, level)| (level, i))
            .collect();
        let cells = field
            .all_node_ids()
            .filter_map(|node| {
                let level = field.level_of(node)?;
                let point = field.point_of(node)?;
                let slot = field
                    .nodes_at(level, point)
                    .iter()
                    .position(|&n| n == node)?;
                let (x, y) = point_to_xy(point);
                Some((node, format!("{}:{x},{y}/{slot}", level_index[&level])))
            })
            .collect();
        Self { cells }
    }

    /// Panics for a node absent from the indexed field — a raw `NodeId` must never leak into a
    /// canonical snapshot, since it would make the baseline depend on id allocation.
    pub fn cell(&self, node: NodeId) -> String {
        self.cells
            .get(&node)
            .cloned()
            .unwrap_or_else(|| panic!("node {node} is not in the indexed field"))
    }

    fn cell_u32(&self, node: u32) -> String {
        self.cell(NodeId::from(node))
    }
}

fn edge_kind_name(kind: EdgeKind) -> &'static str {
    match kind {
        EdgeKind::Basic => "basic",
        EdgeKind::Teleport => "teleport",
        EdgeKind::VerticalPassage => "vertical_passage",
        EdgeKind::Elevator => "elevator",
    }
}

/// Every directed edge as `"<from> > <to> <kind>"`, sorted. A two-way connection appears as both
/// of its directed edges.
pub fn canonical_edges(graph: &Graph, cells: &CellIndex) -> Vec<String> {
    let mut edges: Vec<String> = graph
        .edges()
        .map(|e| {
            format!(
                "{} > {} {}",
                cells.cell(e.from),
                cells.cell(e.to),
                edge_kind_name(e.kind)
            )
        })
        .collect();
    edges.sort_unstable();
    edges
}

fn sorted_values(mut values: Vec<Value>) -> Value {
    values.sort_by_cached_key(|v| v.to_string());
    Value::Array(values)
}

fn sorted_strings(mut values: Vec<String>) -> Value {
    values.sort_unstable();
    json!(values)
}

fn edge_pair(cells: &CellIndex, [from, to]: [u32; 2]) -> String {
    format!("{} > {}", cells.cell_u32(from), cells.cell_u32(to))
}

fn edge_pairs(cells: &CellIndex, edges: &[[u32; 2]]) -> Value {
    sorted_strings(edges.iter().map(|&e| edge_pair(cells, e)).collect())
}

fn node_set(cells: &CellIndex, nodes: &[u32]) -> Value {
    sorted_strings(nodes.iter().map(|&n| cells.cell_u32(n)).collect())
}

/// `HashMap<source check, Vec<V>>` → object keyed by source check, each list order-independent.
fn by_source<V>(map: &HashMap<String, Vec<V>>, f: impl Fn(&V) -> Value) -> Value {
    let sorted: BTreeMap<&String, Value> = map
        .iter()
        .map(|(source, items)| (source, sorted_values(items.iter().map(&f).collect())))
        .collect();
    json!(sorted)
}

fn edge_group(cells: &CellIndex, g: &IssueEdgeGroupPayload) -> Value {
    json!({ "edges": edge_pairs(cells, &g.edges), "preset_locked": g.preset_locked })
}

fn region(cells: &CellIndex, r: &IssueRegionPayload) -> Value {
    json!({ "region": node_set(cells, &r.region), "preset_locked": r.preset_locked })
}

fn split_tile(cells: &CellIndex, t: &IssueSplitTilePayload) -> Value {
    json!({ "nodes": node_set(cells, &t.nodes), "preset_locked": t.preset_locked })
}

fn canonical_payload(payload: &IssuePayload, cells: &CellIndex) -> Value {
    match payload {
        IssuePayload::None => Value::Null,
        IssuePayload::InvalidLoop { edges } => {
            json!({ "invalid_loop": by_source(edges, |g| edge_group(cells, g)) })
        }
        IssuePayload::RegionNeedsExpansion { nodes } => {
            json!({ "region_needs_expansion": by_source(nodes, |r| region(cells, r)) })
        }
        IssuePayload::RegionNeedsShrink { nodes } => {
            json!({ "region_needs_shrink": by_source(nodes, |r| region(cells, r)) })
        }
        IssuePayload::InvalidTeleport { groups } => {
            json!({ "invalid_teleport": by_source(groups, |g| edge_group(cells, g)) })
        }
        IssuePayload::InvalidOneWay { groups } => {
            json!({ "invalid_one_way": by_source(groups, |g| edge_group(cells, g)) })
        }
        IssuePayload::InvalidVerticalPassage { groups } => {
            json!({ "invalid_vertical_passage": by_source(groups, |g| edge_group(cells, g)) })
        }
        IssuePayload::InvalidSplitTile { groups } => json!({
            "invalid_split_tile": by_source(groups, |g| json!({
                "tiles": sorted_values(g.tiles.iter().map(|t| split_tile(cells, t)).collect()),
                "preset_locked": g.preset_locked,
            }))
        }),
        IssuePayload::InvalidSplitRoute { routes } => json!({
            "invalid_split_route": by_source(routes, |r| json!({
                "edges": sorted_strings(r.edges.iter().map(|e| format!(
                    "{}{}",
                    edge_pair(cells, [e.from, e.to]),
                    if e.is_split_edge { " split" } else { "" }
                )).collect()),
                "preset_locked": r.preset_locked,
            }))
        }),
        IssuePayload::ExcessiveSccCount { preset_locked } => {
            let sorted: BTreeMap<&String, &bool> = preset_locked.iter().collect();
            json!({ "excessive_scc_count": sorted })
        }
        IssuePayload::InvalidElevator { groups } => {
            json!({ "invalid_elevator": by_source(groups, |g| edge_group(cells, g)) })
        }
        IssuePayload::InvalidElevatorStop { nodes } => {
            json!({ "invalid_elevator_stop": by_source(nodes, |r| region(cells, r)) })
        }
        IssuePayload::AreaDeficit { areas } => {
            json!({ "area_deficit": by_source(areas, |a| json!(a)) })
        }
        IssuePayload::MissingElevatorStopCount { groups } => json!({
            "missing_elevator_stop_count": by_source(groups, |g| json!({
                "edges": edge_pairs(cells, &g.edges),
                "missing": g.missing,
                "available": node_set(cells, &g.available),
                "preset_locked": g.preset_locked,
            }))
        }),
        IssuePayload::InvalidCrossElementGroup { groups } => json!({
            "invalid_cross_element_group": by_source(groups, |group| sorted_values(
                group.iter().map(|entry| json!({
                    "kind": entry.kind,
                    "edges": edge_pairs(cells, &entry.edges),
                    "nodes": node_set(cells, &entry.nodes),
                    "tile": entry.tile.as_ref().map(|t| split_tile(cells, t)),
                    "removable": entry.removable,
                    "preset_locked": entry.preset_locked,
                })).collect()
            ))
        }),
    }
}

/// Every issue as kind, sorted source checks, display details and canonical payload; sorted.
pub fn canonical_issues<T: Tessellation>(
    issues: &[Box<dyn Issue>],
    graph: &Graph,
    field: &MultiLevelField<T>,
    scc: &maze_core::graph::scc::ConnectedComponents,
    preset_state: &PresetState,
    check_types: &HashMap<String, String>,
    cells: &CellIndex,
) -> Value {
    sorted_values(
        issues
            .iter()
            .map(|issue| {
                let issue = issue.as_ref();
                let mut sources = issue.source_checks().to_vec();
                sources.sort_unstable();
                let details: BTreeMap<&String, BTreeMap<&&str, &String>> = issue
                    .details()
                    .iter()
                    .map(|(check, values)| (check, values.iter().collect()))
                    .collect();
                let payload = resolve_issue_payload(
                    issue,
                    graph,
                    field,
                    scc,
                    preset_state,
                    Some(check_types),
                );
                json!({
                    "kind": issue.kind().as_str(),
                    "source_checks": sources,
                    "details": details,
                    "payload": canonical_payload(&payload, cells),
                })
            })
            .collect(),
    )
}

fn requirement_name(requirement: SplitFaceRequirement) -> &'static str {
    match requirement {
        SplitFaceRequirement::Passage => "passage",
        SplitFaceRequirement::OneWay(OneWayDirection::Forward) => "one_way_forward",
        SplitFaceRequirement::OneWay(OneWayDirection::Backward) => "one_way_backward",
        SplitFaceRequirement::Wall => "wall",
        SplitFaceRequirement::Unspecified => "unspecified",
    }
}

/// One adaptation candidate as a sorted face list,
/// `"n<node>:<requirement>-><cell | sib<node> | none>"` per face.
fn canonical_candidate(faces: &[ResolvedFace], cells: &CellIndex) -> String {
    let mut parts: Vec<String> = faces
        .iter()
        .map(|face| {
            let target = match (face.sibling_target, face.neighbor) {
                (Some(sibling), _) => format!("sib{sibling}"),
                (None, Some(neighbor)) => cells.cell(neighbor),
                (None, None) => "none".to_string(),
            };
            format!(
                "n{}:{}->{target}",
                face.node_index,
                requirement_name(face.requirement)
            )
        })
        .collect();
    parts.sort_unstable();
    parts.join("; ")
}

/// One probe configuration for `split_adaptation_candidates`.
struct SplitScenario<'a> {
    name: &'static str,
    visited: &'a HashSet<NodeId>,
    bridge: Option<NodeId>,
    parent: Option<NodeId>,
    cyclic_fired: bool,
}

/// Split-pattern adaptation candidate sets on `seeded`'s current graph. Probes the slot-0 node of
/// every `SPLIT_SAMPLE_STRIDE`-th point against every pattern under four deterministic scenarios:
/// - `free` — nothing visited, no bridge, no parent;
/// - `cyclic` — a fixed coordinate-hashed subset of points visited, cyclicity fired;
/// - `parent` — same visited subset plus the probe's first `Basic` graph neighbor as parent;
/// - `bridge` — same visited subset plus the probe's last `Basic` graph neighbor as bridge.
///
/// Recorded as `"<cell> p<pattern> <scenario>"` → sorted candidate list; scenarios with no
/// candidates are omitted.
fn canonical_split_candidates<T: Tessellation>(
    seeded: &Seeded<T>,
    preset_state: &PresetState,
) -> Value {
    let field = &seeded.field;
    let graph = &seeded.graph;
    let cells = CellIndex::new(field, seeded.point_to_xy);
    let patterns = &seeded.gen_config.split_generation.patterns;

    let mut probes: Vec<(String, NodeId)> = field
        .all_node_ids()
        .map(|node| (cells.cell(node), node))
        .filter(|(cell, _)| cell.ends_with("/0"))
        .collect();
    probes.sort_unstable();

    let visited_subset: HashSet<NodeId> = field
        .all_node_ids()
        .filter(|&node| {
            field.point_of(node).is_some_and(|point| {
                let (x, y) = (seeded.point_to_xy)(point);
                (x * 7 + y * 13).rem_euclid(3) == 0
            })
        })
        .collect();

    // Undirected `Basic`-edge adjacency, built once (a node pair may also carry a parallel
    // teleport, so the kind is read per edge rather than via `edge_between`).
    let mut basic_adjacency: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    for e in graph.edges().filter(|e| e.kind == EdgeKind::Basic) {
        basic_adjacency.entry(e.from).or_default().push(e.to);
        basic_adjacency.entry(e.to).or_default().push(e.from);
    }

    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    for (cell, src) in probes.into_iter().step_by(SPLIT_SAMPLE_STRIDE) {
        let mut basic_neighbors: Vec<(String, NodeId)> = basic_adjacency
            .get(&src)
            .into_iter()
            .flatten()
            .map(|&n| (cells.cell(n), n))
            .collect();
        basic_neighbors.sort_unstable();
        basic_neighbors.dedup();
        let first = basic_neighbors.first().map(|&(_, n)| n);
        let last = basic_neighbors.last().map(|&(_, n)| n);

        let mut visited = visited_subset.clone();
        visited.remove(&src);
        let with = |extra: Option<NodeId>| {
            let mut v = visited.clone();
            v.extend(extra);
            v
        };
        let empty = HashSet::new();
        let mut scenarios = vec![
            SplitScenario {
                name: "free",
                visited: &empty,
                bridge: None,
                parent: None,
                cyclic_fired: false,
            },
            SplitScenario {
                name: "cyclic",
                visited: &visited,
                bridge: None,
                parent: None,
                cyclic_fired: true,
            },
        ];
        let with_parent = with(first);
        if first.is_some() {
            scenarios.push(SplitScenario {
                name: "parent",
                visited: &with_parent,
                bridge: None,
                parent: first,
                cyclic_fired: false,
            });
        }
        let with_bridge = with(last);
        if last.is_some() {
            scenarios.push(SplitScenario {
                name: "bridge",
                visited: &with_bridge,
                bridge: last,
                parent: None,
                cyclic_fired: false,
            });
        }

        for (pattern_index, pattern) in patterns.iter().enumerate() {
            for scenario in &scenarios {
                let name = scenario.name;
                let candidates = split_adaptation_candidates(
                    graph,
                    field,
                    preset_state,
                    scenario.visited,
                    pattern,
                    src,
                    scenario.bridge,
                    scenario.parent,
                    scenario.cyclic_fired,
                );
                if candidates.is_empty() {
                    continue;
                }
                let mut set: Vec<String> = candidates
                    .iter()
                    .map(|faces| canonical_candidate(faces, &cells))
                    .collect();
                set.sort_unstable();
                set.dedup();
                out.insert(format!("{cell} p{pattern_index} {name}"), json!(set));
            }
        }
    }
    json!(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maze_core::ids::IdGenerator;
    use maze_core::space::{SquarePoint, SquareTessellation, square_rect};
    use std::sync::Arc;

    fn three_cells() -> (MultiLevelField<SquareTessellation>, [NodeId; 3], NodeId) {
        let mut ids = IdGenerator::new();
        let mut field = MultiLevelField::<SquareTessellation>::single_level(
            Arc::default(),
            square_rect(3, 1),
            &mut ids,
        )
        .unwrap();
        let level = field.single_level_id();
        let node = |x| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        let nodes = [node(0), node(1), node(2)];
        let split = field.add_node_at(level, SquarePoint { x: 1, y: 0 }, &mut ids);
        (field, nodes, split)
    }

    fn index(field: &MultiLevelField<SquareTessellation>) -> CellIndex {
        CellIndex::new(field, |p| (p.x, p.y))
    }

    #[test]
    fn cell_ids_encode_level_point_and_slot() {
        let (field, [a, b, _], split) = three_cells();
        let cells = index(&field);
        assert_eq!(cells.cell(a), "0:0,0/0");
        assert_eq!(cells.cell(b), "0:1,0/0");
        assert_eq!(cells.cell(split), "0:1,0/1");
    }

    #[test]
    #[should_panic(expected = "is not in the indexed field")]
    fn unknown_node_never_leaks_a_raw_id() {
        let (field, _, _) = three_cells();
        index(&field).cell(9999);
    }

    /// Group order, edge order within a group and source-map iteration order must not affect the
    /// canonical payload.
    #[test]
    fn payload_is_order_independent() {
        let (field, [a, b, c], split) = three_cells();
        let cells = index(&field);
        let [a, b, c, s] = [a, b, c, split].map(|n| n as u32);
        let group = |edges: Vec<[u32; 2]>| IssueEdgeGroupPayload {
            edges,
            preset_locked: false,
        };
        let payload = |groups: Vec<IssueEdgeGroupPayload>| IssuePayload::InvalidLoop {
            edges: HashMap::from([
                ("rule:0".to_string(), groups),
                ("rule:1".to_string(), vec![]),
            ]),
        };

        let forward = payload(vec![group(vec![[a, b], [b, c]]), group(vec![[s, c]])]);
        let shuffled = payload(vec![group(vec![[s, c]]), group(vec![[b, c], [a, b]])]);

        let canonical = canonical_payload(&forward, &cells);
        assert_eq!(canonical, canonical_payload(&shuffled, &cells));
        assert_eq!(
            canonical["invalid_loop"]["rule:0"][0]["edges"],
            json!(["0:0,0/0 > 0:1,0/0", "0:1,0/0 > 0:2,0/0"])
        );
    }

    #[test]
    fn candidate_faces_are_sorted_and_resolve_targets() {
        let (field, [a, _, c], _) = three_cells();
        let cells = index(&field);
        let face = |node_index, requirement, sibling_target, neighbor| ResolvedFace {
            node_index,
            requirement,
            sibling_target,
            neighbor,
        };
        let faces = [
            face(1, SplitFaceRequirement::Passage, None, Some(c)),
            face(0, SplitFaceRequirement::Wall, None, None),
            face(
                0,
                SplitFaceRequirement::OneWay(OneWayDirection::Forward),
                None,
                Some(a),
            ),
            face(0, SplitFaceRequirement::Passage, Some(1), None),
        ];
        assert_eq!(
            canonical_candidate(&faces, &cells),
            "n0:one_way_forward->0:0,0/0; n0:passage->sib1; n0:wall->none; n1:passage->0:2,0/0"
        );
    }
}
