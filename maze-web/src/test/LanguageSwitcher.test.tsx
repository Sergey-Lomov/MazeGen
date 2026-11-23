import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimEscape, escapePriority } from "../keyboard/escapeResponder";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { setLocale } from "../i18n/localeStore";

describe("LanguageSwitcher", () => {
  beforeEach(() => act(() => setLocale("en")));
  afterEach(() => {
    cleanup();
    act(() => setLocale("en"));
  });

  it("shows the current language in the button name and hides the menu initially", () => {
    render(<LanguageSwitcher />);
    expect(screen.getByRole("button", { name: "Language: English" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("marks the current language and switches on pick", () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: "Language: English" }));
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Русский" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Язык: Русский" })).toBeTruthy();
  });

  it("closes on Escape without reaching a lower-priority responder, and returns focus", () => {
    const panelClose = vi.fn(() => true);
    const release = claimEscape(panelClose, escapePriority.panel);
    render(<LanguageSwitcher />);
    const button = screen.getByRole("button", { name: "Language: English" });
    fireEvent.click(button);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(panelClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panelClose).toHaveBeenCalledTimes(1);
    release();
  });

  it("closes on outside press", () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: "Language: English" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("focuses the current item on open and moves with arrows, wrapping", () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: "Language: English" }));
    const [en, ru] = screen.getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(en);
    fireEvent.keyDown(en, { key: "ArrowDown" });
    expect(document.activeElement).toBe(ru);
    fireEvent.keyDown(ru, { key: "ArrowDown" });
    expect(document.activeElement).toBe(en);
    fireEvent.keyDown(en, { key: "ArrowUp" });
    expect(document.activeElement).toBe(ru);
  });
});
