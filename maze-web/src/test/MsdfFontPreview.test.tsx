import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";

// The preview draws the highlighted baked font and redraws when a font that was still downloading
// arrives (GitHub issue #982). The pixi application and the label factory are faked: only the loading
// and redraw decisions are under test.

const makeCenteredLabel = vi.hoisted(() => vi.fn());
const loadMsdfFamily = vi.hoisted(() => vi.fn());

vi.mock("pixi.js", () => ({
  Application: class {
    screen = { width: 300, height: 48 };
    stage = { removeChildren: () => [], addChild: vi.fn() };
    renderer = { background: { color: 0 } };
    canvas = document.createElement("canvas");
    init = vi.fn().mockResolvedValue(undefined);
    resize = vi.fn();
    render = vi.fn();
    destroy = vi.fn();
  },
}));
vi.mock("../pixi/renderers/msdfFont", () => ({
  loadMsdfFont: () => Promise.resolve(),
  makeCenteredLabel: (...args: unknown[]) => makeCenteredLabel(...args),
}));
vi.mock("../pixi/renderers/msdfLoader", () => ({ loadMsdfFamily: (family: string) => loadMsdfFamily(family) }));

const { MSDF_FONTS, markMsdfFamilyLoaded } = await import("../pixi/renderers/fontChoice");
const { MsdfFontPreview } = await import("../components/MsdfFontPreview");

const face = (id: string, weight: number) => ({ weight, atlasName: `${id}-${weight}`, url: `/fonts/${id}-${weight}.fnt` });
for (const id of ["late", "later", "ready"]) MSDF_FONTS[`msdf:${id}`] = { label: id, scripts: [], faces: [face(id, 400), face(id, 700)] };
markMsdfFamilyLoaded("msdf:ready");

beforeEach(() => {
  makeCenteredLabel.mockReset();
  makeCenteredLabel.mockImplementation(() => ({ width: 10, position: { set: vi.fn() }, destroy: vi.fn() }));
  loadMsdfFamily.mockReset();
});

const props = { text: "Lorem", textColor: 0, background: 0xffffff, fontSize: 32, style: {} };

async function mount(family: string) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<MsdfFontPreview {...props} font={{ family, weight: 400 }} />); });
  return view;
}

/** A load the test settles by hand. */
function deferredLoad() {
  let settle!: (loaded: boolean) => void;
  loadMsdfFamily.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
  return (loaded: boolean) => act(async () => { settle(loaded); });
}

describe("MsdfFontPreview font loading", () => {
  it("asks for nothing when the font is the default or already loaded", async () => {
    await mount("");
    await mount("msdf:ready");
    expect(loadMsdfFamily).not.toHaveBeenCalled();
  });

  it("requests a font that is still downloading and redraws once it has loaded", async () => {
    const finish = deferredLoad();
    await mount("msdf:late");
    expect(loadMsdfFamily).toHaveBeenCalledWith("msdf:late");
    const drawsBefore = makeCenteredLabel.mock.calls.length;
    expect(drawsBefore).toBeGreaterThan(0);
    await finish(true);
    expect(makeCenteredLabel.mock.calls.length).toBeGreaterThan(drawsBefore);
  });

  it("keeps the drawing as it is when the download fails", async () => {
    const finish = deferredLoad();
    await mount("msdf:late");
    const drawsBefore = makeCenteredLabel.mock.calls.length;
    await finish(false);
    expect(makeCenteredLabel.mock.calls.length).toBe(drawsBefore);
  });

  it("ignores a download that finishes after another font was highlighted", async () => {
    const finishLate = deferredLoad();
    const view = await mount("msdf:late");
    const drawsBefore = makeCenteredLabel.mock.calls.length;
    await act(async () => { view.rerender(<MsdfFontPreview {...props} font={{ family: "msdf:ready", weight: 400 }} />); });
    const drawsAfterSwitch = makeCenteredLabel.mock.calls.length;
    expect(drawsAfterSwitch).toBeGreaterThan(drawsBefore);
    await finishLate(true);
    expect(makeCenteredLabel.mock.calls.length).toBe(drawsAfterSwitch);
  });
});
