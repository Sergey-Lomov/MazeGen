use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use codegen::{
    check, dto_ts, golden, id_enum, issue_payload_check, naming::to_camel_case, parser,
    quality_i18n, rust_emitter, scaffold_new, ts_emitter,
};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let check_only = args.iter().any(|a| a == "--check");
    let scaffold = args.iter().any(|a| a == "--scaffold");
    let new_check_id = flag_value(&args, "--new-check");
    let new_strategy_id = flag_value(&args, "--new-strategy");

    if check_only && scaffold {
        eprintln!(
            "codegen: --check and --scaffold are mutually exclusive (--check must stay read-only)"
        );
        return ExitCode::FAILURE;
    }

    if scaffold_flag_conflicts(
        new_check_id.is_some(),
        new_strategy_id.is_some(),
        check_only,
        scaffold,
    ) {
        eprintln!(
            "codegen: --new-check/--new-strategy must be run alone, not combined with --check/--scaffold/each other"
        );
        return ExitCode::FAILURE;
    }

    let repo_root = find_repo_root();

    if let Some(id) = &new_check_id {
        return run_new_check(&repo_root, id);
    }
    if let Some(id) = &new_strategy_id {
        return run_new_strategy(&repo_root, id);
    }

    let maze_core_src = repo_root.join("maze-core").join("src");
    let ts_out_dir = repo_root
        .join("maze-web")
        .join("src")
        .join("debug")
        .join("eventTape")
        .join("generated");
    let golden_out_dir = repo_root.join("codegen").join("golden");
    let id_enum_ts_out_dir = repo_root
        .join("maze-web")
        .join("src")
        .join("wasm")
        .join("generated");

    let sources = match parser::discover_sources(&maze_core_src) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("codegen: parse error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let mut had_errors = false;
    let mut warnings = Vec::new();

    for source in &sources {
        for err in check::check_source(source) {
            eprintln!("codegen: check error: {}", err.0);
            had_errors = true;
        }
    }
    if had_errors {
        return ExitCode::FAILURE;
    }

    for source in &sources {
        let rust_wire_path = repo_root
            .join("maze-core")
            .join("src")
            .join(parent_dir_of(&source.location.rust_file))
            .join(format!("{}_wire.rs", source.location.stem));
        let raw_rust_text = rust_emitter::generate_rust_wire_file(source);
        let new_rust_text = match format_rust(&raw_rust_text, &rust_wire_path) {
            Ok(text) => text,
            Err(e) => {
                eprintln!(
                    "codegen: could not format {}: {e}",
                    rust_wire_path.display()
                );
                return ExitCode::FAILURE;
            }
        };

        if let Ok(old_text) = fs::read_to_string(&rust_wire_path) {
            warnings.extend(check::detect_breaking_changes(&old_text, source));
        }

        // Every write for one source is all-or-nothing (`continue` on the first write failure) —
        // a half-written source (Rust wire file failed but TS/golden still landed, or vice versa)
        // would leave Rust and TS silently disagreeing on disk despite `had_errors` correctly
        // failing the process; a caller that inspects the generated files directly (rather than
        // the exit code) could act on that stale, inconsistent state. Under `--check` nothing is
        // written at all, so this early-exit-on-failure concern doesn't apply there — every file
        // is independently compared against disk regardless of an earlier mismatch.
        let had_errors_before_writes = had_errors;
        write_or_check(&rust_wire_path, &new_rust_text, check_only, &mut had_errors);
        if !check_only && had_errors != had_errors_before_writes {
            continue;
        }

        if !check_only {
            let source_file_path = repo_root
                .join("maze-core")
                .join("src")
                .join(&source.location.rust_file);
            if let Ok(existing) = fs::read_to_string(&source_file_path)
                && let Some(updated) =
                    rust_emitter::ensure_mod_declared(&existing, &source.location.stem)
            {
                let _ = fs::write(&source_file_path, updated);
            }
        }

        let ts_text = ts_emitter::generate_ts_file(source);
        let ts_path = ts_out_dir.join(format!("{}.ts", to_camel_case(&source.location.stem)));
        let had_errors_before_ts = had_errors;
        write_or_check(&ts_path, &ts_text, check_only, &mut had_errors);
        if !check_only && had_errors != had_errors_before_ts {
            continue;
        }

        let entries = golden::generate_golden(source);
        let golden_json = golden_to_json(&entries);
        let golden_path = golden_out_dir.join(format!("{}.json", source.location.stem));
        let had_errors_before_golden = had_errors;
        write_or_check(&golden_path, &golden_json, check_only, &mut had_errors);
        if !check_only && had_errors != had_errors_before_golden {
            continue;
        }

        let stem_camel = to_camel_case(&source.location.stem);
        if let Some(golden_test_text) =
            ts_emitter::generate_golden_test_file(source, &format!("./{stem_camel}"))
        {
            let golden_test_path = ts_out_dir.join(format!("{stem_camel}.golden.test.ts"));
            write_or_check(
                &golden_test_path,
                &golden_test_text,
                check_only,
                &mut had_errors,
            );
        }
    }

    let id_enum_sources = match id_enum::discover_sources(&maze_core_src) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("codegen: parse error: {e}");
            return ExitCode::FAILURE;
        }
    };

    for source in &id_enum_sources {
        let rust_ids_path = repo_root
            .join("maze-core")
            .join("src")
            .join(parent_dir_of(&source.rust_file))
            .join(format!("{}_ids.rs", to_snake_case_stem(&source.enum_name)));
        let raw_rust_text = id_enum::generate_rust_ids_file(source);
        let rust_text = match format_rust(&raw_rust_text, &rust_ids_path) {
            Ok(text) => text,
            Err(e) => {
                eprintln!("codegen: could not format {}: {e}", rust_ids_path.display());
                return ExitCode::FAILURE;
            }
        };
        let had_errors_before_rust = had_errors;
        write_or_check(&rust_ids_path, &rust_text, check_only, &mut had_errors);
        if !check_only && had_errors != had_errors_before_rust {
            continue;
        }

        if !check_only {
            let source_file_path = repo_root
                .join("maze-core")
                .join("src")
                .join(&source.rust_file);
            if let Ok(existing) = fs::read_to_string(&source_file_path)
                && let Some(updated) =
                    id_enum::ensure_mod_declared(&existing, &to_snake_case_stem(&source.enum_name))
            {
                let _ = fs::write(&source_file_path, updated);
            }
        }

        let ts_text = id_enum::generate_ts_ids_file(source);
        let ts_path = id_enum_ts_out_dir.join(format!(
            "{}.ts",
            to_camel_case(&to_snake_case_stem(&source.enum_name))
        ));
        write_or_check(&ts_path, &ts_text, check_only, &mut had_errors);
    }

    // `dto.rs` re-exports its actual struct/enum definitions from sibling `dto_*.rs` files
    // (`dto_issues.rs`, `dto_statistics.rs`, `dto_analytics_config.rs` — see the "Decomposition
    // refactoring" commit) via `pub use`, so `dto.rs` alone no longer contains every `#[derive(Dto)]`
    // item; each sibling must be parsed too or its types silently vanish from the generated TS.
    let dto_wasm_dir = repo_root.join("maze-wasm").join("src");
    let dto_source_files = [
        "dto.rs",
        "dto_issues.rs",
        "dto_statistics.rs",
        "dto_analytics_config.rs",
    ];
    let mut dto_parse_result: Result<Vec<dto_ts::DtoItem>, dto_ts::DtoParseError> = Ok(Vec::new());
    for file in dto_source_files {
        let path = dto_wasm_dir.join(file);
        match dto_ts::parse_dto_file(&path) {
            Ok(mut items) => {
                if let Ok(all) = &mut dto_parse_result {
                    all.append(&mut items);
                }
            }
            Err(e) => {
                dto_parse_result = Err(e);
                break;
            }
        }
    }
    match dto_parse_result {
        Ok(dto_items) => {
            let dto_ts_text = dto_ts::generate_ts_file(
                &dto_items,
                "maze-wasm/src/dto.rs",
                &[
                    ("IssueKindId", "./issueKind"),
                    ("RegionClass", "../types"),
                    ("CheckInstanceConfig", "../types"),
                    ("WasmTessellationConfig", "../types"),
                    ("PresetConnection", "../types"),
                    ("StrategyConfig", "../types"),
                ],
            );
            let dto_ts_path = repo_root
                .join("maze-web")
                .join("src")
                .join("wasm")
                .join("generated")
                .join("dto.ts");
            write_or_check(&dto_ts_path, &dto_ts_text, check_only, &mut had_errors);
        }
        Err(e) => {
            eprintln!("codegen: dto parse error: {}", e.message);
            had_errors = true;
        }
    }

    let quality_ids = quality_i18n::discover();
    let quality_ts_text = quality_i18n::generate_ts_file(&quality_ids);
    let quality_ts_path = repo_root
        .join("maze-web")
        .join("src")
        .join("components")
        .join("features")
        .join("generated")
        .join("qualityIds.ts");
    write_or_check(
        &quality_ts_path,
        &quality_ts_text,
        check_only,
        &mut had_errors,
    );

    // `qualityI18n.ts` was decomposed into `qualityI18n/{checks,issues,params,strategies}.ts`
    // (one file per `export const *I18n` registry) — `find_missing`/`scaffold` are per-registry
    // text scans that no-op on a file missing their target registry, so running them once per
    // sub-file (instead of once against a single monolithic file that no longer exists) is safe:
    // each call only ever matches its own registry's home file.
    let quality_i18n_dir = repo_root
        .join("maze-web")
        .join("src")
        .join("components")
        .join("features")
        .join("qualityI18n");
    let en_messages_path = repo_root.join("maze-web").join("messages").join("en.json");
    let ru_messages_path = repo_root.join("maze-web").join("messages").join("ru.json");
    for file_name in ["checks.ts", "issues.ts", "params.ts", "strategies.ts"] {
        let quality_i18n_path = quality_i18n_dir.join(file_name);
        let Ok(existing) = fs::read_to_string(&quality_i18n_path) else {
            continue;
        };
        let missing = quality_i18n::find_missing(&quality_ids, &existing);
        if scaffold && !missing.is_empty() {
            match (
                fs::read_to_string(&en_messages_path),
                fs::read_to_string(&ru_messages_path),
            ) {
                (Ok(en_existing), Ok(ru_existing)) => {
                    let (new_ts, new_en, new_ru) =
                        quality_i18n::scaffold(&missing, &existing, &en_existing, &ru_existing);
                    if let Err(e) = fs::write(&quality_i18n_path, &new_ts) {
                        eprintln!(
                            "codegen: failed to write {}: {e}",
                            quality_i18n_path.display()
                        );
                        had_errors = true;
                    }
                    if let Err(e) = fs::write(&en_messages_path, &new_en) {
                        eprintln!(
                            "codegen: failed to write {}: {e}",
                            en_messages_path.display()
                        );
                        had_errors = true;
                    }
                    if let Err(e) = fs::write(&ru_messages_path, &new_ru) {
                        eprintln!(
                            "codegen: failed to write {}: {e}",
                            ru_messages_path.display()
                        );
                        had_errors = true;
                    }
                    println!(
                        "codegen: scaffolded {} qualityI18n/{file_name} entr{}",
                        missing.len(),
                        if missing.len() == 1 { "y" } else { "ies" }
                    );
                }
                _ => {
                    eprintln!("codegen: --scaffold could not read en.json/ru.json — skipped");
                    had_errors = true;
                }
            }
        } else {
            for m in &missing {
                report_missing_entry(
                    &format!("qualityI18n/{file_name}"),
                    m,
                    check_only,
                    &mut had_errors,
                );
            }
        }
    }

    let issue_registry_path = repo_root
        .join("maze-web")
        .join("src")
        .join("components")
        .join("issueRegistry.ts");
    if let Ok(existing) = fs::read_to_string(&issue_registry_path) {
        for m in quality_i18n::find_missing_issue_registry(&quality_ids, &existing) {
            report_missing_entry("issueRegistry.ts", &m, check_only, &mut had_errors);
        }
    }

    let issue_payload_rust_path = repo_root
        .join("maze-core")
        .join("src")
        .join("quality_control")
        .join("event_encode.rs");
    let issue_payload_ts_path = repo_root
        .join("maze-web")
        .join("src")
        .join("debug")
        .join("eventTape")
        .join("qcCustom.ts");
    match (
        fs::read_to_string(&issue_payload_rust_path),
        fs::read_to_string(&issue_payload_ts_path),
    ) {
        (Ok(rust_src), Ok(ts_src)) => {
            for err in issue_payload_check::check_tags(&rust_src, &ts_src) {
                eprintln!("codegen: check error: {}", err.0);
                had_errors = true;
            }
        }
        _ => {
            eprintln!(
                "codegen: WARNING: could not read event_encode.rs/qcCustom.ts — skipped IssuePayload tag check"
            );
        }
    }

    let qc_kind_registry_path = repo_root
        .join("maze-runner")
        .join("src")
        .join("runner")
        .join("qc_kind_registry.rs");
    if let Ok(existing) = fs::read_to_string(&qc_kind_registry_path) {
        for m in quality_i18n::find_missing_check_factory(&quality_ids, &existing) {
            report_missing_entry("qc_kind_registry.rs", &m, check_only, &mut had_errors);
        }
    }

    for w in &warnings {
        eprintln!("codegen: WARNING: {w}");
    }

    if had_errors {
        ExitCode::FAILURE
    } else {
        println!(
            "codegen: generated {} wire source(s), {} id-enum source(s)",
            sources.len(),
            id_enum_sources.len()
        );
        ExitCode::SUCCESS
    }
}

/// Writes `text` to `path` (creating parent dirs) when `check_only` is `false`; when `true`,
/// never writes and instead compares `text` against whatever is already on disk, reporting a
/// staleness error (and setting `*had_errors`) on any mismatch — including the file being absent.
/// Without this, `--check` only re-validates that `text` *can* be derived from the source (parse/
/// structural errors), never that the file on disk actually still matches it, so a source edit
/// that was never followed by a plain (write) codegen run passes `--check` silently while the
/// generated file quietly drifts out of sync.
fn write_or_check(path: &Path, text: &str, check_only: bool, had_errors: &mut bool) {
    if check_only {
        let on_disk = fs::read_to_string(path).unwrap_or_default();
        // Every generated file's text always uses `\n` (`fs::write` below never touches line
        // endings), but `git checkout`/clone on a repo with `core.autocrlf=true` (the default on
        // Windows, and this repo's setting) rewrites `\n` to `\r\n` on disk for every tracked
        // text file. Comparing raw bytes would then flag every single generated file as "stale"
        // right after a fresh checkout even though the content is identical — normalizing both
        // sides to `\n` before comparing is what makes this a real content diff, not line-ending
        // noise.
        if normalize_line_endings(&on_disk) != normalize_line_endings(text) {
            eprintln!(
                "codegen: {} is stale — run codegen without --check to regenerate it",
                path.display()
            );
            *had_errors = true;
        }
    } else {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(e) = fs::write(path, text) {
            eprintln!("codegen: failed to write {}: {e}", path.display());
            *had_errors = true;
        }
    }
}

/// Formats generated Rust through the same formatter the workspace check uses. Keeping this at
/// the write boundary means generated files remain reproducible while `cargo fmt --check` can
/// validate the entire workspace without a generated-code exception.
fn format_rust(source: &str, output_path: &Path) -> Result<String, String> {
    let file_name = output_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid generated file name: {}", output_path.display()))?;
    let parent = output_path
        .parent()
        .ok_or_else(|| format!("generated file has no parent: {}", output_path.display()))?;
    let mut temporary_path = None;
    for attempt in 0..100 {
        let candidate = parent.join(format!(
            ".{file_name}.rustfmt-{}-{attempt}.rs",
            std::process::id()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(source.as_bytes()) {
                    let _ = fs::remove_file(&candidate);
                    return Err(format!("failed to write temporary source: {e}"));
                }
                temporary_path = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("failed to create temporary source: {e}")),
        }
    }
    let path =
        temporary_path.ok_or_else(|| "could not reserve a temporary source path".to_string())?;

    let output = match Command::new("rustfmt")
        .args(["--edition", "2024"])
        .arg(&path)
        .output()
    {
        Ok(output) => output,
        Err(e) => {
            let _ = fs::remove_file(&path);
            return Err(format!("failed to start rustfmt: {e}"));
        }
    };
    let text =
        fs::read_to_string(&path).map_err(|e| format!("failed to read formatted source: {e}"));
    let _ = fs::remove_file(&path);

    if output.status.success() {
        text
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("rustfmt exited with {}", output.status)
        } else {
            stderr
        })
    }
}

fn normalize_line_endings(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// Reports one `quality_i18n::MissingEntry` under `source_label` (the hand-written file it's
/// missing from) — a hard `--check` error, or a plain-run warning. Shared by every completeness
/// diff (`qualityI18n.ts`, `issueRegistry.ts`, `qc_kind_registry.rs`) so the three call sites agree
/// on wording and on what counts as fatal.
fn report_missing_entry(
    source_label: &str,
    entry: &quality_i18n::MissingEntry,
    check_only: bool,
    had_errors: &mut bool,
) {
    let msg = format!(
        "{source_label}: {} has no entry for id \"{}\" (see generated/qualityIds.ts)",
        entry.registry, entry.id
    );
    if check_only {
        eprintln!("codegen: {msg}");
        *had_errors = true;
    } else {
        eprintln!("codegen: WARNING: {msg}");
    }
}

/// `--new-check`/`--new-strategy` scaffold a file and exit — combining either with `--check`
/// (which must stay read-only) or `--scaffold` (a different, unrelated write mode) would silently
/// run only the scaffold path while the other flag's request is dropped on the floor, so the
/// combination is rejected instead of the extra flag being ignored.
fn scaffold_flag_conflicts(
    has_new_check: bool,
    has_new_strategy: bool,
    check_only: bool,
    scaffold: bool,
) -> bool {
    (has_new_check || has_new_strategy)
        && (check_only || scaffold || (has_new_check && has_new_strategy))
}

/// Returns the value following `flag` in `args` (e.g. `--new-check min_region_size` -> Some
/// `"min_region_size"`), or `None` if `flag` isn't present or has nothing after it.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// `snake_case` only, matching every existing check/strategy id — scaffolding a file from an id
/// containing spaces, uppercase, or path separators would produce a broken filename or a Rust
/// identifier that doesn't compile, so this is checked before any file is touched.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn run_new_check(repo_root: &Path, id: &str) -> ExitCode {
    if !is_valid_id(id) {
        eprintln!(
            "codegen: --new-check id must be snake_case (lowercase letters, digits, underscores), got \"{id}\""
        );
        return ExitCode::FAILURE;
    }
    let checks_dir = repo_root
        .join("maze-core")
        .join("src")
        .join("quality_control")
        .join("checks");
    let scaffold = scaffold_new::new_check(id, &checks_dir);
    write_new_scaffold(scaffold, &checks_dir.join("mod.rs"), id)
}

fn run_new_strategy(repo_root: &Path, id: &str) -> ExitCode {
    if !is_valid_id(id) {
        eprintln!(
            "codegen: --new-strategy id must be snake_case (lowercase letters, digits, underscores), got \"{id}\""
        );
        return ExitCode::FAILURE;
    }
    let strategies_dir = repo_root
        .join("maze-core")
        .join("src")
        .join("repair")
        .join("strategies");
    let scaffold = scaffold_new::new_strategy(id, &strategies_dir);
    write_new_scaffold(scaffold, &strategies_dir.join("mod.rs"), id)
}

fn write_new_scaffold(
    scaffold: scaffold_new::NewFileScaffold,
    mod_rs_path: &Path,
    id: &str,
) -> ExitCode {
    if scaffold.path.exists() {
        eprintln!(
            "codegen: {} already exists — refusing to overwrite",
            scaffold.path.display()
        );
        return ExitCode::FAILURE;
    }
    if let Some(parent) = scaffold.path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::write(&scaffold.path, &scaffold.contents) {
        eprintln!("codegen: failed to write {}: {e}", scaffold.path.display());
        return ExitCode::FAILURE;
    }

    if let Ok(mod_rs_text) = fs::read_to_string(mod_rs_path) {
        if let Some(updated) = scaffold_new::ensure_mod_declared(&mod_rs_text, id)
            && let Err(e) = fs::write(mod_rs_path, updated)
        {
            eprintln!("codegen: failed to update {}: {e}", mod_rs_path.display());
            return ExitCode::FAILURE;
        }
    } else {
        eprintln!(
            "codegen: WARNING: could not read {} — add `pub mod {id};` by hand",
            mod_rs_path.display()
        );
    }

    println!("{}", scaffold.checklist);
    ExitCode::SUCCESS
}

fn to_snake_case_stem(enum_name: &str) -> String {
    codegen::naming::to_snake_case(enum_name)
}

fn parent_dir_of(rel_file: &str) -> PathBuf {
    Path::new(rel_file)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default()
}

fn find_repo_root() -> PathBuf {
    let mut dir = env::current_dir().expect("cwd");
    loop {
        if dir.join("Cargo.toml").exists() && dir.join("maze-core").exists() {
            return dir;
        }
        if !dir.pop() {
            panic!(
                "codegen: could not locate repo root (looked for a directory containing both Cargo.toml and maze-core/)"
            );
        }
    }
}

fn golden_to_json(entries: &[golden::GoldenEntry]) -> String {
    let mut out = String::from("[\n");
    for (i, e) in entries.iter().enumerate() {
        let bytes_json: Vec<String> = e.expected_bytes.iter().map(|b| b.to_string()).collect();
        out.push_str(&format!(
            "  {{ \"variant\": {}, \"value\": {}, \"bytes\": [{}] }}{}\n",
            json_escape(&e.variant_name),
            e.example_value_json,
            bytes_json.join(","),
            if i + 1 < entries.len() { "," } else { "" }
        ));
    }
    out.push_str("]\n");
    out
}

/// Escapes `s` as a JSON string literal (including the surrounding quotes) — `variant_name` is a
/// Rust identifier today and never needs it in practice, but the golden fixture is JSON consumed
/// by both `serde_json` (Rust golden tests) and `JSON.parse` (TS golden tests), so building it via
/// raw string interpolation is the wrong default regardless of what happens to be safe right now.
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod report_missing_entry_tests {
    use super::*;

    #[test]
    fn format_rust_uses_rustfmt_output() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_name = format!(
            "codegen-format-rust-test-{}-{unique}.rs",
            std::process::id()
        );
        let output_path = env::temp_dir().join(&file_name);
        assert_eq!(
            format_rust("fn main(){println!(\"ok\");}\n", &output_path).unwrap(),
            "fn main() {\n    println!(\"ok\");\n}\n"
        );
        let temporary_path = output_path
            .parent()
            .unwrap()
            .join(format!(".{file_name}.rustfmt-{}-0.rs", std::process::id()));
        assert!(!temporary_path.exists());
    }

    #[test]
    fn check_only_sets_had_errors() {
        let entry = quality_i18n::MissingEntry {
            registry: "checkI18n",
            id: "foo".to_string(),
        };
        let mut had_errors = false;
        report_missing_entry("qualityI18n.ts", &entry, true, &mut had_errors);
        assert!(had_errors);
    }

    #[test]
    fn plain_run_does_not_set_had_errors() {
        let entry = quality_i18n::MissingEntry {
            registry: "checkI18n",
            id: "foo".to_string(),
        };
        let mut had_errors = false;
        report_missing_entry("qualityI18n.ts", &entry, false, &mut had_errors);
        assert!(!had_errors);
    }

    #[test]
    fn had_errors_already_true_stays_true_on_plain_run() {
        let entry = quality_i18n::MissingEntry {
            registry: "checkI18n",
            id: "foo".to_string(),
        };
        let mut had_errors = true;
        report_missing_entry("qualityI18n.ts", &entry, false, &mut had_errors);
        assert!(had_errors);
    }
}

#[cfg(test)]
mod scaffold_flag_conflicts_tests {
    use super::*;

    #[test]
    fn new_check_alone_does_not_conflict() {
        assert!(!scaffold_flag_conflicts(true, false, false, false));
    }

    #[test]
    fn new_strategy_alone_does_not_conflict() {
        assert!(!scaffold_flag_conflicts(false, true, false, false));
    }

    #[test]
    fn neither_new_flag_never_conflicts() {
        assert!(!scaffold_flag_conflicts(false, false, true, true));
    }

    #[test]
    fn new_check_with_check_only_conflicts() {
        assert!(scaffold_flag_conflicts(true, false, true, false));
    }

    #[test]
    fn new_check_with_scaffold_conflicts() {
        assert!(scaffold_flag_conflicts(true, false, false, true));
    }

    #[test]
    fn new_check_and_new_strategy_together_conflicts() {
        assert!(scaffold_flag_conflicts(true, true, false, false));
    }
}

#[cfg(test)]
mod flag_value_tests {
    use super::*;

    #[test]
    fn returns_the_value_following_the_flag() {
        let args = vec![
            "codegen".to_string(),
            "--new-check".to_string(),
            "min_region_size".to_string(),
        ];
        assert_eq!(
            flag_value(&args, "--new-check"),
            Some("min_region_size".to_string())
        );
    }

    #[test]
    fn returns_none_when_flag_is_absent() {
        let args = vec!["codegen".to_string(), "--check".to_string()];
        assert_eq!(flag_value(&args, "--new-check"), None);
    }

    #[test]
    fn returns_none_when_flag_is_the_last_argument() {
        let args = vec!["codegen".to_string(), "--new-check".to_string()];
        assert_eq!(flag_value(&args, "--new-check"), None);
    }
}

#[cfg(test)]
mod is_valid_id_tests {
    use super::*;

    #[test]
    fn accepts_snake_case_ids() {
        assert!(is_valid_id("min_region_size"));
        assert!(is_valid_id("a"));
        assert!(is_valid_id("a1_2b"));
    }

    #[test]
    fn rejects_empty_string() {
        assert!(!is_valid_id(""));
    }

    #[test]
    fn rejects_leading_digit_or_underscore() {
        assert!(!is_valid_id("1abc"));
        assert!(!is_valid_id("_abc"));
    }

    #[test]
    fn rejects_uppercase_and_path_separators() {
        assert!(!is_valid_id("MinRegionSize"));
        assert!(!is_valid_id("min-region-size"));
        assert!(!is_valid_id("../evil"));
        assert!(!is_valid_id("a/b"));
    }
}

#[cfg(test)]
mod json_escape_tests {
    use super::*;

    #[test]
    fn plain_identifier_is_wrapped_in_quotes_unchanged() {
        assert_eq!(json_escape("VertexSelected"), "\"VertexSelected\"");
    }

    #[test]
    fn escapes_quotes_and_backslashes() {
        assert_eq!(json_escape(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    #[test]
    fn escapes_newline_carriage_return_and_tab() {
        assert_eq!(json_escape("a\nb\rc\td"), r#""a\nb\rc\td""#);
    }

    #[test]
    fn escapes_other_control_characters_as_unicode_escapes() {
        let input = char::from_u32(1).unwrap().to_string();
        let backslash = char::from_u32(0x5c).unwrap();
        let quote = '"';
        let expected = format!("{quote}{backslash}u{:04x}{quote}", 1u32);
        assert_eq!(json_escape(&input), expected);
    }
}
