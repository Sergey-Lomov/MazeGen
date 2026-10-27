# Scripts

Helper scripts for local development. Run them from any directory: each one resolves the repo root itself.

| Task | macOS / Linux | Windows (PowerShell) |
|------|---------------|----------------------|
| Start the web dev server | `scripts/dev.sh` | `scripts/windows/dev.ps1` |
| Run all Rust tests, rebuild WASM, run web tests | `scripts/test.sh` | `scripts/windows/test.ps1` |
| Rebuild WASM and copy it to `maze-web/src/wasm/pkg` | `scripts/wasm-rebuild.sh` | `scripts/windows/wasm-rebuild.ps1` |
| Remove stale Cargo artifacts from `target/` | `scripts/clean-stale.sh` | `scripts/windows/clean-stale.ps1` |
| Schedule periodic stale-artifact cleanup | n/a (use cron) | `scripts/windows/register-clean-task.ps1` |

Cross-platform logic lives next to the shell wrappers (`clean-stale.mjs`, run with Node). The `windows/` folder holds only PowerShell equivalents and Windows-only tooling (Task Scheduler).

## Stale artifact cleanup

`cargo` never deletes outputs of old toolchains, changed dependencies, features or profiles, so `target/` grows without bound. `clean-stale.mjs` groups artifacts in `deps`, `.fingerprint`, `build` and `incremental` by crate and removes all but the newest variants.

```
scripts/clean-stale.sh [--dry-run] [--keep N] [--max-age DAYS]
```

- `--dry-run`: only report what would be removed.
- `--keep N`: variants kept per crate (default 2: current and previous, so alternating feature sets or profiles does not thrash).
- `--max-age DAYS`: age after which throwaway dirs (`target/flycheck*`, `target/tmp`) are removed (default 14).

Safe to run during a build: variants modified within the last hour are kept, and files locked by a running process are skipped. Removing a file that was still needed only costs a rebuild.

### Automatic run (Windows)

```
scripts/windows/register-clean-task.ps1 [-At 03:00]
```

Registers the Task Scheduler job `MazeGenCleanStale` for the current user (no admin needed). It runs 4 times a day, every 6 hours starting at `-At` (default 03:00, 09:00, 15:00, 21:00). It survives reboots; if the machine was off at a scheduled time, the job runs at the next opportunity (a single run, missed runs do not pile up). Re-run to change the start time. Remove with `Unregister-ScheduledTask MazeGenCleanStale`.

On macOS / Linux add a cron entry instead, for example `0 3,9,15,21 * * * /path/to/MazeGen/scripts/clean-stale.sh`.
