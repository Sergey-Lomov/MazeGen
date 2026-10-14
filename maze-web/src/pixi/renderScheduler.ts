import type { Application, Container } from "pixi.js";

/** The Pixi v8 `RenderGroup` internals the scheduler hooks into (GitHub issue #738). Not part of
 *  Pixi's public API — `hookRenderGroup` verifies their shape at runtime and the scheduler falls
 *  back to continuous rendering if a Pixi upgrade changes them. */
interface RenderGroupInternals {
  structureDidChange: boolean;
  renderGroupChildren: RenderGroupInternals[];
  childrenToUpdate: Record<string, { index: number }>;
  childrenRenderablesToUpdate: { index: number };
  onChildUpdate(child: Container): void;
  onChildViewUpdate(child: Container): void;
  addRenderGroupChild(child: RenderGroupInternals): void;
}

/** Frame-callback source; injectable so tests can drive frames by hand. */
export interface FrameSource {
  request(cb: () => void): number;
  cancel(id: number): void;
}

const browserFrames: FrameSource = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

/** Interval of the dev-build check for scene changes that slipped past the hooks. */
const MISSED_INVALIDATION_CHECK_MS = 1000;

const HOOKED = Symbol("renderSchedulerHooked");

function isDevBuild(): boolean {
  return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}

function hasRenderGroupShape(group: unknown): group is RenderGroupInternals {
  const g = group as Partial<RenderGroupInternals> | null;
  return !!g
    && typeof g.structureDidChange === "boolean"
    && Array.isArray(g.renderGroupChildren)
    && typeof g.childrenToUpdate === "object"
    && typeof g.childrenRenderablesToUpdate?.index === "number"
    && typeof g.onChildUpdate === "function"
    && typeof g.onChildViewUpdate === "function"
    && typeof g.addRenderGroupChild === "function";
}

/** Wraps every path through which Pixi records a pending scene change on a render group (transform
 *  / visibility / color updates, view updates such as a redrawn `Graphics` context or a new text,
 *  structure changes such as add/remove/reorder/mask/filter — the latter all go through
 *  `structureDidChange = true`), so `onChange` fires for any edit regardless of which renderer made
 *  it. Nested render groups are hooked as they attach. Each hook pushes its own undo onto
 *  `unhooks` — Pixi pools `RenderGroup` objects, so a group left hooked would keep notifying a
 *  destroyed scheduler after being reused by another canvas. Returns false when the internals are
 *  not the expected shape. */
function hookRenderGroup(group: unknown, onChange: () => void, unhooks: (() => void)[]): boolean {
  if (!hasRenderGroupShape(group)) return false;
  const tagged = group as RenderGroupInternals & { [HOOKED]?: true };
  if (tagged[HOOKED]) return true;
  tagged[HOOKED] = true;

  const onChildUpdate = group.onChildUpdate;
  group.onChildUpdate = function (child) {
    onChildUpdate.call(this, child);
    onChange();
  };
  const onChildViewUpdate = group.onChildViewUpdate;
  group.onChildViewUpdate = function (child) {
    onChildViewUpdate.call(this, child);
    onChange();
  };
  const addRenderGroupChild = group.addRenderGroupChild;
  group.addRenderGroupChild = function (child) {
    addRenderGroupChild.call(this, child);
    hookRenderGroup(child, onChange, unhooks);
    onChange();
  };

  let structureDidChange = group.structureDidChange;
  Object.defineProperty(group, "structureDidChange", {
    configurable: true,
    enumerable: true,
    get: () => structureDidChange,
    set: (value: boolean) => {
      structureDidChange = value;
      if (value) onChange();
    },
  });

  unhooks.push(() => {
    // The wrappers are own properties shadowing the prototype methods; deleting them restores Pixi's.
    const own = group as Partial<RenderGroupInternals> & { [HOOKED]?: true };
    delete own.onChildUpdate;
    delete own.onChildViewUpdate;
    delete own.addRenderGroupChild;
    delete own[HOOKED];
    Object.defineProperty(group, "structureDidChange", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: structureDidChange,
    });
  });

  for (const child of group.renderGroupChildren) hookRenderGroup(child, onChange, unhooks);
  return true;
}

/** True when the render group (or a nested one) holds changes the next render would apply. */
function hasPendingSceneChanges(group: RenderGroupInternals): boolean {
  if (group.structureDidChange || group.childrenRenderablesToUpdate.index > 0) return true;
  for (const depth in group.childrenToUpdate) {
    if (group.childrenToUpdate[depth].index > 0) return true;
  }
  return group.renderGroupChildren.some(hasPendingSceneChanges);
}

/** Renders the main Pixi application on demand instead of every ticker frame (GitHub issue #738).
 *
 *  The app's ticker is stopped; any scene change Pixi records on the stage's render group (see
 *  `hookRenderGroup`) or an explicit `requestRender()` schedules one `app.render()` on the next
 *  animation frame, and all invalidations within a frame coalesce into that single render.
 *  `app.render` itself is routed through the scheduler, so Pixi's own synchronous renders (the
 *  resize plugin) also consume the pending frame, and are deferred to resume while suspended. Changes Pixi makes during a render are ignored —
 *  they are bookkeeping of the frame being drawn, not new content.
 *
 *  If the render-group internals are missing (a Pixi upgrade changed them), the scheduler warns
 *  and leaves the ticker running, so the canvas never goes stale. Dev builds additionally poll for
 *  pending scene changes with no frame queued and warn about them, so a hook that stopped firing
 *  is noticed early. */
export class RenderScheduler {
  private readonly app: Application;
  private readonly frames: FrameSource;
  private readonly renderOriginal: () => void;
  private readonly continuous: boolean;
  private frameId: number | null = null;
  private rendering = false;
  private suspended = false;
  private dirtyWhileSuspended = false;
  private destroyed = false;
  private readonly unhooks: (() => void)[] = [];
  private pendingAfterLastRender = false;
  private devCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(app: Application, options: { frames?: FrameSource; devChecks?: boolean } = {}) {
    this.app = app;
    this.frames = options.frames ?? browserFrames;
    this.renderOriginal = app.render.bind(app);
    app.render = () => this.renderNow();

    app.stage.enableRenderGroup();
    const hooked = hookRenderGroup(app.stage.renderGroup, () => this.onSceneChanged(), this.unhooks);
    this.continuous = !hooked;
    if (hooked) {
      app.ticker.stop();
    } else {
      console.warn("RenderScheduler: Pixi render-group internals not found, falling back to rendering every frame");
      app.ticker.start();
    }

    if (hooked && (options.devChecks ?? isDevBuild())) {
      this.devCheckTimer = setInterval(() => this.checkMissedInvalidation(), MISSED_INVALIDATION_CHECK_MS);
    }
    this.requestRender();
  }

  /** Schedules one render on the next animation frame; repeated calls before it coalesce. */
  requestRender(): void {
    if (this.destroyed || this.continuous) return;
    if (this.suspended) {
      this.dirtyWhileSuspended = true;
      return;
    }
    if (this.frameId !== null) return;
    this.frameId = this.frames.request(() => {
      this.frameId = null;
      this.renderNow();
    });
  }

  /** Pauses on-demand rendering while the canvas is hidden (the Quality card replaces it);
   *  changes made meanwhile are drawn in one render on resume. */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended || this.destroyed) return;
    this.suspended = suspended;
    if (this.continuous) {
      if (suspended) this.app.ticker.stop();
      else this.app.ticker.start();
      return;
    }
    if (suspended) {
      this.cancelFrame();
      this.dirtyWhileSuspended = true;
    } else if (this.dirtyWhileSuspended) {
      this.dirtyWhileSuspended = false;
      this.requestRender();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelFrame();
    for (const unhook of this.unhooks) unhook();
    this.unhooks.length = 0;
    if (this.devCheckTimer !== null) clearInterval(this.devCheckTimer);
    this.devCheckTimer = null;
  }

  private onSceneChanged(): void {
    if (this.rendering) return;
    this.requestRender();
  }

  private renderNow(): void {
    if (this.destroyed) return;
    this.cancelFrame();
    // The canvas is hidden; Pixi's own synchronous renders (resize plugin) would draw for nothing.
    if (this.suspended && !this.continuous) {
      this.dirtyWhileSuspended = true;
      return;
    }
    this.rendering = true;
    try {
      this.renderOriginal();
    } finally {
      this.rendering = false;
    }
    if (this.devCheckTimer !== null) this.pendingAfterLastRender = this.stageHasPendingChanges();
  }

  private cancelFrame(): void {
    if (this.frameId === null) return;
    this.frames.cancel(this.frameId);
    this.frameId = null;
  }

  private stageHasPendingChanges(): boolean {
    const group: unknown = this.app.stage.renderGroup;
    return hasRenderGroupShape(group) && hasPendingSceneChanges(group);
  }

  /** Dev-only: the stage holds unrendered changes yet no frame is queued — some edit bypassed the
   *  render-group hooks. Changes already left over right after the last render (made by Pixi
   *  during that render) don't count. */
  private checkMissedInvalidation(): void {
    if (this.destroyed || this.suspended || this.frameId !== null || this.pendingAfterLastRender) return;
    if (!this.stageHasPendingChanges()) return;
    console.warn("RenderScheduler: scene changed without a render request; rendering now");
    this.requestRender();
  }
}
