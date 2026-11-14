import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as m from "~/paraglide/messages";
import { PngOverflowWarningBubble, PngFitWarningBubble } from "../components/features/PngOverflowWarningBubble";

describe("PngOverflowWarningBubble", () => {
  it("shows the bubble message but not the modal description until clicked", () => {
    render(<PngOverflowWarningBubble id="png_content_overflows_canvas" percent={150} />);
    const message = m["image_export.format.png.warning_overflows_canvas"]({ percent: "150" });
    expect(screen.getByText(message)).toBeInTheDocument();
    const description = m["image_export.format.png.warning_overflows_canvas_description"]({ percent: "150" });
    expect(screen.queryByText(description)).not.toBeInTheDocument();
  });

  it("opens a Modal with the warning's description on click", () => {
    render(<PngOverflowWarningBubble id="png_content_overflows_canvas" percent={150} />);
    const message = m["image_export.format.png.warning_overflows_canvas"]({ percent: "150" });
    fireEvent.click(screen.getByText(message));
    const description = m["image_export.format.png.warning_overflows_canvas_description"]({ percent: "150" });
    expect(screen.getByText(description)).toBeInTheDocument();
  });
});

describe("PngFitWarningBubble", () => {
  it("shows the plain yes/no message with no percent, and opens its own description on click", () => {
    render(<PngFitWarningBubble id="png_content_clips_sheet" />);
    const message = m["image_export.format.png.warning_clips_sheet"]();
    expect(screen.getByText(message)).toBeInTheDocument();
    fireEvent.click(screen.getByText(message));
    const description = m["image_export.format.png.warning_clips_sheet_description"]();
    expect(screen.getByText(description)).toBeInTheDocument();
  });

  it("renders the margin-zone variant's own distinct message", () => {
    render(<PngFitWarningBubble id="png_content_in_margin_zone" />);
    const message = m["image_export.format.png.warning_in_margin_zone"]();
    expect(screen.getByText(message)).toBeInTheDocument();
  });
});
