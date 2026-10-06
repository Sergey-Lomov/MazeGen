import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readImageFile } from "../components/backgroundImageFile";

let readerResult: string | null = "data:image/png;base64,test";
let readerError: Error | null = null;
let imageWidth = 200;
let imageHeight = 100;
let imageError = false;

class TestFileReader {
  result = readerResult;
  error = readerError;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(): void {
    if (this.error) this.onerror?.();
    else this.onload?.();
  }
}

class TestImage {
  naturalWidth = imageWidth;
  naturalHeight = imageHeight;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    if (imageError) this.onerror?.();
    else this.onload?.();
  }
}

beforeEach(() => {
  readerResult = "data:image/png;base64,test";
  readerError = null;
  imageWidth = 200;
  imageHeight = 100;
  imageError = false;
  vi.stubGlobal("FileReader", TestFileReader);
  vi.stubGlobal("Image", TestImage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readImageFile", () => {
  const file = () => new File(["image"], "underlay.png", { type: "image/png" });

  it("reads the data URL and natural dimensions", async () => {
    await expect(readImageFile(file())).resolves.toEqual({
      dataUrl: "data:image/png;base64,test",
      width: 200,
      height: 100,
    });
  });

  it("rejects reader failures and missing data URLs", async () => {
    readerError = new Error("read failed");
    await expect(readImageFile(file())).rejects.toThrow("read failed");

    readerError = null;
    readerResult = null;
    await expect(readImageFile(file())).rejects.toThrow("data URL");
  });

  it("rejects decode failures and invalid dimensions", async () => {
    imageError = true;
    await expect(readImageFile(file())).rejects.toThrow("decode image");

    imageError = false;
    imageWidth = 0;
    await expect(readImageFile(file())).rejects.toThrow("invalid dimensions");
  });
});
