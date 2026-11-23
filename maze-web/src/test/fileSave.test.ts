import { afterEach, describe, expect, it, vi } from "vitest";
import { lastSavedFileName, resetSavedHandles, saveJsonInPlace, supportsInPlaceSave } from "../store/projectExport/fileSave";
import { resetNotifications } from "../notifications/notificationStore";
import { errorCards } from "./notificationTestHelpers";

function makeHandle(name: string, failOn?: "write" | "close") {
  const writes: Blob[] = [];
  const writable = {
    write: vi.fn(async (blob: Blob) => {
      if (failOn === "write") throw new Error("disk full");
      writes.push(blob);
    }),
    close: vi.fn(async () => {
      if (failOn === "close") throw new Error("denied");
    }),
    abort: vi.fn(async () => undefined),
  };
  return { handle: { name, createWritable: vi.fn(async () => writable) }, writable, writes };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSavedHandles();
});

describe("saveJsonInPlace", () => {
  it("reports no support without showSaveFilePicker", () => {
    expect(supportsInPlaceSave()).toBe(false);
  });

  it("asks for a file once, then rewrites it while the name is unchanged", async () => {
    const { handle, writes } = makeHandle("castle.maze");
    const picker = vi.fn(async () => handle);
    vi.stubGlobal("showSaveFilePicker", picker);

    expect(await saveJsonInPlace("project", { a: 1 }, "castle.maze", ".maze")).toBe("saved");
    expect(await saveJsonInPlace("project", { a: 2 }, "castle.maze", ".maze")).toBe("saved");

    expect(picker).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(2);
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(writes[1]);
    });
    expect(text).toBe(JSON.stringify({ a: 2 }, null, 2));
    expect(lastSavedFileName("project")).toBe("castle.maze");
  });

  it("opens the picker again when the name changed", async () => {
    const picker = vi.fn(async (options: { suggestedName: string }) => makeHandle(options.suggestedName).handle);
    vi.stubGlobal("showSaveFilePicker", picker);
    await saveJsonInPlace("project", {}, "castle.maze", ".maze");
    await saveJsonInPlace("project", {}, "other.maze", ".maze");
    expect(picker).toHaveBeenCalledTimes(2);
    expect(lastSavedFileName("project")).toBe("other.maze");
  });

  it("treats a cancelled picker as no save and no error", async () => {
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => { throw new DOMException("cancelled", "AbortError"); }));
    expect(await saveJsonInPlace("project", {}, "a.maze", ".maze")).toBe("cancelled");
    expect(lastSavedFileName("project")).toBeNull();
  });

  it("notifies and does not remember a handle when the commit on close fails", async () => {
    const { handle, writable } = makeHandle("a.maze", "close");
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => handle));
    resetNotifications();

    expect(await saveJsonInPlace("project", {}, "a.maze", ".maze")).toBe("failed");

    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(lastSavedFileName("project")).toBeNull();
    expect(errorCards()).toEqual(["file_save/file_save.failed"]);
  });

  it("reports an error instead of throwing when the picker is unavailable", async () => {
    resetNotifications();
    expect(await saveJsonInPlace("project", {}, "a.maze", ".maze")).toBe("failed");
    expect(errorCards()).toEqual(["file_save/file_save.failed"]);
  });

  it("keeps handles of different kinds apart", async () => {
    vi.stubGlobal("showSaveFilePicker", vi.fn(async (options: { suggestedName: string }) => makeHandle(options.suggestedName).handle));
    await saveJsonInPlace("project", {}, "a.maze", ".maze");
    await saveJsonInPlace("style", {}, "b.mazestyle", ".mazestyle");
    expect(lastSavedFileName("project")).toBe("a.maze");
    expect(lastSavedFileName("style")).toBe("b.mazestyle");
  });

  it("aborts the stream, notifies and forgets the handle when the write fails", async () => {
    const { handle, writable } = makeHandle("a.maze", "write");
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => handle));
    resetNotifications();

    expect(await saveJsonInPlace("project", {}, "a.maze", ".maze")).toBe("failed");

    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(lastSavedFileName("project")).toBeNull();
    expect(errorCards()).toEqual(["file_save/file_save.failed"]);
  });
});
