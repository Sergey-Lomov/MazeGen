#[derive(Debug, Clone)]
pub struct ElementsConfig {
    pub one_way_chance: f64,
    /// Probability that, at each edge-addition opportunity `advance` handles, the edge is a
    /// teleport instead of a normal (geometrically-adjacent) connection.
    pub teleport_chance: f64,
    /// Probability that an added teleport is one-way rather than two-way. Only consulted when
    /// `teleport_chance` already hit — mirrors `one_way_chance`'s role but scoped to teleports.
    pub teleport_one_way_chance: f64,
    /// `CustomVertexBased`-only (GitHub issue #222): probability, rolled fresh at the start of
    /// every step (before any other per-step logic), that the step's tile is split into several
    /// graph nodes instead of merged into one. Always consumed regardless of value, same
    /// RNG-parity discipline as `teleport_chance`/`cyclicity` (see `vertex_based.rs`).
    pub split_chance: f64,
}

impl Default for ElementsConfig {
    fn default() -> Self {
        ElementsConfig {
            one_way_chance: 0.04,
            teleport_chance: 0.0,
            teleport_one_way_chance: 0.0,
            split_chance: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GenerationParams {
    pub depth_first:     f64,
    pub corridor_chance: f64,
    pub branching:       f64,
    pub directionality:  f64,
    pub cyclicity:       f64,
}

impl Default for GenerationParams {
    fn default() -> Self {
        GenerationParams {
            depth_first:     0.9,
            corridor_chance: 0.7,
            branching:       0.5,
            directionality:  0.0,
            cyclicity:       0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EdgeBasedParams {
    pub corridor_length: f64,
    pub branching:       f64,
    pub depth_first:     f64,
    pub directionality:  f64,
    pub cyclicity:       f64,
}

impl Default for EdgeBasedParams {
    fn default() -> Self {
        EdgeBasedParams {
            corridor_length: 0.5,
            branching:       0.5,
            depth_first:     0.5,
            directionality:  0.0,
            cyclicity:       0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub enum GenerationAlgorithm {
    CustomVertexBased(GenerationParams),
    CustomEdgeBased(EdgeBasedParams),
    RecursiveBacktracker,
    WilsonAlgorithm,
    KruskalAlgorithm,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PresetConnectionState {
    Wall,
    Passage,
    OneWayForward,
    OneWayBackward,
    Teleport(TeleportDirection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportDirection {
    Forward,
    Backward,
    TwoWay,
}

/// One endpoint of a preset connection/lock/marker (GitHub issue #231) — a point plus an optional
/// slot addressing one of that point's extra ("split") nodes. `slot: None` means the point's
/// original node — not a broadcast to every node at the point (that was #219/#220's interim
/// behavior before presets could address a specific split node; see `build_preset_state`'s doc
/// comment). Presets never hold a resolved `NodeId` up front — split nodes referenced here are
/// created from `GenerationConfig.split_points` before any preset is resolved (see
/// `build_preset_state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresetEndpoint {
    pub point: (i32, i32),
    pub slot: Option<u32>,
}

impl PresetEndpoint {
    pub fn original(point: (i32, i32)) -> Self {
        Self { point, slot: None }
    }
}

#[derive(Debug, Clone)]
pub struct PresetConnection {
    pub from: PresetEndpoint,
    pub to:   PresetEndpoint,
    pub state: PresetConnectionState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeLockKind {
    In,
    Out,
    Both,
}

#[derive(Debug, Clone)]
pub struct LockedNode {
    pub point: PresetEndpoint,
    pub kind:  NodeLockKind,
}

#[derive(Debug, Clone)]
pub struct GenerationConfig {
    pub algorithm:          GenerationAlgorithm,
    pub elements:           ElementsConfig,
    pub preset_connections: Vec<PresetConnection>,
    pub locked_nodes:       Vec<LockedNode>,
    /// Extra nodes to create at declared points before any preset above is resolved — one entry
    /// per `(point, slot)` pair (GitHub issue #231). Applied via `Field::add_node_at` in
    /// `(point, slot)`-sorted order by `build_preset_state`, mirroring `apply_split_points`
    /// (`maze-wasm/src/analytics.rs`) for post-edit's split nodes.
    pub split_points: Vec<((i32, i32), u32)>,
    /// `CustomVertexBased`-only (GitHub issue #222) automatic split-point assignment settings.
    /// Ignored by every other generation algorithm.
    pub split_generation: crate::generation::split_pattern::SplitGenerationConfig,
}

impl Default for GenerationConfig {
    fn default() -> Self {
        GenerationConfig {
            algorithm:          GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
            elements:           ElementsConfig::default(),
            preset_connections: vec![],
            locked_nodes:       vec![],
            split_points:       vec![],
            split_generation:   crate::generation::split_pattern::SplitGenerationConfig::default(),
        }
    }
}

