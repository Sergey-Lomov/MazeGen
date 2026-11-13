import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { FontLicensesModal } from "../components/FontLicensesModal";
import { FONT_NOTICES, LICENSE_TEXT_URLS, findFontNotice } from "../components/fontLicenses";
import * as m from "~/paraglide/messages";

afterEach(() => vi.unstubAllGlobals());

async function openModal(family: string, fetchImpl: (url: string) => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const notice = findFontNotice(family)!;
  await act(async () => { render(<FontLicensesModal notice={notice} onClose={vi.fn()} />); });
  return notice;
}

describe("FontLicensesModal", () => {
  it("shows the font's name, copyright line, license, source and the fetched full license text", async () => {
    const notice = await openModal("msdf:fira-sans", (url) => Promise.resolve({ ok: true, text: () => Promise.resolve(`text of ${url}`) }));
    expect(screen.getByText(notice.name)).toBeTruthy();
    expect(screen.getByTestId(`font-license-${notice.id}`).textContent).toContain(notice.copyright);
    expect(screen.getByText(m["font_licenses.license_ofl"](), { selector: "div" })).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(notice.source);
    expect(screen.getByTestId("license-text").textContent).toBe(`text of ${LICENSE_TEXT_URLS["ofl-1.1"]}`);
  });

  it("fetches only the license of this font", async () => {
    await openModal("", (url) => Promise.resolve({ ok: true, text: () => Promise.resolve(url) }));
    expect(screen.getByTestId("license-text").textContent).toBe(LICENSE_TEXT_URLS["apache-2.0"]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("keeps the notice and reports a license text that could not be loaded", async () => {
    const notice = await openModal("msdf:arimo", () => Promise.reject(new Error("offline")));
    expect(screen.getByText(m["font_licenses.load_failed"]())).toBeTruthy();
    expect(screen.getByTestId(`font-license-${notice.id}`).textContent).toContain(notice.copyright);
  });

  it("finds a notice for every bundled font and none for a browser font", () => {
    expect(FONT_NOTICES.length).toBeGreaterThan(0);
    expect(findFontNotice("Arial")).toBeUndefined();
    expect(findFontNotice("roboto")).toBeUndefined();
  });
});
