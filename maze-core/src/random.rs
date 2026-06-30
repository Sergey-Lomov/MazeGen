//! Project-wide RNG. Centralizing the concrete algorithm here means swapping it later
//! (e.g. for performance or quality reasons) only touches this file.
//!
//! `Xoshiro256PlusPlus` is used directly instead of `rand::rngs::SmallRng` because `SmallRng`
//! aliases to a *different* algorithm depending on `target_pointer_width` (32-bit vs 64-bit),
//! which breaks the Determinism Contract (`Specs/repair.md`): the same seed must produce the
//! same sequence on wasm32 (32-bit) and native (64-bit) targets.

pub use rand_xoshiro::Xoshiro256PlusPlus as MazeRng;
