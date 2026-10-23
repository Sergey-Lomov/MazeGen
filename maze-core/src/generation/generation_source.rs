use crate::random::{MazeRng, derive_seed};
use rand::SeedableRng;
use rand::prelude::IndexedRandom;

/// Domain tag for `derive_seed` — keeps the generation-source RNG stream independent from the
/// main generation algorithm's own draws off the same shared `seed`.
const DOMAIN_GEN_SOURCE: &str = "generation_source";

/// How the geometric fallback start point is chosen when no preset `gen_source` pin resolves
/// (GitHub issue #640). `preset_gen_source` (a separate, higher-priority mechanism) is not part
/// of this enum — when a pin is present it always wins regardless of `mode`; see
/// `resolve_generation_start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GenerationSourceMode {
    /// Centroid-nearest point — deterministic, no seed dependency (`pick_start_default`).
    #[default]
    Default,
    /// Uniformly random point, deterministic per `seed` via an independent RNG stream.
    Random,
}

/// Centroid-nearest point — the long-standing default geometric fallback. Panics if `points` is
/// empty; callers must guard for a non-empty field before calling.
pub fn pick_start_default<P: Copy>(points: &[P], to_xy: impl Fn(P) -> (i32, i32)) -> P {
    let n = points.len() as i32;
    let cx: i32 = points.iter().map(|&p| to_xy(p).0).sum::<i32>() / n;
    let cy: i32 = points.iter().map(|&p| to_xy(p).1).sum::<i32>() / n;
    *points
        .iter()
        .min_by_key(|&&p| {
            let (x, y) = to_xy(p);
            (x - cx) * (x - cx) + (y - cy) * (y - cy)
        })
        .unwrap()
}

/// Uniformly random point among all `points`, deterministic for a given `seed` and independent
/// of iteration order (`points` is sorted by `to_xy` before the draw, so callers building the
/// field in a different order still get the same pick for the same seed). Panics if `points` is
/// empty; callers must guard for a non-empty field before calling.
fn pick_start_random<P: Copy>(points: &[P], seed: u64, to_xy: impl Fn(P) -> (i32, i32)) -> P {
    let mut sorted: Vec<P> = points.to_vec();
    sorted.sort_by_key(|&p| to_xy(p));
    let mut rng = MazeRng::seed_from_u64(derive_seed(seed, DOMAIN_GEN_SOURCE));
    *sorted.choose(&mut rng).unwrap()
}

/// Single point of decision for the geometric fallback start point (GitHub issue #640) —
/// `pinned` (an already-resolved preset `gen_source` marker, if any) always wins; otherwise picks
/// per `mode`. Both `maze-wasm`'s `tessellation_dispatch` and `maze-runner`'s native runner call
/// this instead of keeping their own duplicated `pick_start`/`resolve_start` pair. `points` must be
/// non-empty when `pinned` is `None` — both call sites already guard the field for emptiness
/// before reaching this function.
pub fn resolve_generation_start<P: Copy>(
    points: &[P],
    pinned: Option<P>,
    mode: GenerationSourceMode,
    seed: u64,
    to_xy: impl Fn(P) -> (i32, i32),
) -> P {
    if let Some(p) = pinned {
        return p;
    }
    match mode {
        GenerationSourceMode::Default => pick_start_default(points, to_xy),
        GenerationSourceMode::Random => pick_start_random(points, seed, to_xy),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type P = (i32, i32);
    fn to_xy(p: P) -> (i32, i32) {
        p
    }

    fn grid(w: i32, h: i32) -> Vec<P> {
        (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).collect()
    }

    #[test]
    fn derive_seed_is_deterministic_and_domain_separated() {
        let seed = 12345u64;
        assert_eq!(
            derive_seed(seed, "a"),
            derive_seed(seed, "a"),
            "same (seed, domain) must yield the same sub-seed"
        );
        assert_ne!(
            derive_seed(seed, "a"),
            derive_seed(seed, "b"),
            "different domains must yield different sub-seeds for the same seed"
        );
    }

    #[test]
    fn pick_start_random_is_independent_of_input_order() {
        let points = grid(5, 5);
        let mut shuffled = points.clone();
        shuffled.reverse();

        for seed in [1u64, 2, 42, 999] {
            let a = pick_start_random(&points, seed, to_xy);
            let b = pick_start_random(&shuffled, seed, to_xy);
            assert_eq!(
                a, b,
                "pick must not depend on the order points were passed in (seed {seed})"
            );
        }
    }

    #[test]
    fn resolve_generation_start_default_mode_picks_centroid_nearest() {
        let points = grid(5, 5);
        let picked =
            resolve_generation_start(&points, None, GenerationSourceMode::Default, 7, to_xy);
        assert_eq!(picked, pick_start_default(&points, to_xy));
    }

    #[test]
    fn resolve_generation_start_random_mode_is_deterministic_for_fixed_seed() {
        // Snapshot-style: fixed field + fixed seed must always resolve to the same point. This
        // assertion is intentionally tied to the current derive_seed/sort scheme — if that scheme
        // changes deliberately, update this expected value as part of the same change, it is not
        // a regression signal on its own.
        let points = grid(5, 5);
        let picked =
            resolve_generation_start(&points, None, GenerationSourceMode::Random, 7, to_xy);
        let picked_again =
            resolve_generation_start(&points, None, GenerationSourceMode::Random, 7, to_xy);
        assert_eq!(
            picked, picked_again,
            "same seed must reproduce the same pick"
        );
    }

    #[test]
    fn resolve_generation_start_random_mode_varies_across_seeds() {
        let points = grid(6, 6);
        let picks: std::collections::HashSet<P> = (0u64..20)
            .map(|seed| {
                resolve_generation_start(&points, None, GenerationSourceMode::Random, seed, to_xy)
            })
            .collect();
        assert!(
            picks.len() > 1,
            "random mode across many seeds must not always resolve to the same point"
        );
    }

    #[test]
    fn resolve_generation_start_pin_wins_over_random_regardless_of_seed() {
        let points = grid(5, 5);
        let pin = (2, 2);
        for seed in [0u64, 1, 2, 3, 100] {
            let picked = resolve_generation_start(
                &points,
                Some(pin),
                GenerationSourceMode::Random,
                seed,
                to_xy,
            );
            assert_eq!(picked, pin, "a resolved pin must win regardless of seed");
        }
    }

    #[test]
    fn resolve_generation_start_pin_wins_over_default_too() {
        let points = grid(5, 5);
        let pin = (0, 0);
        let picked =
            resolve_generation_start(&points, Some(pin), GenerationSourceMode::Default, 7, to_xy);
        assert_eq!(picked, pin);
    }

    #[test]
    fn resolve_generation_start_single_point_field_returns_that_point() {
        let points = vec![(3, 4)];
        for mode in [GenerationSourceMode::Default, GenerationSourceMode::Random] {
            let picked = resolve_generation_start(&points, None, mode, 7, to_xy);
            assert_eq!(
                picked,
                (3, 4),
                "a single-point field must resolve to that point ({mode:?})"
            );
        }
    }
}
