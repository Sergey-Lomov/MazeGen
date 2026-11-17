import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingScreen } from "../components/LoadingScreen";

const bootScreenHtml = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

describe("LoadingScreen", () => {
  it("exposes a determinate progress bar to assistive technology", () => {
    render(<LoadingScreen status="Loading engine" progress={0.42} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading engine");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  });

  it("keeps an indeterminate progress bar without a numeric value", () => {
    render(<LoadingScreen status="Preparing graphics" />);

    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });

  it("uses the app background and fixed text metrics during the boot-screen handoff", () => {
    const { container } = render(<LoadingScreen status="Preparing label fonts" />);

    expect(container.firstElementChild).toHaveStyle({ background: "#111111" });
    expect(screen.getByText("Maze Studio")).toHaveStyle({ lineHeight: "18px" });
    expect(screen.getByRole("status")).toHaveStyle({ color: "#cccccc", lineHeight: "17px" });
  });

  it("keeps the HTML boot splash aligned with the React loading screen", () => {
    expect(bootScreenHtml).toContain("body { background: #111111");
    expect(bootScreenHtml).toContain("#boot-splash { height:100%; display:flex; align-items:center; justify-content:center; background:#111111; }");
    expect(bootScreenHtml).toContain(".boot-name { font-size:20px; font-weight:600; line-height:18px; margin-bottom:26px; }");
    expect(bootScreenHtml).toContain("#boot-status { min-height:17px; margin-bottom:9px; color:#ccc; font-size:14px; line-height:17px; }");
    expect(bootScreenHtml).toContain("#boot-progress-value { height:14px; margin-top:6px; color:#aaa; font-size:12px; letter-spacing:.3px; line-height:14px; }");
  });
});
