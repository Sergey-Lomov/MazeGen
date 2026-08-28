import { describe, it, expect, beforeEach, vi } from "vitest";

// jsdom in this project runs without a usable localStorage (no --localstorage-file / opaque
// origin). screenCalibration.ts already guards every access in try/catch; give it a plain
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
  mmToCssPx,
  loadCalibratedCssPpi,
  saveCalibratedCssPpi,
  subscribe,
  MIN_CSS_PPI,
  MAX_CSS_PPI,
  CALIBRATION_CARD_WIDTH_MM,
  __resetCalibrationCacheForTests,
} from "../pixi/imageExport/screenCalibration";

beforeEach(() => {
  localStorage.clear();
  __resetCalibrationCacheForTests();
});

describe("mmToCssPx", () => {
  it("converts the ISO card width at 96 CSS PPI", () => {
    expect(mmToCssPx(CALIBRATION_CARD_WIDTH_MM, 96)).toBeCloseTo((85.6 / 25.4) * 96, 3);
  });
});

describe("loadCalibratedCssPpi", () => {
  it("returns null when nothing is stored", () => {
    expect(loadCalibratedCssPpi()).toBeNull();
  });

  it("returns null for stored garbage", () => {
    localStorage.setItem("printScreenCalibration.cssPpi", "not-a-number");
    __resetCalibrationCacheForTests();
    expect(loadCalibratedCssPpi()).toBeNull();
  });

  it("returns null for a non-positive stored value", () => {
    localStorage.setItem("printScreenCalibration.cssPpi", "0");
    __resetCalibrationCacheForTests();
    expect(loadCalibratedCssPpi()).toBeNull();
  });
});

describe("saveCalibratedCssPpi", () => {
  it("round-trips through storage", () => {
    saveCalibratedCssPpi(120);
    __resetCalibrationCacheForTests();
    expect(loadCalibratedCssPpi()).toBe(120);
  });

  it("clamps below MIN and above MAX", () => {
    saveCalibratedCssPpi(MIN_CSS_PPI - 50);
    expect(loadCalibratedCssPpi()).toBe(MIN_CSS_PPI);
    saveCalibratedCssPpi(MAX_CSS_PPI + 500);
    expect(loadCalibratedCssPpi()).toBe(MAX_CSS_PPI);
  });

  it("keeps the in-memory value and still notifies when storage write throws", () => {
    const spy = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const fn = vi.fn();
    const unsub = subscribe(fn);

    expect(() => saveCalibratedCssPpi(133)).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(loadCalibratedCssPpi()).toBe(133);

    unsub();
    spy.mockRestore();
  });

  it("notifies subscribers", () => {
    const fn = vi.fn();
    const unsub = subscribe(fn);
    saveCalibratedCssPpi(100);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    saveCalibratedCssPpi(110);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
