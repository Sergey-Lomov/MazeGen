import { beforeEach, describe, expect, it, vi } from "vitest";

/** Manually named fonts (GitHub issue #985). The store reads local storage once at import, so each test
 *  re-imports it over a fresh storage. */
async function freshStore() {
  vi.resetModules();
  return import("../pixi/renderers/rasterFont/rasterFontStore");
}

describe("manual font names", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    });
  });

  it("adds a trimmed name and lists it sorted", async () => {
    const store = await freshStore();
    expect(store.addManualFontName("  Zeta Sans ")).toBe(true);
    expect(store.addManualFontName("Alpha")).toBe(true);
    expect(store.manualFontNames()).toEqual(["Alpha", "Zeta Sans"]);
  });

  it("refuses an empty name", async () => {
    const store = await freshStore();
    expect(store.addManualFontName("   ")).toBe(false);
    expect(store.manualFontNames()).toEqual([]);
  });

  it("survives a reload through local storage", async () => {
    const first = await freshStore();
    first.addManualFontName("Persisted");
    const second = await freshStore();
    expect(second.manualFontNames()).toEqual(["Persisted"]);
  });

  it("notifies subscribers once per new name only", async () => {
    const store = await freshStore();
    const listener = vi.fn();
    store.subscribeRasterFonts(listener);
    store.addManualFontName("Once");
    store.addManualFontName("Once");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores a corrupt or foreign value in local storage", async () => {
    localStorage.setItem("mazegen-manual-fonts", "{not json");
    expect((await freshStore()).manualFontNames()).toEqual([]);
    localStorage.setItem("mazegen-manual-fonts", JSON.stringify(["Ok", 5, " "]));
    expect((await freshStore()).manualFontNames()).toEqual(["Ok"]);
  });
});
