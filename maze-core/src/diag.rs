//! Temporary diagnostic logging channel — see `CLAUDE.md`'s "Debugging" section: every call site
//! using this must be tagged `// DIAG` and removed before committing. Not a permanent logging
//! facility (no levels, no filtering) — just a `println!` that also reaches the browser console
//! when built for `wasm32`, where stdout doesn't exist.
//!
//! Native (including `cargo test`/`maze-runner`) prints to stdout via `println!`; `wasm32` prints
//! via `console.log` (`web_sys::console::log_1`), since `println!` is silently swallowed there.

#[cfg(target_arch = "wasm32")]
pub fn diag_print(s: &str) {
    web_sys::console::log_1(&s.into());
}

#[cfg(not(target_arch = "wasm32"))]
pub fn diag_print(s: &str) {
    println!("{s}");
}

#[macro_export]
macro_rules! diag_log {
    ($($arg:tt)*) => {
        $crate::diag::diag_print(&format!($($arg)*)) // DIAG
    };
}
