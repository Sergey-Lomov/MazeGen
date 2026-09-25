/// Which `VerticalPassage` logical passages a min/max count/ratio check considers — see GitHub
/// issue #343 (original `Up`/`Down`/`All` direction scope) and its follow-up fixing the double-
/// count bug: a two-way vertical passage is two `EdgeKind::VerticalPassage` edges (one each way)
/// but a single logical passage between two nodes, and every variant here counts logical passages,
/// not edges. Used by `MinVerticalPassageCountCheck`/`MinVerticalPassageRatioCheck`/
/// `MaxVerticalPassageCountCheck`/`MaxVerticalPassageRatioCheck` and, since their own follow-up
/// migration off the older per-edge `VerticalPassageDirection` scope, also by
/// `VerticalPassageGroupGeometricProximityCheck`/`VerticalPassageGroupGraphProximityCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerticalPassageType {
    /// Every logical passage, one-way or two-way alike.
    Any,
    /// Only passages with both directions present.
    TwoWay,
    /// Only passages with exactly one direction present, either way.
    OneWay,
    /// Only one-way passages going downward (`to`'s floor index < `from`'s).
    OneWayDown,
    /// Only one-way passages going upward (`to`'s floor index > `from`'s).
    OneWayUp,
}

impl VerticalPassageType {
    pub const ALL_VALUES: [VerticalPassageType; 5] = [
        VerticalPassageType::Any,
        VerticalPassageType::TwoWay,
        VerticalPassageType::OneWay,
        VerticalPassageType::OneWayDown,
        VerticalPassageType::OneWayUp,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            VerticalPassageType::Any => "any",
            VerticalPassageType::TwoWay => "two_way",
            VerticalPassageType::OneWay => "one_way",
            VerticalPassageType::OneWayDown => "one_way_down",
            VerticalPassageType::OneWayUp => "one_way_up",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "any" => Some(VerticalPassageType::Any),
            "two_way" => Some(VerticalPassageType::TwoWay),
            "one_way" => Some(VerticalPassageType::OneWay),
            "one_way_down" => Some(VerticalPassageType::OneWayDown),
            "one_way_up" => Some(VerticalPassageType::OneWayUp),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_round_trips_through_from_str() {
        for t in VerticalPassageType::ALL_VALUES {
            assert_eq!(VerticalPassageType::from_str(t.as_str()), Some(t));
        }
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert_eq!(VerticalPassageType::from_str("not_a_type"), None);
    }
}
