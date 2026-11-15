import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Uploaded fonts keep only their identity in memory; the file is read when used (GitHub issue #985). */
const fontBytes = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, "../../tools/msdf", name)));
const REGULAR = fontBytes("Roboto-Regular.ttf");
const BOLD = fontBytes("Roboto-Bold.ttf");
const asBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

async function freshStore() {
  vi.resetModules();
  return import("../pixi/renderers/rasterFont/rasterFontStore");
}

describe("uploaded font identity and bytes", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    });
  });

  it("reads a face's file back on demand and keys its source on the file's fingerprint", async () => {
    const store = await freshStore();
    expect((await store.addUploadedFont(asBlob(REGULAR))).ok).toBe(true);
    expect((await store.addUploadedFont(asBlob(BOLD))).ok).toBe(true);
    const family = store.uploadedFamilies()[0];
    const regular = store.rasterFaceSource(family, 400);
    expect(regular).toMatch(/^upload:/);
    expect(store.rasterFaceSource(family, 700)).not.toBe(regular);
    expect(await store.rasterFaceBytes(family, 400)).toEqual(REGULAR);
    // The same file again keeps its identity, so a built atlas stays valid.
    await store.addUploadedFont(asBlob(REGULAR));
    expect(store.rasterFaceSource(family, 400)).toBe(regular);
  });

  it("loading a face of a family that was not uploaded does nothing", async () => {
    const store = await freshStore();
    await expect(store.ensureUploadedFace("Not Uploaded", 400)).resolves.toBeUndefined();
    expect(store.isUploadedFaceLoaded("Not Uploaded")).toBe(false);
  });

  it("remembers a measured script coverage per file and forgets it when the file is replaced", async () => {
    const store = await freshStore();
    await store.addUploadedFont(asBlob(REGULAR));
    const family = store.uploadedFamilies()[0];
    expect(store.storedUploadedCoverage(family, "ЖЩ")).toBeUndefined();
    store.saveUploadedCoverage(family, "ЖЩ", true);
    expect(store.storedUploadedCoverage(family, "ЖЩ")).toBe(true);
    await store.removeUploadedFont(family);
    await store.addUploadedFont(asBlob(BOLD));
    expect(store.storedUploadedCoverage(family, "ЖЩ")).toBeUndefined();
  });

  it("refuses a font file over the size limit and stores nothing", async () => {
    const store = await freshStore();
    const huge = new Uint8Array(REGULAR.length + store.MAX_UPLOAD_FILE_BYTES);
    huge.set(REGULAR);
    const result = await store.addUploadedFont(asBlob(huge));
    expect(result).toEqual({ ok: false, reason: "file-too-large" });
    expect(store.uploadedFamilies()).toEqual([]);
  });

  it("counts a replaced face once: uploading the same face again does not use up the limits", async () => {
    const store = await freshStore();
    for (let i = 0; i < 3; i++) expect((await store.addUploadedFont(asBlob(REGULAR))).ok).toBe(true);
    expect(store.uploadedUsage()).toEqual({ faces: 1, bytes: REGULAR.length });
  });

  it("reports an exhausted limit before any file is chosen, and none while there is room", async () => {
    const store = await freshStore();
    expect(store.uploadCapacityExhausted()).toBeNull();
    await store.addUploadedFont(asBlob(REGULAR));
    expect(store.uploadCapacityExhausted()).toBeNull();
  });
});
