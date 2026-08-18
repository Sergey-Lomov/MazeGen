    use super::*;

    #[test]
    fn golden_round_trip_teleport_bridge_rolled() {
        let event = VertexBasedEvent::TeleportBridgeRolled { roll: 1.5, teleport_chance: 1.5, fired: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

    #[test]
    fn golden_round_trip_teleport_bridge_added() {
        let event = VertexBasedEvent::TeleportBridgeAdded { src: 7, dst: 7, bidirectional: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_reserve_candidate_rejected() {
        let event = VertexBasedEvent::ReserveCandidateRejected { node: 7, already_visited: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_reserve_candidate_chosen() {
        let event = VertexBasedEvent::ReserveCandidateChosen { node: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_reserve_exhausted() {
        let event = VertexBasedEvent::ReserveExhausted;
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![]);
    }

    #[test]
    fn golden_round_trip_bridge_added() {
        let event = VertexBasedEvent::BridgeAdded { src: 7, dst: 7, bidirectional: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_src_chosen_from_frontier() {
        let event = VertexBasedEvent::SrcChosenFromFrontier { src: 7, frontier_len: 7, position: 7, depth_first: 1.5 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 248, 63]);
    }

    #[test]
    fn golden_round_trip_teleport_rolled() {
        let event = VertexBasedEvent::TeleportRolled { src: 7, roll: 1.5, teleport_chance: 1.5, fired: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

    #[test]
    fn golden_round_trip_cyclic_rolled() {
        let event = VertexBasedEvent::CyclicRolled { src: 7, roll: 1.5, cyclicity: 1.5, fired: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

    #[test]
    fn golden_round_trip_cyclic_candidates_computed() {
        let event = VertexBasedEvent::CyclicCandidatesComputed { src: 7, geometric: true, candidates: vec![3, 5] };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_cyclic_edge_added() {
        let event = VertexBasedEvent::CyclicEdgeAdded { src: 7, dst: 7, teleport: true, bidirectional: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    }

    #[test]
    fn golden_round_trip_corridor_rolled() {
        let event = VertexBasedEvent::CorridorRolled { roll: 1.5, corridor_chance: 1.5, is_corridor: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

    #[test]
    fn golden_round_trip_candidate_chosen() {
        let event = VertexBasedEvent::CandidateChosen { src: 7, dst: 7, used_directionality: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_single_candidate_skips_directionality() {
        let event = VertexBasedEvent::SingleCandidateSkipsDirectionality { node: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_no_parent_skips_directionality() {
        let event = VertexBasedEvent::NoParentSkipsDirectionality { node: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_directionality_rolled() {
        let event = VertexBasedEvent::DirectionalityRolled { roll: 1.5, directionality: 1.5, fired: true, straight_found: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1, 1]);
    }

    #[test]
    fn golden_round_trip_junction_roll_setup() {
        let event = VertexBasedEvent::JunctionRollSetup { max: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_junction_slot_rolled() {
        let event = VertexBasedEvent::JunctionSlotRolled { slot: 7, roll: 1.5, branching: 1.5, taken: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

    #[test]
    fn golden_round_trip_junction_candidates_chosen() {
        let event = VertexBasedEvent::JunctionCandidatesChosen { src: 7, candidates: vec![3, 5] };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_edge_added() {
        let event = VertexBasedEvent::EdgeAdded { src: 7, dst: 7, bidirectional: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_preset_neighbor_visited() {
        let event = VertexBasedEvent::PresetNeighborVisited { src: 7, dst: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_teleport_connect_added() {
        let event = VertexBasedEvent::TeleportConnectAdded { src: 7, dst: 7, bidirectional: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_node_visited() {
        let event = VertexBasedEvent::NodeVisited { node: 7, parent: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_node_queued_to_reserve() {
        let event = VertexBasedEvent::NodeQueuedToReserve { node: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_start_visited() {
        let event = VertexBasedEvent::StartVisited { node: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_split_rolled() {
        let event = VertexBasedEvent::SplitRolled { src: 7, roll: 1.5, split_chance: 1.5, fired: true, eligible: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1, 1]);
    }

    #[test]
    fn golden_round_trip_split_nodes_created() {
        let event = VertexBasedEvent::SplitNodesCreated { src: 7, nodes: vec![3, 5], pattern: Some(9) };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 1, 9, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_split_cyclic_rolled() {
        let event = VertexBasedEvent::SplitCyclicRolled { src: 7, roll: 1.5, cyclicity: 1.5, fired: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

    #[test]
    fn golden_round_trip_pattern_adaptations_computed() {
        let event = VertexBasedEvent::PatternAdaptationsComputed { src: 7, pattern: 7, count: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 7, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_pattern_adaptation_chosen() {
        let event = VertexBasedEvent::PatternAdaptationChosen { src: 7, pattern: 7, rotation: 7, mirror: Some(9) };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 7, 0, 0, 0, 1, 9, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_split_teleport_rolled() {
        let event = VertexBasedEvent::SplitTeleportRolled { roll: 1.5, teleport_chance: 1.5, fired: true, anchor: Some(9) };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1, 1, 9, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_split_start_reassigned() {
        let event = VertexBasedEvent::SplitStartReassigned { original: 7, reassigned_to: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_split_parent_edge_relocated() {
        let event = VertexBasedEvent::SplitParentEdgeRelocated { parent: 7, src: 7, taken_by: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_vertical_rolled() {
        let event = VertexBasedEvent::VerticalRolled { src: 7, roll: 1.5, vertical_chance: 1.5, fired: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

    #[test]
    fn golden_round_trip_vertical_balance_rolled() {
        let event = VertexBasedEvent::VerticalBalanceRolled { src: 7, roll: 1.5, balance: 1.5, is_elevator: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

    #[test]
    fn golden_round_trip_vertical_passage_one_way_rolled() {
        let event = VertexBasedEvent::VerticalPassageOneWayRolled { roll: 1.5, one_way_chance: 1.5, fired: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

    #[test]
    fn golden_round_trip_vertical_passage_direction_rolled() {
        let event = VertexBasedEvent::VerticalPassageDirectionRolled { roll: 1.5, balance: 1.5, upward: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

    #[test]
    fn golden_round_trip_vertical_passage_added() {
        let event = VertexBasedEvent::VerticalPassageAdded { src: 7, dst: 7, one_way: true, upward: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    }

    #[test]
    fn golden_round_trip_vertical_passage_failed() {
        let event = VertexBasedEvent::VerticalPassageFailed { src: 7, elevator_fallback_allowed: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_elevator_slots_computed() {
        let event = VertexBasedEvent::ElevatorSlotsComputed { src: 7, unvisited_pool_size: 7, has_cyclic_visited: true, max_slots: 7, span_min: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 1, 7, 0, 0, 0, 7, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_elevator_slots_failed() {
        let event = VertexBasedEvent::ElevatorSlotsFailed { src: 7, fallback_allowed: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn golden_round_trip_elevator_floor_count_chosen() {
        let event = VertexBasedEvent::ElevatorFloorCountChosen { src: 7, floor_count: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_elevator_added() {
        let event = VertexBasedEvent::ElevatorAdded { nodes: vec![3, 5], edges_added: 7 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0]);
    }

    #[test]
    fn golden_round_trip_cross_floor_teleport_rolled() {
        let event = VertexBasedEvent::CrossFloorTeleportRolled { roll: 1.5, balance: 1.5, other_floor_preferred: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![0, 0, 0, 0, 0, 0, 248, 63, 0, 0, 0, 0, 0, 0, 248, 63, 1]);
    }

