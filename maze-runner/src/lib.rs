pub mod config;
mod config_dto;
pub mod runner;

pub use runner::{run_from_config, run_fixture, MazeRunResult};
pub use config::GenerateConfig;
