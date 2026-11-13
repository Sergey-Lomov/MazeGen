import { describe, expect, it, vi, beforeEach } from "vitest";
import { createStore } from "zustand/vanilla";

// Export settings that name an on-demand MSDF font start its download (GitHub issue #982).

const loadMsdfFamily = vi.fn().mockResolvedValue(true);
vi.mock("../pixi/renderers/msdfLoader", () => ({ loadMsdfFamily: (family: string) => loadMsdfFamily(family) }));

const { MSDF_FONTS } = await import("../pixi/renderers/fontChoice");
const { collectLazyMsdfFamilies, installLabelFontSync } = await import("../store/labelFontSync");

const face = (family: string, weight: number) => ({ weight, atlasName: `${family}-${weight}`, url: `/fonts/${family}-${weight}.fnt` });
MSDF_FONTS.Mono = { label: "Mono", faces: [face("Mono", 400)] };
MSDF_FONTS.Serif = { label: "Serif", faces: [face("Serif", 400)] };

const font = (family: string) => ({ family, weight: 400 });

beforeEach(() => loadMsdfFamily.mockClear());

describe("collectLazyMsdfFamilies", () => {
  it("finds fonts at any depth, in arrays too, and skips Roboto and browser fonts", () => {
    const settings = {
      startMarker: { textFont: font("Mono") },
      groups: [{ inner: { labelFont: font("Serif") } }, { labelFont: font("") }, { labelFont: font("Arial") }],
      textSize: 12,
    };
    expect([...collectLazyMsdfFamilies(settings)].sort()).toEqual(["Mono", "Serif"]);
  });

  it("stays correct when an updated tree reuses its unchanged subtrees", () => {
    const shared = { textFont: font("Mono") };
    const first = { shared, other: { textFont: font("") } };
    expect([...collectLazyMsdfFamilies(first)]).toEqual(["Mono"]);
    // A later settings object keeps `shared` by identity, swaps the other font and adds a new one.
    const second = { shared, other: { textFont: font("Serif") }, extra: [{ labelFont: font("Mono") }] };
    expect([...collectLazyMsdfFamilies(second)].sort()).toEqual(["Mono", "Serif"]);
    // And dropping the reused subtree drops its family.
    expect(collectLazyMsdfFamilies({ other: second.other }).has("Mono")).toBe(false);
  });

  it("ignores values that only look like a font", () => {
    expect(collectLazyMsdfFamilies({ family: "Mono" }).size).toBe(0);
    expect(collectLazyMsdfFamilies(null).size).toBe(0);
  });
});

describe("installLabelFontSync", () => {
  type Settings = { vectorByWallsSettings: unknown; vectorByCorridorsSettings: unknown; pngExportSettings: unknown };
  const makeStore = (initial: Partial<Settings> = {}) => {
    const store = createStore<Settings>()(() => ({ vectorByWallsSettings: {}, vectorByCorridorsSettings: {}, pngExportSettings: {}, ...initial }));
    installLabelFontSync(store as never);
    return store;
  };

  it("loads a font already referenced by the settings at install time", () => {
    makeStore({ vectorByWallsSettings: { textFont: font("Mono") } });
    expect(loadMsdfFamily).toHaveBeenCalledWith("Mono");
  });

  it("loads a font that arrives with a later settings change, whichever mode holds it", () => {
    const store = makeStore();
    expect(loadMsdfFamily).not.toHaveBeenCalled();
    store.setState({ vectorByCorridorsSettings: { markerIndex: { textFont: font("Serif") } } });
    expect(loadMsdfFamily).toHaveBeenCalledWith("Serif");
  });

  it("requests each family once", () => {
    const store = makeStore();
    store.setState({ pngExportSettings: { a: font("Mono") } });
    store.setState({ pngExportSettings: { a: font("Mono"), b: font("Mono") } });
    store.setState({ vectorByWallsSettings: { c: font("Mono") } });
    expect(loadMsdfFamily).toHaveBeenCalledTimes(1);
  });

  it("does nothing for the default font", () => {
    const store = makeStore({ vectorByWallsSettings: { textFont: font("") } });
    store.setState({ pngExportSettings: { textFont: font("") } });
    expect(loadMsdfFamily).not.toHaveBeenCalled();
  });
});
