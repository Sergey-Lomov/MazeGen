import { describe, it, expect, vi } from "vitest";
import { postEditEdgesToDto } from "../pixi/selectors/mazeSelectors";
import { nodeEndpoint } from "../pixi/postEditEndpoint";
import { pe, noSplits } from "./mazeSelectorsKit";

vi.mock("pixi.js", async () => (await import("./mazeSelectorsMocks")).pixiMock());
vi.mock("../store/mazeStore", async () => (await import("./mazeSelectorsMocks")).mazeStoreMock());
// getCellCenter (via cartesianCache's getCartesian) delegates to wasm, unavailable in this
// unit-test environment, so only the real preset/geometry entry points are kept.
vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));

describe("postEditEdgesToDto", () => {
  it("null input returns empty array", () => {
    expect(postEditEdgesToDto(null, noSplits)).toEqual([]);
  });

  it("filters out wall edges", () => {
    const input = {
      "0-1": pe(0, 1, "wall"),
      "1-2": pe(1, 2, "basic"),
    };
    const result = postEditEdgesToDto(input, noSplits);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ from: 1, to: 2, kind: "basic" });
  });

  it("includes basic and one_way edges", () => {
    const input = {
      "0-1": pe(0, 1, "basic"),
      "1-0": pe(1, 0, "basic"),
      "2-3": pe(2, 3, "one_way_forward"),
      "3-4": pe(3, 4, "one_way_backward"),
    };
    const result = postEditEdgesToDto(input, noSplits);
    expect(result).toHaveLength(4);
  });

  it("returns from/to plus a basic kind, dropping the post-edit tool kind", () => {
    const input = { "5-6": pe(5, 6, "basic") };
    const result = postEditEdgesToDto(input, noSplits);
    expect(result[0]).toEqual({ from: 5, to: 6, kind: "basic" });
    expect(Object.keys(result[0]).sort()).toEqual(["from", "kind", "to"]);
  });

  it("empty record returns empty array", () => {
    expect(postEditEdgesToDto({}, noSplits)).toEqual([]);
  });

  it("all walls returns empty array", () => {
    const input = {
      "0-1": pe(0, 1, "wall"),
      "1-2": pe(1, 2, "wall"),
    };
    expect(postEditEdgesToDto(input, noSplits)).toEqual([]);
  });

  it("drops an entry whose split endpoint doesn't resolve yet", () => {
    const input = { "s-1": { from: { kind: "split" as const, point: [1, 2] as [number, number], slotId: 0 }, to: nodeEndpoint(1), kind: "basic" as const } };
    expect(postEditEdgesToDto(input, noSplits)).toEqual([]);
  });

  it("resolves a split endpoint via resolveSplit", () => {
    const input = { "s-1": { from: { kind: "split" as const, point: [1, 2] as [number, number], slotId: 0 }, to: nodeEndpoint(1), kind: "basic" as const } };
    expect(postEditEdgesToDto(input, () => 42)).toEqual([{ from: 42, to: 1, kind: "basic" }]);
  });
});