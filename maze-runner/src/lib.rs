pub mod config;
pub mod runner;

pub use runner::{run_from_config, run_fixture, MazeRunResult};
pub use config::GenerateConfig;
