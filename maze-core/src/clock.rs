//! Monotonic-enough millisecond clock shared by the generation pipeline and `deadline`. Lives in
//! its own leaf module so low-level code (`graph`, `deadline`) never depends on `generation`.
//! `generation::pipeline::now_ms` re-exports it for existing callers (`maze-wasm`, `maze-runner`).

/// Milliseconds since an arbitrary epoch — only ever used for measuring elapsed duration within
/// one `build_maze` call, never compared across calls. `std::time::Instant` panics on
/// `wasm32-unknown-unknown` (no syscall backing it), so the wasm target reads `Performance.now()`
/// via `js-sys` instead; native (including `cargo test`) uses the monotonic `Instant` clock.
/// `pub` so `maze-wasm`'s `runner.rs` can time the initial `generate_maze` stage with the same
/// clock before calling `build_maze` — see `GenerationTiming::initial_build_ms`.
#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}
