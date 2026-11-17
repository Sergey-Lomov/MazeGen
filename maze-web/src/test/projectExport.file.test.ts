import { describe, it, expect, vi, afterEach } from "vitest";
import { downloadProjectFile, parseAndValidate, projectFileAccept, PROJECT_FILE_EXTENSION } from "../store/projectExport";
import { makeState, toJson } from "./projectExportKit";

describe("parseAndValidate — migrations", () => {
  it("throws when a file's version has no registered migration path to current", () => {
    const data = toJson(makeState());
    data.version = 0;
    expect(() => parseAndValidate(data)).toThrow(/No migration for version/);
  });
});

describe("downloadProjectFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("saves under the project extension with a MIME type browsers won't re-extension", () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mock-url");
    // jsdom implements neither object URLs nor navigation — same stubs as `pngExport.test.ts`.
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    let downloadName = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });

    downloadProjectFile(makeState());

    expect(PROJECT_FILE_EXTENSION).toBe(".maze");
    expect(downloadName).toBe(`maze-project${PROJECT_FILE_EXTENSION}`);
    // `application/json` would make Safari/mobile save `maze-project.maze.json`, which the load
    // dialog's `accept` filter then hides.
    expect(createObjectURL.mock.calls[0][0].type).toBe("application/octet-stream");
  });
});

describe("projectFileAccept", () => {
  const nav = (userAgent: string, platform: string, maxTouchPoints: number) => ({ userAgent, platform, maxTouchPoints });

  it("filters by the project extension on desktop", () => {
    expect(projectFileAccept(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0))).toBe(PROJECT_FILE_EXTENSION);
    expect(projectFileAccept(nav("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", 0))).toBe(PROJECT_FILE_EXTENSION);
  });

  it("drops the filter on iPhone and on iPadOS (which reports a desktop Mac user agent)", () => {
    expect(projectFileAccept(nav("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "iPhone", 5))).toBeUndefined();
    expect(projectFileAccept(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5))).toBeUndefined();
  });
});