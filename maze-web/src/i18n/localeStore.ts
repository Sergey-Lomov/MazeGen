import {
  setLocale as paraglideSetLocale,
  getLocale,
  locales,
  baseLocale,
} from "~/paraglide/runtime";

export type Locale = (typeof locales)[number];

const STORAGE_KEY = "locale";
export const DEFAULT_LOCALE: Locale = baseLocale as Locale;

function isValidLocale(tag: string): tag is Locale {
  return (locales as readonly string[]).includes(tag);
}

function loadSaved(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved && isValidLocale(saved) ? saved : DEFAULT_LOCALE;
}

function persist(locale: Locale): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEY, locale);
  }
}

const subscribers = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify(): void {
  subscribers.forEach((fn) => fn());
}

export function getSnapshot(): Locale {
  return getLocale() as Locale;
}

export function setLocale(locale: Locale): void {
  paraglideSetLocale(locale, { reload: false });
  persist(locale);
  notify();
}

export function initLocale(): void {
  // Call paraglide directly — no notify needed, React not mounted yet
  paraglideSetLocale(loadSaved(), { reload: false });
}

export { locales };
