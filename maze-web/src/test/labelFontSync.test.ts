import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createStore } from "zustand/vanilla";

// Export settings that name an on-demand MSDF font start its download (GitHub issue #982).

const loadMsdfFamily = vi.fn().mockResolvedValue(true);
vi.mock("../pixi/renderers/msdfLoader", () => ({ loadMsdfFamily: (family: string) => loadMsdfFamily(family) }));

const loadRasterFont = vi.fn().mockResolvedValue(true);
const pruneRasterFonts = vi.fn();
vi.mock("../pixi/renderers/rasterFont/rasterMsdf", () => ({
  loadRasterFont: (font: unknown) => loadRasterFont(font),
  pruneRasterFonts: (keys: unknown) => pruneRasterFonts(keys),
  isRasterFontReady: () => false,
}));

const loadLabelFont = vi.fn().mockResolvedValue(true);
vi.mock("../pixi/renderers/labelFont", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pixi/renderers/labelFont")>()),
  loadLabelFont: (font: unknown) => loadLabelFont(font),
}));

const { MSDF_FONTS } = await import("../domain/renderers/fontChoice");
const { setFontPickerOpen } = await import("../pixi/renderers/rasterFont/pickerSession");
const { collectDrawnLabelFontFamilies, collectLabelFonts, installLabelFontSync, reportProjectFontProblems } = await import("../pixi/labelFontSync");
const { useNotificationStore, resetNotifications } = await import("../notifications/notificationStore");
const { resetFontProblems } = await import("../notifications/fontNotifications");
const { addManualFontName, registerLocalFaces } = await import("../pixi/renderers/rasterFont/rasterFontStore");
const { loadLocalFontFamilies } = await import("../pixi/renderers/labelFont");
const { closeFontPermissionRequest, getFontPermissionRequest, resetFontPermissionAnswer } = await import("../pixi/renderers/rasterFont/fontPermissionRequest");

const face = (family: string, weight: number) => ({ weight, atlasName: `${family}-${weight}`, url: `/fonts/${family}-${weight}.fnt` });
MSDF_FONTS.Mono = { label: "Mono", scripts: [], faces: [face("Mono", 400)] };
MSDF_FONTS.Serif = { label: "Serif", scripts: [], faces: [face("Serif", 400)] };

const font = (family: string) => ({ family, weight: 400 });

beforeEach(() => {
  loadMsdfFamily.mockClear();
  loadRasterFont.mockClear();
  loadLabelFont.mockClear();
  pruneRasterFonts.mockClear();
  setFontPickerOpen(false);
});

describe("collectDrawnLabelFontFamilies (GitHub issue #1012)", () => {
  const state = (walls: unknown, extra: object = {}) => ({ vectorByWallsSettings: walls, vectorByCorridorsSettings: {}, nodes: [], edges: [], floors: [{ id: "a" }], ...extra }) as never;

  it("counts a font while its text is drawn and drops it when the text is hidden", () => {
    expect([...collectDrawnLabelFontFamilies(state({ startMarker: { textFont: font("Arial") } }))]).toEqual(["Arial"]);
    expect(collectDrawnLabelFontFamilies(state({ startMarker: { textEnabled: false, textFont: font("Arial") } })).size).toBe(0);
  });

  it("needs the maze to have the element: floor labels need several floors", () => {
    const walls = { floorLabel: { enabled: true, textFont: font("Arial") } };
    expect(collectDrawnLabelFontFamilies(state(walls)).size).toBe(0);
    expect([...collectDrawnLabelFontFamilies(state(walls, { floors: [{ id: "a" }, { id: "b" }] }))]).toEqual(["Arial"]);
    expect(collectDrawnLabelFontFamilies(state({ floorLabel: { enabled: false, textFont: font("Arial") } }, { floors: [{ id: "a" }, { id: "b" }] })).size).toBe(0);
  });
});

describe("collectDrawnLabelFontFamilies and the maze (GitHub issue #1012)", () => {
  const elevatorEdges = [{ kind: "elevator" }];
  const state = (walls: unknown, edges: unknown[] = [], mode: "vectorByWallsSettings" | "vectorByCorridorsSettings" = "vectorByWallsSettings") =>
    ({ vectorByWallsSettings: {}, vectorByCorridorsSettings: {}, [mode]: walls, nodes: [], edges, floors: [{ id: "a" }] }) as never;
  const families = (value: never) => [...collectDrawnLabelFontFamilies(value)].sort();

  it("draws elevator badge and marker index fonts only for a maze with an elevator", () => {
    const walls = { elevatorBadges: { enabled: true, textFont: font("Arial") }, markerIndex: { enabled: true, textFont: font("Georgia") } };
    expect(families(state(walls))).toEqual([]);
    expect(families(state(walls, elevatorEdges))).toEqual(["Arial", "Georgia"]);
  });

  it("drops the font of a text its own switch turns off", () => {
    const walls = { elevatorBadges: { enabled: false, textFont: font("Arial") }, markerIndex: { enabled: true, textFont: font("Georgia") } };
    expect(families(state(walls, elevatorEdges))).toEqual(["Georgia"]);
  });

  it("reads the corridors settings too", () => {
    expect(families(state({ finishMarker: { textFont: font("Arial") } }, [], "vectorByCorridorsSettings"))).toEqual(["Arial"]);
  });
});

describe("collectLabelFonts", () => {
  const families = (value: unknown) => [...collectLabelFonts(value).values()].map((f) => f.family).sort();

  it("finds every font at any depth, in arrays too, the default and browser fonts included", () => {
    const settings = { startMarker: { textFont: font("Mono") }, groups: [{ inner: { labelFont: font("Serif") } }, { labelFont: font("") }, { labelFont: font("Arial") }], textSize: 12 };
    expect(families(settings)).toEqual(["", "Arial", "Mono", "Serif"]);
  });

  it("stays correct when an updated tree reuses its unchanged subtrees", () => {
    const shared = { textFont: font("Mono") };
    expect(families({ shared, other: { textFont: font("") } })).toEqual(["", "Mono"]);
    // A later settings object keeps `shared` by identity, swaps the other font and adds a new one.
    expect(families({ shared, other: { textFont: font("Serif") }, extra: [{ labelFont: font("Mono") }] })).toEqual(["Mono", "Serif"]);
    // And dropping the reused subtree drops its family.
    expect(families({ other: { textFont: font("Serif") } })).toEqual(["Serif"]);
  });

  it("ignores values that only look like a font", () => {
    expect(collectLabelFonts({ family: "Mono" }).size).toBe(0);
    expect(collectLabelFonts(null).size).toBe(0);
  });
});

describe("installLabelFontSync", () => {
  type Settings = { vectorByWallsSettings: unknown; vectorByCorridorsSettings: unknown; pngExportSettings: unknown; nodes: unknown[]; edges: unknown[]; floors: unknown[] };
  const makeStore = (initial: Partial<Settings> = {}) => {
    const store = createStore<Settings>()(() => ({ vectorByWallsSettings: {}, vectorByCorridorsSettings: {}, pngExportSettings: {}, nodes: [], edges: [], floors: [], ...initial }));
    disposers.push(installLabelFontSync(store as never));
    return store;
  };
  const disposers: Array<() => void> = [];
  afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

  it("loads a font already referenced by the settings at install time", () => {
    makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Mono") } } });
    expect(loadMsdfFamily).toHaveBeenCalledWith("Mono");
  });

  it("loads a font that arrives with a later settings change, whichever mode holds it", () => {
    const store = makeStore();
    expect(loadMsdfFamily).not.toHaveBeenCalled();
    store.setState({ vectorByCorridorsSettings: { startMarker: { textFont: font("Serif") } } });
    expect(loadMsdfFamily).toHaveBeenCalledWith("Serif");
  });

  it("requests each family once", () => {
    const store = makeStore();
    store.setState({ vectorByWallsSettings: { startMarker: { textFont: font("Mono") } } });
    store.setState({ vectorByWallsSettings: { startMarker: { textFont: font("Mono") }, finishMarker: { textFont: font("Mono") } } });
    store.setState({ vectorByCorridorsSettings: { startMarker: { textFont: font("Mono") } } });
    expect(loadMsdfFamily).toHaveBeenCalledTimes(1);
  });

  it("ignores a font whose text is not drawn (GitHub issue #1012)", () => {
    const store = makeStore({ vectorByWallsSettings: { startMarker: { textEnabled: false, textFont: font("Mono") } } });
    expect(loadMsdfFamily).not.toHaveBeenCalled();
    // The text switches on: its font starts loading then.
    store.setState({ vectorByWallsSettings: { startMarker: { textEnabled: true, textFont: font("Mono") } } });
    expect(loadMsdfFamily).toHaveBeenCalledWith("Mono");
  });

  it("ignores the Shared style source font and fonts of elements the maze lacks", () => {
    makeStore({ vectorByWallsSettings: { labelFont: font("Mono"), elevatorBadges: { textFont: font("Serif") }, floorLabel: { textFont: font("Serif") } } });
    expect(loadMsdfFamily).not.toHaveBeenCalled();
  });

  it("starts the download when the maze gains the element that draws the font", () => {
    const store = makeStore({ vectorByWallsSettings: { elevatorBadges: { enabled: true, textFont: font("Mono") } } });
    expect(loadMsdfFamily).not.toHaveBeenCalled();
    store.setState({ edges: [{ kind: "elevator" }] });
    expect(loadMsdfFamily).toHaveBeenCalledWith("Mono");
  });

  it("does nothing for the default font", () => {
    const store = makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("") } } });
    store.setState({ vectorByCorridorsSettings: { startMarker: { textFont: font("") } } });
    expect(loadMsdfFamily).not.toHaveBeenCalled();
  });

  describe("raster fonts (GitHub issue #966)", () => {
    it("converts a project font once no picker is open", () => {
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Arial") } } });
      expect(loadRasterFont).toHaveBeenCalledWith({ family: "Arial", weight: 400 });
    });

    it("does not convert a font whose MSDF conversion is switched off, and frees its atlas", () => {
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: { family: "Gamma", weight: 400, msdf: false } } } });
      expect(loadRasterFont).not.toHaveBeenCalled();
      expect(pruneRasterFonts).toHaveBeenLastCalledWith(new Set());
    });

    it("loads the browser face of a font without conversion so its labels leave the fallback font", () => {
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: { family: "Gamma", weight: 400, msdf: false } } } });
      expect(loadLabelFont).toHaveBeenCalledWith({ family: "Gamma", weight: 400, msdf: false });
    });

    it("loads no browser face while a picker is open", () => {
      setFontPickerOpen(true);
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: { family: "Gamma", weight: 400, msdf: false } } } });
      expect(loadLabelFont).not.toHaveBeenCalled();
    });

    it("keeps converting a font that one text converts and another does not", () => {
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: { family: "Delta", weight: 400, msdf: false } }, finishMarker: { textFont: font("Delta") } } });
      expect(loadRasterFont).toHaveBeenCalledWith({ family: "Delta", weight: 400 });
    });

    it("converts nothing while a picker is open, however often the previewed font changes", () => {
      const store = makeStore();
      loadRasterFont.mockClear();
      pruneRasterFonts.mockClear();
      setFontPickerOpen(true);
      store.setState({ vectorByWallsSettings: { startMarker: { textFont: font("Arial") } } });
      store.setState({ vectorByWallsSettings: { startMarker: { textFont: font("Verdana") } } });
      expect(loadRasterFont).not.toHaveBeenCalled();
      expect(pruneRasterFonts).not.toHaveBeenCalled();
    });

    it("converts the font that stays when the picker closes", () => {
      const store = makeStore();
      setFontPickerOpen(true);
      store.setState({ vectorByWallsSettings: { startMarker: { textFont: font("Alpha") } } });
      store.setState({ vectorByWallsSettings: { startMarker: { textFont: font("Beta") } } });
      expect(loadRasterFont).not.toHaveBeenCalledWith({ family: "Alpha", weight: 400 });
      setFontPickerOpen(false);
      expect(loadRasterFont).toHaveBeenCalledWith({ family: "Beta", weight: 400 });
      expect(loadRasterFont).not.toHaveBeenCalledWith({ family: "Alpha", weight: 400 });
      expect(pruneRasterFonts).toHaveBeenCalledWith(new Set(["400|Beta"]));
    });

    it("still downloads a baked font while a picker is open", () => {
      const store = makeStore();
      setFontPickerOpen(true);
      store.setState({ vectorByWallsSettings: { startMarker: { textFont: font("Mono") } } });
      expect(loadMsdfFamily).toHaveBeenCalledWith("Mono");
    });
  });

  describe("unavailable raster fonts (GitHub issue #974)", () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const setPermission = (state: PermissionState | null) => {
      const win = window as Window & { queryLocalFonts?: unknown };
      if (state === null) {
        delete win.queryLocalFonts;
        return;
      }
      // Before the permission is decided the browser refuses the query that is not made from a click.
      win.queryLocalFonts = state === "prompt" ? vi.fn().mockRejectedValue(new Error("needs a user gesture")) : vi.fn().mockResolvedValue([]);
      Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: () => Promise.resolve({ state }) } });
    };

    beforeEach(async () => {
      // The font list query is cached for the page lifetime: drop what an earlier case left in it.
      (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn().mockRejectedValue(new Error("reset"));
      await loadLocalFontFamilies(true);
      resetNotifications();
      resetFontProblems();
      closeFontPermissionRequest(false);
      resetFontPermissionAnswer();
    });

    it("raises one error naming every font that has no source when the browser cannot read installed fonts", async () => {
      setPermission(null);
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") }, finishMarker: { textFont: font("Phantom") } } });
      await settle();
      const { errors } = useNotificationStore.getState();
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("fonts.unavailable");
      expect(errors[0].occurrences[0].params.fonts).toBe("Ghost, Phantom");
      expect(getFontPermissionRequest().open).toBe(false);
    });

    it("also reports a missing font whose MSDF conversion is switched off", async () => {
      setPermission(null);
      makeStore({ vectorByWallsSettings: { finishMarker: { textFont: { family: "Ghost", weight: 400, msdf: false } } } });
      await settle();
      const { errors } = useNotificationStore.getState();
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("fonts.unavailable");
      expect(errors[0].occurrences[0].params.fonts).toBe("Ghost");
    });

    it("does not report a font without conversion that the user typed in as an installed one", async () => {
      setPermission(null);
      addManualFontName("Typed Sans");
      makeStore({ vectorByWallsSettings: { finishMarker: { textFont: { family: "Typed Sans", weight: 400, msdf: false } } } });
      await settle();
      expect(useNotificationStore.getState().errors).toHaveLength(0);
    });

    it("withdraws the error once the font becomes available", async () => {
      setPermission(null);
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") } } });
      await settle();
      expect(useNotificationStore.getState().errors).toHaveLength(1);
      registerLocalFaces([{ family: "Ghost", style: "Regular", blob: () => Promise.resolve(new Blob()) }]);
      await settle();
      expect(useNotificationStore.getState().errors).toHaveLength(0);
      registerLocalFaces([]);
    });

    it("asks again through the dialog when a granted permission's query is refused without a gesture", async () => {
      setPermission("granted");
      (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn().mockRejectedValue(new Error("needs a user gesture"));
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") } } });
      await settle();
      expect(getFontPermissionRequest()).toEqual({ open: true, families: ["Ghost"] });
      expect(useNotificationStore.getState().errors).toHaveLength(0);
    });

    it("does not ask for a permission that is already given when one query is refused and the next one is answered", async () => {
      setPermission("granted");
      (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn()
        .mockRejectedValueOnce(new Error("refused for a passing reason"))
        .mockResolvedValue([]);
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") } } });
      await settle();
      expect(getFontPermissionRequest().open).toBe(false);
      expect(useNotificationStore.getState().errors[0].code).toBe("fonts.unavailable");
    });

    it("trusts a font list that loads when the browser cannot report the permission state", async () => {
      setPermission("granted");
      Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: () => Promise.reject(new Error("unknown permission name")) } });
      (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn().mockResolvedValue([]);
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") } } });
      await settle();
      expect(getFontPermissionRequest().open).toBe(false);
      expect(useNotificationStore.getState().errors[0].code).toBe("fonts.unavailable");
    });

    it("asks for the permission first when the browser can still prompt, and reports nothing yet", async () => {
      setPermission("prompt");
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") } } });
      await settle();
      expect(getFontPermissionRequest()).toEqual({ open: true, families: ["Ghost"] });
      expect(useNotificationStore.getState().errors).toHaveLength(0);
    });

    it("turns a cancelled request into an error, once", async () => {
      setPermission("prompt");
      const store = makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") } } });
      await settle();
      closeFontPermissionRequest(true);
      await settle();
      store.setState({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") }, other: 1 } });
      expect(getFontPermissionRequest().open).toBe(false);
      const { errors } = useNotificationStore.getState();
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("fonts.permission_denied");
      expect(errors[0].occurrences).toHaveLength(1);
    });

    it("asks again when another font goes missing after the dialog was cancelled", async () => {
      setPermission("prompt");
      const store = makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") } } });
      await settle();
      closeFontPermissionRequest(true);
      await settle();
      expect(getFontPermissionRequest().open).toBe(false);
      store.setState({ vectorByCorridorsSettings: { startMarker: { textFont: font("Phantom") } } });
      expect(getFontPermissionRequest()).toEqual({ open: true, families: ["Ghost", "Phantom"] });
    });

    it("says the access is blocked when the permission was denied", async () => {
      setPermission("denied");
      makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") } } });
      await settle();
      expect(useNotificationStore.getState().errors[0].code).toBe("fonts.permission_denied");
    });

    it("reports again for an export without opening the dialog", async () => {
      setPermission("prompt");
      const store = makeStore({ vectorByWallsSettings: { startMarker: { textFont: font("Ghost") } } });
      await settle();
      closeFontPermissionRequest(true);
      await settle();
      const firstId = useNotificationStore.getState().errors[0].occurrences[0].id;
      reportProjectFontProblems(store.getState() as never);
      const { errors } = useNotificationStore.getState();
      expect(errors).toHaveLength(1);
      expect(errors[0].occurrences).toHaveLength(1);
      expect(errors[0].occurrences[0].id).not.toBe(firstId);
    });
  });
});
