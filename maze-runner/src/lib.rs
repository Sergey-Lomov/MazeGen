pub mod canonical;
pub mod config;
mod config_dto;
pub mod runner;
pub mod topology_wire;

pub use config::GenerateConfig;
pub use runner::{MazeRunResult, run_fixture, run_from_config};
