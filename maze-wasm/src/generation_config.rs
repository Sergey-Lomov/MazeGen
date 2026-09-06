// Re-export all config types from maze-runner — no duplication.
pub use maze_runner::config::{
    CheckInstanceConfig, QcRuleConfig, StageConfig,
    TessellationType, TessellationConfig,
    GenerateConfig, PresetConnectionDto, PresetEndpointDto,
    build_repair_limits, build_generation_config,
};
#[cfg(test)]
pub(crate) use maze_runner::config::StrategyConfig;
