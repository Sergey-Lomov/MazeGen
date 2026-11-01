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
        // A row has no bits above its own pivot, so xoring it never touches words above the
        // current top word: the pivot search resumes from there instead of rescanning from the end.
        let mut top = vector.len();
        loop {
            while top > 0 && vector[top - 1] == 0 {
                top -= 1;
            }
            if top == 0 {
                return false; // reduced to the zero vector: dependent
            }
            let pivot = (top - 1) * 64 + 63 - vector[top - 1].leading_zeros() as usize;
            match &self.rows[pivot] {
                Some(row) => xor_into(&mut vector[..top], &row[..top]),
                None => {
                    self.rows[pivot] = Some(vector);
                    return true;
                }
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn bits(words: usize, set: &[usize]) -> Vec<u64> {
        set_bit(words, set.iter().copied())
    }

    #[test]
    fn dependent_vector_across_word_boundary_is_rejected() {
        let mut basis = GF2Basis::new(130);
        assert!(basis.try_insert(bits(3, &[0, 70, 129])));
        assert!(basis.try_insert(bits(3, &[70, 100])));
        // (0,70,129) xor (70,100) = (0,100,129): dependent on the two rows above.
        assert!(!basis.try_insert(bits(3, &[0, 100, 129])));
    }

    #[test]
    fn zero_vector_is_dependent() {
        let mut basis = GF2Basis::new(64);
        assert!(!basis.try_insert(bits(1, &[])));
    }

    #[test]
    fn reduction_to_lower_word_pivot_inserts_independent_vector() {
        let mut basis = GF2Basis::new(130);
        assert!(basis.try_insert(bits(3, &[129, 5])));
        // Reduces against the row above, leaving only bit 7 in word 0.
        assert!(basis.try_insert(bits(3, &[129, 5, 7])));
        assert!(!basis.try_insert(bits(3, &[7])));
    }
}
