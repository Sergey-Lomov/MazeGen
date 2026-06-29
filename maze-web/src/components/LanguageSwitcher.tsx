import React from "react";
import { ui, font } from "../styles/theme";
import { useLocale } from "../i18n/useLocale";
import type { Locale } from "../i18n/useLocale";

export function LanguageSwitcher() {
  const { locale, setLocale, availableLocales } = useLocale();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      style={styles.select}
    >
      {availableLocales.map((lang) => (
        <option key={lang} value={lang}>{lang.toUpperCase()}</option>
      ))}
    </select>
  );
}

const styles: Record<string, React.CSSProperties> = {
  select: {
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    fontSize: font.sm,
    padding: "4px 6px",
    borderRadius: 3,
    cursor: "pointer",
    alignSelf: "stretch",
  },
};
