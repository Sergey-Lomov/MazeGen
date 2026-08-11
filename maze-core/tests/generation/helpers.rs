use maze_core::{Graph, IdGenerator, NodeId};
use maze_core::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{
    EdgeBasedParams, ElementsConfig, GenerationAlgorithm, GenerationConfig, GenerationParams, PresetState,
    build_preset_state, PresetConnection, PresetConnectionState, PresetEndpoint,
};

pub fn build(width: usize, height: usize) -> (Graph, MultiLevelField<SquareTessellation>, NodeId) {
    let (graph, field, start, _ids) = build_with_ids(width, height);
    (graph, field, start)
}

/// Same as `build`, but also returns the `IdGenerator` used to construct `field` — needed by
/// callers that go on to declare `split_points` (GitHub issue #231) via `build_preset_state`,
/// which itself calls `MultiLevelField::add_node_at` and needs an `IdGenerator` that won't collide
/// with the field's already-assigned ids.
pub fn build_with_ids(width: usize, height: usize) -> (Graph, MultiLevelField<SquareTessellation>, NodeId, IdGenerator) {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(width, height), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let start = field.nodes_at(level, SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
    (graph, field, start, ids)
}

pub fn empty_preset() -> PresetState { PresetState::empty() }

/// Builds a 1x4 field where `node_at(1,0)`<->`node_at(2,0)` geometric adjacency is walled off,
/// so the only way to cross from the first half to the second is a preset two-way `Teleport` edge
/// planted directly in the graph between those same two nodes (mirrors what `build_preset_state`
/// does for a `PresetConnectionState::Teleport(TwoWay)` entry — see `Specs/preset-connections.md`).
/// Regression fixture for GitHub issue #226: every generation algorithm must treat a preset
/// teleport as a traversable extra neighbor, not a dead end. Returns
/// `(graph, field, start, preset_state, node_count, teleport_a, teleport_b, ids)`.
pub fn build_with_preset_teleport_bridge() -> (Graph, MultiLevelField<SquareTessellation>, NodeId, PresetState, usize, NodeId, NodeId, IdGenerator) {
    let (mut graph, field, start, ids) = build_with_ids(4, 1);
    let level = field.single_level_id();
    let node_count = graph.nodes().count();
    let a = field.nodes_at(level, SquarePoint { x: 1, y: 0 }).first().copied().unwrap();
    let b = field.nodes_at(level, SquarePoint { x: 2, y: 0 }).first().copied().unwrap();

    graph.build_initial_edge(a, b, maze_core::graph::EdgeKind::Teleport);
    graph.build_initial_edge(b, a, maze_core::graph::EdgeKind::Teleport);

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));
    preset_state.preset_teleports.entry(a).or_default().push(b);
    preset_state.preset_teleports.entry(b).or_default().push(a);

    (graph, field, start, preset_state, node_count, a, b, ids)
}

/// One-way counterpart of `build_with_preset_teleport_bridge`: same 1x4 layout and walled-off
/// geometric adjacency between `node_at(1,0)` and `node_at(2,0)`, but only a single directed
/// preset `Teleport` edge `a -> b` is planted (mirrors `PresetConnectionState::Teleport(Forward)` —
/// see `Specs/preset-connections.md`), so `preset_teleports` has an entry only for `a`, not `b`.
/// Regression fixture for GitHub issue #226: a one-way preset teleport must still be traversed
/// (from `a`'s side only) exactly like the two-way case, not silently treated symmetrically.
/// Returns `(graph, field, start, preset_state, node_count, ids)`.
pub fn build_with_one_way_preset_teleport_bridge() -> (Graph, MultiLevelField<SquareTessellation>, NodeId, PresetState, usize, IdGenerator) {
    let (mut graph, field, start, ids) = build_with_ids(4, 1);
    let level = field.single_level_id();
    let node_count = graph.nodes().count();
    let a = field.nodes_at(level, SquarePoint { x: 1, y: 0 }).first().copied().unwrap();
    let b = field.nodes_at(level, SquarePoint { x: 2, y: 0 }).first().copied().unwrap();

    graph.build_initial_edge(a, b, maze_core::graph::EdgeKind::Teleport);

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));
    preset_state.preset_teleports.entry(a).or_default().push(b);

    (graph, field, start, preset_state, node_count, ids)
}

pub fn no_one_way_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 } }

/// A 3x1 field where `(1,0)` is a split point with two nodes — the original and one extra slot —
/// and a preset `Passage` wires the *original* node to `(0,0)` specifically. Regression fixture
/// for GitHub issue #242: `Field::neighbors` has no notion of which face belongs to which of a
/// split point's several nodes, so without split-aware filtering, the slot node would also see
/// `(0,0)` as a free candidate — even though that neighbor's only face into `(1,0)` is already
/// claimed by the original node's preset passage. Returns
/// `(graph, field, preset_state, original, slot, left, right)` where `left` is `(0,0)` (claimed by
/// `original`) and `right` is `(2,0)` (still free for either split node).
pub fn build_with_split_point_preset_claim() -> (Graph, MultiLevelField<SquareTessellation>, PresetState, NodeId, NodeId, NodeId, NodeId) {
    let (mut graph, mut field, _start, mut ids) = build_with_ids(3, 1);
    let split_points = vec![((1, 0), 0)];
    let presets = vec![PresetConnection {
        from: PresetEndpoint::original((1, 0)), to: PresetEndpoint::original((0, 0)), state: PresetConnectionState::Passage,
    }];
    let preset_state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &split_points, |x, y| SquarePoint { x, y }, None, None).unwrap();

    let level = field.single_level_id();
    let nodes = field.nodes_at(level, SquarePoint { x: 1, y: 0 });
    let original = nodes[0];
    let slot = nodes[1];
    let left = field.nodes_at(level, SquarePoint { x: 0, y: 0 })[0];
    let right = field.nodes_at(level, SquarePoint { x: 2, y: 0 })[0];

    (graph, field, preset_state, original, slot, left, right)
}

/// A 3x2 field where `(1,0)` is a split point with two nodes — original and one extra slot — and
/// *both* end up in `preset_connected`, but via unrelated presets that never create an edge
/// between either split node and `left`: original has a Passage to `up` (`(1,1)`, its other free
/// face), and slot has a Passage to `right` (`(2,0)`) plus an explicit Wall to `left` (`(0,0)`).
/// Regression fixture for GitHub issue #242's second bug: RB's candidate filter used to check
/// `preset_connected.contains(current) && preset_connected.contains(n)` — a flat NodeId set with
/// no notion of *which* pair is actually preset-connected — and let that short-circuit `can_connect`
/// entirely, so `slot` and `left` both being *somewhere* in `preset_connected` (via their own,
/// unrelated presets) made the explicit Wall between them a no-op. Distinct from
/// `build_with_split_point_preset_claim`: there, `original`'s Passage to `left` plants a real graph
/// edge that `split_aware_neighbors`'s sibling-exclusivity check alone already catches, masking this
/// second bug — here, neither split node ever has an edge to `left`, isolating the flat-set
/// false-positive specifically. Returns `(graph, field, preset_state, original, slot, left, right)`.
pub fn build_with_split_point_preset_connected_false_positive() -> (Graph, MultiLevelField<SquareTessellation>, PresetState, NodeId, NodeId, NodeId, NodeId) {
    let (mut graph, mut field, _start, mut ids) = build_with_ids(3, 2);
    let split_points = vec![((1, 0), 0)];
    let presets = vec![
        PresetConnection { from: PresetEndpoint::original((1, 0)), to: PresetEndpoint::original((1, 1)), state: PresetConnectionState::Passage },
        PresetConnection { from: PresetEndpoint { point: (1, 0), slot: Some(0) }, to: PresetEndpoint::original((2, 0)), state: PresetConnectionState::Passage },
        PresetConnection { from: PresetEndpoint { point: (1, 0), slot: Some(0) }, to: PresetEndpoint::original((0, 0)), state: PresetConnectionState::Wall },
        // `left` (`(0,0)`) needs its own, unrelated Passage so it's `preset_connected` too — the
        // flat-set false positive only fires when *both* sides of the checked pair are somewhere
        // in `preset_connected`, regardless of whether they're connected to *each other*.
        PresetConnection { from: PresetEndpoint::original((0, 0)), to: PresetEndpoint::original((0, 1)), state: PresetConnectionState::Passage },
    ];
    let preset_state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &split_points, |x, y| SquarePoint { x, y }, None, None).unwrap();

    let level = field.single_level_id();
    let nodes = field.nodes_at(level, SquarePoint { x: 1, y: 0 });
    let original = nodes[0];
    let slot = nodes[1];
    let left = field.nodes_at(level, SquarePoint { x: 0, y: 0 })[0];
    let right = field.nodes_at(level, SquarePoint { x: 2, y: 0 })[0];

    (graph, field, preset_state, original, slot, left, right)
}

/// A 2x1 field where `(1,0)` is a split point with two nodes (original + one extra slot) and
/// `(0,0)` is its *only* geometric neighbor — no presets at all. Regression fixture for GitHub
/// issue #242's Kruskal-specific shape: with plain geometric adjacency, both split siblings are
/// separate, unconnected DSU components, so both `(original, left)` and `(slot, left)` are valid,
/// cycle-free candidate edges — nothing but split-awareness stops Kruskal from adding both, wiring
/// `left`'s one physical face to two different split passages at once. Returns
/// `(graph, field, original, slot, left)`.
pub fn build_with_split_point_single_free_neighbor() -> (Graph, MultiLevelField<SquareTessellation>, NodeId, NodeId, NodeId) {
    let (mut graph, mut field, _start, mut ids) = build_with_ids(2, 1);
    let level = field.single_level_id();
    let point = SquarePoint { x: 1, y: 0 };
    let original = field.nodes_at(level, point)[0];
    let slot = field.add_node_at(level, point, &mut ids);
    graph.add_node(slot);
    let left = field.nodes_at(level, SquarePoint { x: 0, y: 0 })[0];
    (graph, field, original, slot, left)
}

/// A 2x1 field where `a`/`b` are geometric neighbors and exactly *one* direction between them is
/// preset-blocked (`blocked.insert((a, b))` only, not the reverse) — `can_connect` allows this pair
/// (either direction free suffices for a one-way pick), but `bidirectional_edge_feasible` does not
/// (both directions must be free). Regression fixture: RB/Wilson/Kruskal always commit a full
/// bidirectional passage via `try_add_bidirectional_edge`, which itself requires both directions
/// free — filtering candidates with `can_connect` let a pair like this pass the filter, get
/// narrated as connected (or, for Kruskal, DSU-unioned), while `try_add_bidirectional_edge` silently
/// refused to add anything. Returns `(graph, field, preset_state, a, b)`.
pub fn build_with_one_directionally_blocked_pair() -> (Graph, MultiLevelField<SquareTessellation>, PresetState, NodeId, NodeId) {
    let (graph, field, _start, _ids) = build_with_ids(2, 1);
    let level = field.single_level_id();
    let a = field.nodes_at(level, SquarePoint { x: 0, y: 0 })[0];
    let b = field.nodes_at(level, SquarePoint { x: 1, y: 0 })[0];
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    (graph, field, preset_state, a, b)
}

/// A 3x1 field (`start`/`middle`/`isolated`, left to right) where `middle`<->`isolated` is
/// one-directionally blocked (only `blocked.insert((middle, isolated))`, not the reverse) — the
/// walk algorithm's search phase (which uses `can_connect`'s looser either-direction-free check)
/// can still step onto `isolated`, but the commit phase's bidirectional add always refuses it, so
/// `isolated` can never actually join the maze. Regression fixture for the Wilson infinite-loop
/// fix: with more than one node in the field, `isolated` being permanently unreachable must not
/// prevent `start`/`middle` from generating normally — the outer unvisited-set loop has to make
/// progress and terminate even though one node can never be committed. Returns
/// `(graph, field, preset_state, start, middle, isolated)`.
pub fn build_with_isolated_node_among_others() -> (Graph, MultiLevelField<SquareTessellation>, PresetState, NodeId, NodeId, NodeId) {
    let (graph, field, _start, _ids) = build_with_ids(3, 1);
    let level = field.single_level_id();
    let start = field.nodes_at(level, SquarePoint { x: 0, y: 0 })[0];
    let middle = field.nodes_at(level, SquarePoint { x: 1, y: 0 })[0];
    let isolated = field.nodes_at(level, SquarePoint { x: 2, y: 0 })[0];
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((middle, isolated));
    (graph, field, preset_state, start, middle, isolated)
}

pub fn default_config() -> GenerationConfig {
    GenerationConfig::default()
}

pub fn config_with_params(params: GenerationParams) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomVertexBased(params),
        elements: ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 },
        ..GenerationConfig::default()
    }
}

pub fn config_with_elements(elements: ElementsConfig) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
        elements,
        ..GenerationConfig::default()
    }
}

pub fn edge_based_config(params: EdgeBasedParams) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomEdgeBased(params),
        elements: ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 },
        ..GenerationConfig::default()
    }
}

pub fn kruskal_config() -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::KruskalAlgorithm,
        elements: ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 },
        ..GenerationConfig::default()
    }
}

pub fn assert_perfect_maze(graph: &Graph, node_count: usize) {
    assert_eq!(graph.edges().count(), 2 * (node_count - 1),
        "expected perfect maze: 2*(node_count-1) directed edges");
}

pub fn collect_edges(graph: &Graph) -> Vec<(NodeId, NodeId)> {
    graph.edges().map(|e| (e.from, e.to)).collect()
}

pub fn assert_deterministic(g1: &Graph, g2: &Graph) {
    let mut e1 = collect_edges(g1);
    let mut e2 = collect_edges(g2);
    e1.sort();
    e2.sort();
    assert_eq!(e1, e2, "same seed produced different graphs");
}
