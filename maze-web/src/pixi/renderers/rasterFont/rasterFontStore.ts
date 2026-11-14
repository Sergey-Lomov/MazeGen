import { CSS_FONT_WEIGHTS, weightFromStyleName } from "../fontChoice";
import { FontFileFailure, readBlobBytes, readFontInfo, toSfnt, type FontFileError } from "./sfnt";

/** Where the raster fonts come from, and what became of each (GitHub issue #966). A raster font is an
 *  installed font reported by the Local Font Access API or a file the user uploaded; its bytes feed the
 *  MSDF conversion (`rasterMsdf.ts`). Uploaded files are remembered in IndexedDB, never in the project. */

/** The slice of a Local Font Access `FontData` used here. */
export interface LocalFontFace {
  family: string;
  style?: string;
  blob(): Promise<Blob>;
}

// --- Change notification -------------------------------------------------------------------

const listeners = new Set<() => void>();
let version = 0;

/** Tells subscribers (the picker) something about the raster fonts changed. */
export function notifyRasterFontsChanged(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

/** `useSyncExternalStore` subscription. */
export function subscribeRasterFonts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Changes whenever an uploaded font or the local face list changes. */
export function rasterFontsVersion(): number {
  return version;
}

// --- Background work -------------------------------------------------------------------------

let busy = 0;
const busyListeners = new Set<() => void>();

/** Marks the start of an atlas conversion; pair with `endRasterWork`. Feeds the "preparing fonts" indicator. */
export function beginRasterWork(): void {
  busy++;
  for (const listener of [...busyListeners]) listener();
}

export function endRasterWork(): void {
  busy = Math.max(0, busy - 1);
  for (const listener of [...busyListeners]) listener();
}

export function subscribeRasterWork(listener: () => void): () => void {
  busyListeners.add(listener);
  return () => { busyListeners.delete(listener); };
}

/** Whether any atlas is being converted right now. */
export function isRasterWorkBusy(): boolean {
  return busy > 0;
}

// --- Installed fonts (Local Font Access API) -------------------------------------------------

/** Normal-style faces of each reported family, by weight. */
let localFaces = new Map<string, Map<number, LocalFontFace>>();

/** Remembers the faces the machine reported, so their bytes can be read when a family is picked. Italic,
 *  oblique and non-regular-width faces are skipped: a font value addresses a normal-style face. */
export function registerLocalFaces(faces: readonly LocalFontFace[]): void {
  const next = new Map<string, Map<number, LocalFontFace>>();
  for (const face of faces) {
    const family = face.family.trim();
    const weight = weightFromStyleName(face.style ?? "");
    if (!family || weight === null) continue;
    let byWeight = next.get(family);
    if (!byWeight) next.set(family, (byWeight = new Map()));
    if (!byWeight.has(weight)) byWeight.set(weight, face);
  }
  localFaces = next;
  notifyRasterFontsChanged();
}

// --- Uploaded fonts --------------------------------------------------------------------------

interface UploadedFace {
  family: string;
  weight: number;
  bytes: Uint8Array;
}

/** A cheap fingerprint of font bytes: length plus a hash of every 7th byte. */
function fingerprint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 7) hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
  return `${bytes.length}:${hash.toString(16)}`;
}

const uploaded = new Map<string, Map<number, UploadedFace>>();

const DB_NAME = "mazegen-fonts";
const DB_STORE = "faces";

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function dbWrite(run: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    run(transaction.objectStore(DB_STORE));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  db.close();
}

/** Browser faces of the uploaded fonts. The picker preview and the script coverage probes are drawn by the
 *  browser, so an uploaded font must be known to it too; the canvas labels use the MSDF atlas instead. */
const browserFaces = new Map<string, FontFace>();

function dropBrowserFace(family: string, weight: number): void {
  const key = `${weight}|${family}`;
  const old = browserFaces.get(key);
  if (old && typeof document !== "undefined") document.fonts?.delete(old);
  browserFaces.delete(key);
}

function installBrowserFace(face: UploadedFace): void {
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return;
  dropBrowserFace(face.family, face.weight);
  try {
    const browserFace = new FontFace(face.family, face.bytes.slice().buffer, { weight: String(face.weight) });
    document.fonts.add(browserFace);
    browserFaces.set(`${face.weight}|${face.family}`, browserFace);
    void browserFace.load().then(notifyRasterFontsChanged, () => {});
  } catch {
    // The preview then falls back to a generic font; the MSDF conversion does not depend on it.
  }
}

function remember(face: UploadedFace): void {
  let byWeight = uploaded.get(face.family);
  if (!byWeight) uploaded.set(face.family, (byWeight = new Map()));
  byWeight.set(face.weight, face);
  installBrowserFace(face);
}

let restored: Promise<void> | null = null;

/** Loads the fonts uploaded in earlier sessions from IndexedDB, once. */
export function restoreUploadedFonts(): Promise<void> {
  restored ??= (async () => {
    const db = await openDb();
    if (!db) return;
    const stored = await new Promise<UploadedFace[]>((resolve) => {
      const request = db.transaction(DB_STORE).objectStore(DB_STORE).getAll();
      request.onsuccess = () => resolve(request.result as UploadedFace[]);
      request.onerror = () => resolve([]);
    });
    db.close();
    for (const face of stored) if (!uploaded.get(face.family)?.has(face.weight)) remember(face);
    if (stored.length > 0) notifyRasterFontsChanged();
  })();
  return restored;
}

export type UploadResult =
  | { ok: true; family: string; weight: number }
  | { ok: false; reason: FontFileError };

/** Accepts a font file (TTF, OTF or WOFF): checks it parses, keeps it for the session and in IndexedDB. A
 *  face with the same family and weight is replaced. */
export async function addUploadedFont(file: Blob): Promise<UploadResult> {
  try {
    const sfnt = await toSfnt(await readBlobBytes(file));
    const info = readFontInfo(sfnt);
    if (!info) return { ok: false, reason: "corrupt" };
    // The Local Font Access API and the picker address normal-style faces only.
    if (info.italic) return { ok: false, reason: "unsupported-format" };
    const face: UploadedFace = { family: info.family, weight: info.weight, bytes: sfnt };
    remember(face);
    await dbWrite((store) => { store.put({ id: `${face.family}|${face.weight}`, ...face }); });
    notifyRasterFontsChanged();
    return { ok: true, family: face.family, weight: face.weight };
  } catch (error) {
    return { ok: false, reason: error instanceof FontFileFailure ? error.reason : "corrupt" };
  }
}

/** Forgets an uploaded family, in memory and in IndexedDB. */
export async function removeUploadedFont(family: string): Promise<void> {
  const faces = uploaded.get(family);
  if (!faces) return;
  uploaded.delete(family);
  for (const weight of faces.keys()) dropBrowserFace(family, weight);
  await dbWrite((store) => { for (const weight of faces.keys()) store.delete(`${family}|${weight}`); });
  notifyRasterFontsChanged();
}

/** Families the user uploaded, sorted. */
export function uploadedFamilies(): string[] {
  return [...uploaded.keys()].sort();
}

export function isUploadedFamily(family: string): boolean {
  return uploaded.has(family.trim());
}

// --- Weights and bytes -----------------------------------------------------------------------

/** Weights `family` is known to have a font file for: its uploaded faces, else its installed ones. Empty
 *  for a family with no readable source. */
export function knownRasterWeights(family: string): number[] {
  const name = family.trim();
  const weights = uploaded.get(name) ?? localFaces.get(name);
  return weights ? CSS_FONT_WEIGHTS.filter((weight) => weights.has(weight)) : [];
}

/** Identity of the file behind a face: the fingerprint of an uploaded font, `local` for an installed one. A
 *  built atlas is stale once this changes (an upload replaced the file). `null` when no source has the face. */
export function rasterFaceSource(family: string, weight: number): string | null {
  const name = family.trim();
  const upload = uploaded.get(name)?.get(weight);
  if (upload) return `upload:${fingerprint(upload.bytes)}`;
  return localFaces.get(name)?.has(weight) ? "local" : null;
}

/** The sfnt bytes of the face of `family` at exactly `weight`; `null` when no source has one. An uploaded
 *  file wins over an installed font of the same name. */
export async function rasterFaceBytes(family: string, weight: number): Promise<Uint8Array | null> {
  const name = family.trim();
  const upload = uploaded.get(name)?.get(weight);
  if (upload) return upload.bytes;
  const local = localFaces.get(name)?.get(weight);
  if (!local) return null;
  try {
    return await toSfnt(await readBlobBytes(await local.blob()));
  } catch (error) {
    if (error instanceof FontFileFailure) throw error;
    return null;
  }
}
