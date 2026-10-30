import { describe, expect, it } from "vitest";
import { canActivateFieldPrimitive } from "../pixi/fieldPrimitiveShortcuts";
import { blurActiveElement, postEditToolForShortcut, postEditToolShortcut, presetToolForShortcut, presetToolShortcut } from "../pixi/toolShortcuts";

describe("canActivateFieldPrimitive", () => {
  it("blocks the mirror tool in Select mode and where reflect is unavailable, and every tool while locked", () => {
    expect(canActivateFieldPrimitive("mirror", "add", false, true)).toBe(true);
    expect(canActivateFieldPrimitive("mirror", "select", false, true)).toBe(false);
    expect(canActivateFieldPrimitive("mirror", "add", false, false)).toBe(false);
    expect(canActivateFieldPrimitive("point", "add", false, false)).toBe(true);
    expect(canActivateFieldPrimitive("point", "add", true, true)).toBe(false);
  });
});

describe("tool shortcuts", () => {
  it("uses each tool's first letter and Alt for one-way variants", () => {
    expect(presetToolForShortcut(new KeyboardEvent("keydown", { code: "KeyW" }))).toBe("wall");
    expect(presetToolForShortcut(new KeyboardEvent("keydown", { code: "KeyT" }))).toBe("teleport_two_way");
    expect(presetToolForShortcut(new KeyboardEvent("keydown", { code: "KeyT", altKey: true }))).toBe("teleport_one_way");
    expect(postEditToolForShortcut(new KeyboardEvent("keydown", { code: "KeyV", altKey: true }))).toBe("vertical_passage_one_way");
  });

  it("maps Config and destructive tools as agreed", () => {
    expect(presetToolShortcut("settings")).toEqual(["C"]);
    expect(presetToolShortcut("clear")).toEqual(["D"]);
    expect(postEditToolShortcut("delete")).toEqual(["D"]);
  });

  it("ignores ordinary browser and text-editing modifiers", () => {
    expect(postEditToolForShortcut(new KeyboardEvent("keydown", { code: "KeyP", ctrlKey: true }))).toBeUndefined();
    expect(postEditToolForShortcut(new KeyboardEvent("keydown", { code: "KeyP", shiftKey: true }))).toBeUndefined();
  });

  it("does not select unavailable vertical tools on a single-floor field", () => {
    expect(presetToolForShortcut(new KeyboardEvent("keydown", { code: "KeyV" }), false)).toBeUndefined();
    expect(postEditToolForShortcut(new KeyboardEvent("keydown", { code: "KeyV", altKey: true }), false)).toBeUndefined();
  });

  it("clears the prior focus after a keyboard tool selection", () => {
    const header = document.createElement("button");
    document.body.appendChild(header);
    header.focus();

    blurActiveElement();

    expect(document.activeElement).not.toBe(header);
    header.remove();
  });
});
