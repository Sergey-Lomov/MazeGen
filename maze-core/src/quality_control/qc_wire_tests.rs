    use super::*;

    #[test]
    fn golden_round_trip_iteration_started() {
        let event = QcEvent::IterationStarted(7);
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_directed_edge_proposed() {
        let event = QcEvent::DirectedEdgeProposed { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_edge_proposed() {
        let event = QcEvent::BidirectionalEdgeProposed { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_directed_teleport_proposed() {
        let event = QcEvent::DirectedTeleportProposed { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_teleport_proposed() {
        let event = QcEvent::BidirectionalTeleportProposed { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_directed_vertical_passage_proposed() {
        let event = QcEvent::DirectedVerticalPassageProposed { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_vertical_passage_proposed() {
        let event = QcEvent::BidirectionalVerticalPassageProposed { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_elevator_proposed() {
        let event = QcEvent::BidirectionalElevatorProposed { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_edge_remove_proposed() {
        let event = QcEvent::EdgeRemoveProposed { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_edge_remove_between_proposed() {
        let event = QcEvent::EdgeRemoveBetweenProposed { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_edge_remove_with_reverse_proposed() {
        let event = QcEvent::EdgeRemoveWithReverseProposed { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_teleport_remove_with_reverse_proposed() {
        let event = QcEvent::TeleportRemoveWithReverseProposed { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_vertical_passage_remove_with_reverse_proposed() {
        let event = QcEvent::VerticalPassageRemoveWithReverseProposed { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_start_set_proposed() {
        let event = QcEvent::StartSetProposed(7);
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_finish_set_proposed() {
        let event = QcEvent::FinishSetProposed(7);
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_node_remove_proposed() {
        let event = QcEvent::NodeRemoveProposed(7);
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_directed_edge_added() {
        let event = QcEvent::DirectedEdgeAdded { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_edge_added() {
        let event = QcEvent::BidirectionalEdgeAdded { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_directed_teleport_added() {
        let event = QcEvent::DirectedTeleportAdded { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_teleport_added() {
        let event = QcEvent::BidirectionalTeleportAdded { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_directed_vertical_passage_added() {
        let event = QcEvent::DirectedVerticalPassageAdded { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_vertical_passage_added() {
        let event = QcEvent::BidirectionalVerticalPassageAdded { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_elevator_added() {
        let event = QcEvent::BidirectionalElevatorAdded { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_edge_removed() {
        let event = QcEvent::EdgeRemoved { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_edge_removed_between() {
        let event = QcEvent::EdgeRemovedBetween { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_edge_removed_with_reverse() {
        let event = QcEvent::EdgeRemovedWithReverse { from: 7, to: 7, reverse_removed: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_teleport_removed_with_reverse() {
        let event = QcEvent::TeleportRemovedWithReverse { from: 7, to: 7, reverse_removed: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_vertical_passage_removed_with_reverse() {
        let event = QcEvent::VerticalPassageRemovedWithReverse { from: 7, to: 7, reverse_removed: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_start_set() {
        let event = QcEvent::StartSet(7);
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_finish_set() {
        let event = QcEvent::FinishSet(7);
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_node_removed() {
        let event = QcEvent::NodeRemoved(7);
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_directed_edge_declined() {
        let event = QcEvent::DirectedEdgeDeclined { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_edge_declined() {
        let event = QcEvent::BidirectionalEdgeDeclined { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_directed_teleport_declined() {
        let event = QcEvent::DirectedTeleportDeclined { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_teleport_declined() {
        let event = QcEvent::BidirectionalTeleportDeclined { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_directed_vertical_passage_declined() {
        let event = QcEvent::DirectedVerticalPassageDeclined { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_vertical_passage_declined() {
        let event = QcEvent::BidirectionalVerticalPassageDeclined { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_bidirectional_elevator_declined() {
        let event = QcEvent::BidirectionalElevatorDeclined { a: 7, b: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_edge_remove_declined() {
        let event = QcEvent::EdgeRemoveDeclined { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_edge_remove_between_declined() {
        let event = QcEvent::EdgeRemoveBetweenDeclined { from: 7, to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_edge_remove_with_reverse_declined() {
        let event = QcEvent::EdgeRemoveWithReverseDeclined { from: 7, to: 7, reverse_removed: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_teleport_remove_with_reverse_declined() {
        let event = QcEvent::TeleportRemoveWithReverseDeclined { from: 7, to: 7, reverse_removed: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_vertical_passage_remove_with_reverse_declined() {
        let event = QcEvent::VerticalPassageRemoveWithReverseDeclined { from: 7, to: 7, reverse_removed: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_start_set_declined() {
        let event = QcEvent::StartSetDeclined(7);
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_finish_set_declined() {
        let event = QcEvent::FinishSetDeclined(7);
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_node_remove_declined() {
        let event = QcEvent::NodeRemoveDeclined(7);
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

