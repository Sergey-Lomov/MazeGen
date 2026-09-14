import { describe, it, expect, beforeEach, vi } from "vitest";

// jsdom in this project runs without a usable localStorage (no --localstorage-file / opaque
// origin). recentColorsStore.ts already guards every access in try/catch; give it a plain
// in-memory store so the persistence path is actually exercised here.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

import {
  loadRecentColors,
  pushRecentColor,
  subscribe,
  MAX_RECENT_COLORS,
  __resetRecentColorsCacheForTests,
} from "../components/recentColorsStore";

beforeEach(() => {
  localStorage.clear();
  __resetRecentColorsCacheForTests();
});

describe("loadRecentColors", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(loadRecentColors()).toEqual([]);
  });

  it("returns an empty list for corrupt JSON", () => {
    localStorage.setItem("colorPicker.recentColors", "not-json");
    __resetRecentColorsCacheForTests();
    expect(loadRecentColors()).toEqual([]);
  });

  it("returns an empty list when the stored value isn't an array", () => {
    localStorage.setItem("colorPicker.recentColors", JSON.stringify({ not: "an array" }));
    __resetRecentColorsCacheForTests();
    expect(loadRecentColors()).toEqual([]);
  });

  it("drops non-numeric entries", () => {
    localStorage.setItem("colorPicker.recentColors", JSON.stringify([1, "red", null, 2]));
    __resetRecentColorsCacheForTests();
    expect(loadRecentColors()).toEqual([1, 2]);
  });
});

describe("pushRecentColor", () => {
  it("round-trips through storage", () => {
    pushRecentColor(0xff0000);
    __resetRecentColorsCacheForTests();
    expect(loadRecentColors()).toEqual([0xff0000]);
  });

  it("adds new colors most-recent-first", () => {
    pushRecentColor(1);
    pushRecentColor(2);
    pushRecentColor(3);
    expect(loadRecentColors()).toEqual([3, 2, 1]);
  });

  it("de-duplicates by moving an existing color to the front instead of adding a second entry", () => {
    pushRecentColor(1);
    pushRecentColor(2);
    pushRecentColor(1);
    expect(loadRecentColors()).toEqual([1, 2]);
  });

  it(`caps the list at ${MAX_RECENT_COLORS} entries, dropping the oldest`, () => {
    for (let i = 0; i < MAX_RECENT_COLORS + 3; i++) pushRecentColor(i);
    const result = loadRecentColors();
    expect(result).toHaveLength(MAX_RECENT_COLORS);
    expect(result[0]).toBe(MAX_RECENT_COLORS + 2);
    expect(result).not.toContain(0);
    expect(result).not.toContain(1);
    expect(result).not.toContain(2);
  });

  it("keeps the in-memory value and still notifies when storage write throws", () => {
    const spy = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const fn = vi.fn();
    const unsub = subscribe(fn);

    expect(() => pushRecentColor(5)).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(loadRecentColors()).toEqual([5]);

    unsub();
    spy.mockRestore();
  });

  it("notifies subscribers", () => {
    const fn = vi.fn();
    const unsub = subscribe(fn);
    pushRecentColor(1);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    pushRecentColor(2);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
