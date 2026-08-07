import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadPngExport } from "../components/features/pngExport";

describe("downloadPngExport", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn(() => "blob:mock-url");
    revokeObjectURL = vi.fn();
    // jsdom doesn't implement these — same stub-and-restore approach as any other browser API
    // this test environment lacks natively.
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    // jsdom also doesn't implement real navigation — an <a href="blob:..."> click would otherwise
    // log an async "Not implemented: navigation" warning after the test already finished.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates an object URL from the blob and revokes it after triggering the download", () => {
    const blob = new Blob(["fake png bytes"], { type: "image/png" });
    downloadPngExport(blob);

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("does not leave the temporary anchor element attached to the document", () => {
    const blob = new Blob(["fake png bytes"], { type: "image/png" });
    downloadPngExport(blob);

    expect(document.querySelector("a[download='maze-export.png']")).toBeNull();
  });
});
