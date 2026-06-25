use crate::quality_control::IssueKind;

/// Identifies a check type (`available_checks()`'s `CheckDescriptor.id`). Used internally for
/// routing/matching (rule membership, issue attribution) — `as_str`/`from_str` exist only for
/// the wire boundary (wasm config parsing, serialization), same pattern as `IssueKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CheckId {
    MissingEndpoints,
    UnreachableFinish,
    MinLoopsCount,
    MinLoopLength,
    MaxLoopLength,
    ExternalEscapeDiversity,
}

impl CheckId {
    pub fn as_str(self) -> &'static str {
        match self {
            CheckId::MissingEndpoints => "missing_endpoints",
            CheckId::UnreachableFinish => "unreachable_finish",
            CheckId::MinLoopsCount => "min_loops_count",
            CheckId::MinLoopLength => "min_loop_length",
            CheckId::MaxLoopLength => "max_loop_length",
            CheckId::ExternalEscapeDiversity => "external_escape_diversity",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "missing_endpoints" => Some(CheckId::MissingEndpoints),
            "unreachable_finish" => Some(CheckId::UnreachableFinish),
            "min_loops_count" => Some(CheckId::MinLoopsCount),
            "min_loop_length" => Some(CheckId::MinLoopLength),
            "max_loop_length" => Some(CheckId::MaxLoopLength),
            "external_escape_diversity" => Some(CheckId::ExternalEscapeDiversity),
            _ => None,
        }
    }
}

impl std::fmt::Display for CheckId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A user-defined QC rule: a set of checks producing the same `IssueKind`, sharing one repair
/// strategy. Caller-supplied configuration (built by the wasm layer from
/// `GenerateConfig.qc_rules`), not generated or interpreted by core. `id` is opaque — core
/// never inspects its content, only uses it as a lookup/dedup key for one `build_maze` call.
pub struct QcRule {
    pub id: String,
    pub kind: IssueKind,
    pub checks: Vec<CheckId>,
}
