    use super::*;
    use event_encode::write_str;
    use crate::event_log::{DebugEvent, EncodeEventPayload};
    use std::collections::HashMap;

    #[test]
    fn mutating_split_matches_mutation_mirror_variants() {
        assert!(QcEvent::DirectedEdgeAdded { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::BidirectionalEdgeAdded { a: 1, b: 2 }.is_mutating());
        assert!(QcEvent::DirectedTeleportAdded { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::BidirectionalTeleportAdded { a: 1, b: 2 }.is_mutating());
        assert!(QcEvent::EdgeRemoved { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::EdgeRemovedBetween { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::EdgeRemovedWithReverse { from: 1, to: 2, reverse_removed: true }.is_mutating());
        assert!(QcEvent::TeleportRemovedWithReverse { from: 1, to: 2, reverse_removed: true }.is_mutating());
        assert!(QcEvent::DirectedVerticalPassageAdded { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::BidirectionalVerticalPassageAdded { a: 1, b: 2 }.is_mutating());
        assert!(QcEvent::VerticalPassageRemovedWithReverse { from: 1, to: 2, reverse_removed: true }.is_mutating());
        assert!(QcEvent::BidirectionalElevatorAdded { a: 1, b: 2 }.is_mutating());
        assert!(QcEvent::StartSet(1).is_mutating());
        assert!(QcEvent::FinishSet(1).is_mutating());
        assert!(QcEvent::NodeRemoved(1).is_mutating());
    }

    #[test]
    fn trace_events_are_not_mutating() {
        assert!(!QcEvent::IterationStarted(0).is_mutating());
        assert!(!QcEvent::CheckRan { check_id: "c".to_string(), issue: None }.is_mutating());
        assert!(!QcEvent::IssuesMerged {
            issue_kind: IssueKind::from_str("missing_endpoints").unwrap(), payload: IssuePayload::None, details: HashMap::new(),
        }.is_mutating());
        assert!(!QcEvent::IterationLimitReached(RepairLimitKind::MaxIterations).is_mutating());
    }

    #[test]
    fn declined_variants_are_not_mutating() {
        assert!(!QcEvent::DirectedEdgeDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalEdgeDeclined { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::DirectedTeleportDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalTeleportDeclined { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveBetweenDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveWithReverseDeclined { from: 1, to: 2, reverse_removed: false }.is_mutating());
        assert!(!QcEvent::TeleportRemoveWithReverseDeclined { from: 1, to: 2, reverse_removed: false }.is_mutating());
        assert!(!QcEvent::DirectedVerticalPassageDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalVerticalPassageDeclined { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::VerticalPassageRemoveWithReverseDeclined { from: 1, to: 2, reverse_removed: false }.is_mutating());
        assert!(!QcEvent::BidirectionalElevatorDeclined { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::StartSetDeclined(1).is_mutating());
        assert!(!QcEvent::FinishSetDeclined(1).is_mutating());
        assert!(!QcEvent::NodeRemoveDeclined(1).is_mutating());
    }

    #[test]
    fn proposed_variants_are_not_mutating() {
        assert!(!QcEvent::DirectedEdgeProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalEdgeProposed { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::DirectedTeleportProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalTeleportProposed { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveBetweenProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveWithReverseProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::TeleportRemoveWithReverseProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::DirectedVerticalPassageProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalVerticalPassageProposed { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::VerticalPassageRemoveWithReverseProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalElevatorProposed { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::StartSetProposed(1).is_mutating());
        assert!(!QcEvent::FinishSetProposed(1).is_mutating());
        assert!(!QcEvent::NodeRemoveProposed(1).is_mutating());
    }

    #[test]
    fn every_variant_has_a_unique_nonzero_wire_tag() {
        use std::collections::HashSet;
        let events: Vec<QcEvent> = vec![
            QcEvent::IterationStarted(0),
            QcEvent::CheckRan { check_id: "c".to_string(), issue: None },
            QcEvent::IssuesMerged {
                issue_kind: IssueKind::from_str("missing_endpoints").unwrap(), payload: IssuePayload::None, details: HashMap::new(),
            },
            QcEvent::IterationLimitReached(RepairLimitKind::MaxIterations),
            QcEvent::DirectedEdgeAdded { from: 0, to: 0 },
            QcEvent::BidirectionalEdgeAdded { a: 0, b: 0 },
            QcEvent::DirectedTeleportAdded { from: 0, to: 0 },
            QcEvent::BidirectionalTeleportAdded { a: 0, b: 0 },
            QcEvent::EdgeRemoved { from: 0, to: 0 },
            QcEvent::EdgeRemovedBetween { from: 0, to: 0 },
            QcEvent::EdgeRemovedWithReverse { from: 0, to: 0, reverse_removed: true },
            QcEvent::TeleportRemovedWithReverse { from: 0, to: 0, reverse_removed: true },
            QcEvent::DirectedVerticalPassageAdded { from: 0, to: 0 },
            QcEvent::BidirectionalVerticalPassageAdded { a: 0, b: 0 },
            QcEvent::VerticalPassageRemovedWithReverse { from: 0, to: 0, reverse_removed: true },
            QcEvent::BidirectionalElevatorAdded { a: 0, b: 0 },
            QcEvent::StartSet(0),
            QcEvent::FinishSet(0),
            QcEvent::NodeRemoved(0),
            QcEvent::DirectedEdgeDeclined { from: 0, to: 0 },
            QcEvent::BidirectionalEdgeDeclined { a: 0, b: 0 },
            QcEvent::DirectedTeleportDeclined { from: 0, to: 0 },
            QcEvent::BidirectionalTeleportDeclined { a: 0, b: 0 },
            QcEvent::EdgeRemoveDeclined { from: 0, to: 0 },
            QcEvent::EdgeRemoveBetweenDeclined { from: 0, to: 0 },
            QcEvent::EdgeRemoveWithReverseDeclined { from: 0, to: 0, reverse_removed: false },
            QcEvent::TeleportRemoveWithReverseDeclined { from: 0, to: 0, reverse_removed: false },
            QcEvent::DirectedVerticalPassageDeclined { from: 0, to: 0 },
            QcEvent::BidirectionalVerticalPassageDeclined { a: 0, b: 0 },
            QcEvent::VerticalPassageRemoveWithReverseDeclined { from: 0, to: 0, reverse_removed: false },
            QcEvent::BidirectionalElevatorDeclined { a: 0, b: 0 },
            QcEvent::StartSetDeclined(0),
            QcEvent::FinishSetDeclined(0),
            QcEvent::NodeRemoveDeclined(0),
            QcEvent::DirectedEdgeProposed { from: 0, to: 0 },
            QcEvent::BidirectionalEdgeProposed { a: 0, b: 0 },
            QcEvent::DirectedTeleportProposed { from: 0, to: 0 },
            QcEvent::BidirectionalTeleportProposed { a: 0, b: 0 },
            QcEvent::EdgeRemoveProposed { from: 0, to: 0 },
            QcEvent::EdgeRemoveBetweenProposed { from: 0, to: 0 },
            QcEvent::EdgeRemoveWithReverseProposed { from: 0, to: 0 },
            QcEvent::TeleportRemoveWithReverseProposed { from: 0, to: 0 },
            QcEvent::DirectedVerticalPassageProposed { from: 0, to: 0 },
            QcEvent::BidirectionalVerticalPassageProposed { a: 0, b: 0 },
            QcEvent::VerticalPassageRemoveWithReverseProposed { from: 0, to: 0 },
            QcEvent::BidirectionalElevatorProposed { a: 0, b: 0 },
            QcEvent::StartSetProposed(0),
            QcEvent::FinishSetProposed(0),
            QcEvent::NodeRemoveProposed(0),
            QcEvent::StrategyFailed { strategy_id: "remove_split" },
        ];
        let mut tags = HashSet::new();
        for event in &events {
            let tag = event.type_id();
            assert_ne!(tag, 0, "TAG_SCOPE (0) must never be used by an event's type_id");
            assert!(tags.insert(tag), "duplicate wire tag {tag} for {event:?}");
        }
    }

    #[test]
    fn declined_variant_encodes_identically_to_its_mutating_mirror_except_the_tag() {
        let added = QcEvent::DirectedEdgeAdded { from: 7, to: 9 };
        let declined = QcEvent::DirectedEdgeDeclined { from: 7, to: 9 };
        let mut added_bytes = Vec::new();
        added.encode_payload(&mut added_bytes);
        let mut declined_bytes = Vec::new();
        declined.encode_payload(&mut declined_bytes);
        assert_eq!(added_bytes, declined_bytes);
        assert_ne!(added.type_id(), declined.type_id());
    }

    #[test]
    fn edge_removed_with_reverse_encodes_from_to_then_reverse_removed_byte() {
        let event = QcEvent::EdgeRemovedWithReverse { from: 5, to: 6, reverse_removed: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![5, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn edge_removed_with_reverse_encodes_reverse_removed_false_as_zero_byte() {
        let event = QcEvent::EdgeRemovedWithReverse { from: 5, to: 6, reverse_removed: false };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes[16], 0);
    }

    #[test]
    fn node_removed_declined_and_proposed_all_encode_the_same_node_id_bytes() {
        // GitHub issue #248: NodeRemoved/NodeRemoveDeclined/NodeRemoveProposed share the same
        // single-NodeId payload shape as StartSet/FinishSet, but never had their own direct
        // encode_payload assertion (only indirectly exercised via every_variant_has_a_unique_
        // nonzero_wire_tag's type_id() calls) — pins the actual byte output down explicitly.
        for event in [QcEvent::NodeRemoved(42), QcEvent::NodeRemoveDeclined(42), QcEvent::NodeRemoveProposed(42)] {
            let mut bytes = Vec::new();
            event.encode_payload(&mut bytes);
            assert_eq!(bytes, 42u64.to_le_bytes().to_vec(), "{event:?} must encode its NodeId as 8 little-endian bytes");
        }
    }

    #[test]
    fn strategy_failed_is_not_mutating_and_encodes_its_strategy_id() {
        let event = QcEvent::StrategyFailed { strategy_id: "remove_split" };
        assert!(!event.is_mutating());
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        let mut expected = Vec::new();
        write_str(&mut expected, "remove_split");
        assert_eq!(bytes, expected);
    }

    /// `EdgeRemoveWithReverseDeclined` is always constructed with `reverse_removed: false` in
    /// practice (see its own doc comment — a declined `RemoveEdgeWithReverse` means nothing was
    /// removed at all), but this test pins the doc's "same field shape, same bytes except the tag"
    /// claim at the wire level regardless of which `reverse_removed` value is passed, the same way
    /// `declined_variant_encodes_identically_to_its_mutating_mirror_except_the_tag` does for the
    /// plain `DirectedEdgeAdded`/`DirectedEdgeDeclined` pair above.
    #[test]
    fn edge_remove_with_reverse_declined_encodes_identically_to_its_mutating_mirror_except_the_tag() {
        let added = QcEvent::EdgeRemovedWithReverse { from: 5, to: 6, reverse_removed: true };
        let declined = QcEvent::EdgeRemoveWithReverseDeclined { from: 5, to: 6, reverse_removed: true };
        let mut added_bytes = Vec::new();
        added.encode_payload(&mut added_bytes);
        let mut declined_bytes = Vec::new();
        declined.encode_payload(&mut declined_bytes);
        assert_eq!(added_bytes, declined_bytes);
        assert_ne!(added.type_id(), declined.type_id());
    }

    #[test]
    fn teleport_remove_with_reverse_declined_encodes_identically_to_its_mutating_mirror_except_the_tag() {
        let added = QcEvent::TeleportRemovedWithReverse { from: 3, to: 4, reverse_removed: true };
        let declined = QcEvent::TeleportRemoveWithReverseDeclined { from: 3, to: 4, reverse_removed: true };
        let mut added_bytes = Vec::new();
        added.encode_payload(&mut added_bytes);
        let mut declined_bytes = Vec::new();
        declined.encode_payload(&mut declined_bytes);
        assert_eq!(added_bytes, declined_bytes);
        assert_ne!(added.type_id(), declined.type_id());
    }

    fn read_u32le(bytes: &[u8], offset: &mut usize) -> u32 {
        let v = u32::from_le_bytes(bytes[*offset..*offset + 4].try_into().unwrap());
        *offset += 4;
        v
    }

    fn read_str(bytes: &[u8], offset: &mut usize) -> String {
        let len = read_u32le(bytes, offset) as usize;
        let s = String::from_utf8(bytes[*offset..*offset + len].to_vec()).unwrap();
        *offset += len;
        s
    }

    #[test]
    fn check_ran_with_no_issue_encodes_check_id_then_a_zero_present_byte() {
        let event = QcEvent::CheckRan { check_id: "c1".to_string(), issue: None };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 0);
        assert_eq!(bytes.len(), offset + 1);
    }

    #[test]
    fn check_ran_with_issue_payload_none_encodes_kind_then_a_zero_payload_variant_byte_then_an_empty_details_map() {
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("missing_endpoints").unwrap(), IssuePayload::None, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1);
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "missing_endpoints");
        assert_eq!(bytes[offset], 0);
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_encodes_this_checks_own_details() {
        let mut details = HashMap::new();
        details.insert("threshold", "10".to_string());
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("invalid_loop").unwrap(), IssuePayload::None, details)),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1);
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_loop");
        assert_eq!(bytes[offset], 0);
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // details: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "threshold");
        assert_eq!(read_str(&bytes, &mut offset), "10");
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_with_invalid_loop_payload_encodes_the_full_str_keyed_edge_pairs_map() {
        let mut edges = std::collections::HashMap::new();
        edges.insert("check1".to_string(), vec![super::super::issue_payload::IssueEdgeGroupPayload { edges: vec![[1u32, 2u32]], preset_locked: false }]);
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("invalid_loop").unwrap(), IssuePayload::InvalidLoop { edges }, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1); // issue present
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_loop");
        assert_eq!(bytes[offset], 1); // IssuePayload::InvalidLoop variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 cycle
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // cycle has 1 edge pair
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // from
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // to
        assert_eq!(bytes[offset], 0); // preset_locked = false
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_with_region_needs_expansion_payload_encodes_the_full_str_keyed_node_lists_map() {
        use crate::quality_control::issue_payload::IssueRegionPayload;
        let mut nodes = std::collections::HashMap::new();
        nodes.insert("check1".to_string(), vec![IssueRegionPayload { region: vec![5u32], preset_locked: true }]);
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("region_needs_expansion").unwrap(), IssuePayload::RegionNeedsExpansion { nodes }, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1); // issue present
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "region_needs_expansion");
        assert_eq!(bytes[offset], 2); // IssuePayload::RegionNeedsExpansion variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 region
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // region has 1 node
        assert_eq!(read_u32le(&bytes, &mut offset), 5); // node id
        assert_eq!(bytes[offset], 1); // region preset_locked
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_with_invalid_teleport_payload_encodes_the_full_str_keyed_edge_pairs_map() {
        let mut groups = std::collections::HashMap::new();
        groups.insert("check1".to_string(), vec![super::super::issue_payload::IssueEdgeGroupPayload { edges: vec![[1u32, 2u32]], preset_locked: false }]);
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("invalid_teleport").unwrap(), IssuePayload::InvalidTeleport { groups }, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1); // issue present
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_teleport");
        assert_eq!(bytes[offset], 4); // IssuePayload::InvalidTeleport variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 group
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // group has 1 edge pair
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // from
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // to
        assert_eq!(bytes[offset], 0); // preset_locked = false
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_with_invalid_split_route_payload_encodes_the_full_str_keyed_routes_map() {
        use crate::quality_control::issue_payload::{IssueRoutePayload, IssueRouteEdge};
        let mut routes = std::collections::HashMap::new();
        routes.insert("check1".to_string(), vec![IssueRoutePayload {
            edges: vec![
                IssueRouteEdge { from: 1, to: 2, is_split_edge: true },
                IssueRouteEdge { from: 2, to: 3, is_split_edge: false },
            ],
            preset_locked: false,
        }]);
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("invalid_split_route").unwrap(), IssuePayload::InvalidSplitRoute { routes }, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1); // issue present
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_split_route");
        assert_eq!(bytes[offset], 7); // IssuePayload::InvalidSplitRoute variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 route
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // route has 2 edges, order preserved
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // edge0 from
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // edge0 to
        assert_eq!(bytes[offset], 1); // edge0 is_split_edge
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // edge1 from
        assert_eq!(read_u32le(&bytes, &mut offset), 3); // edge1 to
        assert_eq!(bytes[offset], 0); // edge1 is_split_edge
        offset += 1;
        assert_eq!(bytes[offset], 0); // route preset_locked
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_with_excessive_scc_count_payload_encodes_the_full_str_keyed_bools_map() {
        let mut preset_locked = std::collections::HashMap::new();
        preset_locked.insert("check1".to_string(), true);
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("excessive_scc_count").unwrap(), IssuePayload::ExcessiveSccCount { preset_locked }, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1); // issue present
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "excessive_scc_count");
        assert_eq!(bytes[offset], 8); // IssuePayload::ExcessiveSccCount variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(bytes[offset], 1); // preset_locked = true, no nested lists
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn issues_merged_encodes_the_kind_string_then_a_zero_payload_variant_byte_then_an_empty_details_map() {
        let event = QcEvent::IssuesMerged {
            issue_kind: IssueKind::from_str("invalid_loop").unwrap(), payload: IssuePayload::None, details: HashMap::new(),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_loop");
        assert_eq!(bytes[offset], 0);
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn issues_merged_encodes_the_merged_invalid_loop_payload_and_details() {
        let mut edges = std::collections::HashMap::new();
        edges.insert("check1".to_string(), vec![super::super::issue_payload::IssueEdgeGroupPayload { edges: vec![[1u32, 2u32]], preset_locked: false }]);
        let mut check1_details = HashMap::new();
        check1_details.insert("threshold", "10".to_string());
        let mut details = HashMap::new();
        details.insert("r1:check1".to_string(), check1_details);
        let event = QcEvent::IssuesMerged {
            issue_kind: IssueKind::from_str("invalid_loop").unwrap(),
            payload: IssuePayload::InvalidLoop { edges },
            details,
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_loop");
        assert_eq!(bytes[offset], 1); // IssuePayload::InvalidLoop variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 cycle
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // cycle has 1 edge pair
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // from
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // to
        assert_eq!(bytes[offset], 0); // preset_locked = false
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // details map: 1 contributing check
        assert_eq!(read_str(&bytes, &mut offset), "r1:check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 detail entry
        assert_eq!(read_str(&bytes, &mut offset), "threshold");
        assert_eq!(read_str(&bytes, &mut offset), "10");
        assert_eq!(bytes.len(), offset);
    }
