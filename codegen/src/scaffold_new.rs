//! `--new-check <id>`/`--new-strategy <id>`: scaffolds a skeleton source file (impl + matching
//! `_tests.rs`-style test module) for a brand-new `Check<T, I>`/`RepairStrategy<T, I>`, and prints
//! the remaining hand-wiring checklist from `Specs/quality-control-checklist.md` with `<id>`
//! already substituted in. Pure navigation/typing aid (GitHub issue #406) — it never invents the
//! check's/strategy's actual logic, only the boilerplate shape every one of them shares.

use std::path::PathBuf;

use crate::naming::to_pascal_case;

pub struct NewFileScaffold {
    pub path: PathBuf,
    pub contents: String,
    pub checklist: String,
}

/// Builds the skeleton `Check<T, I>` impl + checklist for a new check id. `checks_dir` is
/// `maze-core/src/quality_control/checks`; the caller owns writing the file and declaring the
/// `mod` (same split as every other codegen entry point in `main.rs`).
pub fn new_check(id: &str, checks_dir: &PathBuf) -> NewFileScaffold {
    let type_name = to_pascal_case(id);
    let struct_name = format!("{type_name}Check");
    let issue_name = format!("{type_name}Issue");

    let contents = format!(
        r#"use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{issue_name};

pub struct {struct_name} {{
    pub instance_id: String,
}}

impl<T: Tessellation> Check<T, {issue_name}> for {struct_name} {{
    fn check_type_id(&self) -> &'static str {{ "{id}" }}

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<{issue_name}>, _rng: &mut dyn RngCore, _requirement: ()) {{
        todo!("implement {id} check logic")
    }}
}}

#[cfg(test)]
mod tests {{
    use super::*;

    const TEST_ID: &str = "{id}";

    #[test]
    fn todo_add_real_assertions() {{
        todo!("cover the silent and firing cases for {struct_name}")
    }}
}}
"#
    );

    let checklist = format!(
        r#"New check "{id}" scaffolded at maze-core/src/quality_control/checks/{id}.rs
[done] pub mod {id}; added to checks/mod.rs

Remaining manual wiring (see Specs/quality-control-checklist.md "New Check"):
  1. [done] Check<T, I> skeleton written to checks/{id}.rs — fill in repair_check + tests.
  1b. Add `pub use {id}::{struct_name};` (plus any `_DEFAULT` constants) to checks/mod.rs by hand.
  2. Register CheckDescriptor {{ id: "{id}", .. }} in maze-wasm/src/checks_catalog.rs's available_checks_list().
  3. Wire "{id}" into maze-runner's check_factory.rs (check_kind_for_type's match arms) so build_rule_for! can select it.
  4. Add checkI18n["{id}"] to qualityI18n.ts (or run `cargo run -p codegen -- --scaffold` for a TODO stub),
     plus a DETAIL_LABELS/DETAIL_DESCRIPTIONS entry in issueRegistry.ts if the check calls .with_detail(...) —
     otherwise add "{id}" to issueRegistry.ts's NO_DETAIL_CHECKS list instead.
  5. Add check.{id}.label/.description (and any detail-label) keys to both maze-web/messages/en.json and ru.json.

If this check needs a new IssueKind (only if no existing kind fits), see the checklist's "New IssueKind variant" section first.

Verify with: cargo run -p codegen -- --check
"#
    );

    NewFileScaffold {
        path: checks_dir.join(format!("{id}.rs")),
        contents,
        checklist,
    }
}

/// Builds the skeleton `RepairStrategy<T, I>` impl + checklist for a new strategy id.
/// `strategies_dir` is `maze-core/src/repair/strategies`.
pub fn new_strategy(id: &str, strategies_dir: &PathBuf) -> NewFileScaffold {
    let type_name = to_pascal_case(id);
    let struct_name = format!("{type_name}Strategy");

    let contents = format!(
        r#"use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{{RepairStrategy, NestedStrategyConfig}};
use crate::repair::command::MutationCommand;
use crate::generation::PresetState;
// TODO: import the concrete issue type this strategy repairs, then replace every
// `TodoIssueType` below with it (see Specs/quality-control-checklist.md "New Strategy").

pub struct {struct_name};

impl<T: Tessellation> RepairStrategy<T, TodoIssueType> for {struct_name} {{
    fn strategy_id(&self) -> &'static str {{ "{id}" }}

    fn apply(&self, issue: &TodoIssueType, maze: &Maze<T>, rng: &mut dyn RngCore, params: &StrategyParams, preset_state: &PresetState, nested: &[NestedStrategyConfig<T>]) -> (RepairResult, Vec<MutationCommand>) {{
        todo!("implement {id} strategy logic")
    }}
}}

crate::impl_erased_repair_strategy!({struct_name}, TodoIssueType);

#[cfg(test)]
mod tests {{
    use super::*;

    #[test]
    fn todo_add_real_assertions() {{
        todo!("cover apply()'s Fixed/Failed/Deferred cases for {struct_name}")
    }}
}}
"#
    );

    let checklist = format!(
        r#"New strategy "{id}" scaffolded at maze-core/src/repair/strategies/{id}.rs
[done] pub mod {id}; added to strategies/mod.rs

Remaining manual wiring (see Specs/quality-control-checklist.md "New Strategy"):
  1. [done] RepairStrategy<T, I> skeleton written to strategies/{id}.rs — replace every
     `TodoIssueType` placeholder with the concrete issue type this strategy repairs, then fill in
     apply()'s logic + tests.
  1b. Add `pub use {id}::{struct_name};` to strategies/mod.rs by hand.
  2. Register StrategyDescriptor {{ id: "{id}", .. }} in maze-wasm/src/strategies_catalog.rs's available_strategies_list().
  3. Add strategyI18n["{id}"] to qualityI18n.ts (or run `cargo run -p codegen -- --scaffold` for a TODO stub),
     plus check.{id}/strategy keys in both maze-web/messages/en.json and ru.json.

Verify with: cargo run -p codegen -- --check
"#
    );

    NewFileScaffold {
        path: strategies_dir.join(format!("{id}.rs")),
        contents,
        checklist,
    }
}

/// Appends `pub mod <id>;` to `mod_rs_text` right after the last existing `mod `/`pub mod ` line
/// (or at the top if there are none), so a freshly scaffolded file is reachable without the caller
/// hand-editing `mod.rs`. Returns `None` if `<id>` is already declared (idempotent, same contract
/// as `rust_emitter::ensure_mod_declared`). The `pub use` re-export line is deliberately left for
/// the caller to add by hand — unlike the `mod` declaration, what a check/strategy needs to
/// re-export (the struct, plus whichever `_DEFAULT` constants it defines) can't be inferred from
/// just the id.
pub fn ensure_mod_declared(mod_rs_text: &str, id: &str) -> Option<String> {
    let target_line = format!("pub mod {id};");
    let already_declared = mod_rs_text.lines().any(|l| {
        let t = l.trim();
        t == target_line || t == format!("mod {id};") || t == format!("pub(crate) mod {id};")
    });
    if already_declared {
        return None;
    }

    let last_mod_line_idx = mod_rs_text
        .lines()
        .enumerate()
        .filter(|(_, l)| {
            let t = l.trim();
            t.starts_with("mod ") || t.starts_with("pub mod ")
        })
        .map(|(i, _)| i)
        .last();

    let mut lines: Vec<String> = mod_rs_text.lines().map(String::from).collect();
    match last_mod_line_idx {
        Some(i) => lines.insert(i + 1, target_line),
        None => lines.insert(0, target_line),
    }
    Some(lines.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_check_names_struct_and_issue_from_id() {
        let scaffold = new_check("min_region_size", &PathBuf::from("checks"));
        assert!(scaffold.contents.contains("pub struct MinRegionSizeCheck"));
        assert!(scaffold.contents.contains("MinRegionSizeIssue"));
        assert!(scaffold.contents.contains(r#""min_region_size""#));
        assert_eq!(
            scaffold.path,
            PathBuf::from("checks").join("min_region_size.rs")
        );
    }

    #[test]
    fn new_check_checklist_names_all_registration_points() {
        let scaffold = new_check("foo_bar", &PathBuf::from("checks"));
        assert!(scaffold.checklist.contains("checks_catalog.rs"));
        assert!(scaffold.checklist.contains("check_factory.rs"));
        assert!(scaffold.checklist.contains("qualityI18n.ts"));
        assert!(scaffold.checklist.contains("en.json"));
        assert!(scaffold.checklist.contains("ru.json"));
        assert!(scaffold.checklist.contains("foo_bar"));
    }

    #[test]
    fn new_strategy_names_struct_from_id() {
        let scaffold = new_strategy("farthest_endpoints", &PathBuf::from("strategies"));
        assert!(
            scaffold
                .contents
                .contains("pub struct FarthestEndpointsStrategy")
        );
        assert!(scaffold.contents.contains(r#""farthest_endpoints""#));
        assert_eq!(
            scaffold.path,
            PathBuf::from("strategies").join("farthest_endpoints.rs")
        );
    }

    #[test]
    fn new_strategy_checklist_names_all_registration_points() {
        let scaffold = new_strategy("foo_bar", &PathBuf::from("strategies"));
        assert!(scaffold.checklist.contains("strategies_catalog.rs"));
        assert!(scaffold.checklist.contains("qualityI18n.ts"));
        assert!(scaffold.checklist.contains("en.json"));
        assert!(scaffold.checklist.contains("ru.json"));
        assert!(scaffold.checklist.contains("foo_bar"));
    }

    #[test]
    fn ensure_mod_declared_appends_after_last_mod_line() {
        let text = "pub mod a;\npub mod b;\nmod c;\n\npub use a::A;\n";
        let updated = ensure_mod_declared(text, "d").expect("id absent, should insert");
        assert_eq!(
            updated,
            "pub mod a;\npub mod b;\nmod c;\npub mod d;\n\npub use a::A;\n"
        );
    }

    #[test]
    fn ensure_mod_declared_inserts_at_top_when_no_mod_lines_exist() {
        let text = "pub use a::A;\n";
        let updated = ensure_mod_declared(text, "d").expect("id absent, should insert");
        assert_eq!(updated, "pub mod d;\npub use a::A;\n");
    }

    #[test]
    fn ensure_mod_declared_is_idempotent_when_already_public() {
        let text = "pub mod d;\n";
        assert_eq!(ensure_mod_declared(text, "d"), None);
    }

    #[test]
    fn ensure_mod_declared_is_idempotent_when_already_private() {
        let text = "mod d;\n";
        assert_eq!(ensure_mod_declared(text, "d"), None);
    }

    #[test]
    fn ensure_mod_declared_is_idempotent_when_already_pub_crate() {
        // pub(crate) mod is a real pattern in this codebase (e.g. strategies/mod.rs's
        // farthest_reachable/split_core) — must not be treated as absent and re-declared pub.
        let text = "pub(crate) mod d;\n";
        assert_eq!(ensure_mod_declared(text, "d"), None);
    }
}
