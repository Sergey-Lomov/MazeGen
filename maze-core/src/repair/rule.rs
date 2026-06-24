use crate::quality_control::IssueKind;

/// Newtype over a check id (`available_checks()`'s `CheckDescriptor.id`, e.g. `"min_loop_length"`).
/// Wraps `&'static str` today — exists so future extensions (e.g. instance ids) don't require
/// rewriting every signature that takes a check id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CheckId(pub &'static str);

/// A user-defined QC rule: a set of checks producing the same `IssueKind`, sharing one repair
/// strategy. Caller-supplied configuration (built by the wasm layer from
/// `GenerateConfig.qc_rules`), not generated or interpreted by core. `id` is opaque — core
/// never inspects its content, only uses it as a lookup/dedup key for one `build_maze` call.
pub struct QcRule {
    pub id: String,
    pub kind: IssueKind,
    pub checks: Vec<CheckId>,
}
