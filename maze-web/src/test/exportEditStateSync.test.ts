import { describe, expect, it } from "vitest";

const { useMazeStore } = await import("../store/mazeStore");
const { isTeleportConnectorEditActive, isFloorLabelDragActive } = await import("../pixi/sceneTypes");

// Connector editing and floor-label drag are owned by the export feature (GitHub issue #947).

const edit = { renderMode: "vector_by_walls" as const, selected: null };

describe("installExportEditStateSync", () => {
  it("drops the edit state when another card opens, so returning to export starts with editing off", () => {
    useMazeStore.setState({ openCard: "image_export", activeRenderMode: "vector_by_walls", teleportConnectorEdit: edit });
    useMazeStore.getState().setOpenCard("post_edit");
    expect(useMazeStore.getState().teleportConnectorEdit).toBeNull();
    useMazeStore.getState().setOpenCard("image_export");
    expect(useMazeStore.getState().teleportConnectorEdit).toBeNull();
  });

  it("keeps the edit state while export stays open", () => {
    useMazeStore.setState({ openCard: "image_export", activeRenderMode: "vector_by_walls", teleportConnectorEdit: edit });
    useMazeStore.getState().setOpenCard("image_export");
    expect(useMazeStore.getState().teleportConnectorEdit).toEqual(edit);
  });
});

describe("floor-label drag ownership", () => {
  const drag = { renderMode: "vector_by_walls" as const, floorId: "f1", initialPosition: { mode: "free" as const, x: 0, y: 0 } };

  it("is dropped when another card opens", () => {
    useMazeStore.setState({ openCard: "image_export", floorLabelDrag: drag });
    useMazeStore.getState().setOpenCard("post_edit");
    expect(useMazeStore.getState().floorLabelDrag).toBeNull();
  });

  it("claims input only on the export card, in its render mode and floor", () => {
    const base = { floorLabelDrag: drag, openCard: "image_export" as const, activeRenderMode: "vector_by_walls" as const, activeFloorId: "f1" };
    expect(isFloorLabelDragActive(base)).toBe(true);
    expect(isFloorLabelDragActive({ ...base, openCard: "post_edit" })).toBe(false);
    expect(isFloorLabelDragActive({ ...base, activeRenderMode: "vector_by_corridors" })).toBe(false);
    expect(isFloorLabelDragActive({ ...base, activeFloorId: "f2" })).toBe(false);
    expect(isFloorLabelDragActive({ ...base, floorLabelDrag: null })).toBe(false);
  });
});

describe("installExportEditStateSync — unrelated changes", () => {
  it("keeps the edit state on store changes that do not switch the card", () => {
    useMazeStore.setState({ openCard: "image_export", activeRenderMode: "vector_by_walls", teleportConnectorEdit: edit });
    useMazeStore.getState().setTeleportConnectorEditSelection({ key: "1:2", index: 0 });
    expect(useMazeStore.getState().teleportConnectorEdit?.selected).toEqual({ key: "1:2", index: 0 });
  });

  it("is a no-op when another card opens while no edit is active", () => {
    useMazeStore.setState({ openCard: "image_export", teleportConnectorEdit: null });
    useMazeStore.getState().setOpenCard("post_edit");
    expect(useMazeStore.getState().teleportConnectorEdit).toBeNull();
  });
});

describe("TeleportConnectorEditController input guard", () => {
  const drawn = [{ edge: { fromNode: 1, toNode: 2 } as never, points: [0, 0, 100, 0] }];
  const pan = { start() {}, move() {}, end() {} };

  async function press(openCard: "image_export" | "post_edit") {
    const { Container } = await import("pixi.js");
    const { TeleportConnectorEditController } = await import("../pixi/imageExport/TeleportConnectorEditController");
    // Switch the card first so the edit-state sync cannot clear the edit this test sets afterwards.
    useMazeStore.setState({ openCard, teleportConnectorEdit: null });
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", teleportConnectorEdit: edit });
    const controller = new TeleportConnectorEditController(() => new Container(), () => drawn, pan, new Container());
    controller.onPointerDown(50, 0, 0);
    controller.onPointerUp();
    controller.destroy();
    return useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths ?? {};
  }

  it("inserts a point while the export card owns input", async () => {
    expect(Object.keys(await press("image_export"))).toContain("1:2");
  });

  it("ignores a click when another card is open", async () => {
    useMazeStore.getState().setManualTeleportConnectorPaths({});
    expect(await press("post_edit")).toEqual({});
  });
});

describe("isTeleportConnectorEditActive", () => {
  it("is active only on the export card in the edited render mode", () => {
    const base = { teleportConnectorEdit: edit, openCard: "image_export" as const, activeRenderMode: "vector_by_walls" as const };
    expect(isTeleportConnectorEditActive(base)).toBe(true);
    expect(isTeleportConnectorEditActive({ ...base, openCard: "post_edit" })).toBe(false);
    expect(isTeleportConnectorEditActive({ ...base, activeRenderMode: "vector_by_corridors" })).toBe(false);
    expect(isTeleportConnectorEditActive({ ...base, teleportConnectorEdit: null })).toBe(false);
  });
});
