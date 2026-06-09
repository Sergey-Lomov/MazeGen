pub enum RepairResult {
    Fixed { score: Option<f64> },
    Failed,
}
