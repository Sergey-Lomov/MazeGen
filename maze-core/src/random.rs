//! Project-wide RNG. Centralizing the concrete algorithm here means swapping it later
//! (e.g. for performance or quality reasons) only touches this file.
//!
//! `Xoshiro256PlusPlus` is used directly instead of `rand::rngs::SmallRng` because `SmallRng`
//! aliases to a *different* algorithm depending on `target_pointer_width` (32-bit vs 64-bit),
//! which breaks the Determinism Contract (`Specs/repair.md`): the same seed must produce the
//! same sequence on wasm32 (32-bit) and native (64-bit) targets.

pub use rand_xoshiro::Xoshiro256PlusPlus as MazeRng;

/// Derives an independent, deterministic sub-seed from the run's shared `seed` and a `domain`
/// tag, so a feature (e.g. random generation-source pick) can draw from its own `MazeRng` stream
/// without perturbing the sequence the main generation algorithm consumes from `seed` directly.
/// Same `(seed, domain)` always yields the same sub-seed; different domains yield uncorrelated
/// streams even for the same `seed`. Uses `SplitMix64`-style mixing — cheap, well-distributed,
/// and independent of the `rand` crate's own algorithm choice.
pub fn derive_seed(seed: u64, domain: &str) -> u64 {
    let domain_hash = domain
        .bytes()
        .fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    let mut z = seed.wrapping_add(domain_hash).wrapping_add(0x9e3779b97f4a7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}
