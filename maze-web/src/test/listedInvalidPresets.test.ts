import { describe, it, expect } from "vitest";
import { listedInvalidConnections, listedInvalidSplitKeys } from "../domain/fieldValidity";
import { presetEndpoint } from "../domain/presetEndpoint";
import type { PresetConnectionEntry } from "../domain/fieldEditUtils";

const entry = (from: [number, number], to: [number, number], source: "user" | "auto" = "user", level?: number): PresetConnectionEntry =>
  ({ from: presetEndpoint(from, undefined, level), to: presetEndpoint(to, undefined, level), state: "passage", source }) as PresetConnectionEntry;

describe("listedInvalidConnections", () => {
  const plain = entry([0, 0], [1, 0]);
  const derived = entry([0, 1], [1, 1], "auto");
  const atSplit = entry([2, 0], [3, 0]);
  const connections = new Map([["plain", plain], ["derived", derived], ["split", atSplit]]);
  const invalid = new Set(["plain", "derived", "split", "missing"]);

  it("keeps only user connections that no split point with slots touches", () => {
    expect(listedInvalidConnections(connections, { "3,0": [1] }, invalid)).toEqual([plain]);
  });

  it("treats a split point without slots as a plain cell", () => {
    expect(listedInvalidConnections(connections, { "3,0": [] }, invalid)).toEqual([plain, atSplit]);
  });

  it("matches a split point on its own floor only", () => {
    const upper = new Map([["up", entry([2, 0], [3, 0], "user", 1)]]);
    expect(listedInvalidConnections(upper, { "3,0": [1] }, new Set(["up"]))).toHaveLength(1);
    expect(listedInvalidConnections(upper, { "3,0@1": [1] }, new Set(["up"]))).toHaveLength(0);
  });
});

describe("listedInvalidSplitKeys", () => {
  it("drops split points without slots", () => {
    expect(listedInvalidSplitKeys({ "0,0": [1, 2], "1,0": [] }, new Set(["0,0", "1,0", "9,9"]))).toEqual(["0,0"]);
  });
});
