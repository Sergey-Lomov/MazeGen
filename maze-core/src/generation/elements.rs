/// Controls Phase 1 graph growth.
pub struct GenerationConfig {
    /// weights[i] = weight for target degree i.
    /// Normalization is internal. Out-of-bounds falls back to 1.0.
    pub vertex_weights: VertexWeights,
    /// Probability [0.0, 1.0] of adding a back-edge (cycle) to an already-queued
    /// neighbour instead of a tree-edge to an unqueued one.
    /// Applies only when both tree and back candidates exist.
    pub cycle_prob: f64,
    /// Hard cap on bidirectional degree per node. Determined by tessellation.
    pub max_degree: usize,
}

impl GenerationConfig {
    pub fn new(vertex_weights: VertexWeights, cycle_prob: f64, max_degree: usize) -> Self {
        Self { vertex_weights, cycle_prob: cycle_prob.clamp(0.0, 1.0), max_degree }
    }
}

/// Target degree weights for vertex sampling.
/// weights[i] = weight for target degree i.
/// Length should be >= max_degree + 1 for the tessellation; out-of-bounds falls back to 1.0.
/// Normalization is done internally during sampling — no need to pre-normalize.
pub struct VertexWeights {
    pub weights: Vec<f64>,
}

impl VertexWeights {
    pub fn uniform(max_degree: usize) -> Self {
        Self { weights: vec![1.0; max_degree + 1] }
    }

    /// Returns the weight for the given degree. Falls back to 1.0 if out of bounds.
    pub fn get(&self, degree: usize) -> f64 {
        self.weights.get(degree).copied().unwrap_or(1.0)
    }
}

/// Weights controlling the probability of edge decoration in Phase 2.
pub struct EdgeWeights {
    /// Weight for one-way (directed) passage.
    pub one_way: f64,
    /// Weight for keeping the standard bidirectional passage.
    pub standard: f64,
}

impl EdgeWeights {
    pub fn one_way_probability(&self) -> f64 {
        let total = self.one_way + self.standard;
        if total <= 0.0 { 0.0 } else { self.one_way / total }
    }
}

impl Default for EdgeWeights {
    fn default() -> Self {
        // ~4% one-way to match the previous hardcoded behaviour
        Self { one_way: 0.04 / 0.96, standard: 1.0 }
    }
}
