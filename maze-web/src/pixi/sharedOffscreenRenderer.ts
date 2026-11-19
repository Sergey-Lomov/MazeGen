import { Application, Container } from "pixi.js";

// One WebGL context for every small static preview. A `new Application()` per preview exhausts the
// browser's context limit (~16) as soon as a dialog lists many of them.
let appPromise: Promise<Application> | null = null;
// Renders share the one canvas, so they run strictly one after another.
let queue: Promise<unknown> = Promise.resolve();

function sharedApp(): Promise<Application> {
  if (!appPromise) {
    const app = new Application();
    const created: Promise<Application> = app
      .init({ width: 1, height: 1, backgroundAlpha: 0, antialias: true, autoStart: false, sharedTicker: false })
      .then(
        () => {
          // A lost context leaves a dead renderer that draws blanks: drop it, the next render
          // builds a fresh one. A context lost between two renders is the only case that matters,
          // since a render itself runs to completion within one task.
          app.canvas.addEventListener("webglcontextlost", () => {
            if (appPromise === created) appPromise = null;
            try {
              app.destroy({ removeView: true }, { children: true });
            } catch (error) {
              console.error("Lost shared Pixi application not destroyed", error);
            }
          });
          return app;
        },
        (err) => {
          // Let a later call retry (e.g. transient WebGL context loss).
          if (appPromise === created) appPromise = null;
          throw err;
        },
      );
    appPromise = created;
  }
  return appPromise;
}

/** Renders a `size` x `size` static scene on the shared Pixi application and returns it as a plain
 *  2D canvas the caller owns. `draw` fills the given container; it is destroyed afterwards. Resolves
 *  to `null` when `signal` was aborted before the job started. */
export function renderOffscreen(
  size: number,
  draw: (scene: Container) => void,
  signal?: AbortSignal,
): Promise<HTMLCanvasElement | null> {
  const job = queue.then(async () => {
    if (signal?.aborted) return null;
    const app = await sharedApp();
    if (signal?.aborted) return null;
    app.renderer.resize(size, size);
    const scene = new Container();
    app.stage.addChild(scene);
    try {
      draw(scene);
      app.render();
      const out = document.createElement("canvas");
      out.width = app.canvas.width;
      out.height = app.canvas.height;
      out.style.width = `${size}px`;
      out.style.height = `${size}px`;
      out.getContext("2d")!.drawImage(app.canvas, 0, 0);
      return out;
    } finally {
      app.stage.removeChild(scene);
      scene.destroy({ children: true });
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
