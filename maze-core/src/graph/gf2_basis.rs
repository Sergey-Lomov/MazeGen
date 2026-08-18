//! Reduced row-echelon GF(2) basis over an abstract bit-universe — see [`GF2Basis`]'s doc
//! comment for the shared elimination core reused by cycle-space computations across the crate.

/// Reduced row-echelon GF(2) basis over an abstract bit-universe — knows nothing about what a
/// bit represents (a nav-edge's `canonical_index` here, an `EdgeId`-remap index in
/// `InvalidLoopScoredStrategy`); each caller maps its own domain to bit positions before
/// calling `try_insert`. See GitHub issue #284: this is the shared elimination core reused by
/// both `find_all_simple_cycles`'s incremental basis construction and the repair-strategy's
/// batch elimination over an already-known cycle list — only the XOR/pivot mechanics are
/// shared; each call site's domain-to-bit mapping is its own, not abstracted into this type.
pub(crate) struct GF2Basis {
    words_per_row: usize,
    /// Indexed by pivot bit position; `None` until that bit becomes some row's pivot.
    rows: Vec<Option<Vec<u64>>>,
}

impl GF2Basis {
    pub(crate) fn new(bit_count: usize) -> Self {
        GF2Basis {
            words_per_row: bit_count.div_ceil(64).max(1),
            rows: (0..bit_count).map(|_| None).collect(),
        }
    }

    /// Reduces `vector` against existing pivot rows (highest bit first); if a nonzero
    /// remainder survives, inserts it as a new pivot row (at its own highest set bit) and
    /// returns `true` (independent of everything inserted so far). If it reduces to zero,
    /// returns `false` (linearly dependent, already spanned) and `vector` is discarded.
    pub(crate) fn try_insert(&mut self, mut vector: Vec<u64>) -> bool {
        debug_assert_eq!(vector.len(), self.words_per_row);
        loop {
            let Some(pivot) = highest_set_bit(&vector) else {
                return false; // reduced to the zero vector: dependent
            };
            match &self.rows[pivot] {
                Some(row) => xor_into(&mut vector, row),
                None => {
                    self.rows[pivot] = Some(vector);
                    return true;
                }
            }
        }
    }
}

fn highest_set_bit(vector: &[u64]) -> Option<usize> {
    for (word_idx, &word) in vector.iter().enumerate().rev() {
        if word != 0 {
            let bit_in_word = 63 - word.leading_zeros() as usize;
            return Some(word_idx * 64 + bit_in_word);
        }
    }
    None
}

fn xor_into(vector: &mut [u64], other: &[u64]) {
    for (a, &b) in vector.iter_mut().zip(other.iter()) {
        *a ^= b;
    }
}

/// Sets bit `bit` (word-index `bit / 64`, in-word `bit % 64`) in a fresh zeroed bit-vector of
/// `words_per_row` words. Shared helper for building the bit-vector `GF2Basis::try_insert`
/// expects from a domain-specific caller — `words_per_row` must match the `GF2Basis` it will be
/// inserted into (i.e. `bit_count.div_ceil(64).max(1)` for that basis' own `bit_count`).
pub(crate) fn set_bit(words_per_row: usize, bits: impl Iterator<Item = usize>) -> Vec<u64> {
    let mut v = vec![0u64; words_per_row];
    for bit in bits {
        v[bit / 64] |= 1u64 << (bit % 64);
    }
    v
}
