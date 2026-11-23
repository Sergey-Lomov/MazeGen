import React, { useEffect, useRef, useState } from "react";
import { Check, Languages } from "lucide-react";
import { FlatIconButton } from "./FlatIconButton";
import { useLocale } from "../i18n/useLocale";
import type { Locale } from "../i18n/useLocale";
import { claimEscape, escapePriority } from "../keyboard/escapeResponder";
import { ui, radius, typography, shadow } from "../styles/theme";
import * as m from "~/paraglide/messages";

/** Native language names are never translated: a user must recognise their own language in any UI locale. */
const NATIVE_NAMES: Record<Locale, string> = {
  en: "English",
  ru: "Русский",
};

export function LanguageSwitcher() {
  const { locale, setLocale, availableLocales } = useLocale();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) rootRef.current?.querySelector("button")?.focus();
  }

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    // Joins the shared Escape order so one press closes only the menu, not the panel or dialog below it.
    const releaseEscape = claimEscape(() => {
      close(true);
      return true;
    }, escapePriority.transient);
    const items = menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]");
    (menuRef.current?.querySelector<HTMLElement>("[aria-checked=true]") ?? items?.[0])?.focus();
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      releaseEscape();
    };
  }, [open]);

  function handleMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  }

  return (
    <div ref={rootRef} style={styles.root}>
      <FlatIconButton
        title={m["language.tooltip"]({ language: NATIVE_NAMES[locale] })}
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Languages size={16} />
      </FlatIconButton>
      {open && (
        <div ref={menuRef} role="menu" aria-label={m["language.title"]()} style={styles.menu} onKeyDown={handleMenuKeyDown}>
          {availableLocales.map((lang) => (
            <button
              key={lang}
              type="button"
              role="menuitemradio"
              aria-checked={lang === locale}
              className="hoverable"
              style={{ ...styles.item, ...(lang === locale ? styles.itemCurrent : {}) }}
              onClick={() => {
                setLocale(lang);
                close(true);
              }}
            >
              <span style={styles.check}>{lang === locale && <Check size={14} />}</span>
              {NATIVE_NAMES[lang]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { position: "relative", display: "flex", alignItems: "center" },
  menu: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    marginBottom: 4,
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 120,
    background: ui.bg.panel,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.sm,
    boxShadow: shadow.modal,
    padding: 4,
  },
  item: {
    ...typography.body,
    display: "flex",
    alignItems: "center",
    gap: 6,
    cursor: "default",
    padding: "2px 4px",
    borderRadius: 3,
    whiteSpace: "nowrap",
    background: "transparent",
    border: "none",
    color: ui.text.primary,
    textAlign: "left",
  },
  itemCurrent: { background: ui.state.selected },
  check: { display: "inline-flex", width: 14, flexShrink: 0 },
};
