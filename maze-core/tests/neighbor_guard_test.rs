//! Guard: `Tessellation::neighbor` is the base adjacency. Maze algorithms must use
//! `Field::neighbor_via` / `MultiLevelField::neighbor_via` so folds are honoured
//! (`Specs/topology.md`).

use std::fs;
use std::path::{Path, PathBuf};

/// Directories and files where direct `.neighbor(` calls are allowed: the space layer itself
/// (tessellation implementations, `space/geometry`, `field_ops`, presets) and the geometry
/// snapshot, which describes base geometry.
const ALLOWED: &[&str] = &["maze-core/src/space/", "maze-runner/src/runner/geometry.rs"];

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn direct_tessellation_neighbor_calls_stay_in_allowed_modules() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut files = Vec::new();
    for dir in ["maze-core/src", "maze-runner/src", "maze-wasm/src"] {
        collect(&root.join(dir), &mut files);
    }
    let mut offenders = Vec::new();
    for path in files {
        let rel = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        if ALLOWED.iter().any(|a| rel.starts_with(a)) {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        for (i, line) in text.lines().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            if code.contains(".neighbor(") {
                offenders.push(format!("{rel}:{}", i + 1));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "use `neighbor_via` instead of `Tessellation::neighbor` in: {offenders:?}"
    );
}
