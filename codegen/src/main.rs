use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use codegen::{check, golden, naming::to_camel_case, parser, rust_emitter, ts_emitter};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let check_only = args.iter().any(|a| a == "--check");

    let repo_root = find_repo_root();
    let maze_core_src = repo_root.join("maze-core").join("src");
    let ts_out_dir = repo_root.join("maze-web").join("src").join("debug").join("eventTape").join("generated");
    let golden_out_dir = repo_root.join("codegen").join("golden");

    let sources = match parser::discover_sources(&maze_core_src) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("codegen: parse error: {e}");
            return ExitCode::FAILURE;
        }
    };

    if sources.is_empty() {
        eprintln!("codegen: no #[derive(WireEvent)] enums found under {}", maze_core_src.display());
        return ExitCode::FAILURE;
    }

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
        let rust_wire_path = repo_root.join("maze-core").join("src").join(parent_dir_of(&source.location.rust_file)).join(format!("{}_wire.rs", source.location.stem));
        let new_rust_text = rust_emitter::generate_rust_wire_file(source);

        if let Ok(old_text) = fs::read_to_string(&rust_wire_path) {
            warnings.extend(check::detect_breaking_changes(&old_text, source));
        }

        // Every write for one source is all-or-nothing (`continue` on the first failure) — a
        // half-written source (Rust wire file failed but TS/golden still landed, or vice versa)
        // would leave Rust and TS silently disagreeing on disk despite `had_errors` correctly
        // failing the process; a caller that inspects the generated files directly (rather than
        // the exit code) could act on that stale, inconsistent state.
        if !check_only {
            if let Some(parent) = rust_wire_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Err(e) = fs::write(&rust_wire_path, &new_rust_text) {
                eprintln!("codegen: failed to write {}: {e}", rust_wire_path.display());
                had_errors = true;
                continue;
            }

            let source_file_path = repo_root.join("maze-core").join("src").join(&source.location.rust_file);
            if let Ok(existing) = fs::read_to_string(&source_file_path) {
                if let Some(updated) = rust_emitter::ensure_mod_declared(&existing, &source.location.stem) {
                    let _ = fs::write(&source_file_path, updated);
                }
            }
        }

        let ts_text = ts_emitter::generate_ts_file(source);
        let ts_path = ts_out_dir.join(format!("{}.ts", to_camel_case(&source.location.stem)));
        if !check_only {
            let _ = fs::create_dir_all(&ts_out_dir);
            if let Err(e) = fs::write(&ts_path, &ts_text) {
                eprintln!("codegen: failed to write {}: {e}", ts_path.display());
                had_errors = true;
                continue;
            }
        }

        let entries = golden::generate_golden(source);
        let golden_json = golden_to_json(&entries);
        let golden_path = golden_out_dir.join(format!("{}.json", source.location.stem));
        if !check_only {
            let _ = fs::create_dir_all(&golden_out_dir);
            if let Err(e) = fs::write(&golden_path, &golden_json) {
                eprintln!("codegen: failed to write {}: {e}", golden_path.display());
                had_errors = true;
                continue;
            }
        }

        let stem_camel = to_camel_case(&source.location.stem);
        if let Some(golden_test_text) = ts_emitter::generate_golden_test_file(source, &format!("./{stem_camel}")) {
            let golden_test_path = ts_out_dir.join(format!("{stem_camel}.golden.test.ts"));
            if !check_only {
                if let Err(e) = fs::write(&golden_test_path, &golden_test_text) {
                    eprintln!("codegen: failed to write {}: {e}", golden_test_path.display());
                    had_errors = true;
                    continue;
                }
            }
        }
    }

    for w in &warnings {
        eprintln!("codegen: WARNING: {w}");
    }

    if had_errors {
        ExitCode::FAILURE
    } else {
        println!("codegen: generated {} source(s)", sources.len());
        ExitCode::SUCCESS
    }
}

fn parent_dir_of(rel_file: &str) -> PathBuf {
    Path::new(rel_file).parent().map(|p| p.to_path_buf()).unwrap_or_default()
}

fn find_repo_root() -> PathBuf {
    let mut dir = env::current_dir().expect("cwd");
    loop {
        if dir.join("Cargo.toml").exists() && dir.join("maze-core").exists() {
            return dir;
        }
        if !dir.pop() {
            panic!("codegen: could not locate repo root (looked for a directory containing both Cargo.toml and maze-core/)");
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
