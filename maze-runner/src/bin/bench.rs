//! Per-stage pipeline benchmark against a recorded baseline (GitHub issue #753).
//!
//! ```sh
//! cargo run --release -p maze-runner --bin bench              # compare with the baseline
//! cargo run --release -p maze-runner --bin bench -- --record  # rewrite the baseline
//! cargo run --release -p maze-runner --bin bench -- --runs 20 # more runs per measurement
//! ```
//!
//! Stages are measured on the canonical baseline fixtures (`tests/fixtures/baseline/`):
//! `generation` on every `*-gen.json` fixture, `qc` (all checks once, no repair) and `repair` (the
//! full QC+repair loop) on every `*-qc.json` fixture, whose fixed graph keeps them independent of
//! generation. Each measurement is the median of `--runs` samples (at least 10) after one warm-up
//! run; setup (field, presets, graph) is never timed. `qc` and `repair` include building the QC
//! engine from the config (and `qc` copying the field/graph) — sub-millisecond next to the stage. A stage shorter than `MIN_SAMPLE_MS` is
//! repeated within each sample (count fixed from the warm-up) and the sample is the per-run mean,
//! so millisecond-scale stages aren't dominated by timer and scheduler noise.
//!
//! The baseline stores each measurement's median, its spread (interquartile range relative to
//! the median) and a threshold: the larger of 5% and the recorded spread. Comparison fails when a
//! median exceeds its baseline median by more than the threshold.

use maze_core::space::Tessellation;
use maze_runner::GenerateConfig;
use maze_runner::runner::prepare::{Prepared, TessellationVisitor, dispatch};
use maze_runner::runner::stages::{run_check_only, run_generation, run_repair, seed_graph};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

const SEED: u64 = 753;
const MIN_RUNS: usize = 10;
const DEFAULT_RUNS: usize = 15;
const DEFAULT_THRESHOLD: f64 = 0.05;
const MIN_SAMPLE_MS: f64 = 100.0;
const FIXTURE_DIR: &str = "tests/fixtures/baseline";
const BASELINE_FILE: &str = "bench/baseline.json";

#[derive(Clone, Copy)]
enum Stage {
    Generation,
    Qc,
    Repair,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Generation => "generation",
            Stage::Qc => "qc",
            Stage::Repair => "repair",
        }
    }
}

/// Times one stage of one run; everything before the stage starts is untimed setup.
struct TimeStage<'a> {
    config: &'a GenerateConfig,
    stage: Stage,
}

impl TessellationVisitor for TimeStage<'_> {
    type Output = f64;

    fn visit<T: Tessellation + 'static>(self, prepared: Prepared<T>) -> Result<f64, String> {
        let config = self.config;
        let mut seeded = seed_graph(prepared, config)?;
        let started = Instant::now();
        match self.stage {
            Stage::Generation => {
                std::hint::black_box(run_generation(&mut seeded, config));
            }
            Stage::Qc => {
                std::hint::black_box(run_check_only(&seeded, config)?);
            }
            Stage::Repair => {
                std::hint::black_box(run_repair(seeded, config, None, None)?);
            }
        }
        Ok(started.elapsed().as_secs_f64() * 1000.0)
    }
}

struct Measurement {
    median_ms: f64,
    spread: f64,
}

fn measure(config: &GenerateConfig, stage: Stage, runs: usize) -> Result<Measurement, String> {
    let run = || dispatch(SEED, config, TimeStage { config, stage });
    let warm_up_ms = run()?;
    let repeats = (MIN_SAMPLE_MS / warm_up_ms.max(1e-3)).ceil().max(1.0) as usize;
    let sample = || -> Result<f64, String> {
        let mut total = 0.0;
        for _ in 0..repeats {
            total += run()?;
        }
        Ok(total / repeats as f64)
    };
    let mut samples = (0..runs)
        .map(|_| sample())
        .collect::<Result<Vec<f64>, String>>()?;
    samples.sort_by(f64::total_cmp);
    let quantile = |q: f64| samples[((samples.len() - 1) as f64 * q).round() as usize];
    let median_ms = quantile(0.5);
    let spread = if median_ms > 0.0 {
        (quantile(0.75) - quantile(0.25)) / median_ms
    } else {
        0.0
    };
    Ok(Measurement { median_ms, spread })
}

fn fixtures(root: &Path, suffix: &str) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(root.join(FIXTURE_DIR))
        .unwrap_or_else(|e| panic!("failed to read {FIXTURE_DIR}: {e}"))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.to_string_lossy().ends_with(suffix))
        .collect();
    paths.sort();
    paths
}

fn load(path: &Path) -> GenerateConfig {
    let json = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&json)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

fn parse_args() -> Result<(bool, usize), String> {
    let mut record = false;
    let mut runs = DEFAULT_RUNS;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--record" => record = true,
            "--runs" => {
                runs = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or("--runs needs a number")?;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if runs < MIN_RUNS {
        return Err(format!("--runs must be at least {MIN_RUNS}"));
    }
    Ok((record, runs))
}

fn main() -> ExitCode {
    let (record, runs) = match parse_args() {
        Ok(args) => args,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    if cfg!(debug_assertions) {
        eprintln!("warning: debug build — run with `cargo run --release` for meaningful numbers");
    }

    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let plan: Vec<(Stage, PathBuf)> = fixtures(root, "-gen.json")
        .into_iter()
        .map(|path| (Stage::Generation, path))
        .chain(
            fixtures(root, "-qc.json")
                .into_iter()
                .flat_map(|path| [(Stage::Qc, path.clone()), (Stage::Repair, path)]),
        )
        .collect();

    let baseline_path = root.join(BASELINE_FILE);
    let baseline: Value = if record {
        Value::Null
    } else {
        match std::fs::read_to_string(&baseline_path) {
            Ok(text) => serde_json::from_str(&text).expect("invalid benchmark baseline"),
            Err(e) => {
                eprintln!(
                    "failed to read {}: {e} (record one with --record)",
                    baseline_path.display()
                );
                return ExitCode::FAILURE;
            }
        }
    };

    let mut recorded = Map::new();
    let mut regressions = 0;
    println!(
        "{:<36} {:>12} {:>8} {:>12} {:>9} {:>9}",
        "measurement", "median ms", "spread", "baseline ms", "change", "threshold"
    );
    for (stage, path) in plan {
        let fixture = path.file_stem().unwrap().to_string_lossy().into_owned();
        let key = format!("{}/{fixture}", stage.name());
        let m = match measure(&load(&path), stage, runs) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("{key}: {e}");
                return ExitCode::FAILURE;
            }
        };

        if record {
            let threshold = DEFAULT_THRESHOLD.max((m.spread * 100.0).ceil() / 100.0);
            println!(
                "{key:<36} {:>12.3} {:>7.1}% {:>12} {:>9} {:>8.0}%",
                m.median_ms,
                m.spread * 100.0,
                "-",
                "-",
                threshold * 100.0
            );
            recorded.insert(
                key,
                json!({ "median_ms": m.median_ms, "spread": m.spread, "threshold": threshold }),
            );
            continue;
        }

        let entry = &baseline["measurements"][&key];
        let (Some(base_ms), Some(threshold)) =
            (entry["median_ms"].as_f64(), entry["threshold"].as_f64())
        else {
            println!(
                "{key:<36} {:>12.3} {:>7.1}%  not in baseline",
                m.median_ms,
                m.spread * 100.0
            );
            regressions += 1;
            continue;
        };
        let change = m.median_ms / base_ms - 1.0;
        let verdict = if change > threshold {
            regressions += 1;
            "  REGRESSION"
        } else {
            ""
        };
        println!(
            "{key:<36} {:>12.3} {:>7.1}% {:>12.3} {:>+8.1}% {:>8.0}%{verdict}",
            m.median_ms,
            m.spread * 100.0,
            base_ms,
            change * 100.0,
            threshold * 100.0
        );
    }

    if record {
        let out = json!({ "seed": SEED, "runs": runs, "measurements": recorded });
        std::fs::create_dir_all(baseline_path.parent().unwrap()).unwrap();
        std::fs::write(
            &baseline_path,
            serde_json::to_string_pretty(&out).unwrap() + "\n",
        )
        .unwrap();
        println!("baseline written to {}", baseline_path.display());
        return ExitCode::SUCCESS;
    }
    if regressions > 0 {
        println!("{regressions} measurement(s) over threshold");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
