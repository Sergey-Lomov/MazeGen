/** Code registry for the toast channel (GitHub issue #767, epic #766).
 *
 * Every `notify()` code is registered once by the integration that emits it: its category, a
 * paraglide message function of the call's `params`, and — for `notice` codes — `dedupParams`, the
 * param names that are part of the dedup key. Text is never stored; it is rebuilt from
 * `code + params` at render time, so a language switch re-translates visible toasts in place. */

export type NotificationCategory = "notice" | "error";

export type NotificationParamValue = string | number | boolean | null;
export type NotificationParams = Readonly<Record<string, NotificationParamValue>>;

export interface NotificationCodeDef {
  category: NotificationCategory;
  /** Paraglide message function of the call's `params` — called at render time. */
  message: (params: NotificationParams) => string;
  /** `notice` only: params that are part of the dedup key. Defaults to none — the key is then
   *  `source + code` and a repeat replaces the visible params in place. Ignored for `error`,
   *  which always aggregates by `source + code`. */
  dedupParams?: readonly string[];
}

const registry = new Map<string, NotificationCodeDef>();

/** Registers `code`. Re-registering an existing code replaces its definition (keeps HMR and test
 *  setups idempotent). */
export function registerNotificationCode(code: string, def: NotificationCodeDef): void {
  registry.set(code, def);
}

export function getNotificationCode(code: string): NotificationCodeDef | undefined {
  return registry.get(code);
}

/** Message text of `code` for `params` in the current locale; the raw code when unregistered. */
export function notificationMessage(code: string, params: NotificationParams): string {
  return registry.get(code)?.message(params) ?? code;
}

/** Deterministic JSON serialization with object keys sorted at every level. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Dedup key: `source + code` plus the stable serialization of the selected params. Missing
 *  selected params serialize as absent, so they never collide with an explicit `null`. */
export function notificationKey(
  source: string,
  code: string,
  params: NotificationParams = {},
  dedupParams: readonly string[] = [],
): string {
  const selected: Record<string, NotificationParamValue> = {};
  for (const name of dedupParams) {
    if (Object.prototype.hasOwnProperty.call(params, name)) selected[name] = params[name];
  }
  return stableStringify([source, code, selected]);
}
