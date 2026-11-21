import { describe, it, expect, vi } from "vitest";

const installEdgeMarkerSync = vi.fn();
const installLabelFontSync = vi.fn();
vi.mock("../pixi/edgeMarkerSync", () => ({ installEdgeMarkerSync }));
vi.mock("../pixi/labelFontSync", () => ({ installLabelFontSync }));

const { installStoreSyncs } = await import("../pixi/installStoreSyncs");
const { useMazeStore } = await import("../store/mazeStore");

describe("installStoreSyncs", () => {
  it("installs each canvas-layer sync once on the store, however often it is called", () => {
    installStoreSyncs();
    installStoreSyncs();
    expect(installEdgeMarkerSync).toHaveBeenCalledTimes(1);
    expect(installEdgeMarkerSync).toHaveBeenCalledWith(useMazeStore);
    expect(installLabelFontSync).toHaveBeenCalledTimes(1);
    expect(installLabelFontSync).toHaveBeenCalledWith(useMazeStore);
  });
});
