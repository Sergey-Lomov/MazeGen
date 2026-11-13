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

  it("a geometry parameter edit goes through the links per leaf: the finish follows it and keeps its links to the start", () => {
    useMazeStore.getState().patchVectorByWallsOpening("startOpening", { geometry: { arrow: { headWidth: 9 } } });
    expect(settings().startOpening.geometry.arrow.headWidth).toBe(9);
    expect(settings().finishOpening.geometry.arrow.headWidth).toBe(9);
    expect(settings().finishOpening.geometry.arrow.length).toBe(settings().startOpening.geometry.arrow.length);
    expect(linkOf("finishOpening.geometry.arrow.headWidth")?.enabled).toBe(true);
    expect(linkOf("finishOpening.geometry.arrow.length")?.enabled).toBe(true);
  });
});
