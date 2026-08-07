/// Descriptor for a single rule-level parameter — see GitHub issue #253. Mirrors
/// `repair::params::StrategyParam`'s shape, but is not tied to `RepairStrategy`/`StrategyParams`:
/// a `Check` consumes rule-level params too, and `Check` has no params concept of its own.
pub struct RuleParamDescriptor {
    pub id: &'static str,
    pub kind: RuleParamKind,
    /// Check `type_id`s and strategy `id`s that actually consume this parameter — a rule only
    /// shows/resolves this parameter when at least one of its own checks or its strategy appears
    /// here. Not every rule shares the same rule-level parameter set (e.g. `protect_route` is
    /// meaningless for a `min_region_count` rule) — this list is the single source of truth for
    /// that relevance filter, mirrored by `maze-wasm`'s DTO and read by the web UI.
    pub applies_to: &'static [&'static str],
}

pub enum RuleParamKind {
    Bool { default: bool },
}

pub const PARAM_PROTECT_ROUTE: &str = "protect_route";

/// Single source of truth for every rule-level parameter's id/type/default — both
/// `maze-runner`'s `resolve_rule_params` and `maze-wasm`'s rule-level descriptor DTO are built
/// from this list, never duplicating an id/default independently.
pub const RULE_PARAM_DESCRIPTORS: &[RuleParamDescriptor] = &[
    RuleParamDescriptor {
        id: PARAM_PROTECT_ROUTE,
        kind: RuleParamKind::Bool { default: true },
        applies_to: &[
            "teleport_duplicates_connection",
            "teleport_waypoint_distance",
            "teleport_geometric_length",
            "teleport_graph_distance",
            "teleport_super_hub_avoidance",
            "teleport_split_intersection",
            "teleport_group_proximity",
            "one_way_waypoint_distance",
            "one_way_group_geometric_proximity",
            "one_way_group_graph_proximity",
            "region_shrink_split",
            "teleport_group_select",
            "one_way_group_select",
            "add_split",
        ],
    },
];

/// Resolved rule-level parameter values — see GitHub issue #253. One `RuleParams` is built once
/// per `Rule` at factory construction time (`maze-runner`'s `build_rule_for!`) and shared by every
/// check/strategy in that rule; there is no per-check/per-strategy override for a migrated
/// parameter.
#[derive(Clone, Copy, Debug)]
pub struct RuleParams {
    pub protect_route: bool,
}

impl Default for RuleParams {
    fn default() -> Self {
        Self { protect_route: default_bool(PARAM_PROTECT_ROUTE) }
    }
}

fn default_bool(id: &str) -> bool {
    RULE_PARAM_DESCRIPTORS.iter()
        .find(|d| d.id == id)
        .map(|d| match d.kind { RuleParamKind::Bool { default } => default })
        .unwrap_or(false)
}

/// True if `param_id` is a known rule-level parameter that `member_id` (a check `type_id` or
/// strategy `id`) actually consumes — derived from `RULE_PARAM_DESCRIPTORS.applies_to`, the single
/// source of truth. Used by `maze-runner`'s factory layer to reject a migrated parameter's key if
/// it's still present in that member's own local `params` (GitHub issue #253's "no override"
/// contract) — replaces what used to be two independent hardcoded lists (a check-side literal
/// string compare and a strategy-side `&[&str]` const), both of which could silently drift from
/// `applies_to` as new rule-level params are added.
pub fn rule_param_applies_to(param_id: &str, member_id: &str) -> bool {
    RULE_PARAM_DESCRIPTORS.iter()
        .find(|d| d.id == param_id)
        .is_some_and(|d| d.applies_to.contains(&member_id))
}
