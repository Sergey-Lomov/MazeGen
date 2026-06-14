import { useSyncExternalStore } from "react";
import {
  subscribe,
  getSnapshot,
  setLocale,
  locales,
  DEFAULT_LOCALE,
  type Locale,
} from "./localeStore";

export function useLocale() {
  const locale = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_LOCALE,
  );
  return { locale, setLocale, availableLocales: locales };
}

export type { Locale };
