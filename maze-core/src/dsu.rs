/// Union-find over `0..n` indices, with path-compressed `find`.
pub struct Dsu {
    parent: Vec<usize>,
    size: Vec<usize>,
}

impl Dsu {
    pub fn new(n: usize) -> Self {
        Self { parent: (0..n).collect(), size: vec![1; n] }
    }

    pub fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            self.parent[x] = self.find(self.parent[x]);
        }
        self.parent[x]
    }

    /// Merge smaller tree into larger (amortized O(log n) per op). Use when the choice
    /// of resulting root doesn't matter, only speed.
    pub fn union_by_size(&mut self, a: usize, b: usize) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra == rb { return; }
        if self.size[ra] >= self.size[rb] {
            self.parent[rb] = ra;
            self.size[ra] += self.size[rb];
        } else {
            self.parent[ra] = rb;
            self.size[rb] += self.size[ra];
        }
    }

    /// Merge into the lower-indexed root. Deterministic regardless of union order —
    /// needed when callers rely on a reproducible root (e.g. seeded generation).
    pub fn union_by_min(&mut self, a: usize, b: usize) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra == rb { return; }
        if ra < rb {
            self.parent[rb] = ra;
        } else {
            self.parent[ra] = rb;
        }
    }
}
