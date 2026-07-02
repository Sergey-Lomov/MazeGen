/// A user-defined, named, ordered group of `QcRule` ids. `RepairEngine` dispatches rules one
/// stage at a time — see `Specs/repair.md`'s "Stages" section. Caller-supplied configuration
/// (built by `maze-runner`/`maze-wasm` from `GenerateConfig.stages`), not generated or
/// interpreted by core beyond grouping. `id` is opaque, same role as `QcRule.id`.
pub struct RepairStage {
    pub id: String,
    pub name: String,
    /// Order is significant for UI/serialization round-trip, not for repair dispatch order
    /// within the stage — `RepairEngine::run` resolves rules by id via `HashMap` lookup
    /// regardless of `rule_ids` order. Includes every rule in this stage, strategy or not (same
    /// role `RepairEngine.all_rules` plays today) — a rule without a strategy has no dispatch
    /// consequence but still needs a stage for merge/attribution routing.
    pub rule_ids: Vec<String>,
}
