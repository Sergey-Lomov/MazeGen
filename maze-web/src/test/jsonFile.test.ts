import { describe, it, expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { readJsonFile } from "../components/jsonFile";
import * as m from "~/paraglide/messages";

describe("readJsonFile", () => {
  it("passes parsed JSON to onJson", async () => {
    const onJson = vi.fn();
    const onError = vi.fn();
    readJsonFile(new File(['{"a":1}'], "x.maze"), onJson, onError);
    await waitFor(() => expect(onJson).toHaveBeenCalledWith({ a: 1 }));
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports invalid JSON with the shared message and skips onJson", async () => {
    const onJson = vi.fn();
    const onError = vi.fn();
    readJsonFile(new File(["{not json"], "x.maze"), onJson, onError);
    await waitFor(() => expect(onError).toHaveBeenCalledWith(m["project.load_error_json"]()));
    expect(onJson).not.toHaveBeenCalled();
  });
});
