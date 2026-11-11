//! Cooperative QC time limit (GitHub issue #976). `RepairBudget` only checks `time_budget_secs`
//! between fixpoint iterations, so one long check/strategy could overrun it unboundedly. The
//! engine installs a deadline ([`install`]) for the duration of `run_repair_stages`; long-running loops call
//! [`expired`] and bail out early with their existing "nothing found / failed" result.
//!
//! The deadline lives in a thread-local so no `Check`/`RepairStrategy` signature changes. It uses
//! the real clock (`clock::now_ms`), not the injected `now_ms` of `run_full`.
//! Once expired it stays expired until the guard drops, so every later call also bails out.

use crate::clock::now_ms;
use std::cell::Cell;

/// How many `expired` calls share one clock read — keeps the call cheap enough for hot loops.
const CLOCK_READ_INTERVAL: u32 = 64;

/// All state in one thread-local so a call is a single TLS access (`expired` sits in the hot loop
/// of Johnson's cycle enumeration).
#[derive(Clone, Copy)]
struct State {
    deadline_ms: Option<f64>,
    expired: bool,
    ticks: u32,
}

impl State {
    /// The first `expired` call reads the clock, so an already-past deadline fires immediately.
    const fn fresh(deadline_ms: Option<f64>) -> Self {
        Self {
            deadline_ms,
            expired: false,
            ticks: CLOCK_READ_INTERVAL - 1,
        }
    }
}

thread_local! {
    static STATE: Cell<State> = const { Cell::new(State::fresh(None)) };
}

/// Restores the previously installed deadline (and clears the expired latch) on drop.
pub struct DeadlineGuard {
    previous: Option<f64>,
}

impl Drop for DeadlineGuard {
    fn drop(&mut self) {
        STATE.with(|s| s.set(State::fresh(self.previous)));
    }
}

/// Installs an absolute deadline (`clock::now_ms` epoch); `None` means no limit.
pub fn install(deadline_ms: Option<f64>) -> DeadlineGuard {
    let previous = STATE.with(|s| s.replace(State::fresh(deadline_ms)).deadline_ms);
    DeadlineGuard { previous }
}

/// True once the installed deadline has passed. Always false when none is installed.
pub fn expired() -> bool {
    STATE.with(|cell| {
        let mut state = cell.get();
        if state.expired {
            return true;
        }
        let Some(deadline) = state.deadline_ms else {
            return false;
        };
        state.ticks = state.ticks.wrapping_add(1);
        if state.ticks.is_multiple_of(CLOCK_READ_INTERVAL) && now_ms() >= deadline {
            state.expired = true;
        }
        cell.set(state);
        state.expired
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_or_far_future_deadline_never_expires() {
        {
            let _guard = install(None);
            for _ in 0..1000 {
                assert!(!expired());
            }
        }
        let _guard = install(Some(now_ms() + 1e9));
        for _ in 0..1000 {
            assert!(!expired());
        }
    }

    #[test]
    fn past_deadline_expires_on_first_call_and_latches() {
        let _guard = install(Some(now_ms() - 1.0));
        assert!(expired());
        assert!(expired());
    }

    #[test]
    fn guard_drop_clears_deadline_and_latch() {
        {
            let _guard = install(Some(now_ms() - 1.0));
            assert!(expired());
        }
        assert!(!expired());
    }

    #[test]
    fn nested_guard_restores_outer_deadline() {
        let _outer = install(Some(now_ms() + 1e9));
        {
            let _inner = install(Some(now_ms() - 1.0));
            assert!(expired());
        }
        assert!(!expired());
    }
}
