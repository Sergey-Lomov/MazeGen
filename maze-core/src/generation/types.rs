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
    /// `CustomVertexBased`-only (GitHub issue #337): balance between a teleport targeting the
    /// current floor vs. a different floor, consulted after `teleport_chance` already hit. `0.0` =
    /// always current floor, `1.0` = always a different floor. Only rolled when the maze has more
    /// than one floor — see `vertex_based.rs`'s RNG-parity policy for single-floor mazes.
    pub cross_floor_teleport_balance: f64,
    /// `CustomVertexBased`-only (GitHub issue #337): probability of a vertical connection
    /// (`VerticalPassage`/`Elevator`) at each growth-opportunity, same inline-roll model as
    /// `teleport_chance`. Only rolled when the maze has more than one floor — see
    /// `vertex_based.rs`'s RNG-parity policy.
    pub vertical_chance: f64,
    /// Balance between a `VerticalPassage` (adjacent-floor) and an `Elevator` (multi-floor fan)
    /// outcome once `vertical_chance` hits. `0.0` = always passage, `1.0` = always elevator.
    pub vertical_passage_elevator_balance: f64,
    /// Probability that a rolled `VerticalPassage` is one-way rather than two-way. Only consulted
    /// for `VerticalPassage` — `Elevator` connections are always two-way.
    pub one_way_vertical_passage_chance: f64,
    /// Direction balance for a one-way `VerticalPassage`, relative to the already-resolved target
    /// floor: `0.0` = always toward the src floor, `1.0` = always toward the target floor.
    pub vertical_up_down_balance: f64,
    /// Minimum number of floors a single `Elevator` connects (inclusive).
    pub elevator_span_min: usize,
    /// Maximum number of floors a single `Elevator` connects (inclusive).
    pub elevator_span_max: usize,
    /// Branching distribution for an elevator's floor count, same shape as `branching`/
    /// `junction_count` but starting from `elevator_span_min` instead of a hardcoded `2`.
    pub elevator_branching: f64,
    /// Whether an elevator's floor set may skip floors (non-contiguous) rather than only span a
    /// contiguous run.
    pub allow_non_consecutive_elevator_floors: bool,
    /// `CustomVertexBased`-only (GitHub issue #450): when picking a node from the reserve after the
    /// frontier empties, prefer candidates that have a visited neighbor on their *own* floor over
    /// ones reachable only via a vertical neighbor. Biases growth toward locally connected regions
    /// giving more horizontal connectivity and fewer vertical passages. No effect on a single-floor
    /// field (every reserve candidate is same-floor) — see `vertex_based.rs`'s reserve scan.
    /// Default `false`.
    pub reserve_prefer_same_floor: bool,
}

impl Default for ElementsConfig {
    fn default() -> Self {
        ElementsConfig {
            one_way_chance: 0.0,
            teleport_chance: 0.0,
            teleport_one_way_chance: 0.0,
            split_chance: 0.0,
            cross_floor_teleport_balance: 0.0,
            vertical_chance: 0.0,
            vertical_passage_elevator_balance: 0.5,
            one_way_vertical_passage_chance: 0.0,
            vertical_up_down_balance: 0.5,
            elevator_span_min: 2,
            elevator_span_max: 2,
            elevator_branching: 0.5,
            allow_non_consecutive_elevator_floors: false,
            reserve_prefer_same_floor: false,
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
pub enum GenerationAlgorithm {
    CustomVertexBased(GenerationParams),
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
///
/// `level` (GitHub issue #340) is the endpoint's 0-based position in `levels_ordered()` — the same
/// index space `level_fields`/`NodeDto.level` already use. `None` means level 0, so every
/// pre-#340 caller (single-level mazes, all Rust-side unit tests) is unaffected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresetEndpoint {
    pub point: (i32, i32),
    pub slot: Option<u32>,
    pub level: Option<u32>,
}

impl PresetEndpoint {
    pub fn original(point: (i32, i32)) -> Self {
        Self { point, slot: None, level: None }
    }
}

#[derive(Debug, Clone)]
pub struct PresetConnection {
    pub from: PresetEndpoint,
    pub to:   PresetEndpoint,
    pub state: PresetConnectionState,
}

/// Direction of a preset `VerticalPassage` — mirrors `TeleportDirection` but without `TwoWay`'s
/// counterpart being a *third* variant: a two-way passage is simply `one_way: None` on
/// `PresetVerticalPassage` (see that struct's own doc comment), so this enum only ever needs to
/// distinguish which of the two adjacent floors is the arrival end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerticalPassageDirection {
    /// Passage runs `from -> to`.
    Forward,
    /// Passage runs `to -> from`.
    Backward,
}

/// A user-placed `VerticalPassage` preset (GitHub issue #357) — planted directly into the graph by
/// `build_preset_state`, exactly like a preset `Passage`/`OneWay` connection, rather than treated
/// as an extra traversable neighbor the way preset `Teleport` is (see `PresetState::preset_teleports`'s
/// doc comment) — a vertical passage is a guaranteed structural connection between two floors, not
/// an optional shortcut generation may or may not route through. Kept as its own top-level
/// `GenerationConfig` field (not folded into `PresetConnectionState`) since its two endpoints
/// aren't required to be geometrically adjacent (they live on different floors), the same reason
/// preset teleports get their own field on the client side (`Specs/preset-connections.md`).
///
/// `from`/`to` must resolve to nodes on **adjacent** floors (by `levels_ordered()` position) — the
/// same constraint `vertex_based.rs`'s own generation-time `VerticalPassage` growth enforces. The
/// client is responsible for only ever sending adjacent-floor endpoints (mirrors every other
/// preset endpoint's "client pre-filters invalid entries" contract, `Specs/preset-connections.md`);
/// `build_preset_state` does not re-validate adjacency and simply plants whatever resolved edge it
/// is given.
#[derive(Debug, Clone)]
pub struct PresetVerticalPassage {
    pub from: PresetEndpoint,
    pub to:   PresetEndpoint,
    /// `None` = two-way (both directions planted). `Some(dir)` = one-way in that direction.
    pub one_way: Option<VerticalPassageDirection>,
}

/// A user-placed `Elevator` preset (GitHub issue #357) — a fully-connected two-way fan across
/// `floors.len()` nodes, planted directly into the graph the same way `PresetVerticalPassage` is
/// (guaranteed structural connections, not extra-traversable-neighbor shortcuts). Unlike the
/// generation-time `Elevator` (`vertex_based.rs`), a preset elevator's floors need not be
/// contiguous or ordered — `build_preset_state` simply connects every pair.
#[derive(Debug, Clone)]
pub struct PresetElevator {
    /// One endpoint per floor the elevator reaches — always resolved against the same (x, y)
    /// point, differing only in `level` (client-side placement constraint, `Specs/preset-connections.md`).
    pub floors: Vec<PresetEndpoint>,
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
    /// User-placed `VerticalPassage` presets (GitHub issue #357) — see `PresetVerticalPassage`'s
    /// own doc comment for why these live in their own field rather than `preset_connections`.
    pub preset_vertical_passages: Vec<PresetVerticalPassage>,
    /// User-placed `Elevator` presets (GitHub issue #357) — see `PresetElevator`'s own doc comment.
    pub preset_elevators:   Vec<PresetElevator>,
    pub locked_nodes:       Vec<LockedNode>,
    /// Extra nodes to create at declared points before any preset above is resolved — one entry
    /// per `(point, slot, level)` triple (GitHub issue #231; `level` added by #340 — 0-based
    /// `levels_ordered()` index, same space `PresetEndpoint.level` uses). Applied via
    /// `MultiLevelField::add_node_at` in `(level, point, slot)`-sorted order by
    /// `build_preset_state`, mirroring `apply_split_points` (`maze-wasm/src/analytics.rs`) for
    /// post-edit's split nodes.
    pub split_points: Vec<((i32, i32), u32, u32)>,
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
            preset_vertical_passages: vec![],
            preset_elevators:   vec![],
            locked_nodes:       vec![],
            split_points:       vec![],
            split_generation:   crate::generation::split_pattern::SplitGenerationConfig::default(),
        }
    }
}

