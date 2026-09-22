import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PostEditFeature } from "../components/features/PostEditFeature";

// Tool pictograms are drawn through a real pixi.js off-screen canvas (toolGlyphs.ts) — irrelevant
// to this test and unsupported in jsdom, so stub the glyph component out, same rationale as the
// renderer tests that mock pixi internals instead of exercising them under jsdom.
vi.mock("../components/features/ToolGlyph", () => ({ ToolGlyph: () => null }));

// GitHub issue #576: the auto-confirm/auto-compact toggles each get an info icon that opens an
// explanatory modal (AutoConfirmInfoModal/AutoCompactInfoModal), same convention as
// AnalyticsFeature's ScoreInfoModal/SidesInfoModal (see AnalyticsFeaturePath.test.tsx).
describe("PostEditFeature auto-confirm/auto-compact info icons", () => {
  it("opens AutoConfirmInfoModal on its info icon click", () => {
    render(<PostEditFeature />);

    const infoText = "Confirming is what makes post-edit changes take effect and become visible in other menus.";
    expect(screen.queryByText(infoText)).not.toBeInTheDocument();

    const label = screen.getByText("Auto-confirm");
    fireEvent.click(label.parentElement!.querySelector('[role="button"]')!);
    expect(screen.getByText(infoText)).toBeInTheDocument();
  });

  it("opens AutoCompactInfoModal on its info icon click", () => {
    render(<PostEditFeature />);

    const label = screen.getByText("Auto-compact");
    fireEvent.click(label.parentElement!.querySelector('[role="button"]')!);
    expect(screen.getByText(/Auto-compact shrinks the log after every edit/)).toBeInTheDocument();
  });
});
