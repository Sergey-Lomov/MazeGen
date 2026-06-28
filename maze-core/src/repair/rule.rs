use crate::quality_control::IssueKind;

/// A user-defined QC rule: a set of checks producing the same `IssueKind`, sharing one repair
/// strategy. Caller-supplied configuration (built by the wasm layer from
/// `GenerateConfig.qc_rules`), not generated or interpreted by core. `id` is opaque — core
/// never inspects its content, only uses it as a lookup/dedup key for one `build_maze` call.
/// `checks` holds opaque per-instance composite ids (`{rule_id}:{local_id}`, minted by
/// `maze-wasm/src/runner.rs`'s `composite_check_id`) — not check type ids. This lets multiple
/// instances of the same check type be active independently (see GitHub issue #60); core never
/// parses these ids back apart, only uses them as routing/dedup keys.
pub struct QcRule {
    pub id: String,
    pub kind: IssueKind,
    pub checks: Vec<String>,
}
