use std::collections::HashMap;
use crate::quality_control::issue_data::IssueData;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IssueKind {
    MissingEndpoints,
    UnreachableFinish,
    InvalidLoop,
    MissingLoops,
    CycleAnalysisOverflowed,
    RepairLimitReached,
    QcNoProgress,
    ExcessiveSccCount,
    RegionNeedsExpansion,
    MissingRegions,
    InvalidTeleport,
}

pub const MISSING_ENDPOINTS: IssueKind = IssueKind::MissingEndpoints;
pub const UNREACHABLE_FINISH: IssueKind = IssueKind::UnreachableFinish;
/// A cycle is invalid for some check-specific reason (currently: shorter than a configured
/// minimum tile-length — see `MinLoopLengthCheck`). Future checks may flag cycles invalid for
/// other reasons entirely (e.g. too long) and reuse this same kind — see `IssueData::InvalidLoops`
/// and `Issue.source_checks` for how multiple checks contributing to one kind are distinguished.
pub const INVALID_LOOP: IssueKind = IssueKind::InvalidLoop;
/// The maze has fewer loops than some check requires (currently only `MinLoopsCountCheck`).
/// Mirrors `INVALID_LOOP`'s role for invalid cycles, but for a missing-count condition instead
/// of a specific-cycle one — future checks needing more loops added can reuse this kind. Carries
/// `IssueData::Missing { missing }` — see that variant's doc comment.
pub const MISSING_LOOPS: IssueKind = IssueKind::MissingLoops;
/// Not a toggleable QC check — raised directly by `build_analytics_snapshot`
/// (maze-wasm/src/analytics.rs) whenever `GraphAnalytics::cycle_analysis_overflowed` is true.
/// Unlike the other kinds here, no `Check<T>` implementation produces this; it surfaces a
/// condition from the always-on analytics computation, not a user-selected check.
pub const CYCLE_ANALYSIS_OVERFLOWED: IssueKind = IssueKind::CycleAnalysisOverflowed;
/// Not a toggleable QC check — pushed directly by `build_maze` (`generation::pipeline`) when the
/// repair fixpoint loop exits because a `RepairLimits` bound was hit (max iterations or time
/// budget), rather than via convergence (no active issues) or no-progress. Carries
/// `IssueData::RepairLimitReached { limit }` identifying which bound fired. Surfaces as a
/// critical analytics issue so the user can tell "still broken because the cap cut repair short"
/// apart from "still broken because no strategy could fix it".
pub const REPAIR_LIMIT_REACHED: IssueKind = IssueKind::RepairLimitReached;
/// Not a toggleable QC check — pushed directly by `build_maze` when the repair fixpoint loop
/// exits via the no-progress guard (the same `(rule_id, Issue)` set repeated identically across
/// two iterations), rather than via convergence or a `RepairLimits` cap. Carries
/// `IssueData::QcNoProgress { rule_ids }` naming the stuck rule(s) — typically a sign of two
/// active rules whose strategies fight to a net-zero change each iteration (e.g. contradictory
/// min/max thresholds on the same metric), distinct from simply running out of iterations/time.
pub const QC_NO_PROGRESS: IssueKind = IssueKind::QcNoProgress;
/// The graph is split into more strongly-connected components than a check's configured limit
/// allows (currently only `SccCountCheck`) — often signals a poorly-connected or fragmented
/// maze even when other checks pass. Reuses `build_scc` (`graph::scc`) rather than
/// re-implementing SCC computation.
pub const EXCESSIVE_SCC_COUNT: IssueKind = IssueKind::ExcessiveSccCount;
/// An SCC region needs to be expanded for some check-specific reason (currently: smaller than a
/// configured absolute tile count, or smaller than a configured share of the field — see
/// `MinRegionSizeCheck`/`MinRegionRatioCheck`). Mirrors `INVALID_LOOP`'s role for cycles: a
/// semantic category, not tied to size specifically or to any one reason — future checks may
/// flag a region as needing expansion for reasons unrelated to size and reuse this same kind.
/// Carries `IssueData::RegionsNeedingExpansion` — see that variant's doc comment.
pub const REGION_NEEDS_EXPANSION: IssueKind = IssueKind::RegionNeedsExpansion;
/// The maze has fewer regions of some `RegionClass` than a check's configured minimum requires
/// (currently only `MinRegionCountCheck`) — e.g. guaranteeing at least N trap or alternative-route
/// regions for structural variety. Carries `IssueData::MissingRegions { missing_by_class }` —
/// see that variant's doc comment. No `RepairStrategy` registered yet for this kind.
pub const MISSING_REGIONS: IssueKind = IssueKind::MissingRegions;
/// A teleport edge (`EdgeKind::Teleport`) is invalid for some check-specific reason (currently:
/// a regular, non-teleport connection already exists between the same pair in the same direction
/// — see `TeleportDuplicatesConnectionCheck`). Mirrors `INVALID_LOOP`'s role for cycles: a
/// semantic category, not tied to one specific reason — future per-teleport validation checks
/// (geometric length, waypoint distance, super-hub avoidance) may flag teleports invalid for
/// other reasons and reuse this same kind. Carries `IssueData::InvalidTeleports` — see that
/// variant's doc comment.
pub const INVALID_TELEPORT: IssueKind = IssueKind::InvalidTeleport;

impl IssueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueKind::MissingEndpoints => "missing_endpoints",
            IssueKind::UnreachableFinish => "unreachable_finish",
            IssueKind::InvalidLoop => "invalid_loop",
            IssueKind::MissingLoops => "missing_loops",
            IssueKind::CycleAnalysisOverflowed => "cycle_analysis_overflowed",
            IssueKind::RepairLimitReached => "repair_limit_reached",
            IssueKind::QcNoProgress => "qc_no_progress",
            IssueKind::ExcessiveSccCount => "excessive_scc_count",
            IssueKind::RegionNeedsExpansion => "region_needs_expansion",
            IssueKind::MissingRegions => "missing_regions",
            IssueKind::InvalidTeleport => "invalid_teleport",
        }
    }

    /// Round-trips every variant including `CycleAnalysisOverflowed`, even though the latter
    /// can never have a registered `RepairStrategy` (it's not a toggleable QC check — see
    /// `CYCLE_ANALYSIS_OVERFLOWED`'s doc comment). `IssueKind::from_str` is also used by
    /// `maze-wasm/src/runner.rs` to validate `config.strategies` keys; a config naming this
    /// kind will parse here, then fail downstream with "unknown strategy" the same way any
    /// other kind with no matching strategy registration would — there is no dedicated
    /// rejection at this layer, by design, since strategy availability is the repair engine's
    /// concern, not `IssueKind`'s.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "missing_endpoints"  => Some(IssueKind::MissingEndpoints),
            "unreachable_finish" => Some(IssueKind::UnreachableFinish),
            "invalid_loop"       => Some(IssueKind::InvalidLoop),
            "missing_loops"      => Some(IssueKind::MissingLoops),
            "cycle_analysis_overflowed" => Some(IssueKind::CycleAnalysisOverflowed),
            "repair_limit_reached" => Some(IssueKind::RepairLimitReached),
            "qc_no_progress" => Some(IssueKind::QcNoProgress),
            "excessive_scc_count" => Some(IssueKind::ExcessiveSccCount),
            "region_needs_expansion" => Some(IssueKind::RegionNeedsExpansion),
            "missing_regions" => Some(IssueKind::MissingRegions),
            "invalid_teleport" => Some(IssueKind::InvalidTeleport),
            _ => None,
        }
    }
}

impl std::fmt::Display for IssueKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub kind: IssueKind,
    pub data: Option<IssueData>,
    /// Opaque check id(s) that produced or contributed to this issue — the same id passed to
    /// `new_from_check`/`with_data_from_check`, expected to be `maze-wasm/src/runner.rs`'s
    /// composite routing key (not a `CheckId` — see `CheckId`'s doc comment for why attribution
    /// no longer uses it). Empty for issues not raised by a toggleable `Check<T>` — currently
    /// only `CYCLE_ANALYSIS_OVERFLOWED`, pushed directly by `build_analytics_snapshot` (see its
    /// doc comment). Merging two issues of the same kind (pipeline dedup) unions this list
    /// without duplicates.
    ///
    /// Private — a raw (pre-merge) `Issue` must carry exactly one source check, and the pipeline's
    /// rule-routing (`pipeline.rs`) reads only the first element under that assumption. Making
    /// this a public `Vec` field let any code construct an `Issue` with 0 or 2+ raw sources,
    /// bypassing `new_from_check`/`with_data_from_check` — a release build (no `debug_assert`)
    /// would then silently route by an arbitrary single id, dropping the rest. `source_checks()`
    /// exposes the list read-only; `push_source` is the only way to add to it, used solely by
    /// `merge_issue` after merge has already established the issue may legitimately carry several.
    source_checks: Vec<String>,
    /// Generic per-source-check display data, e.g. `"max_loop_length" -> {"threshold" -> "100"}`.
    /// Raw values only (numbers/ids as strings) — never assembled messages; the web UI owns all
    /// wording and looks values up by key via its own i18n templates keyed by check id. Keyed by
    /// check id (not merged into one flat map) because a merged `Issue` may carry details from
    /// several checks at once (e.g. `min_loop_length`'s and `max_loop_length`'s thresholds both
    /// present on one merged `INVALID_LOOP` issue) and a UI bubble is rendered per source check.
    details: HashMap<String, HashMap<&'static str, String>>,
}

impl Issue {
    /// For issues not raised by a toggleable `Check<T>` (currently only
    /// `CYCLE_ANALYSIS_OVERFLOWED`) — `source_checks` is empty since there is no check id to
    /// attribute this to. Checks should use `new_from_check` instead.
    pub fn new(kind: IssueKind) -> Self {
        Self { kind, data: None, source_checks: Vec::new(), details: HashMap::new() }
    }

    pub fn with_data(kind: IssueKind, data: IssueData) -> Self {
        Self { kind, data: Some(data), source_checks: Vec::new(), details: HashMap::new() }
    }

    pub fn new_from_check(kind: IssueKind, source_check: &str) -> Self {
        Self { kind, data: None, source_checks: vec![source_check.to_string()], details: HashMap::new() }
    }

    pub fn with_data_from_check(kind: IssueKind, data: IssueData, source_check: &str) -> Self {
        Self { kind, data: Some(data), source_checks: vec![source_check.to_string()], details: HashMap::new() }
    }

    /// Attaches a display detail under `source_check` (raw value only, e.g. a threshold —
    /// never an assembled message, see `details`' doc comment above). Chainable — a `Check`
    /// calls this right after constructing its `Issue` via `new_from_check`/`with_data_from_check`.
    /// `source_check` should be the same id the issue was constructed with.
    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.details.entry(source_check.to_string()).or_default().insert(key, value);
        self
    }

    pub fn source_checks(&self) -> &[String] {
        &self.source_checks
    }

    /// Display details keyed by source check id, then by detail key — see `details`' doc
    /// comment for why this isn't a flat map.
    pub fn details(&self) -> &HashMap<String, HashMap<&'static str, String>> {
        &self.details
    }

    /// The check id this raw (pre-merge) issue should route by — `Some` only when there is
    /// exactly one source check, `None` for zero (e.g. `CYCLE_ANALYSIS_OVERFLOWED`) or for an
    /// already-merged issue (2+ sources). Pipeline routing (`pipeline.rs`) must use this instead
    /// of indexing `source_checks()` directly, so a malformed 2+-source raw issue is routed to
    /// "no rule" (safe, same as 0 sources) rather than silently picked by an arbitrary first id.
    pub fn single_source_check(&self) -> Option<&str> {
        match self.source_checks.as_slice() {
            [only] => Some(only.as_str()),
            _ => None,
        }
    }

    /// Adds `source` to this issue's recorded sources if not already present — the only way to
    /// grow `source_checks` past its construction-time value. Used exclusively by `merge_issue`
    /// once two issues are confirmed to share a rule and are being combined into one.
    pub(crate) fn push_source(&mut self, source: &str) {
        if !self.source_checks.iter().any(|s| s == source) {
            self.source_checks.push(source.to_string());
        }
    }

    /// Merges `incoming`'s details into `self`'s, keyed by source check id. Since each check id
    /// only ever appears as a raw (pre-merge) issue's sole source, `incoming`'s entries simply
    /// overwrite any existing entry for the same check id — there is no same-check-id conflict
    /// to reconcile. Used exclusively by `merge_issue` (`pipeline.rs`).
    pub(crate) fn merge_details(&mut self, incoming: HashMap<String, HashMap<&'static str, String>>) {
        self.details.extend(incoming);
    }

    /// Takes `self`'s details by value, leaving an empty map behind — lets `merge_issue` fold an
    /// `incoming: Issue` (consumed by value anyway) into `existing` without cloning.
    pub(crate) fn take_details(&mut self) -> HashMap<String, HashMap<&'static str, String>> {
        std::mem::take(&mut self.details)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue_data::IssueData;

    #[test]
    fn with_data_round_trip() {
        let issue = Issue::with_data(MISSING_LOOPS, IssueData::TestPayload(vec![1, 2, 3]));
        assert_eq!(issue.kind, MISSING_LOOPS);
        assert_eq!(issue.data, Some(IssueData::TestPayload(vec![1, 2, 3])));
        let cloned = issue.clone();
        assert_eq!(issue, cloned);
    }

    #[test]
    fn new_has_no_data() {
        let issue = Issue::new(MISSING_ENDPOINTS);
        assert_eq!(issue.data, None);
        assert!(issue.source_checks().is_empty());
    }

    #[test]
    fn with_detail_attaches_value_under_source_check() {
        let issue = Issue::new_from_check(INVALID_LOOP, "max_loop_length")
            .with_detail("max_loop_length", "threshold", "100".to_string());
        let details = issue.details();
        assert_eq!(details.get("max_loop_length").and_then(|kv| kv.get("threshold")), Some(&"100".to_string()));
    }

    #[test]
    fn merge_details_keeps_each_source_checks_details_separate() {
        let mut a = Issue::new_from_check(INVALID_LOOP, "min_loop_length")
            .with_detail("min_loop_length", "threshold", "10".to_string());
        let b = Issue::new_from_check(INVALID_LOOP, "max_loop_length")
            .with_detail("max_loop_length", "threshold", "100".to_string());
        a.merge_details(b.details().clone());
        assert_eq!(a.details().get("min_loop_length").and_then(|kv| kv.get("threshold")), Some(&"10".to_string()));
        assert_eq!(a.details().get("max_loop_length").and_then(|kv| kv.get("threshold")), Some(&"100".to_string()));
    }

    #[test]
    fn new_from_check_records_source() {
        let issue = Issue::new_from_check(MISSING_ENDPOINTS, "missing_endpoints");
        assert_eq!(issue.source_checks(), vec!["missing_endpoints".to_string()]);
    }

    #[test]
    fn single_source_check_returns_the_one_source() {
        let issue = Issue::new_from_check(MISSING_ENDPOINTS, "missing_endpoints");
        assert_eq!(issue.single_source_check(), Some("missing_endpoints"));
    }

    #[test]
    fn single_source_check_is_none_for_zero_sources() {
        let issue = Issue::new(MISSING_ENDPOINTS);
        assert_eq!(issue.single_source_check(), None);
    }

    #[test]
    fn single_source_check_is_none_after_a_second_source_is_pushed() {
        let mut issue = Issue::new_from_check(MISSING_ENDPOINTS, "missing_endpoints");
        issue.push_source("unreachable_finish");
        assert_eq!(issue.single_source_check(), None,
            "an issue with 2+ sources (e.g. post-merge) must not look like a routable single-source issue");
    }

    #[test]
    fn push_source_does_not_duplicate_an_existing_source() {
        let mut issue = Issue::new_from_check(MISSING_ENDPOINTS, "missing_endpoints");
        issue.push_source("missing_endpoints");
        assert_eq!(issue.source_checks(), vec!["missing_endpoints".to_string()]);
    }

    #[test]
    fn push_source_appends_a_new_source() {
        let mut issue = Issue::new_from_check(MISSING_ENDPOINTS, "missing_endpoints");
        issue.push_source("unreachable_finish");
        assert_eq!(issue.source_checks(), vec!["missing_endpoints".to_string(), "unreachable_finish".to_string()]);
    }

    #[test]
    fn as_str_from_str_round_trip_for_every_variant() {
        let kinds = [
            IssueKind::MissingEndpoints,
            IssueKind::UnreachableFinish,
            IssueKind::InvalidLoop,
            IssueKind::MissingLoops,
            IssueKind::CycleAnalysisOverflowed,
            IssueKind::RepairLimitReached,
            IssueKind::QcNoProgress,
            IssueKind::ExcessiveSccCount,
            IssueKind::RegionNeedsExpansion,
            IssueKind::MissingRegions,
            IssueKind::InvalidTeleport,
        ];
        for kind in kinds {
            assert_eq!(IssueKind::from_str(kind.as_str()), Some(kind));
        }
    }

    #[test]
    fn from_str_rejects_unknown_string() {
        assert_eq!(IssueKind::from_str("not_a_real_kind"), None);
    }
}
