//! Canonical generation/QC/repair/split-pattern baselines (GitHub issue #753).
//!
//! Every fixture listed in `baseline_tests!` (from `tests/fixtures/baseline/`) is run with `BASELINE_SEED` and its canonical
//! snapshot (`maze_runner::canonical::canonical_baseline`) is compared with
//! `tests/baselines/<fixture>.json`. `*-gen.json` fixtures run the whole pipeline;
//! `*-qc.json` fixtures are QC experiments whose preset connections are a fixed graph, so their QC
//! and repair results don't depend on generation.
//!
//! A mismatch means observable behavior changed. Intentional differences must be explained before
//! the baselines are regenerated with:
//!
//! ```sh
//! UPDATE_BASELINES=1 cargo test -p maze-runner --test baselines
//! ```

use maze_runner::{GenerateConfig, canonical::canonical_baseline};
use serde_json::Value;
use std::path::Path;

const BASELINE_SEED: u64 = 753;
const FIXTURE_DIR: &str = "tests/fixtures/baseline";
const BASELINE_DIR: &str = "tests/baselines";

fn compute(fixture: &Path) -> Value {
    let json = std::fs::read_to_string(fixture).unwrap();
    let config: GenerateConfig = serde_json::from_str(&json)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", fixture.display()));
    canonical_baseline(&config, BASELINE_SEED)
        .unwrap_or_else(|e| panic!("baseline run failed for {}: {e}", fixture.display()))
}

/// First differing JSON path between `expected` and `actual`, for a readable failure message.
fn first_difference(expected: &Value, actual: &Value, path: &str) -> Option<String> {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            let mut keys: Vec<&String> = e.keys().chain(a.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|key| {
                let sub = format!("{path}.{key}");
                match (e.get(key), a.get(key)) {
                    (Some(ev), Some(av)) => first_difference(ev, av, &sub),
                    (Some(_), None) => Some(format!("{sub}: missing in actual")),
                    (None, Some(_)) => Some(format!("{sub}: unexpected in actual")),
                    (None, None) => None,
                }
            })
        }
        (Value::Array(e), Value::Array(a)) => {
            let shared = e
                .iter()
                .zip(a)
                .enumerate()
                .find_map(|(i, (ev, av))| first_difference(ev, av, &format!("{path}[{i}]")));
            shared.or_else(|| {
                (e.len() != a.len())
                    .then(|| format!("{path}: length {} expected, {} actual", e.len(), a.len()))
            })
        }
        _ if expected == actual => None,
        _ => Some(format!("{path}: expected {expected}, actual {actual}")),
    }
}

/// Compares `<FIXTURE_DIR>/<name>.json`'s canonical snapshot with `<BASELINE_DIR>/<name>.json`, or
/// rewrites the latter when `UPDATE_BASELINES` is set.
fn check_baseline(name: &str) {
    let fixture = Path::new(FIXTURE_DIR).join(format!("{name}.json"));
    let baseline = Path::new(BASELINE_DIR).join(format!("{name}.json"));
    let actual = compute(&fixture);
    if std::env::var_os("UPDATE_BASELINES").is_some() {
        std::fs::create_dir_all(BASELINE_DIR).unwrap();
        let text = serde_json::to_string_pretty(&actual).unwrap() + "\n";
        std::fs::write(&baseline, text).unwrap();
        return;
    }
    let text = std::fs::read_to_string(&baseline)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", baseline.display()));
    let expected: Value = serde_json::from_str(&text).unwrap();
    if let Some(diff) = first_difference(&expected, &actual, "$") {
        panic!(
            "{name}: canonical baseline differs (explain the change, then rerun with \
             UPDATE_BASELINES=1): {diff}"
        );
    }
}

macro_rules! baseline_tests {
    ($($test:ident => $name:literal),* $(,)?) => {
        $(
            #[test]
            fn $test() {
                check_baseline($name);
            }
        )*

        /// Every fixture in `FIXTURE_DIR` must have a baseline test — the benchmark scans the
        /// directory, so an unlisted fixture would be benchmarked but never compared.
        #[test]
        fn every_fixture_has_a_baseline_test() {
            let listed: Vec<&str> = vec![$($name),*];
            let mut on_disk: Vec<String> = std::fs::read_dir(FIXTURE_DIR)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
                .map(|path| path.file_stem().unwrap().to_string_lossy().into_owned())
                .collect();
            on_disk.sort();
            let mut listed: Vec<String> = listed.into_iter().map(String::from).collect();
            listed.sort();
            assert_eq!(on_disk, listed, "baseline_tests! must list every fixture in {FIXTURE_DIR}");
        }
    };
}

baseline_tests! {
    square_generation => "baseline-square-gen",
    hex_generation => "baseline-hex-gen",
    tri_generation => "baseline-tri-gen",
    cairo_generation => "baseline-cairo-gen",
    square_qc_repair_split => "baseline-square-qc",
    hex_qc_repair_split => "baseline-hex-qc",
    tri_qc_repair_split => "baseline-tri-qc",
    cairo_qc_repair_split => "baseline-cairo-qc",
}

/// Every rule with a strategy must have that strategy dispatched during repair in at least one QC
/// fixture — a rule that never fires is a blind spot: a refactor that breaks its detection would
/// leave every baseline unchanged.
#[test]
fn every_rule_strategy_is_dispatched_somewhere() {
    let read = |dir: &str, name: &str| -> Value {
        let path = Path::new(dir).join(format!("{name}.json"));
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
    };
    let mut configured = std::collections::BTreeSet::new();
    let mut dispatched = std::collections::BTreeSet::new();
    for tess in ["square", "hex", "tri", "cairo"] {
        let name = format!("baseline-{tess}-qc");
        let config = read(FIXTURE_DIR, &name);
        for stage in config["stages"].as_array().unwrap() {
            for rule in stage["rules"].as_array().unwrap() {
                if !rule["strategy"].is_null() {
                    configured.insert(rule["id"].as_str().unwrap().to_string());
                }
            }
        }
        let baseline = read(BASELINE_DIR, &name);
        dispatched.extend(
            baseline["repair"]["dispatched"]
                .as_object()
                .unwrap()
                .keys()
                .cloned(),
        );
    }
    let never: Vec<&String> = configured.difference(&dispatched).collect();
    assert!(
        never.is_empty(),
        "rules whose strategy is never dispatched in any QC fixture: {never:?}"
    );
}
