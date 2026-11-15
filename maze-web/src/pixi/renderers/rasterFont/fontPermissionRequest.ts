/** The "installed fonts needed" dialog state (GitHub issue #974). A project names fonts that are neither uploaded
 *  nor readable yet, and the Local Font Access permission has not been decided: the browser only shows its
 *  prompt from a user gesture, so the app asks the user first with a dialog whose button is that gesture. */

export type LocalFontPermission = "unsupported" | "granted" | "prompt" | "denied";

/** The Local Font Access permission without prompting. A browser that cannot tell is treated as `prompt`. */
export async function queryLocalFontPermission(supported: boolean): Promise<LocalFontPermission> {
  if (!supported) return "unsupported";
  try {
    const status = await navigator.permissions.query({ name: "local-fonts" as PermissionName });
    return status.state;
  } catch {
    return "prompt";
  }
}

export interface FontPermissionRequest {
  open: boolean;
  /** Families that wait for the permission. */
  families: readonly string[];
}

const CLOSED: FontPermissionRequest = { open: false, families: [] };
let request: FontPermissionRequest = CLOSED;
/** The missing families (joined) the user answered for; reset once none is missing. A different set is a new question. */
let answeredFor: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function getFontPermissionRequest(): FontPermissionRequest {
  return request;
}

export function subscribeFontPermissionRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const setKey = (families: readonly string[]) => families.join("\n");

export function hasFontPermissionBeenAnswered(families: readonly string[]): boolean {
  return answeredFor === setKey(families);
}

export function openFontPermissionRequest(families: readonly string[]): void {
  if (request.open && setKey(request.families) === setKey(families)) return;
  request = { open: true, families };
  emit();
}

/** Closes the dialog; `wasAnswered` marks that the user pressed a button, so it is not shown again for the same fonts. */
export function closeFontPermissionRequest(wasAnswered: boolean): void {
  if (wasAnswered && request.open) answeredFor = setKey(request.families);
  if (!request.open) return;
  request = CLOSED;
  emit();
}

/** A new set of missing fonts is a new question. */
export function resetFontPermissionAnswer(): void {
  answeredFor = null;
}
