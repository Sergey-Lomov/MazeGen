import { describe, it, expect, vi, afterEach } from "vitest";
import { watchDevicePixelRatio } from "../pixi/devicePixelRatioWatcher";

type Listener = () => void;

/** Fake `matchMedia` that records each `(resolution: Xdppx)` query and lets the test fire `change`. */
function installMatchMedia() {
  const queries: { media: string; listeners: Set<Listener> }[] = [];
  const matchMedia = vi.fn((media: string) => {
    const entry = { media, listeners: new Set<Listener>() };
    queries.push(entry);
    return {
      media,
      addEventListener: (_: string, l: Listener) => entry.listeners.add(l),
      removeEventListener: (_: string, l: Listener) => entry.listeners.delete(l),
    } as unknown as MediaQueryList;
  });
  vi.stubGlobal("matchMedia", matchMedia);
  return queries;
}

function setDpr(dpr: number) {
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: dpr });
}

describe("watchDevicePixelRatio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setDpr(1);
  });

  it("reports density changes and re-arms the query for the new density", () => {
    setDpr(1);
    const queries = installMatchMedia();
    const onChange = vi.fn();
    const unwatch = watchDevicePixelRatio(onChange);
    expect(queries.map((q) => q.media)).toEqual(["(resolution: 1dppx)"]);

    setDpr(2);
    queries[0].listeners.forEach((l) => l());
    expect(onChange).toHaveBeenLastCalledWith(2);
    expect(queries[0].listeners.size).toBe(0);
    expect(queries[1].media).toBe("(resolution: 2dppx)");
    expect(queries[1].listeners.size).toBe(1);

    setDpr(1);
    queries[1].listeners.forEach((l) => l());
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(onChange).toHaveBeenCalledTimes(2);

    unwatch();
    expect(queries[2].listeners.size).toBe(0);
  });
});
