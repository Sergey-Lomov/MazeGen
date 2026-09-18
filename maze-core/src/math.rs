use crate::random::MazeRng;
use rand::{Rng, RngCore};

/// Sample a weighted index from a collection of `len` elements using a
/// gaussian distribution centred at `target` ∈ [0,1] (mapped to index space).
///
/// sigma scales linearly with distance from the extremes:
///   sigma(t) = SIGMA_MAX * min(t, 1-t) * 2
///
/// This gives:
///   target=0.0 or 1.0 → sigma=0 → deterministic (oldest or newest)
///   target=0.5        → sigma=SIGMA_MAX → widest spread (near-uniform)
///   intermediate      → smooth gaussian peak at target
const SIGMA_MAX: f64 = 0.4;
const SIGMA_MIN: f64 = 1e-3; // avoid division by zero at extremes

pub fn sample_by_position(len: usize, target: f64, rng: &mut MazeRng) -> usize {
    debug_assert!(len > 0);
    if len == 1 {
        return 0;
    }

    let sigma = (SIGMA_MAX * (target.min(1.0 - target) * 2.0)).max(SIGMA_MIN);

    // When sigma is tiny, just round to nearest index deterministically.
    if sigma <= SIGMA_MIN * 1.5 {
        return ((target * (len - 1) as f64).round() as usize).min(len - 1);
    }

    let sigma_sq = sigma * sigma;
    let weights: Vec<f64> = (0..len)
        .map(|i| {
            let x = i as f64 / (len - 1) as f64;
            let d = x - target;
            (-(d * d) / sigma_sq).exp()
        })
        .collect();

    let total: f64 = weights.iter().sum();
    let mut r = rng.random::<f64>() * total;
    for (i, &w) in weights.iter().enumerate() {
        r -= w;
        if r <= 0.0 {
            return i;
        }
    }
    len - 1
}

/// Picks an index weighted by `weights`, falling back to a uniform pick over the same slice when
/// every weight is `<= 0` (an all-zero/negative config shouldn't make every pick fail). Shared by
/// generation's own pattern selection (`generation::split_logic::handle_pattern_split`) and
/// `repair::strategies::add_split`'s `pick_weighted_pattern` — both need the exact same
/// weight-or-uniform semantics (GitHub issue #275: the repair side used to ignore weight
/// entirely).
pub fn weighted_index(weights: &[f64], rng: &mut dyn RngCore) -> usize {
    debug_assert!(!weights.is_empty());
    let total: f64 = weights.iter().map(|w| w.max(0.0)).sum();
    if total <= 0.0 {
        return rng.random_range(0..weights.len());
    }

    let mut pick = rng.random::<f64>() * total;
    for (i, &w) in weights.iter().enumerate() {
        let w = w.max(0.0);
        if pick < w {
            return i;
        }
        pick -= w;
    }
    weights.len() - 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn rng(seed: u64) -> MazeRng {
        MazeRng::seed_from_u64(seed)
    }

    #[test]
    fn target_zero_always_returns_first() {
        for seed in 0..100 {
            assert_eq!(sample_by_position(20, 0.0, &mut rng(seed)), 0);
        }
    }

    #[test]
    fn target_one_always_returns_last() {
        for seed in 0..100 {
            assert_eq!(sample_by_position(20, 1.0, &mut rng(seed)), 19);
        }
    }

    #[test]
    fn target_half_covers_all_quartiles() {
        let len = 20usize;
        let mut counts = vec![0usize; len];
        for seed in 0..500 {
            let i = sample_by_position(len, 0.5, &mut rng(seed));
            counts[i] += 1;
        }
        // All quartiles should be visited at least a few times.
        let q: Vec<usize> = (0..4)
            .map(|q| counts[q * 5..(q + 1) * 5].iter().sum())
            .collect();
        for (i, &c) in q.iter().enumerate() {
            assert!(
                c > 10,
                "quartile {i} only got {c}/500 samples at target=0.5"
            );
        }
    }

    #[test]
    fn target_quarter_peak_in_lower_half() {
        let len = 20usize;
        let mut counts = vec![0usize; len];
        for seed in 0..500 {
            let i = sample_by_position(len, 0.25, &mut rng(seed));
            counts[i] += 1;
        }
        let lower: usize = counts[..10].iter().sum();
        let upper: usize = counts[10..].iter().sum();
        assert!(
            lower > upper * 2,
            "target=0.25: lower half {lower} should dominate upper {upper}"
        );
    }

    #[test]
    fn weighted_index_never_picks_a_zero_weight_entry() {
        let weights = [0.0, 5.0, 0.0];
        for seed in 0..200 {
            let mut r = rng(seed);
            assert_eq!(weighted_index(&weights, &mut r), 1);
        }
    }

    #[test]
    fn weighted_index_falls_back_to_uniform_when_all_weights_non_positive() {
        let weights = [0.0, 0.0, 0.0];
        let mut counts = vec![0usize; 3];
        for seed in 0..300 {
            let mut r = rng(seed);
            counts[weighted_index(&weights, &mut r)] += 1;
        }
        assert!(
            counts.iter().all(|&c| c > 0),
            "every index should get picked at least once: {counts:?}"
        );
    }

    #[test]
    fn weighted_index_respects_relative_weight() {
        let weights = [1.0, 9.0];
        let mut counts = [0usize; 2];
        for seed in 0..1000 {
            let mut r = rng(seed);
            counts[weighted_index(&weights, &mut r)] += 1;
        }
        assert!(
            counts[1] > counts[0] * 3,
            "weight 9 should dominate weight 1: {counts:?}"
        );
    }
}
