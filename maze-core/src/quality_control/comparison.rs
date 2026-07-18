/// Shared comparison operator for checks that validate a single entity's numeric property against
/// a threshold — see GitHub issue #177. A check whose min/max variants both flag "this entity is
/// invalid" (same `IssueKind`, same repair strategy) merges into one check type parametrized by
/// `Comparison` instead of staying two near-duplicate check types. Checks whose min/max variants
/// instead flag different problems (a deficit vs. a surplus — different `IssueKind`s, different
/// repair strategies, e.g. region size/ratio, region/loop count) keep separate check types and
/// never use this enum — see `quality_control.md`'s "Comparison operator" section.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comparison {
    Lt,
    Gt,
    Le,
    Ge,
    Eq,
}

impl Comparison {
    pub const ALL: [Comparison; 5] = [Comparison::Lt, Comparison::Gt, Comparison::Le, Comparison::Ge, Comparison::Eq];

    pub fn as_str(self) -> &'static str {
        match self {
            Comparison::Lt => "lt",
            Comparison::Gt => "gt",
            Comparison::Le => "le",
            Comparison::Ge => "ge",
            Comparison::Eq => "eq",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "lt" => Some(Comparison::Lt),
            "gt" => Some(Comparison::Gt),
            "le" => Some(Comparison::Le),
            "ge" => Some(Comparison::Ge),
            "eq" => Some(Comparison::Eq),
            _ => None,
        }
    }

    pub fn compare(self, value: u32, threshold: u32) -> bool {
        match self {
            Comparison::Lt => value < threshold,
            Comparison::Gt => value > threshold,
            Comparison::Le => value <= threshold,
            Comparison::Ge => value >= threshold,
            Comparison::Eq => value == threshold,
        }
    }

    pub fn compare_f64(self, value: f64, threshold: f64) -> bool {
        match self {
            Comparison::Lt => value < threshold,
            Comparison::Gt => value > threshold,
            Comparison::Le => value <= threshold,
            Comparison::Ge => value >= threshold,
            Comparison::Eq => value == threshold,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_round_trips_through_from_str() {
        for c in Comparison::ALL {
            assert_eq!(Comparison::from_str(c.as_str()), Some(c));
        }
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert_eq!(Comparison::from_str("not_an_operator"), None);
    }

    #[test]
    fn compare_matches_operator_semantics() {
        assert!(Comparison::Lt.compare(3, 5));
        assert!(!Comparison::Lt.compare(5, 5));
        assert!(Comparison::Gt.compare(6, 5));
        assert!(!Comparison::Gt.compare(5, 5));
        assert!(Comparison::Le.compare(5, 5));
        assert!(!Comparison::Le.compare(6, 5));
        assert!(Comparison::Ge.compare(5, 5));
        assert!(!Comparison::Ge.compare(4, 5));
        assert!(Comparison::Eq.compare(5, 5));
        assert!(!Comparison::Eq.compare(4, 5));
    }

    #[test]
    fn compare_f64_matches_operator_semantics() {
        assert!(Comparison::Lt.compare_f64(3.0, 5.0));
        assert!(Comparison::Ge.compare_f64(5.0, 5.0));
        assert!(!Comparison::Ge.compare_f64(4.9, 5.0));
    }
}
