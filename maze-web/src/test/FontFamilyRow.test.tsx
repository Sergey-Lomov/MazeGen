import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { FontFamilyRow } from "../components/features/FontFamilyRow";
import { LinkContextProvider, type LinkContextValue } from "../components/features/LinkContext";
import * as m from "~/paraglide/messages";

vi.mock("../pixi/renderers/labelFont", async (importActual) => ({
  ...(await importActual<typeof import("../pixi/renderers/labelFont")>()),
  isLocalFontAccessSupported: () => true,
  loadLocalFontFamilies: () => Promise.resolve(["Arial", "Fira Sans"]),
  // No family ever finishes loading: the machine lacks them all.
  isLabelFontFamilyLoaded: () => false,
  loadLabelFontFamily: (family: string) => new Promise<boolean>((resolve) => { if (!family.trim()) resolve(true); }),
}));

const linkContext = {
  links: [],
  registry: {},
  onSetLinkEnabled: vi.fn(),
  onAddLink: vi.fn(),
  activePaths: new Set<string>(),
  gate: () => true,
} as unknown as LinkContextValue<string>;

describe("FontFamilyRow", () => {
  it("Cancel restores a family that is not loaded on this machine at once", async () => {
    const onChange = vi.fn();
    await act(async () => {
      render(
        <LinkContextProvider value={linkContext}>
          <FontFamilyRow value="Fira Sans" onChange={onChange} linkTarget={null} />
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
    expect(onChange).toHaveBeenLastCalledWith("Fira Sans");
  });
});
