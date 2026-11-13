import { describe, it, expect, vi, beforeEach } from "vitest";

// `msdfLoader.ts` (GitHub issue #982) downloads a baked MSDF font's atlases on demand. Pixi's `Assets`
// is faked; the registry gets a second font so a non-default family can be exercised.

const assetsLoad = vi.fn();

vi.mock("pixi.js", () => ({
  Assets: { load: (url: string) => assetsLoad(url) },
}));

const { LABEL_FONT_LOADED_EVENT, MSDF_FONTS, isMsdfFamilyLoaded, msdfFace } = await import("../pixi/renderers/fontChoice");
const { loadMsdfFamily } = await import("../pixi/renderers/msdfLoader");

function registerFont(family: string) {
  MSDF_FONTS[family] = {
    label: family,
    faces: [
      { weight: 400, atlasName: `${family}-Regular`, url: `/fonts/${family}-regular-msdf.fnt` },
      { weight: 700, atlasName: `${family}-Bold`, url: `/fonts/${family}-bold-msdf.fnt` },
    ],
  };
}

beforeEach(() => {
  assetsLoad.mockReset();
  assetsLoad.mockResolvedValue(undefined);
});

describe("loadMsdfFamily", () => {
  it("resolves false for a family outside the catalog without fetching", async () => {
    expect(await loadMsdfFamily("NotACatalogFont")).toBe(false);
    expect(assetsLoad).not.toHaveBeenCalled();
  });

  it("fetches every atlas of the family once and is idempotent", async () => {
    registerFont("Once");
    expect(await loadMsdfFamily("Once")).toBe(true);
    expect(assetsLoad.mock.calls.map((c) => c[0]).sort()).toEqual(["/fonts/Once-bold-msdf.fnt", "/fonts/Once-regular-msdf.fnt"]);
    await loadMsdfFamily("Once");
    expect(assetsLoad).toHaveBeenCalledTimes(2);
  });

  it("shares one download between concurrent requests", async () => {
    registerFont("Shared");
    const results = await Promise.all([loadMsdfFamily("Shared"), loadMsdfFamily("Shared")]);
    expect(results).toEqual([true, true]);
    expect(assetsLoad).toHaveBeenCalledTimes(2);
  });

  it("fetches only the requested family", async () => {
    registerFont("Picked");
    registerFont("Ignored");
    await loadMsdfFamily("Picked");
    expect(assetsLoad.mock.calls.every((c) => (c[0] as string).includes("Picked"))).toBe(true);
    expect(isMsdfFamilyLoaded("Ignored")).toBe(false);
  });

  it("draws the font only after it is loaded, the default font until then", async () => {
    registerFont("Late");
    const font = { family: "Late", weight: 700 };
    expect(isMsdfFamilyLoaded("Late")).toBe(false);
    expect(msdfFace(font).atlasName).toBe("Roboto-Bold");
    await loadMsdfFamily("Late");
    expect(isMsdfFamilyLoaded("Late")).toBe(true);
    expect(msdfFace(font).atlasName).toBe("Late-Bold");
  });

  it("announces a newly loaded font once", async () => {
    registerFont("Announced");
    const listener = vi.fn();
    window.addEventListener(LABEL_FONT_LOADED_EVENT, listener);
    await loadMsdfFamily("Announced");
    await loadMsdfFamily("Announced");
    window.removeEventListener(LABEL_FONT_LOADED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("resolves false and keeps the default font when a download fails, then retries on the next request", async () => {
    registerFont("Flaky");
    const font = { family: "Flaky", weight: 400 };
    assetsLoad.mockRejectedValueOnce(new Error("network"));
    expect(await loadMsdfFamily("Flaky")).toBe(false);
    expect(isMsdfFamilyLoaded("Flaky")).toBe(false);
    expect(msdfFace(font).atlasName).toBe("Roboto-Regular");
    expect(await loadMsdfFamily("Flaky")).toBe(true);
    expect(msdfFace(font).atlasName).toBe("Flaky-Regular");
  });
});
