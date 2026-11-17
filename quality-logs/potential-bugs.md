# Potential bugs

- maze-core/tests/compile_fail_test fails on clean main (trybuild stderr snapshot mismatch, E0277 text), pre-existing; snapshots likely stale for the installed rustc
- graph/mod.rs add_node: no duplicate check; adding an existing id pushes a second Node and resets its outgoing/incoming lists, orphaning existing edges (callers presumably never do it)
- graph/mod.rs remove_edge: `self.edges[id]` panics on out-of-range EdgeId (public via remove_initial_edge); edge() uses safe get
- repair/strategies/farthest_endpoints.rs: `maze.meta.start.expect("missing_start is false")` and `nav_node_for(..).unwrap()` rely on the issue flags matching maze.meta and on selection returning nav nodes; a stale issue would panic instead of returning Failed
- apply_commands.rs SetStart/SetFinish return ok=true (counted as applied) even when meta already holds a start/finish and nothing changes; inflates ApplyOutcome.applied
- PRE-EXISTING failing tests on clean main: maze-core/tests/generation vertex_based_events::vertex_based_single_step_emits_exact_event_sequence (event sequence mismatch); neighbor_guard_test: maze-runner/src/runner/topology_edit.rs:257 uses `Tessellation::neighbor` directly instead of `neighbor_via`
- max_elevator_density / max_split_density / max_teleport_density `to_remove_for` use round-to-nearest target: e.g. 4 items in 13 cells at limit 30 (density 30.77 > 30) gives target round(3.9)=4 so to_remove=0 and the violation is silently dropped. max_dead_end_density explicitly fixed the same issue with floor (see its comment). Left unchanged: behavior change, may be intentional tolerance
