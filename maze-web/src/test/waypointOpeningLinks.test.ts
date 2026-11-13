import { describe, it, expect } from "vitest";
import { useMazeStore } from "../store/mazeStore";

const settings = () => useMazeStore.getState().vectorByWallsSettings;
const linkOf = (target: string) => settings().links.find((l) => l.target === target);

describe("external passage default links, end to end (GitHub issue #330)", () => {
  it("the finish follows the start's mode and gap width", () => {
    useMazeStore.getState().patchVectorByWallsOpening("startOpening", { mode: "pointer", gapWidth: 8 });
    expect(settings().startOpening).toMatchObject({ mode: "pointer", gapWidth: 8 });
    expect(settings().finishOpening).toMatchObject({ mode: "pointer", gapWidth: 8 });
  });

  it("editing the start's gap width breaks only its own link to the shared gap width", () => {
    expect(linkOf("startOpening.gapWidth")?.enabled).toBe(false);
    expect(linkOf("finishOpening.gapWidth")?.enabled).toBe(true);
  });

  it("editing the finish's own gap width and mode detaches it from the start", () => {
    useMazeStore.getState().patchVectorByWallsOpening("finishOpening", { mode: "both", gapWidth: 2 });
    expect(settings().finishOpening).toMatchObject({ mode: "both", gapWidth: 2 });
    expect(settings().startOpening).toMatchObject({ mode: "pointer", gapWidth: 8 });
    expect(linkOf("finishOpening.mode")?.enabled).toBe(false);
    expect(linkOf("finishOpening.gapWidth")?.enabled).toBe(false);
  });
});
