use maze_core::generation::{
    PresetState,
    pipeline::{RepairLimits, build_maze},
};
use maze_core::quality_control::{
    Comparison, CycleKind, InvalidLoopIssue, LoopLengthCheck, MissingEndpointsCheck,
    MissingEndpointsIssue,
};
use maze_core::repair::{FarthestEndpointsStrategy, InvalidLoopRandomStrategy, RepairStrategy};
use maze_core::space::SquareTessellation;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

#[path = "pipeline_common/mod.rs"]
mod pipeline_common;
use pipeline_common::*;

// --- GenerationTiming.qc tree (GitHub issue #285) ---

/// End-to-end proof that `build_maze`'s returned `GenerationTiming.qc` reflects the real
/// stage/rule/check-or-strategy hierarchy dispatched by `two_stages`' two-stage engine, not just
/// the isolated `stage_node`/`RuleTimingAcc::into_node` fold logic already unit-tested in
/// `quality_control::stage::timing_tree_tests`. Stage 1's `missing_endpoints` rule dispatches
/// exactly once (its check finds an issue, `FarthestEndpointsStrategy` resolves it, the next pass
/// finds nothing and converges) so its `TimingNode.entry.calls` (iterations) reads 1; stage 2's
/// its `loop_length` check never finds a short loop at all on this graph (no cycles), so it converges
/// immediately on the very first pass and its `calls` reads 0 — matching `StageOutcome`'s own
/// doc comment: the final convergence check that finds nothing does not increment `iterations`.
#[test]
fn timing_qc_tree_has_one_node_per_dispatched_stage_with_rule_and_leaf_children() {
    let (field, graph) = make_generated_graph(1);
    let qc = two_stages(
        (
            vec![(
                "missing_endpoints",
                Box::new(MissingEndpointsCheck {
                    instance_id: "ga:missing_endpoints".to_string(),
                }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>,
            )],
            Box::new(FarthestEndpointsStrategy)
                as Box<dyn RepairStrategy<SquareTessellation, MissingEndpointsIssue>>,
        ),
        (
            vec![(
                "min_loop_length",
                Box::new(LoopLengthCheck {
                    instance_id: "gb:min_loop_length".to_string(),
                    comparison: Comparison::Lt,
                    length: 10,
                    cycle_kind: CycleKind::Any,
                }),
            )],
            Box::new(InvalidLoopRandomStrategy)
                as Box<dyn RepairStrategy<SquareTessellation, InvalidLoopIssue>>,
        ),
    );

    let (_, _, timing) = build_maze(
        field,
        graph,
        1,
        qc,
        &PresetState::empty(),
        RepairLimits::default(),
        None,
        None,
        None,
        None,
    );

    assert_eq!(
        timing.qc.len(),
        2,
        "one TimingNode per stage that actually dispatched a rule"
    );
    let stage_1 = timing
        .qc
        .iter()
        .find(|n| n.id == "stage_1")
        .expect("stage_1 must appear in the tree");
    let stage_2 = timing
        .qc
        .iter()
        .find(|n| n.id == "stage_2")
        .expect("stage_2 must appear in the tree");

    assert_eq!(
        stage_1.entry.calls, 1,
        "stage_1 must dispatch once before converging on the next pass"
    );
    assert_eq!(
        stage_2.entry.calls, 0,
        "stage_2 must converge immediately — its check never finds a short loop"
    );

    assert_eq!(stage_1.children.len(), 1);
    let rule_a = &stage_1.children[0];
    assert_eq!(rule_a.id, "ga");
    // FarthestEndpointsStrategy is dispatched (missing_endpoints resolves), so rule_a has both
    // its check and its strategy as leaf children.
    assert!(
        rule_a.children.iter().any(|c| c.id == "missing_endpoints"),
        "rule_a must time its own check"
    );
    assert!(
        rule_a.children.iter().any(|c| c.id == "farthest_endpoints"),
        "rule_a must time its dispatched strategy"
    );

    assert_eq!(stage_2.children.len(), 1);
    let rule_b = &stage_2.children[0];
    assert_eq!(rule_b.id, "gb");
    // The check never finds a short loop on this graph (no cycles at all), so its strategy is
    // never dispatched — only the check itself should be timed. Keyed by check *type* id
    // (`LoopLengthCheck::check_type_id()` returns "loop_length"), not by the local/instance id
    // ("min_loop_length") used above only to build the rule's checks list.
    assert!(
        rule_b.children.iter().any(|c| c.id == "loop_length"),
        "rule_b must time its own check even when it never fires"
    );
    assert!(
        !rule_b
            .children
            .iter()
            .any(|c| c.id == "invalid_loop_random"),
        "a strategy that never dispatched must not appear in the tree"
    );
}

/// A stage whose repair loop is cut short by `RepairLimits` must still report the iteration count
/// it actually reached (not the configured cap, and not the loop's total pass count — the
/// unconverged final pass that trips the limit check doesn't itself increment `iterations`, per
/// `StageOutcome`'s own doc comment) and must not silently drop its per-rule timing.
#[test]
fn timing_qc_tree_reports_partial_iterations_when_repair_limit_cuts_a_stage_short() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&call_count);
    let (field, graph, qc) = never_converging_setup(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });

    let limits = RepairLimits::new(Some(3), None).unwrap();
    let (_, _, timing) = build_maze(
        field,
        graph,
        1,
        qc,
        &PresetState::empty(),
        limits,
        None,
        None,
        None,
        None,
    );

    assert_eq!(timing.qc.len(), 1);
    let stage = &timing.qc[0];
    assert_eq!(
        stage.entry.calls, 3,
        "iterations must equal the cap that was actually hit, matching the 3 strategy dispatches"
    );
    assert_eq!(
        stage.children.len(),
        1,
        "the one rule that ran must still be timed despite the stage being cut short"
    );
}
