import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { FontPickerPanel } from "../components/FontPickerPanel";
import { FontButton } from "../components/FontButton";
import { useMazeStore } from "../store/mazeStore";
import { MSDF_FONTS } from "../pixi/renderers/fontChoice";
import * as m from "~/paraglide/messages";

const localFamilies = vi.hoisted(() => ({
  value: ["Arial", "Consolas", "Georgia"] as string[] | null,
  supported: true,
  retryValue: null as string[] | null,
  // Weights per browser family; a family not listed offers only regular.
  weights: {} as Record<string, number[]>,
}));

vi.mock("../pixi/renderers/labelFont", async (importActual) => ({
  ...(await importActual<typeof import("../pixi/renderers/labelFont")>()),
  isLocalFontAccessSupported: () => localFamilies.supported,
  rasterFontWeights: (family: string) => localFamilies.weights[family] ?? [400],
  loadLocalFontFamilies: (retry?: boolean) => Promise.resolve(retry ? localFamilies.retryValue : localFamilies.value),
}));

// The export warning pass is covered by its own tests; here it is a list the panel has to filter and show.
const exportWarnings = vi.hoisted(() => ({ value: [] as { id: string; key: string; nodes: number[]; edges: never[] }[] }));
vi.mock("../pixi/selectors/activeModeWarnings", () => ({ computeActiveModeTextOverflowWarnings: () => exportWarnings.value }));

// A real pixi canvas needs WebGL, which jsdom lacks. The stand-in reports itself unavailable on demand.
const msdfPreview = vi.hoisted(() => ({ unavailable: false }));
vi.mock("../components/MsdfFontPreview", () => ({
  MsdfFontPreview: ({ onUnavailable, testId }: { onUnavailable?: () => void; testId?: string }) => {
    if (msdfPreview.unavailable) queueMicrotask(() => onUnavailable?.());
    return <div data-testid={testId} />;
  },
}));

afterEach(() => { vi.useRealTimers(); msdfPreview.unavailable = false; });

beforeEach(() => { localFamilies.value = ["Arial", "Consolas", "Georgia"]; localFamilies.supported = true; localFamilies.retryValue = null; localFamilies.weights = {}; });

async function renderPanel(props: Partial<React.ComponentProps<typeof FontPickerPanel>> = {}) {
  const handlers = { onApply: vi.fn(), onClose: vi.fn(), onPreview: vi.fn(), onCancel: vi.fn() };
  await act(async () => { render(<FontPickerPanel font={{ family: "", weight: 400 }} {...handlers} {...props} />); });
  return handlers;
}

const listOptions = () => within(screen.getByRole("listbox")).queryAllByRole("option");
// A row's label is its first child; the rest are badges and the copyright icon.
const labelOf = (o: HTMLElement) => o.firstElementChild!.textContent;
const optionNames = () => listOptions().map(labelOf);
const option = (name: string) => listOptions().find((o) => labelOf(o) === name)!;
const selectedName = () => { const o = listOptions().find((o) => o.getAttribute("aria-selected") === "true"); return o && labelOf(o); };
const weightSelect = () => screen.getByTestId("font-picker-weight") as HTMLSelectElement;
const weightOptions = () => [...weightSelect().options].map((o) => o.value);
const pickWeight = (weight: number) => fireEvent.change(weightSelect(), { target: { value: String(weight) } });
const filter = (name: "msdf" | "vec" | "used" | "locale") => screen.getByTestId(`font-picker-filter-${name}`);
const search = (text: string) => fireEvent.change(screen.getByTestId("font-picker-search"), { target: { value: text } });

const MSDF_LABELS = Object.values(MSDF_FONTS).map((font) => font.label);
// The list holds the bundled fonts first, then the browser ones.
const browserNames = () => optionNames().slice(MSDF_LABELS.length);

describe("FontPickerPanel text warnings (GitHub issue #971)", () => {
  const overflow = (id: string) => ({ id, key: id, nodes: [], edges: [] as never[] });
  const sectionTitle = (count: number) => m["image_export.vector_by_walls.section_warnings"]({ count: String(count) });

  beforeEach(() => {
    useMazeStore.setState({ openRenderModeSettings: "vector_by_walls", activeFieldConfig: {} as never });
    exportWarnings.value = [overflow("marker_text_overflow"), overflow("elevator_badge_text_overflow")];
  });
  afterEach(() => { useMazeStore.setState({ openRenderModeSettings: null, activeFieldConfig: undefined }); exportWarnings.value = []; });

  it("shows no section when the call site names no text kinds", async () => {
    await renderPanel();
    expect(screen.queryByTestId("font-picker-export-warnings")).toBeNull();
  });

  it("shows no section without an open export settings panel", async () => {
    useMazeStore.setState({ openRenderModeSettings: null });
    await renderPanel({ warningKinds: ["start"] });
    expect(screen.queryByTestId("font-picker-export-warnings")).toBeNull();
  });

  it("lists only the overflow warnings of the kinds the font drives, collapsed until opened", async () => {
    await renderPanel({ warningKinds: ["start", "finish"] });
    expect(screen.queryByText(m["image_export.vector_by_walls.warning_marker_text_overflow"]())).toBeNull();
    fireEvent.click(screen.getByText(sectionTitle(1)));
    expect(screen.getByText(m["image_export.vector_by_walls.warning_marker_text_overflow"]())).toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.warning_elevator_badge_text_overflow"]())).toBeNull();
  });

  it("keeps the section visible with a zero count and an empty note", async () => {
    exportWarnings.value = [];
    await renderPanel({ warningKinds: ["markerIndex"] });
    fireEvent.click(screen.getByText(sectionTitle(0)));
    expect(screen.getByText(m["picker.no_export_warnings"]())).toBeInTheDocument();
  });
});

describe("FontPickerPanel weight (GitHub issue #973)", () => {
  it("offers the baked weights for the MSDF font", async () => {
    await renderPanel({ font: { family: "", weight: 700 } });
    expect(weightOptions()).toEqual(["400", "700"]);
  });

  it("offers only the weights the highlighted browser family has", async () => {
    localFamilies.weights = { Arial: [300, 400, 700], Georgia: [400] };
    await renderPanel({ font: { family: "Arial", weight: 400 } });
    expect(weightOptions()).toEqual(["300", "400", "700"]);
    fireEvent.click(option("Georgia"));
    expect(weightOptions()).toEqual(["400"]);
  });

  it("explains a locked weight row through a tooltip on the whole row, and shows none when a choice exists", async () => {
    localFamilies.weights = { Georgia: [400], Arial: [400, 700] };
    await renderPanel({ font: { family: "Georgia", weight: 400 } });
    const hint = m["font_picker.weight_single_hint"]();
    expect(weightSelect().disabled).toBe(true);
    const row = weightSelect().closest("[aria-describedby]") as HTMLElement;
    expect(row).toBeTruthy();
    expect(document.getElementById(row.getAttribute("aria-describedby")!)?.textContent).toBe(hint);
    expect(row.contains(screen.getByText(m["font_picker.section_weight"]()))).toBe(true);
    fireEvent.click(option("Arial"));
    expect(screen.queryByText(hint)).toBeNull();
    expect(weightSelect().closest("[aria-describedby]")).toBeNull();
    expect(weightSelect().disabled).toBe(false);
  });

  it("shows the open-time weight even when the family does not offer it", async () => {
    localFamilies.weights = { Georgia: [400] };
    await renderPanel({ font: { family: "Georgia", weight: 700 } });
    expect(weightOptions()).toEqual(["400", "700"]);
    expect(weightSelect().value).toBe("700");
  });

  it("places the weight select below the family list", async () => {
    await renderPanel();
    const list = screen.getByRole("listbox");
    expect(list.compareDocumentPosition(weightSelect()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("previews and applies the family and the picked weight together", async () => {
    localFamilies.weights = { Arial: [300, 400, 700] };
    const handlers = await renderPanel({ font: { family: "Arial", weight: 400 } });
    pickWeight(700);
    expect(handlers.onPreview).toHaveBeenLastCalledWith({ family: "Arial", weight: 700 });
    expect(screen.getByTestId("font-picker-preview-line").style.fontWeight).toBe("700");
    fireEvent.click(screen.getByRole("button", { name: m["common.apply"]() }));
    expect(handlers.onApply).toHaveBeenCalledWith({ family: "Arial", weight: 700 });
  });

  it("keeps the weight when the new family has it and snaps to the nearest one otherwise", async () => {
    localFamilies.weights = { Arial: [300, 400, 700], Consolas: [400, 700], Georgia: [400] };
    const handlers = await renderPanel({ font: { family: "Arial", weight: 700 } });
    fireEvent.click(option("Consolas"));
    expect(handlers.onPreview).toHaveBeenLastCalledWith({ family: "Consolas", weight: 700 });
    fireEvent.click(option("Georgia"));
    expect(handlers.onPreview).toHaveBeenLastCalledWith({ family: "Georgia", weight: 400 });
  });

  it("restores the open-time family and weight on Cancel", async () => {
    localFamilies.weights = { Arial: [300, 400, 700] };
    const handlers = await renderPanel({ font: { family: "Arial", weight: 300 } });
    pickWeight(700);
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(handlers.onPreview).toHaveBeenLastCalledWith({ family: "Arial", weight: 300 });
  });
});

describe("FontPickerPanel", () => {
  it("previews the phrase, starting with Lorem ipsum, in the highlighted font at a fixed 32 px", async () => {
    await renderPanel({ font: { family: "Consolas", weight: 400 } });
    const input = screen.getByTestId("font-picker-preview-input") as HTMLInputElement;
    expect(input.value).toBe("Lorem ipsum");
    fireEvent.change(input, { target: { value: "Hello" } });
    const line = screen.getByTestId("font-picker-preview-line");
    expect(line.textContent).toBe("Hello");
    expect(line.style.fontSize).toBe("32px");
    expect(line.style.fontFamily).toContain("Consolas");
    fireEvent.click(option("Georgia"));
    expect(line.style.fontFamily).toContain("Georgia");
  });

  it("draws the MSDF font on a pixi canvas and TTF/OTF fonts as DOM text", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    expect(screen.getByTestId("font-picker-preview-msdf")).toBeTruthy();
    expect(screen.queryByTestId("font-picker-preview-line")).toBeNull();
    fireEvent.click(option("Georgia"));
    expect(screen.queryByTestId("font-picker-preview-msdf")).toBeNull();
    expect(screen.getByTestId("font-picker-preview-line")).toBeTruthy();
  });

  it("falls back to DOM text for the MSDF font when the canvas is unavailable", async () => {
    msdfPreview.unavailable = true;
    await renderPanel({ font: { family: "", weight: 400 } });
    await act(async () => {});
    expect(screen.getByTestId("font-picker-preview-line").style.fontFamily).toContain("Roboto");
  });

  it("offers text and background color rows for the preview", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    expect(screen.getByText(m["font_picker.preview_text_color"]())).toBeTruthy();
    expect(screen.getByText(m["font_picker.preview_background_color"]())).toBeTruthy();
  });

  it("holds every bundled font and every local font in one list, Roboto highlighted, for the default family", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    expect(optionNames()).toEqual([...MSDF_LABELS, "Arial", "Consolas", "Georgia"]);
    expect(selectedName()).toBe("Roboto");
  });

  it("highlights the current browser font in the same list", async () => {
    await renderPanel({ font: { family: "Consolas", weight: 400 } });
    expect(browserNames()).toEqual(["Arial", "Consolas", "Georgia"]);
    expect(selectedName()).toBe("Consolas");
  });

  it("keeps a saved family the machine does not report in the list", async () => {
    await renderPanel({ font: { family: "Missing Sans", weight: 400 } });
    expect(browserNames()).toEqual(["Missing Sans", "Arial", "Consolas", "Georgia"]);
    expect(selectedName()).toBe("Missing Sans");
  });

  it("previews a font on click without committing", async () => {
    const { onPreview, onApply } = await renderPanel({ font: { family: "Arial", weight: 400 } });
    fireEvent.click(option("Georgia"));
    expect(onPreview).toHaveBeenLastCalledWith({ family: "Georgia", weight: 400 });
    expect(selectedName()).toBe("Georgia");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("moves the selection with the arrow keys and clamps at both ends", async () => {
    const { onPreview } = await renderPanel({ font: { family: "", weight: 400 } });
    const list = screen.getByRole("listbox");
    vi.useFakeTimers();
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(selectedName()).toBe("Roboto");
    act(() => { vi.advanceTimersByTime(500); });
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedName()).toBe(MSDF_LABELS[1]);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onPreview).toHaveBeenLastCalledWith({ family: "msdf:noto-sans", weight: 400 });
    fireEvent.click(option("Georgia"));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedName()).toBe("Georgia");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(selectedName()).toBe("Consolas");
  });

  it("coalesces a held arrow key into one canvas preview after the moves pause", async () => {
    localFamilies.value = Array.from({ length: 40 }, (_, i) => `Font ${String(i).padStart(2, "0")}`);
    const { onPreview } = await renderPanel({ font: { family: "Font 00", weight: 400 } });
    const list = screen.getByRole("listbox");
    vi.useFakeTimers();
    for (let i = 0; i < 20; i++) fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedName()).toBe("Font 20");
    expect(onPreview).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(500); });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenLastCalledWith({ family: "Font 20", weight: 400 });
  });

  it("Apply delivers a still queued keyboard preview before committing", async () => {
    const { onPreview, onApply } = await renderPanel({ font: { family: "Arial", weight: 400 } });
    vi.useFakeTimers();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: m["common.apply"]() }));
    expect(onPreview).toHaveBeenLastCalledWith({ family: "Consolas", weight: 400 });
    expect(onApply).toHaveBeenCalledWith({ family: "Consolas", weight: 400 });
  });

  it("Cancel drops a queued keyboard preview and restores the open-time family", async () => {
    const { onPreview } = await renderPanel({ font: { family: "Arial", weight: 400 } });
    vi.useFakeTimers();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    act(() => { vi.advanceTimersByTime(500); });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenLastCalledWith({ family: "Arial", weight: 400 });
  });

  it("Apply commits the highlighted family", async () => {
    const { onApply } = await renderPanel({ font: { family: "Arial", weight: 400 } });
    fireEvent.click(option("Georgia"));
    fireEvent.click(screen.getByRole("button", { name: m["common.apply"]() }));
    expect(onApply).toHaveBeenCalledWith({ family: "Georgia", weight: 400 });
  });

  it("Cancel restores the open-time family through the preview and notifies the call site", async () => {
    const { onPreview, onCancel, onClose, onApply } = await renderPanel({ font: { family: "Arial", weight: 400 } });
    fireEvent.click(option("Georgia"));
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(onPreview).toHaveBeenLastCalledWith({ family: "Arial", weight: 400 });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("Escape cancels like the Cancel button", async () => {
    const { onPreview, onClose } = await renderPanel({ font: { family: "Arial", weight: 400 } });
    fireEvent.click(option("Georgia"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(onPreview).toHaveBeenLastCalledWith({ family: "Arial", weight: 400 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([["denied or unsupported", null], ["an empty answer", []]])("lists no installed fonts, only a permission note and the saved family, on %s", async (_name, answer) => {
    localFamilies.value = answer as string[] | null;
    await renderPanel({ font: { family: "Arial", weight: 400 } });
    // Without the machine's list no installed font has a readable file; the saved choice stays listed.
    expect(browserNames()).toEqual(["Arial"]);
    expect(selectedName()).toBe("Arial");
    expect(screen.getByTestId("font-picker-permission-note").textContent).toContain(m["font_picker.local_fonts_permission"]());
  });

  it("points aria-activedescendant at the highlighted option", async () => {
    await renderPanel({ font: { family: "Consolas", weight: 400 } });
    const active = screen.getByRole("listbox").getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(labelOf(document.getElementById(active!)!)).toBe("Consolas");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(labelOf(document.getElementById(screen.getByRole("listbox").getAttribute("aria-activedescendant")!)!)).toBe("Georgia");
  });

  it("offers a grant button that loads the full list once access is given", async () => {
    localFamilies.value = null;
    localFamilies.retryValue = ["Arial", "Fira Code"];
    await renderPanel({ font: { family: "Arial", weight: 400 } });
    expect(screen.getByText(m["font_picker.local_fonts_permission"]())).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId("font-picker-grant-access")); });
    expect(browserNames()).toEqual(["Arial", "Fira Code"]);
    expect(screen.queryByTestId("font-picker-permission-note")).toBeNull();
  });

  it("explains how to unblock access when the grant attempt still gives no list", async () => {
    localFamilies.value = null;
    await renderPanel({ font: { family: "Arial", weight: 400 } });
    await act(async () => { fireEvent.click(screen.getByTestId("font-picker-grant-access")); });
    expect(browserNames()).toEqual(["Arial"]);
    expect(screen.getByText(m["font_picker.local_fonts_blocked"]())).toBeTruthy();
    expect(screen.queryByTestId("font-picker-grant-access")).toBeNull();
  });

  it("offers no grant button in a browser without the Local Font Access API", async () => {
    localFamilies.value = null;
    localFamilies.supported = false;
    await renderPanel({ font: { family: "Arial", weight: 400 } });
    expect(screen.getByText(m["font_picker.local_fonts_unsupported"]())).toBeTruthy();
    expect(screen.queryByTestId("font-picker-grant-access")).toBeNull();
  });

  it("shows no permission note when the local list is available", async () => {
    await renderPanel({ font: { family: "Arial", weight: 400 } });
    expect(screen.queryByTestId("font-picker-permission-note")).toBeNull();
  });

  it("keeps the bundled fonts listed above the permission note while local fonts are unavailable", async () => {
    localFamilies.value = null;
    await renderPanel({ font: { family: "", weight: 400 } });
    expect(optionNames().slice(0, MSDF_LABELS.length)).toEqual(MSDF_LABELS);
    expect(screen.getByTestId("font-picker-permission-note")).toBeTruthy();
  });

  it("offers the MSDF conversion switch for a browser font, on by default, and none for a bundled one", async () => {
    await renderPanel({ font: { family: "Arial", weight: 400 } });
    const toggle = within(screen.getByTestId("font-picker-msdf-toggle")).getByRole("checkbox");
    expect((toggle as HTMLInputElement).checked).toBe(true);
    cleanup();
    await renderPanel({ font: { family: "", weight: 400 } });
    expect(screen.queryByTestId("font-picker-msdf-toggle")).toBeNull();
  });

  it("turning the switch off previews and applies the font with conversion disabled, and keeps it across a weight change", async () => {
    localFamilies.weights = { Arial: [400, 700] };
    const handlers = await renderPanel({ font: { family: "Arial", weight: 400 } });
    fireEvent.click(within(screen.getByTestId("font-picker-msdf-toggle")).getByRole("checkbox"));
    expect(handlers.onPreview).toHaveBeenLastCalledWith({ family: "Arial", weight: 400, msdf: false });
    pickWeight(700);
    expect(handlers.onPreview).toHaveBeenLastCalledWith({ family: "Arial", weight: 700, msdf: false });
    fireEvent.click(screen.getByRole("button", { name: m["common.apply"]() }));
    expect(handlers.onApply).toHaveBeenCalledWith({ family: "Arial", weight: 700, msdf: false });
  });

  it("drops a switched-off conversion when a bundled font is chosen, so no hidden flag lingers", async () => {
    const handlers = await renderPanel({ font: { family: "Arial", weight: 400, msdf: false } });
    fireEvent.click(option(MSDF_LABELS[0]));
    const last = handlers.onPreview.mock.calls.at(-1)![0];
    expect(last.msdf).toBeUndefined();
  });

  it("the switch's info explains the conversion and its artifacts", async () => {
    await renderPanel({ font: { family: "Arial", weight: 400 } });
    fireEvent.click(within(screen.getByTestId("font-picker-msdf-toggle")).getByRole("button", { name: "Info" }));
    expect(screen.getByText(m["font_picker.convert_to_msdf_info"]())).toBeTruthy();
  });

  it("the info button explains both font types", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(screen.getByText(m["font_picker.info_vector"]())).toBeTruthy();
    expect(screen.getByText(m["font_picker.info_raster"]())).toBeTruthy();
  });

  it("shows the format badge on every row", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    const formats = listOptions().map((o) => within(o).getByTestId("font-badge-format").textContent);
    expect(formats).toEqual([...MSDF_LABELS.map(() => m["font_picker.badge_msdf"]()), ...["Arial", "Consolas", "Georgia"].map(() => m["font_picker.badge_vec"]())]);
  });

  it("marks the fonts the project uses, as the panel opened, and not the ones merely browsed", async () => {
    const original = useMazeStore.getState().vectorByWallsSettings;
    useMazeStore.setState({ vectorByWallsSettings: { ...original, label: { family: "Consolas", weight: 400 } } as typeof original });
    try {
      await renderPanel({ font: { family: "Consolas", weight: 400 } });
      fireEvent.click(option("Georgia"));
      const used = listOptions().filter((o) => within(o).queryByTestId("font-badge-used")).map(labelOf);
      // The default Roboto is what the other text styles use.
      expect(used).toEqual(["Roboto", "Consolas"]);
    } finally {
      useMazeStore.setState({ vectorByWallsSettings: original });
    }
  });

  it("shows no locale badge or filter for English", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    expect(screen.queryByTestId("font-badge-locale")).toBeNull();
    expect(screen.queryByTestId("font-picker-filter-locale")).toBeNull();
  });

  it("searches fonts by name, ignoring case, and says so when nothing matches", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    search("noto");
    expect(optionNames()).toEqual(["Noto Sans", "Noto Sans Condensed", "Noto Serif"]);
    search("zzz");
    expect(optionNames()).toEqual([]);
    expect(screen.getByTestId("font-picker-empty")).toBeTruthy();
  });

  it("filters by one format at a time: picking one drops the other, picking it again shows both", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    const all = [...MSDF_LABELS, "Arial", "Consolas", "Georgia"];
    fireEvent.click(filter("msdf"));
    expect(optionNames()).toEqual(MSDF_LABELS);
    expect(filter("msdf").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(filter("vec"));
    expect(optionNames()).toEqual(["Arial", "Consolas", "Georgia"]);
    expect(filter("msdf").getAttribute("aria-pressed")).toBe("false");
    expect(filter("vec").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(filter("vec"));
    expect(optionNames()).toEqual(all);
    expect(filter("vec").getAttribute("aria-pressed")).toBe("false");
  });

  it("puts the indicators before the format bubble, which ends the row", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    const row = option("Roboto");
    const indicators = [...row.querySelectorAll('[data-testid="font-badge-used"], [role="button"], [data-testid="font-badge-format"]')];
    expect(indicators.map((el) => el.getAttribute("data-testid") ?? "copyright")).toEqual(["font-badge-used", "copyright", "font-badge-format"]);
  });

  it("centers the empty note in the list body", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    expect(screen.queryByTestId("font-picker-empty")).toBeNull();
    search("zzz");
    expect((screen.getByTestId("font-picker-empty").closest('[role="presentation"]') as HTMLElement).style.flex).toContain("1");
  });

  it("does not mention the local font permission while only the bundled fonts are shown", async () => {
    localFamilies.value = null;
    await renderPanel({ font: { family: "", weight: 400 } });
    expect(screen.getByTestId("font-picker-permission-note")).toBeTruthy();
    fireEvent.click(filter("msdf"));
    expect(screen.queryByTestId("font-picker-permission-note")).toBeNull();
  });

  it("filters to the fonts the project uses", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    fireEvent.click(filter("used"));
    expect(optionNames()).toEqual(["Roboto"]);
  });

  it("walks only the visible fonts with the arrow keys, and hands the keyboard from the search to the list", async () => {
    await renderPanel({ font: { family: "", weight: 400 } });
    search("noto");
    fireEvent.keyDown(screen.getByTestId("font-picker-search"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("listbox"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(selectedName()).toBe("Noto Sans");
  });

  describe("copyright icon", () => {
    const iconOf = (name: string) => within(option(name)).queryByRole("button", { name: m["font_licenses.button"]({ font: name }) });

    afterEach(() => vi.unstubAllGlobals());

    it("is in the row of every bundled font and in no browser font's row", async () => {
      await renderPanel({ font: { family: "", weight: 400 } });
      for (const label of MSDF_LABELS) expect(iconOf(label), label).not.toBeNull();
      for (const label of ["Arial", "Consolas", "Georgia"]) expect(iconOf(label), label).toBeNull();
      expect(screen.queryAllByRole("button", { name: /./ }).filter((b) => b.closest('[role="option"]'))).toHaveLength(MSDF_LABELS.length);
    });

    it("explains itself in a tooltip that is not a tab stop", async () => {
      await renderPanel({ font: { family: "", weight: 400 } });
      const icon = iconOf("Fira Sans")!;
      expect(icon.closest('[data-testid="tooltip-anchor"]')!.hasAttribute("tabindex")).toBe(false);
      fireEvent.focus(icon);
      expect(screen.getByTestId("tooltip").textContent).toBe(m["font_licenses.tooltip"]());
    });

    it("opens a dialog scoped to that font without selecting the row", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("license text") }));
      const { onPreview } = await renderPanel({ font: { family: "", weight: 400 } });
      await act(async () => { fireEvent.click(iconOf("Fira Sans")!); });
      expect(screen.getByTestId("font-license-fira-sans")).toBeTruthy();
      expect(screen.queryByTestId("font-license-roboto")).toBeNull();
      expect(screen.getByTestId("license-text").textContent).toBe("license text");
      expect(selectedName()).toBe("Roboto");
      expect(onPreview).not.toHaveBeenCalled();
    });

    it("is not a tab stop: the list keeps the keyboard, and \"I\" opens the highlighted font's notice", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("license") }));
      await renderPanel({ font: { family: "msdf:fira-sans", weight: 400 } });
      expect(iconOf("Fira Sans")!.getAttribute("tabindex")).toBe("-1");
      await act(async () => { fireEvent.keyDown(screen.getByRole("listbox"), { key: "i" }); });
      expect(screen.getByTestId("font-license-fira-sans")).toBeTruthy();
    });

    it("\"I\" does nothing on a browser font", async () => {
      await renderPanel({ font: { family: "Arial", weight: 400 } });
      fireEvent.keyDown(screen.getByRole("listbox"), { key: "i" });
      expect(screen.queryByTestId("license-text")).toBeNull();
    });

    it("the global licenses button in the Family header is gone", async () => {
      await renderPanel({ font: { family: "", weight: 400 } });
      const header = screen.getByText(m["font_picker.section_family"]()).parentElement!;
      expect(within(header).getAllByRole("button")).toHaveLength(1);
    });

    it("Escape in the dialog closes only the dialog, not the panel", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("license") }));
      const handlers = await renderPanel({ font: { family: "", weight: 400 } });
      await act(async () => { fireEvent.click(iconOf("Roboto")!); });
      await act(async () => { fireEvent.keyDown(screen.getByTestId("font-license-roboto"), { key: "Escape" }); });
      expect(screen.queryByTestId("font-license-roboto")).toBeNull();
      expect(handlers.onClose).not.toHaveBeenCalled();
      expect(handlers.onCancel).not.toHaveBeenCalled();
    });
  });
});

describe("FontButton", () => {
  async function renderButton(props: Partial<React.ComponentProps<typeof FontButton>> = {}) {
    const onChange = vi.fn();
    await act(async () => { render(<FontButton font={{ family: "Arial", weight: 400 }} onChange={onChange} {...props} />); });
    return onChange;
  }

  it("shows the current font name and weight, Roboto for the default family", async () => {
    await renderButton({ font: { family: "", weight: 400 } });
    expect(screen.getByTestId("font-button").textContent).toBe("Roboto, Regular");
  });

  it("names a browser font by its family and weight", async () => {
    await renderButton({ font: { family: "Arial", weight: 700 } });
    expect(screen.getByTestId("font-button").textContent).toBe("Arial, Bold");
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
    fireEvent.click(option("Georgia"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ family: "Georgia", weight: 400 });
    fireEvent.click(screen.getByRole("button", { name: m["common.apply"]() }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("with the default preview Cancel restores the open-time font and calls onCancel", async () => {
    const onCancel = vi.fn();
    const onChange = await renderButton({ onCancel });
    await act(async () => { fireEvent.click(screen.getByTestId("font-button")); });
    fireEvent.click(option("Georgia"));
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(onChange).toHaveBeenLastCalledWith({ family: "Arial", weight: 400 });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("with a distinct preview channel Apply is the single onChange commit", async () => {
    const onPreview = vi.fn();
    const onChange = await renderButton({ onPreview });
    await act(async () => { fireEvent.click(screen.getByTestId("font-button")); });
    fireEvent.click(option("Georgia"));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: m["common.apply"]() }));
    expect(onChange).toHaveBeenCalledWith({ family: "Georgia", weight: 400 });
  });

  it("does not open while disabled", async () => {
    await renderButton({ disabled: true });
    fireEvent.click(screen.getByTestId("font-button"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("FontPickerPanel preview session (GitHub issue #966)", () => {
  it("marks a picker open while it is mounted, so highlighted fonts are never converted", async () => {
    const { isFontPickerOpen } = await import("../pixi/renderers/rasterFont/pickerSession");
    expect(isFontPickerOpen()).toBe(false);
    const { unmount } = render(<FontPickerPanel font={{ family: "", weight: 400 }} onApply={vi.fn()} onClose={vi.fn()} onPreview={vi.fn()} />);
    expect(isFontPickerOpen()).toBe(true);
    unmount();
    expect(isFontPickerOpen()).toBe(false);
  });

  it("shows no conversion status for a highlighted raster font", async () => {
    await renderPanel({ font: { family: "Arial", weight: 400 } });
    expect(screen.queryByTestId("font-picker-font-note")).toBeNull();
  });
});
