# Skipped (risky or unreliable)

- vertex_based.rs:59 fn with 8 args (clippy too_many_arguments): needs param struct, wide call-site churn
- issue_kind_ids.rs:53 `from_str` name clash with FromStr: rename touches public API/wasm/codegen
- multi_shape.rs:419 test uses `1..=0` deliberately; denied by clippy (reversed_empty_ranges) so `cargo clippy --all-targets` fails; left as intentional
- glued_audit.rs:566 complex tuple type (clippy type_complexity): test helper, low value
- QC check pairs (max_teleport_count/density, max_loop_*, min_*_ratio/count, elevator/vertical proximity) share ~15-57 similar lines each (filter detail blocks, group building); parallel-by-design per-check files, extraction touches many checks and detail ids; left
- repair strategies pairs (priority/weighted_dead_end, one_way_to_passage/wall, expand_region_passage vs vertical_passage_region_merge) similar structure; extraction risks changing RNG consumption order; left
- web: ~200 exports used only by tests or only in own file (e.g. FeaturesPanel compute*Card); removing `export` would break tests importing them; left
- trivial dup: with_detail filter blocks in max_teleport_count/density (only 2 files, low value)
- web: VectorByCorridorsSettingsPanel.tsx vs VectorByWallsSettingsPanel.tsx (~400 duplicated lines, store setter names differ); big UI refactor with no visual check allowed; left
- web: VectorByCorridorsRenderer vs VectorByWallsRenderer, parameterLinksRegistry/Defaults internal repetition, NewRuleStrategyDialog vs StrategySelectDialog; left as risky or low value
- clippy autofix (redundant_closure_for_method_calls etc.) produced uglier code (`std::string::ToString::to_string`, unformatted or-patterns) in codegen/maze-runner/maze-wasm; reverted
- clippy pedantic map_unwrap_or (101 hits), match_same_arms (25): stylistic churn, left
- validateImageExport.ts: shared marker/teleport field blocks in two validators (schema validation, subtle obj vs obj? differences); left
- test setup duplication in remove_teleport / teleport_* checks tests; low value
- SidePanel.tsx console.log: gated by localStorage diagnostics flag (issue #679), intentional, left
