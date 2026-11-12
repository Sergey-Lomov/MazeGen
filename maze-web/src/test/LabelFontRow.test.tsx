import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { LabelFontRow } from "../components/features/LabelFontRow";
import { LinkContextProvider, type LinkContextValue } from "../components/features/LinkContext";
import * as m from "~/paraglide/messages";

// A browser font loads only when the test resolves its request, so the order of loads is under control.
// By default no family finishes loading: the machine lacks them all.
const fonts = vi.hoisted(() => ({
  pending: [] as Array<{ family: string; resolve: () => void }>,
  loaded: new Set<string>(),
}));

vi.mock("../pixi/renderers/labelFont", async (importActual) => ({
  ...(await importActual<typeof import("../pixi/renderers/labelFont")>()),
  isLocalFontAccessSupported: () => true,
  loadLocalFontFamilies: () => Promise.resolve(["Arial", "Consolas", "Fira Sans"]),
  isLabelFontLoaded: (font: { family: string }) => fonts.loaded.has(font.family),
  loadLabelFont: (font: { family: string }) => new Promise<boolean>((resolve) => {
    if (!font.family.trim()) resolve(true);
    else fonts.pending.push({ family: font.family, resolve: () => resolve(true) });
  }),
}));

beforeEach(() => { fonts.pending.length = 0; fonts.loaded.clear(); });

/** Resolve the load request of `family` that is still pending, as the browser finishing that font. */
async function finishLoading(family: string) {
  const request = fonts.pending.find((r) => r.family === family);
  if (!request) throw new Error(`no pending load for ${family}`);
  await act(async () => { request.resolve(); });
}

const linkContext = {
  links: [],
  registry: {},
  onSetLinkEnabled: vi.fn(),
  onAddLink: vi.fn(),
  activePaths: new Set<string>(),
  gate: () => true,
} as unknown as LinkContextValue<string>;

async function openPicker(value: { family: string; weight: number } | undefined, onChange = vi.fn()) {
  await act(async () => {
    render(
      <LinkContextProvider value={linkContext}>
        <LabelFontRow value={value} onChange={onChange} linkTarget={null} />
      </LinkContextProvider>,
    );
  });
  fireEvent.click(screen.getByTestId("font-button"));
  await act(async () => {});
  return onChange;
}

describe("LabelFontRow", () => {
  it("shows the default font when the setting has no value", async () => {
    await act(async () => {
      render(
        <LinkContextProvider value={linkContext}>
          <LabelFontRow value={undefined} onChange={vi.fn()} linkTarget={null} />
        </LinkContextProvider>,
      );
    });
    expect(screen.getByTestId("font-button").textContent).toBe("Roboto, Bold");
  });

  it("applies an already loaded font at once", async () => {
    fonts.loaded.add("Arial");
    const onChange = await openPicker({ family: "Fira Sans", weight: 400 });
    fireEvent.click(screen.getByRole("option", { name: "Arial" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ family: "Arial" }));
  });

  it("applies a font that still has to load once it has loaded", async () => {
    const onChange = await openPicker({ family: "Fira Sans", weight: 400 });
    fireEvent.click(screen.getByRole("option", { name: "Arial" }));
    expect(onChange).not.toHaveBeenCalled();
    await finishLoading("Arial");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ family: "Arial" }));
  });

  it("drops a slow load that finishes after a newer pick, whichever order they finish in", async () => {
    const onChange = await openPicker({ family: "Fira Sans", weight: 400 });
    fireEvent.click(screen.getByRole("option", { name: "Arial" }));
    fireEvent.click(screen.getByRole("option", { name: "Consolas" }));
    // The newer pick finishes first, the older one afterwards: the older one must not overwrite it.
    await finishLoading("Consolas");
    await finishLoading("Arial");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ family: "Consolas" }));
  });

  it("drops an older load that finishes before the newer one", async () => {
    const onChange = await openPicker({ family: "Fira Sans", weight: 400 });
    fireEvent.click(screen.getByRole("option", { name: "Arial" }));
    fireEvent.click(screen.getByRole("option", { name: "Consolas" }));
    await finishLoading("Arial");
    expect(onChange).not.toHaveBeenCalled();
    await finishLoading("Consolas");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ family: "Consolas" }));
  });

  it("drops a pending load once Cancel has restored the open-time font", async () => {
    const onChange = await openPicker({ family: "Fira Sans", weight: 400 });
    fireEvent.click(screen.getByRole("option", { name: "Arial" }));
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(onChange).toHaveBeenCalledTimes(1);
    await finishLoading("Arial");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ family: "Fira Sans", weight: 400 });
  });

  it("Cancel restores a family that is not loaded on this machine at once", async () => {
    const onChange = vi.fn();
    await act(async () => {
      render(
        <LinkContextProvider value={linkContext}>
          <LabelFontRow value={{ family: "Fira Sans", weight: 400 }} onChange={onChange} linkTarget={null} />
        </LinkContextProvider>,
      );
    });
    fireEvent.click(screen.getByTestId("font-button"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("option", { name: "Arial" }));
    // Arial never loads, so the preview itself is not applied.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ family: "Fira Sans", weight: 400 });
  });
});
