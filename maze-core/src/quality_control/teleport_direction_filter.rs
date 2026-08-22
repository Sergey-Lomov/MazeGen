/// Which teleport portals a check considers, filtered by directionality — GitHub issue #379
/// follow-up. A bidirectional portal is an `EdgeKind::Teleport` edge paired with its opposite-
/// direction `Teleport` counterpart (`Graph::teleport_reverse`); a unidirectional portal has no
/// such counterpart. Mirrors `VerticalPassageType`'s role for vertical passages. Used by
/// `MaxTeleportCountCheck`/`MaxTeleportDensityCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportDirectionFilter {
    /// Every portal, one-way or two-way alike.
    Any,
    /// Only portals with both directions present.
    Bidirectional,
    /// Only portals with exactly one direction present.
    Unidirectional,
}

impl TeleportDirectionFilter {
    pub const ALL_VALUES: [TeleportDirectionFilter; 3] = [
        TeleportDirectionFilter::Any,
        TeleportDirectionFilter::Bidirectional,
        TeleportDirectionFilter::Unidirectional,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TeleportDirectionFilter::Any => "any",
            TeleportDirectionFilter::Bidirectional => "bidirectional",
            TeleportDirectionFilter::Unidirectional => "unidirectional",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "any" => Some(TeleportDirectionFilter::Any),
            "bidirectional" => Some(TeleportDirectionFilter::Bidirectional),
            "unidirectional" => Some(TeleportDirectionFilter::Unidirectional),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_round_trips_through_from_str() {
        for f in TeleportDirectionFilter::ALL_VALUES {
            assert_eq!(TeleportDirectionFilter::from_str(f.as_str()), Some(f));
        }
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert_eq!(TeleportDirectionFilter::from_str("not_a_filter"), None);
    }
}
