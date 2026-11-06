import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTrackedMemoStats, inputMemo, resetTrackedMemo, setTrackedMemoParanoid, trackedMemo } from "../pixi/selectors/trackedMemo";

type Settings = { a: number; b: number; nested: { x: number; y: number; deep: { z: number } }; list: { id: string; on: boolean }[]; opt?: number };

const base = (): Settings => ({ a: 1, b: 2, nested: { x: 10, y: 20, deep: { z: 30 } }, list: [{ id: "p", on: true }, { id: "q", on: false }], });

beforeEach(() => {
  resetTrackedMemo();
  setTrackedMemoParanoid(false);
});

describe("trackedMemo", () => {
  it("returns the cached result while the read fields are unchanged and ignores unread fields", () => {
    const compute = vi.fn((s: Settings) => s.a + s.nested.x);
    const first = base();
    expect(trackedMemo("s", [], first, compute)).toBe(11);
    expect(trackedMemo("s", [], { ...first, b: 99 }, compute)).toBe(11);
    expect(trackedMemo("s", [], { ...first, nested: { ...first.nested, y: 0 } }, compute)).toBe(11);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes when a read leaf changes and reports the path", () => {
    const compute = vi.fn((s: Settings) => s.nested.deep.z);
    const first = base();
    trackedMemo("s", [], first, compute);
    const next = { ...first, nested: { ...first.nested, deep: { z: 31 } } };
    expect(trackedMemo("s", [], next, compute)).toBe(31);
    expect(getTrackedMemoStats().get("s")?.lastMiss).toBe("nested.deep.z");
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("follows only the branch a condition took", () => {
    const compute = vi.fn((s: Settings) => (s.a > 0 ? s.nested.x : s.nested.y));
    const first = base();
    trackedMemo("s", [], first, compute);
    trackedMemo("s", [], { ...first, nested: { ...first.nested, y: 5 } }, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    trackedMemo("s", [], { ...first, a: 0 }, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("tracks the whole key set for spread, Object.keys and JSON.stringify", () => {
    const spread = vi.fn((s: Settings) => ({ ...s.nested }).x);
    const first = base();
    trackedMemo("spread", [], first, spread);
    trackedMemo("spread", [], { ...first, nested: { ...first.nested, y: 21 } }, spread);
    expect(spread).toHaveBeenCalledTimes(2);

    const keys = vi.fn((s: Settings) => Object.keys(s.nested).length);
    trackedMemo("keys", [], first, keys);
    trackedMemo("keys", [], { ...first, nested: { ...first.nested, extra: 1 } as Settings["nested"] }, keys);
    expect(keys).toHaveBeenCalledTimes(2);

    const json = vi.fn((s: Settings) => JSON.stringify(s.nested));
    expect(trackedMemo("json", [], first, json)).toBe(JSON.stringify(first.nested));
  });

  it("tracks `in` checks and absent optional keys", () => {
    const compute = vi.fn((s: Settings) => ("opt" in s) + ":" + String(s.opt));
    const first = base();
    expect(trackedMemo("s", [], first, compute)).toBe("false:undefined");
    expect(trackedMemo("s", [], { ...first, opt: 3 }, compute)).toBe("true:3");
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("tracks array length and the elements read", () => {
    const compute = vi.fn((s: Settings) => s.list.filter((item) => item.on).map((item) => item.id).join(","));
    const first = base();
    expect(trackedMemo("s", [], first, compute)).toBe("p");
    expect(trackedMemo("s", [], { ...first, list: [...first.list] }, compute)).toBe("p");
    expect(compute).toHaveBeenCalledTimes(1);
    expect(trackedMemo("s", [], { ...first, list: [...first.list, { id: "r", on: true }] }, compute)).toBe("p,r");
    expect(trackedMemo("s", [], { ...first, list: [{ id: "p", on: true }, { id: "q", on: true }] }, compute)).toBe("p,q");
  });

  it("recomputes on a nested object replaced by an equal-looking one only when its read content differs", () => {
    const compute = vi.fn((s: Settings) => s.nested.deep.z);
    const first = base();
    trackedMemo("s", [], first, compute);
    trackedMemo("s", [], { ...first, nested: { ...first.nested, deep: { z: 30 } } }, compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes when an input changes", () => {
    const compute = vi.fn((s: Settings) => s.a);
    const settings = base();
    trackedMemo("s", [1, "x"], settings, compute);
    trackedMemo("s", [1, "x"], settings, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    trackedMemo("s", [1, "y"], settings, compute);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(getTrackedMemoStats().get("s")?.lastMiss).toBe("input 1");
  });

  it("keeps slots independent", () => {
    const first = vi.fn((s: Settings) => s.a);
    const second = vi.fn((s: Settings) => s.b);
    const settings = base();
    trackedMemo("one", [], settings, first);
    trackedMemo("two", [], settings, second);
    const next = { ...settings, a: 5 };
    trackedMemo("one", [], next, first);
    trackedMemo("two", [], next, second);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps the old entry intact when compute throws", () => {
    const settings = base();
    const compute = vi.fn((s: Settings) => {
      if (s.a === 2) throw new Error("boom");
      return s.a;
    });
    trackedMemo("s", [], settings, compute);
    expect(() => trackedMemo("s", [], { ...settings, a: 2 }, compute)).toThrow("boom");
    expect(trackedMemo("s", [], settings, compute)).toBe(1);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("rejects writes through the view", () => {
    expect(() => trackedMemo("s", [], base(), (s) => { s.a = 5; })).toThrow(/read-only/);
    expect(() => trackedMemo("s2", [], base(), (s) => { delete (s as Partial<Settings>).b; })).toThrow(/read-only/);
  });

  it("stops recording once the call returned and rejects a view in the result", () => {
    let leaked: Settings["nested"] | undefined;
    trackedMemo("leak", [], base(), (s) => { leaked = s.nested; return 1; });
    expect(leaked!.x).toBe(10);
    expect(() => trackedMemo("held", [], base(), (s) => ({ held: s.nested }))).toThrow(/tracked settings view/);
  });

  it("supports frozen settings", () => {
    const frozen = Object.freeze({ nested: Object.freeze({ x: 1 }), list: Object.freeze([1, 2]) });
    expect(trackedMemo("s", [], frozen, (s) => ({ ...s.nested }).x + s.list.length)).toBe(3);
    expect(trackedMemo("arr", [], frozen, (s) => Array.isArray(s.list))).toBe(true);
  });

  it("gives a stable view per object within one call", () => {
    expect(trackedMemo("s", [], base(), (s) => s.nested === s.nested)).toBe(true);
  });

  it("refuses to nest", () => {
    expect(() => trackedMemo("outer", [], base(), (s) => trackedMemo("inner", [], s, () => 1))).toThrow(/inside another/);
  });

  it("paranoid mode throws when a read escapes tracking", () => {
    setTrackedMemoParanoid(true);
    const mutable = { value: 1 };
    const leaky = (s: { a: number }) => s.a + mutable.value;
    const settings = { a: 1 };
    trackedMemo("s", [], settings, leaky);
    mutable.value = 2;
    expect(() => trackedMemo("s", [], settings, leaky)).toThrow(/stale/);
  });

  it("paranoid mode accepts a correctly tracked function", () => {
    setTrackedMemoParanoid(true);
    const settings = base();
    expect(trackedMemo("s", [], settings, (s) => s.a)).toBe(1);
    expect(trackedMemo("s", [], { ...settings, b: 9 }, (s) => s.a)).toBe(1);
  });

  it("inputMemo caches on inputs alone and may run inside a tracked call", () => {
    const compute = vi.fn(() => ({ made: true }));
    const nodes: number[] = [];
    const first = inputMemo("env", [nodes], compute);
    expect(inputMemo("env", [nodes], compute)).toBe(first);
    expect(inputMemo("env", [[]], compute)).not.toBe(first);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(trackedMemo("outer", [], base(), (s) => inputMemo("inner", [s.a], () => s.a + 1))).toBe(2);
  });
});

describe("trackedMemo bookkeeping", () => {
  it("tracks an own-property probe of an absent key", () => {
    const compute = vi.fn((s: Settings) => Object.prototype.hasOwnProperty.call(s, "opt"));
    const first = base();
    expect(trackedMemo("own", [], first, compute)).toBe(false);
    expect(trackedMemo("own", [], { ...first, b: 5 }, compute)).toBe(false);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(trackedMemo("own", [], { ...first, opt: 1 }, compute)).toBe(true);
  });

  it("makes arrays and plain objects look like themselves", () => {
    trackedMemo("shape", [], base(), (s) => {
      expect(Array.isArray(s.list)).toBe(true);
      expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
      return 0;
    });
  });

  it("drops the oldest slot and its counters past the slot limit, keeping the recently used ones", () => {
    const settings = base();
    trackedMemo("keep", [], settings, (s) => s.a);
    for (let i = 0; i < 4100; i++) {
      trackedMemo(`filler:${i}`, [], settings, (s) => s.a);
      if (i % 1000 === 0) trackedMemo("keep", [], settings, (s) => s.a);
    }
    expect(getTrackedMemoStats().has("filler:0")).toBe(false);
    expect(getTrackedMemoStats().size).toBeLessThanOrEqual(4097);
    expect(getTrackedMemoStats().get("keep")?.hits).toBeGreaterThan(0);
    const compute = vi.fn((s: Settings) => s.a);
    trackedMemo("filler:0", [], settings, compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
