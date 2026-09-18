pub mod config;
mod config_dto;
pub mod runner;

pub use config::GenerateConfig;
pub use runner::{MazeRunResult, run_fixture, run_from_config};
