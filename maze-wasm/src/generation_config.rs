// Re-export all config types from maze-runner — no duplication.
pub use maze_runner::config::{
    StrategyConfig, CheckInstanceConfig, QcRuleConfig, StageConfig,
    TessellationType, TessellationConfig,
    GenerateConfig,
    build_repair_limits, build_generation_config,
};
