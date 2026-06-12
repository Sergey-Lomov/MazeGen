use rand::Rng;
use rand::rngs::SmallRng;

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

pub fn sample_by_position(len: usize, target: f64, rng: &mut SmallRng) -> usize {
    debug_assert!(len > 0);
    if len == 1 { return 0; }

    let sigma = (SIGMA_MAX * (target.min(1.0 - target) * 2.0)).max(SIGMA_MIN);

    // When sigma is tiny, just round to nearest index deterministically.
    if sigma <= SIGMA_MIN * 1.5 {
        return ((target * (len - 1) as f64).round() as usize).min(len - 1);
    }

    let sigma_sq = sigma * sigma;
    let weights: Vec<f64> = (0..len).map(|i| {
        let x = i as f64 / (len - 1) as f64;
        let d = x - target;
        (-(d * d) / sigma_sq).exp()
    }).collect();

    let total: f64 = weights.iter().sum();
    let mut r = rng.random::<f64>() * total;
    for (i, &w) in weights.iter().enumerate() {
        r -= w;
        if r <= 0.0 { return i; }
    }
    len - 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn rng(seed: u64) -> SmallRng { SmallRng::seed_from_u64(seed) }

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
        let q: Vec<usize> = (0..4).map(|q| counts[q*5..(q+1)*5].iter().sum()).collect();
        for (i, &c) in q.iter().enumerate() {
            assert!(c > 10, "quartile {i} only got {c}/500 samples at target=0.5");
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
        assert!(lower > upper * 2, "target=0.25: lower half {lower} should dominate upper {upper}");
    }
}
