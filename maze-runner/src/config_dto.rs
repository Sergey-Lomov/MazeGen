use std::collections::HashMap;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct StrategyConfig {
    pub id: String,
    #[serde(default)]
    pub params: HashMap<String, String>,
    /// Which of the parent strategy's `expected_nested()` slots this fills. Required (`Some`)
    /// whenever this `StrategyConfig` appears inside another one's `nested`; must be `None` for
    /// the top-level entry in `QcRuleConfig.strategy`, which has no parent slot to fill.
    /// `Option`, not a plain `String` with `#[serde(default)]` — a missing/empty value must be
    /// a visible `None`, not silently coerced to `""` and only failing later inside
    /// `build_nested` (see `Specs/repair.md`'s nested-strategy pattern).
    #[serde(default)]
    pub slot_id: Option<String>,
    /// Nested strategy assignments, in configured order — empty for every strategy without
    /// nested slots. Recursive.
    #[serde(default)]
    pub nested: Vec<StrategyConfig>,
}

#[derive(Deserialize, Clone)]
pub struct CheckInstanceConfig {
    pub local_id: String,
    pub type_id: String,
    #[serde(default)]
    pub params: HashMap<String, String>,
}

#[derive(Deserialize)]
pub struct QcRuleConfig {
    pub id: String,
    pub checks: Vec<CheckInstanceConfig>,
    #[serde(default)]
    pub strategy: Option<StrategyConfig>,
    /// Rule-level parameters (GitHub issue #253) — a value configured once on the rule, shared by
    /// every check/strategy in it that has been migrated to consume it (e.g. `protect_route`).
    /// Resolved once via `resolve_rule_params` in `build_rule_for!`. Not a fallback/override
    /// layer: a migrated parameter has no per-check/per-strategy equivalent anymore.
    #[serde(default)]
    pub params: HashMap<String, String>,
}

/// A named, ordered group of rules — see `Specs/repair.md`'s "Stages" section and issue #65.
/// `id` is opaque, must be unique across every stage in a `GenerateConfig`. `rules` is this
/// stage's own rule list (not a separate id-reference list) — see plan's "Отдельное 'stages',
/// check_rules уходит" decision.
#[derive(Deserialize)]
pub struct StageConfig {
    pub id: String,
    pub name: String,
    pub rules: Vec<QcRuleConfig>,
}

#[derive(Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TessellationType {
    Square,
    Hex,
    Tri,
}

#[derive(Deserialize)]
pub struct TessellationConfig {
    pub tessellation_type: TessellationType,
}

impl Default for TessellationConfig {
    fn default() -> Self {
        TessellationConfig { tessellation_type: TessellationType::Square }
    }
}

#[derive(Deserialize, Default)]
pub struct GenerationParamsConfig {
    pub depth_first:     Option<f64>,
    pub corridor_chance: Option<f64>,
    pub branching:       Option<f64>,
    pub directionality:  Option<f64>,
    pub cyclicity:       Option<f64>,
}

#[derive(Deserialize, Default)]
pub struct ElementsConfigDto {
    pub one_way_chance: Option<f64>,
    pub teleport_chance: Option<f64>,
    pub teleport_one_way_chance: Option<f64>,
    pub split_chance: Option<f64>,
    pub cross_floor_teleport_balance: Option<f64>,
    pub vertical_chance: Option<f64>,
    pub vertical_passage_elevator_balance: Option<f64>,
    pub one_way_vertical_passage_chance: Option<f64>,
    pub vertical_up_down_balance: Option<f64>,
    pub elevator_span_min: Option<usize>,
    pub elevator_span_max: Option<usize>,
    pub elevator_branching: Option<f64>,
    pub allow_non_consecutive_elevator_floors: Option<bool>,
    pub reserve_prefer_same_floor: Option<bool>,
}

/// Wire shape for `maze_core::generation::SplitFaceRequirement` (GitHub issue #222).
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SplitFaceRequirementDto {
    Passage,
    OneWay { direction: OneWayDirectionDto },
    Wall,
    Unspecified,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OneWayDirectionDto {
    Forward,
    Backward,
}

/// Wire shape for `maze_core::generation::SplitPatternFace`. `face_index` is passed through
/// unvalidated here — this layer isn't generic over a concrete `T: Tessellation` yet, so the
/// degree-range check happens later, in `dispatch`/`run_generate_typed` (see
/// `Specs`/plan section 3.6).
#[derive(Deserialize)]
pub struct SplitPatternFaceDto {
    pub face_index: usize,
    pub requirement: SplitFaceRequirementDto,
    #[serde(default)]
    pub sibling_target: Option<usize>,
}

/// Wire shape for `maze_core::generation::SplitPattern`.
#[derive(Deserialize)]
pub struct SplitPatternDto {
    pub node_count: usize,
    pub faces: Vec<Vec<SplitPatternFaceDto>>,
    #[serde(default = "default_pattern_weight")]
    pub weight: f64,
}

fn default_pattern_weight() -> f64 { 1.0 }

/// Wire shape for `maze_core::generation::SplitGenerationConfig`.
#[derive(Deserialize, Default)]
pub struct SplitGenerationConfigDto {
    #[serde(default)]
    pub pattern_mode: bool,
    pub max_split_nodes: Option<u32>,
    #[serde(default)]
    pub patterns: Vec<SplitPatternDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresetConnectionStateDto {
    Wall,
    Passage,
    OneWayForward,
    OneWayBackward,
    TeleportForward,
    TeleportBackward,
    TeleportTwoWay,
}

/// Wire shape for a preset endpoint (GitHub issue #231) — a point plus an optional slot
/// addressing one of that point's declared extra ("split") nodes. `slot: None` means the point's
/// original node. `level` (GitHub issue #340) is the endpoint's 0-based `levels_ordered()` index;
/// `None` means level 0, backward-compatible with every pre-#340 config. Mirrors
/// `maze-core::generation::PresetEndpoint`.
#[derive(Deserialize)]
pub struct PresetEndpointDto {
    pub point: [i32; 2],
    #[serde(default)]
    pub slot: Option<u32>,
    #[serde(default)]
    pub level: Option<u32>,
}

#[derive(Deserialize)]
pub struct PresetConnectionDto {
    pub from: PresetEndpointDto,
    pub to:   PresetEndpointDto,
    pub state: PresetConnectionStateDto,
}

/// Wire shape for `maze_core::generation::VerticalPassageDirection`.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerticalPassageDirectionDto {
    Forward,
    Backward,
}

/// Wire shape for a preset `VerticalPassage` (GitHub issue #357) — see
/// `maze_core::generation::PresetVerticalPassage`'s own doc comment for why this is a separate
/// top-level config field rather than a `PresetConnectionStateDto` variant.
#[derive(Deserialize)]
pub struct PresetVerticalPassageDto {
    pub from: PresetEndpointDto,
    pub to:   PresetEndpointDto,
    #[serde(default)]
    pub one_way: Option<VerticalPassageDirectionDto>,
}

/// Wire shape for a preset `Elevator` (GitHub issue #357) — see
/// `maze_core::generation::PresetElevator`'s own doc comment.
#[derive(Deserialize)]
pub struct PresetElevatorDto {
    pub floors: Vec<PresetEndpointDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeLockKindDto {
    In,
    Out,
    Both,
}

#[derive(Deserialize)]
pub struct LockedNodeDto {
    pub point: PresetEndpointDto,
    pub kind:  NodeLockKindDto,
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum InitialGenerationConfig {
    CustomVertexBased(GenerationParamsConfig),
    RecursiveBacktracker,
    WilsonAlgorithm,
    KruskalAlgorithm,
}

impl Default for InitialGenerationConfig {
    fn default() -> Self {
        InitialGenerationConfig::CustomVertexBased(GenerationParamsConfig::default())
    }
}

/// Default single-level field points (10x10 square, centered) — used by `GenerateConfig`'s
/// `#[serde(default)]` when `level_fields` is entirely absent, matching `TessellationConfig`'s
/// old default shape.
pub fn default_level_fields() -> Vec<Vec<[i32; 2]>> {
    let w = 10i32;
    let h = 10i32;
    let ox = w / 2;
    let oy = h / 2;
    let points: Vec<[i32; 2]> = (0..w).flat_map(|x| (0..h).map(move |y| [x - ox, y - oy])).collect();
    vec![points]
}
