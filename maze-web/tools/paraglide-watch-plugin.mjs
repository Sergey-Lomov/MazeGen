// Keeps `generated/paraglide` current while the dev server runs. The initial compile happens in
// `tools/prepare-paraglide.mjs` (the `predev`/`prebuild` scripts); this only reacts to edits of
// the translations or the inlang settings. It replaces `paraglideVitePlugin`, which compiled the
// project a second time on every start.
import { isParaglideSource, recompileParaglide } from "./prepare-paraglide.mjs";

const debounceMs = 100;

export function paraglideWatchPlugin() {
  return {
    name: "mazegen-paraglide-watch",
    apply: "serve",
    configureServer(server) {
      let timer;
      let running = Promise.resolve();
      const schedule = (file) => {
        if (!isParaglideSource(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          running = running
            .then(recompileParaglide)
            .then(() => server.config.logger.info("[paraglide] recompiled translations"))
            .catch((error) => server.config.logger.error(`[paraglide] compile failed: ${error.message}`));
        }, debounceMs);
      };
      for (const event of ["add", "change", "unlink"]) server.watcher.on(event, schedule);
    },
  };
}
