import { describe, it, expect, vi, afterEach } from "vitest";
import { Container, Graphics } from "pixi.js";
import type { Application } from "pixi.js";
import { RenderScheduler } from "../pixi/renderScheduler";
import type { FrameSource } from "../pixi/renderScheduler";

/** Hand-driven animation frames: `flush()` runs every queued callback once. */
class ManualFrames implements FrameSource {
  private next = 1;
  private queue = new Map<number, () => void>();
  request(cb: () => void): number {
    const id = this.next++;
    this.queue.set(id, cb);
    return id;
  }
  cancel(id: number): void {
    this.queue.delete(id);
  }
  get pending(): number {
    return this.queue.size;
  }
  flush(): void {
    const callbacks = [...this.queue.values()];
    this.queue.clear();
    for (const cb of callbacks) cb();
  }
}

/** Resets the change-tracking state a real Pixi render consumes, so later edits notify the render
 *  group again (Pixi dedups notifications for a container until the next render). */
function simulateRender(stage: Container): void {
  const group = stage.renderGroup as unknown as {
    structureDidChange: boolean;
    childrenToUpdate: Record<string, { index: number }>;
    childrenRenderablesToUpdate: { index: number };
  };
  group.structureDidChange = false;
  for (const depth in group.childrenToUpdate) group.childrenToUpdate[depth].index = 0;
  group.childrenRenderablesToUpdate.index = 0;
  const reset = (c: Container) => {
    c.didChange = false;
    (c as unknown as { didViewUpdate: boolean }).didViewUpdate = false;
    c.children.forEach(reset);
  };
  reset(stage);
}

/** Minimal `Application` stand-in: a real pixi stage (so the render-group hooks see real Pixi
 *  change tracking) plus a counting `render()`. */
function makeApp(onRender: (stage: Container) => void = simulateRender) {
  const stage = new Container();
  const render = vi.fn(() => onRender?.(stage));
  const ticker = { start: vi.fn(), stop: vi.fn() };
  const app = { stage, ticker, render } as unknown as Application;
  return { app, stage, render, ticker };
}

function makeScheduler(onRender?: (stage: Container) => void) {
  const frames = new ManualFrames();
  const parts = makeApp(onRender);
  const scheduler = new RenderScheduler(parts.app, { frames, devChecks: false });
  return { ...parts, frames, scheduler };
}

describe("RenderScheduler", () => {
  let scheduler: RenderScheduler | null = null;
  afterEach(() => {
    scheduler?.destroy();
    scheduler = null;
  });

  it("stops the ticker, renders once initially, then stays idle", () => {
    const s = makeScheduler();
    scheduler = s.scheduler;
    expect(s.ticker.stop).toHaveBeenCalled();
    expect(s.ticker.start).not.toHaveBeenCalled();
    expect(s.frames.pending).toBe(1);
    s.frames.flush();
    s.frames.flush();
    expect(s.render).toHaveBeenCalledTimes(1);
    expect(s.frames.pending).toBe(0);
  });

  it("schedules a render for scene edits made by any code", () => {
    const s = makeScheduler();
    scheduler = s.scheduler;
    s.frames.flush();

    const child = new Container();
    s.stage.addChild(child);
    expect(s.frames.pending).toBe(1);
    s.frames.flush();
    expect(s.render).toHaveBeenCalledTimes(2);

    child.x = 10;
    expect(s.frames.pending).toBe(1);
    s.frames.flush();

    const g = new Graphics();
    s.stage.addChild(g);
    s.frames.flush();
    g.rect(0, 0, 5, 5).fill(0xff0000);
    expect(s.frames.pending).toBe(1);
    s.frames.flush();

    s.stage.removeChild(child);
    expect(s.frames.pending).toBe(1);
    s.frames.flush();
    expect(s.render).toHaveBeenCalledTimes(6);
  });

  it("hooks nested render groups as they attach", () => {
    const s = makeScheduler();
    scheduler = s.scheduler;
    const nested = new Container({ isRenderGroup: true });
    s.stage.addChild(nested);
    s.frames.flush();

    const grandchild = new Container();
    nested.addChild(grandchild);
    expect(s.frames.pending).toBe(1);
    s.frames.flush();

    grandchild.x = 5;
    expect(s.frames.pending).toBe(1);
  });

  it("restores Pixi's render-group methods on destroy", () => {
    const s = makeScheduler();
    const nested = new Container({ isRenderGroup: true });
    s.stage.addChild(nested);
    s.frames.flush();
    s.scheduler.destroy();

    for (const group of [s.stage.renderGroup, nested.renderGroup]) {
      expect(Object.prototype.hasOwnProperty.call(group, "onChildUpdate")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(group, "onChildViewUpdate")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(group, "addRenderGroupChild")).toBe(false);
      const descriptor = Object.getOwnPropertyDescriptor(group, "structureDidChange");
      expect(descriptor?.get).toBeUndefined();
      expect(descriptor?.writable).toBe(true);
    }
    nested.addChild(new Container());
    s.stage.addChild(new Container());
    expect(s.frames.pending).toBe(0);
  });

  it("coalesces invalidations within a frame into one render", () => {
    const s = makeScheduler();
    scheduler = s.scheduler;
    s.frames.flush();
    for (let i = 0; i < 5; i++) s.stage.addChild(new Container());
    s.scheduler.requestRender();
    s.scheduler.requestRender();
    expect(s.frames.pending).toBe(1);
    s.frames.flush();
    expect(s.render).toHaveBeenCalledTimes(2);
  });

  it("ignores changes made during a render", () => {
    const s = makeScheduler((stage) => stage.addChild(new Container()));
    scheduler = s.scheduler;
    s.frames.flush();
    expect(s.render).toHaveBeenCalledTimes(1);
    expect(s.frames.pending).toBe(0);
  });

  it("consumes the pending frame when the app renders synchronously", () => {
    const s = makeScheduler();
    scheduler = s.scheduler;
    expect(s.frames.pending).toBe(1);
    s.app.render();
    expect(s.render).toHaveBeenCalledTimes(1);
    expect(s.frames.pending).toBe(0);
  });

  it("defers changes while suspended and renders once on resume", () => {
    const s = makeScheduler();
    scheduler = s.scheduler;
    s.frames.flush();
    s.scheduler.setSuspended(true);
    s.stage.addChild(new Container());
    s.scheduler.requestRender();
    expect(s.frames.pending).toBe(0);
    s.scheduler.setSuspended(false);
    expect(s.frames.pending).toBe(1);
    s.frames.flush();
    expect(s.render).toHaveBeenCalledTimes(2);
  });

  it("defers a synchronous app render while suspended", () => {
    const s = makeScheduler();
    scheduler = s.scheduler;
    s.frames.flush();
    s.scheduler.setSuspended(true);
    s.app.render();
    expect(s.render).toHaveBeenCalledTimes(1);
    s.scheduler.setSuspended(false);
    s.frames.flush();
    expect(s.render).toHaveBeenCalledTimes(2);
  });

  it("stops rendering after destroy", () => {
    const s = makeScheduler();
    s.scheduler.destroy();
    expect(s.frames.pending).toBe(0);
    s.stage.addChild(new Container());
    s.scheduler.requestRender();
    s.app.render();
    expect(s.frames.pending).toBe(0);
    expect(s.render).not.toHaveBeenCalled();
  });

  it("falls back to the running ticker when render-group internals are missing", () => {
    const frames = new ManualFrames();
    const { app, stage, ticker, render } = makeApp();
    vi.spyOn(stage, "enableRenderGroup").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    scheduler = new RenderScheduler(app, { frames, devChecks: false });
    expect(warn).toHaveBeenCalled();
    expect(ticker.start).toHaveBeenCalled();
    expect(ticker.stop).not.toHaveBeenCalled();
    scheduler.requestRender();
    expect(frames.pending).toBe(0);
    expect(render).not.toHaveBeenCalled();
    scheduler.setSuspended(true);
    expect(ticker.stop).toHaveBeenCalledTimes(1);
    scheduler.setSuspended(false);
    expect(ticker.start).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("dev check warns when the stage holds changes with no frame queued", () => {
    vi.useFakeTimers();
    try {
      const frames = new ManualFrames();
      const { app, stage, render } = makeApp(simulateRender);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      scheduler = new RenderScheduler(app, { frames, devChecks: true });
      frames.flush();
      // Simulate an edit that bypassed the hooks: a pending transform update with no request.
      const group = stage.renderGroup as unknown as { childrenToUpdate: Record<string, { index: number }> };
      group.childrenToUpdate["0"] = { index: 1 };
      vi.advanceTimersByTime(1000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(frames.pending).toBe(1);
      frames.flush();
      expect(render).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dev check ignores changes Pixi leaves over from the render itself", () => {
    vi.useFakeTimers();
    try {
      const frames = new ManualFrames();
      // A render that leaves a pending transform update behind, as Pixi bookkeeping might.
      const { app } = makeApp((st) => {
        simulateRender(st);
        (st.renderGroup as unknown as { childrenToUpdate: Record<string, { index: number }> })
          .childrenToUpdate["0"] = { index: 1 };
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      scheduler = new RenderScheduler(app, { frames, devChecks: true });
      frames.flush();
      vi.advanceTimersByTime(3000);
      expect(warn).not.toHaveBeenCalled();
      expect(frames.pending).toBe(0);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
