use crate::graph::nav::NavGraph;

/// Shared cycle-directionality filter for loop-based checks — see GitHub issue #217. Restricts
/// which enumerated cycles a check evaluates by whether every edge in the cycle has a
/// `reverse_edge` (see `nav-graph.md`'s "Reverse edge linking"), letting a user tune thresholds
/// separately for one-way shortcuts versus regular bidirectional loops instead of one threshold
/// applying to both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CycleKind {
    /// Every cycle, regardless of directionality — the pre-#217 behavior.
    Any,
    /// Every edge in the cycle has a `reverse_edge` (fully bidirectional loop).
    TwoWay,
    /// At least one edge in the cycle has no `reverse_edge`.
    OneWay,
}

impl CycleKind {
    pub const ALL: [CycleKind; 3] = [CycleKind::Any, CycleKind::TwoWay, CycleKind::OneWay];

    pub fn as_str(self) -> &'static str {
        match self {
            CycleKind::Any => "any",
            CycleKind::TwoWay => "two_way",
            CycleKind::OneWay => "one_way",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "any" => Some(CycleKind::Any),
            "two_way" => Some(CycleKind::TwoWay),
            "one_way" => Some(CycleKind::OneWay),
            _ => None,
        }
    }

    /// Whether `cycle` (a list of nav-edge indices, as enumerated by `find_all_simple_cycles`)
    /// matches this kind.
    pub fn matches(self, nav: &NavGraph, cycle: &[usize]) -> bool {
        match self {
            CycleKind::Any => true,
            CycleKind::TwoWay => cycle
                .iter()
                .all(|&idx| nav.edge_by_idx(idx).reverse_edge.is_some()),
            CycleKind::OneWay => cycle
                .iter()
                .any(|&idx| nav.edge_by_idx(idx).reverse_edge.is_none()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_round_trips_through_from_str() {
        for k in CycleKind::ALL {
            assert_eq!(CycleKind::from_str(k.as_str()), Some(k));
        }
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert_eq!(CycleKind::from_str("not_a_kind"), None);
    }
}
