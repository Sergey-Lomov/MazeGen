// Re-export all config types from maze-runner — no duplication.
pub(crate) use maze_runner::config::StrategyConfig;
pub use maze_runner::config::{
    CheckInstanceConfig, GenerateConfig, PresetConnectionDto, PresetEndpointDto, QcRuleConfig,
    StageConfig, TessellationConfig, TessellationType, build_generation_config,
    build_repair_limits,
};
