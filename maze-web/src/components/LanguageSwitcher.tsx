import React from "react";
import { sharedStyles } from "../styles/shared";
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
    ...sharedStyles.select,
    cursor: "default",
    alignSelf: "stretch",
  },
};
