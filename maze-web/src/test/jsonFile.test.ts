import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { readJsonFile } from "../components/jsonFile";
import { resetNotifications } from "../notifications/notificationStore";
import { errorCards, errorDetails } from "./notificationTestHelpers";

beforeEach(() => resetNotifications());

describe("readJsonFile", () => {
  it("passes parsed JSON to onJson without a toast", async () => {
    const onJson = vi.fn();
    readJsonFile(new File(['{"a":1}'], "x.maze"), "test_source", onJson);
    await waitFor(() => expect(onJson).toHaveBeenCalledWith({ a: 1 }));
    expect(errorCards()).toEqual([]);
  });

  it("reports invalid JSON as an error toast with details and skips onJson", async () => {
    const onJson = vi.fn();
    readJsonFile(new File(["{not json"], "x.maze"), "test_source", onJson);
    await waitFor(() => expect(errorCards()).toEqual(["test_source/file_load.invalid_json"]));
    expect(errorDetails("file_load.invalid_json")).toBeTruthy();
    expect(onJson).not.toHaveBeenCalled();
  });

  it("reports a read failure as an error toast and skips onJson", async () => {
    const original = FileReader.prototype.readAsText;
    FileReader.prototype.readAsText = function (this: FileReader) {
      setTimeout(() => this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>));
    };
    try {
      const onJson = vi.fn();
      readJsonFile(new File(["{}"], "x.maze"), "test_source", onJson);
      await waitFor(() => expect(errorCards()).toEqual(["test_source/file_load.read_failed"]));
      expect(onJson).not.toHaveBeenCalled();
    } finally {
      FileReader.prototype.readAsText = original;
    }
  });
});
