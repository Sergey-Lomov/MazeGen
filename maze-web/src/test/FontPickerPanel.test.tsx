import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { FontPickerPanel, WEB_SAFE_FONT_FAMILIES } from "../components/FontPickerPanel";
import { FontButton } from "../components/FontButton";
import * as m from "~/paraglide/messages";

const localFamilies = vi.hoisted(() => ({
  value: ["Arial", "Consolas", "Georgia"] as string[] | null,
  supported: true,
  retryValue: null as string[] | null,
  // Web-safe candidates this fake machine lacks; jsdom has no canvas to measure glyphs with.
  missing: new Set<string>(),
}));

vi.mock("../pixi/renderers/labelFont", async (importActual) => ({
  ...(await importActual<typeof import("../pixi/renderers/labelFont")>()),
  isFontFamilyInstalled: (family: string) => !localFamilies.missing.has(family),
  isLocalFontAccessSupported: () => localFamilies.supported,
  loadLocalFontFamilies: (retry?: boolean) => Promise.resolve(retry ? localFamilies.retryValue : localFamilies.value),
}));

afterEach(() => { vi.useRealTimers(); });

beforeEach(() => { localFamilies.value = ["Arial", "Consolas", "Georgia"]; localFamilies.supported = true; localFamilies.retryValue = null; localFamilies.missing = new Set(); });

async function renderPanel(props: Partial<React.ComponentProps<typeof FontPickerPanel>> = {}) {
  const handlers = { onApply: vi.fn(), onClose: vi.fn(), onPreview: vi.fn(), onCancel: vi.fn() };
  await act(async () => { render(<FontPickerPanel family="" {...handlers} {...props} />); });
  return handlers;
}

const optionNames = () => screen.getAllByRole("option").map((o) => o.textContent);
const selectedName = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")?.textContent;
const vectorToggle = () => screen.getByRole("button", { name: m["font_picker.type_vector"]() });
const rasterToggle = () => screen.getByRole("button", { name: m["font_picker.type_raster"]() });

describe("FontPickerPanel", () => {
  it("opens on the vector list holding only Roboto for the default family", async () => {
    await renderPanel({ family: "" });
    expect(optionNames()).toEqual(["Roboto"]);
    expect(selectedName()).toBe("Roboto");
  });

  it("opens on the raster list with every local font and the current one highlighted", async () => {
    await renderPanel({ family: "Consolas" });
    expect(optionNames()).toEqual(["Arial", "Consolas", "Georgia"]);
    expect(selectedName()).toBe("Consolas");
  });

  it("keeps a saved family the machine does not report in the raster list", async () => {
    await renderPanel({ family: "Missing Sans" });
    expect(optionNames()).toEqual(["Missing Sans", "Arial", "Consolas", "Georgia"]);
    expect(selectedName()).toBe("Missing Sans");
  });

  it("toggles between the vector and raster lists", async () => {
    await renderPanel({ family: "" });
    fireEvent.click(rasterToggle());
    expect(optionNames()).toEqual(["Arial", "Consolas", "Georgia"]);
    fireEvent.click(vectorToggle());
    expect(optionNames()).toEqual(["Roboto"]);
  });

  it("previews a font on click without committing", async () => {
    const { onPreview, onApply } = await renderPanel({ family: "Arial" });
    fireEvent.click(screen.getByRole("option", { name: "Georgia" }));
    expect(onPreview).toHaveBeenLastCalledWith("Georgia");
    expect(selectedName()).toBe("Georgia");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("moves the selection with the arrow keys and clamps at both ends", async () => {
    const { onPreview } = await renderPanel({ family: "Arial" });
    const list = screen.getByRole("listbox");
    vi.useFakeTimers();
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(selectedName()).toBe("Arial");
    act(() => { vi.advanceTimersByTime(500); });
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedName()).toBe("Consolas");
    act(() => { vi.advanceTimersByTime(500); });
    expect(onPreview).toHaveBeenLastCalledWith("Consolas");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedName()).toBe("Georgia");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(selectedName()).toBe("Consolas");
  });

  it("coalesces a held arrow key into one canvas preview after the moves pause", async () => {
    localFamilies.value = Array.from({ length: 40 }, (_, i) => `Font ${String(i).padStart(2, "0")}`);
    const { onPreview } = await renderPanel({ family: "Font 00" });
    const list = screen.getByRole("listbox");
    vi.useFakeTimers();
    for (let i = 0; i < 20; i++) fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedName()).toBe("Font 20");
    expect(onPreview).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(500); });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenLastCalledWith("Font 20");
  });

  it("Apply delivers a still queued keyboard preview before committing", async () => {
    const { onPreview, onApply } = await renderPanel({ family: "Arial" });
    vi.useFakeTimers();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: m["common.apply"]() }));
    expect(onPreview).toHaveBeenLastCalledWith("Consolas");
    expect(onApply).toHaveBeenCalledWith("Consolas");
  });

  it("Cancel drops a queued keyboard preview and restores the open-time family", async () => {
    const { onPreview } = await renderPanel({ family: "Arial" });
    vi.useFakeTimers();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    act(() => { vi.advanceTimersByTime(500); });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenLastCalledWith("Arial");
  });

  it("Apply commits the highlighted family", async () => {
    const { onApply } = await renderPanel({ family: "Arial" });
    fireEvent.click(screen.getByRole("option", { name: "Georgia" }));
    fireEvent.click(screen.getByRole("button", { name: m["common.apply"]() }));
    expect(onApply).toHaveBeenCalledWith("Georgia");
  });

  it("Cancel restores the open-time family through the preview and notifies the call site", async () => {
    const { onPreview, onCancel, onClose, onApply } = await renderPanel({ family: "Arial" });
    fireEvent.click(screen.getByRole("option", { name: "Georgia" }));
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(onPreview).toHaveBeenLastCalledWith("Arial");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("Escape cancels like the Cancel button", async () => {
    const { onPreview, onClose } = await renderPanel({ family: "Arial" });
    fireEvent.click(screen.getByRole("option", { name: "Georgia" }));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(onPreview).toHaveBeenLastCalledWith("Arial");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([["denied or unsupported", null], ["an empty answer", []]])("lists the web-safe fonts with a permission note on %s", async (_name, answer) => {
    localFamilies.value = answer as string[] | null;
    await renderPanel({ family: "Arial" });
    expect(optionNames()).toEqual(WEB_SAFE_FONT_FAMILIES);
    expect(selectedName()).toBe("Arial");
    expect(screen.getByTestId("font-picker-permission-note").textContent).toContain(m["font_picker.local_fonts_permission"]());
  });

  it("keeps a saved family outside the web-safe list when local fonts are unavailable", async () => {
    localFamilies.value = null;
    await renderPanel({ family: "Fira Sans" });
    expect(optionNames()).toEqual(["Fira Sans", ...WEB_SAFE_FONT_FAMILIES]);
    expect(selectedName()).toBe("Fira Sans");
  });

  it("hides web-safe fonts the machine does not have", async () => {
    localFamilies.value = null;
    localFamilies.missing = new Set(["Impact", "Segoe UI"]);
    await renderPanel({ family: "Arial" });
    expect(optionNames()).toEqual(WEB_SAFE_FONT_FAMILIES.filter((f) => f !== "Impact" && f !== "Segoe UI"));
  });

  it("points aria-activedescendant at the highlighted option", async () => {
    await renderPanel({ family: "Consolas" });
    const active = screen.getByRole("listbox").getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)?.textContent).toBe("Consolas");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(document.getElementById(screen.getByRole("listbox").getAttribute("aria-activedescendant")!)?.textContent).toBe("Georgia");
  });

  it("previews a web-safe font picked while local fonts are unavailable", async () => {
    localFamilies.value = null;
    const { onPreview } = await renderPanel({ family: "Arial" });
    fireEvent.click(screen.getByRole("option", { name: "Verdana" }));
    expect(onPreview).toHaveBeenLastCalledWith("Verdana");
  });

  it("offers a grant button that loads the full list once access is given", async () => {
    localFamilies.value = null;
    localFamilies.retryValue = ["Arial", "Fira Code"];
    await renderPanel({ family: "Arial" });
    expect(screen.getByText(m["font_picker.local_fonts_permission"]())).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId("font-picker-grant-access")); });
    expect(optionNames()).toEqual(["Arial", "Fira Code"]);
    expect(screen.queryByTestId("font-picker-permission-note")).toBeNull();
  });

  it("explains how to unblock access when the grant attempt still gives no list", async () => {
    localFamilies.value = null;
    await renderPanel({ family: "Arial" });
    await act(async () => { fireEvent.click(screen.getByTestId("font-picker-grant-access")); });
    expect(optionNames()).toEqual(WEB_SAFE_FONT_FAMILIES);
    expect(screen.getByText(m["font_picker.local_fonts_blocked"]())).toBeTruthy();
    expect(screen.queryByTestId("font-picker-grant-access")).toBeNull();
  });

  it("offers no grant button in a browser without the Local Font Access API", async () => {
    localFamilies.value = null;
    localFamilies.supported = false;
    await renderPanel({ family: "Arial" });
    expect(screen.getByText(m["font_picker.local_fonts_unsupported"]())).toBeTruthy();
    expect(screen.queryByTestId("font-picker-grant-access")).toBeNull();
  });

  it("shows no permission note when the local list is available", async () => {
    await renderPanel({ family: "Arial" });
    expect(screen.queryByTestId("font-picker-permission-note")).toBeNull();
  });

  it("shows no permission note on the vector list", async () => {
    localFamilies.value = null;
    await renderPanel({ family: "" });
    expect(optionNames()).toEqual(["Roboto"]);
    expect(screen.queryByTestId("font-picker-permission-note")).toBeNull();
  });

  it("the info button explains both font types", async () => {
    await renderPanel({ family: "" });
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(screen.getByText(m["font_picker.info_vector"]())).toBeTruthy();
    expect(screen.getByText(m["font_picker.info_raster"]())).toBeTruthy();
  });
});

describe("FontButton", () => {
  async function renderButton(props: Partial<React.ComponentProps<typeof FontButton>> = {}) {
    const onChange = vi.fn();
    await act(async () => { render(<FontButton family="Arial" onChange={onChange} {...props} />); });
    return onChange;
  }

  it("shows the current font name, Roboto for the default family", async () => {
    await renderButton({ family: "" });
    expect(screen.getByTestId("font-button").textContent).toBe("Roboto");
  });

  it("opens the panel on click", async () => {
    await renderButton();
    expect(screen.queryByRole("listbox")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId("font-button")); });
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("with the default preview the live stream is the commit and Apply only closes", async () => {
    const onChange = await renderButton();
    await act(async () => { fireEvent.click(screen.getByTestId("font-button")); });
    fireEvent.click(screen.getByRole("option", { name: "Georgia" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("Georgia");
    fireEvent.click(screen.getByRole("button", { name: m["common.apply"]() }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("with the default preview Cancel restores the open-time font and calls onCancel", async () => {
    const onCancel = vi.fn();
    const onChange = await renderButton({ onCancel });
    await act(async () => { fireEvent.click(screen.getByTestId("font-button")); });
    fireEvent.click(screen.getByRole("option", { name: "Georgia" }));
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(onChange).toHaveBeenLastCalledWith("Arial");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("with a distinct preview channel Apply is the single onChange commit", async () => {
    const onPreview = vi.fn();
    const onChange = await renderButton({ onPreview });
    await act(async () => { fireEvent.click(screen.getByTestId("font-button")); });
    fireEvent.click(screen.getByRole("option", { name: "Georgia" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: m["common.apply"]() }));
    expect(onChange).toHaveBeenCalledWith("Georgia");
  });

  it("does not open while disabled", async () => {
    await renderButton({ disabled: true });
    fireEvent.click(screen.getByTestId("font-button"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
