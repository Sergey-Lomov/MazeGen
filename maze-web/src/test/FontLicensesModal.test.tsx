import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { FontLicensesModal } from "../components/FontLicensesModal";
import { FONT_NOTICES, LICENSE_TEXT_URLS } from "../components/fontLicenses";
import * as m from "~/paraglide/messages";

afterEach(() => vi.unstubAllGlobals());

async function openModal(fetchImpl: (url: string) => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  await act(async () => { render(<FontLicensesModal onClose={vi.fn()} />); });
}

describe("FontLicensesModal", () => {
  it("lists every bundled font with its copyright line and shows the fetched license texts", async () => {
    await openModal((url) => Promise.resolve({ ok: true, text: () => Promise.resolve(`text of ${url}`) }));
    for (const notice of FONT_NOTICES) {
      expect(screen.getByTestId(`font-license-${notice.id}`).textContent).toContain(notice.copyright);
    }
    expect(screen.getByTestId("license-text-ofl-1.1").textContent).toBe(`text of ${LICENSE_TEXT_URLS["ofl-1.1"]}`);
    expect(screen.getByTestId("license-text-apache-2.0").textContent).toBe(`text of ${LICENSE_TEXT_URLS["apache-2.0"]}`);
  });

  it("keeps the notices and reports a license text that could not be loaded", async () => {
    await openModal((url) => url === LICENSE_TEXT_URLS["ofl-1.1"] ? Promise.reject(new Error("offline")) : Promise.resolve({ ok: false }));
    expect(screen.getAllByText(m["font_licenses.load_failed"]())).toHaveLength(2);
    expect(screen.getByTestId("font-licenses-list").children).toHaveLength(FONT_NOTICES.length);
  });
});
