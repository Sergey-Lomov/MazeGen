import { beginActivity, endActivity, isActivityRunning, subscribeActivity } from "../../../activity/backgroundActivity";
import { CSS_FONT_WEIGHTS, weightFromStyleName } from "../fontChoice";
import { FontFileFailure, readBlobBytes, readFontInfo, toSfnt, type FontFileError } from "./sfnt";

/** Where the raster fonts come from, and what became of each (GitHub issue #966). A raster font is an
 *  installed font reported by the Local Font Access API or a file the user uploaded; its bytes feed the
 *  MSDF conversion (`rasterMsdf.ts`). Uploaded files are remembered in IndexedDB, never in the project. */

/** The slice of a Local Font Access `FontData` used here. */
export interface LocalFontFace {
  family: string;
  style?: string;
  /** Tell the faces of a font collection apart (an installed font may live in a TTC). */
  postscriptName?: string;
  fullName?: string;
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

/** Marks the start of an atlas conversion of the font `label`; pair with `endRasterWork(label)`. Feeds the
 *  "Preparing fonts" background indicator (two weights of one font count twice). */
export function beginRasterWork(label = ""): void {
  beginActivity("fonts", label);
}

export function endRasterWork(label = ""): void {
  endActivity("fonts", label);
}

export function subscribeRasterWork(listener: () => void): () => void {
  return subscribeActivity(listener);
}

/** Whether any atlas is being converted right now. */
export function isRasterWorkBusy(): boolean {
  return isActivityRunning("fonts");
}

// --- Installed fonts (Local Font Access API) -------------------------------------------------

/** Normal-style faces of each reported family, by weight. */
let localFaces = new Map<string, Map<number, LocalFontFace>>();

/** Remembers the faces the machine reported, so their bytes can be read when a family is picked. Italic,
 *  oblique and non-regular-width faces are skipped: a font value addresses a normal-style face. */
export function registerLocalFaces(faces: readonly LocalFontFace[]): void {
  const next = new Map<string, Map<number, LocalFontFace>>();
  const styles = new Map<string, string[]>();
  for (const face of faces) {
    const family = face.family.trim();
    if (family) styles.set(family, [...(styles.get(family) ?? []), face.style ?? ""]);
    const weight = weightFromStyleName(face.style ?? "");
    if (!family || weight === null) continue;
    let byWeight = next.get(family);
    if (!byWeight) next.set(family, (byWeight = new Map()));
    if (!byWeight.has(weight)) byWeight.set(weight, face);
  }
  localFaces = next;
  reportedLocalStyles = styles;
  notifyRasterFontsChanged();
}

/** Every style the machine reported per family, usable or not (italic and non-regular widths are not). */
let reportedLocalStyles = new Map<string, string[]>();

/** What the machine reports for `family`, as text for an error's details: the styles of its faces, or that it
 *  reports none (the font is not installed, or the installed fonts were not read). */
export function describeLocalFaces(family: string): string {
  const name = family.trim();
  const styles = reportedLocalStyles.get(name);
  const usable = [...(localFaces.get(name)?.keys() ?? [])];
  if (!styles) return `${name}: no installed face reported (${reportedLocalStyles.size} families known)`;
  return `${name}: reported styles [${styles.map((style) => style || "(none)").join(", ")}], usable weights [${usable.join(", ") || "none"}]`;
}

// --- Uploaded fonts --------------------------------------------------------------------------

/** An uploaded face. Only its identity is kept in memory: the file stays a `Blob` (file-backed in IndexedDB), read
 *  when its atlas is built or its browser face is needed, so a long list of uploads costs no memory until a font is
 *  used (GitHub issue #985). */
interface UploadedFace {
  family: string;
  weight: number;
  /** Identity of the file (`fingerprint`), kept beside it so the atlas cache can key on it without reading the file. */
  fingerprint: string;
  blob: Blob;
}

/** Limits on what the user may upload (GitHub issue #985): a file, the number of files, and their total size. */
export const MAX_UPLOADED_FACES = 50;
export const MAX_UPLOADED_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;

/** Why an upload was refused for size rather than for the file's content. */
export type UploadLimitError = "file-too-large" | "too-many-fonts" | "storage-full";

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

/** What IndexedDB holds per face. Early versions stored the bytes themselves (`bytes`) and no fingerprint; such a
 *  record is converted when read. */
interface StoredFace {
  id: string;
  family: string;
  weight: number;
  fingerprint?: string;
  blob?: Blob;
  bytes?: Uint8Array;
}

const storedId = (family: string, weight: number) => `${family}|${weight}`;

/** Browser faces of the uploaded fonts, created on demand. The picker preview and the script coverage probes are
 *  drawn by the browser, so a font in use must be known to it; the canvas labels use the MSDF atlas instead. */
const browserFaces = new Map<string, FontFace>();
const pendingBrowserFaces = new Map<string, Promise<void>>();

function dropBrowserFace(family: string, weight: number): void {
  const key = `${weight}|${family}`;
  const old = browserFaces.get(key);
  if (old && typeof document !== "undefined") document.fonts?.delete(old);
  browserFaces.delete(key);
  pendingBrowserFaces.delete(key);
}

function installBrowserFace(face: UploadedFace, bytes: Uint8Array): Promise<void> {
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return Promise.resolve();
  dropBrowserFace(face.family, face.weight);
  try {
    const browserFace = new FontFace(face.family, bytes.slice().buffer, { weight: String(face.weight) });
    document.fonts.add(browserFace);
    browserFaces.set(`${face.weight}|${face.family}`, browserFace);
    return browserFace.load().then(notifyRasterFontsChanged, () => {});
  } catch {
    // The preview then falls back to a generic font; the MSDF conversion does not depend on it.
    return Promise.resolve();
  }
}

/** Makes the browser know the uploaded faces of `family` (only `weight` when given): reads their files and loads
 *  them. A no-op for a family that was not uploaded and for a face already known. Resolves once they are usable. */
export async function ensureUploadedFace(family: string, weight?: number): Promise<void> {
  const name = family.trim();
  const faces = uploaded.get(name);
  if (!faces) return;
  const wanted = [...faces.values()].filter((face) => weight === undefined || face.weight === weight);
  await Promise.all(wanted.map((face) => {
    const key = `${face.weight}|${face.family}`;
    const inFlight = pendingBrowserFaces.get(key);
    if (inFlight) return inFlight;
    if (browserFaces.has(key)) return Promise.resolve();
    const pending = readBlobBytes(face.blob).then((bytes) => {
      // A replaced or removed face must not come back from a read that was in flight.
      if (uploaded.get(face.family)?.get(face.weight) === face) return installBrowserFace(face, bytes);
    }).catch(() => {}).finally(() => { if (pendingBrowserFaces.get(key) === pending) pendingBrowserFaces.delete(key); });
    pendingBrowserFaces.set(key, pending);
    return pending;
  }));
}

/** Whether the browser already knows an uploaded face of `family`, so glyph probes of it mean something. */
export function isUploadedFaceLoaded(family: string): boolean {
  const faces = uploaded.get(family.trim());
  return !!faces && [...faces.values()].some((face) => browserFaces.has(`${face.weight}|${face.family}`));
}

function remember(face: UploadedFace): void {
  let byWeight = uploaded.get(face.family);
  if (!byWeight) uploaded.set(face.family, (byWeight = new Map()));
  byWeight.set(face.weight, face);
}

let restored: Promise<void> | null = null;

/** Loads the fonts uploaded in earlier sessions from IndexedDB, once. Only their identity is read into memory:
 *  the files stay blobs until a font is used (`ensureUploadedFace`, `rasterFaceBytes`). */
export function restoreUploadedFonts(): Promise<void> {
  restored ??= (async () => {
    const db = await openDb();
    if (!db) return;
    const stored = await new Promise<StoredFace[]>((resolve) => {
      const request = db.transaction(DB_STORE).objectStore(DB_STORE).getAll();
      request.onsuccess = () => resolve(request.result as StoredFace[]);
      request.onerror = () => resolve([]);
    });
    db.close();
    const converted: StoredFace[] = [];
    for (const record of stored) {
      if (uploaded.get(record.family)?.has(record.weight)) continue;
      if (record.blob && record.fingerprint) {
        remember({ family: record.family, weight: record.weight, fingerprint: record.fingerprint, blob: record.blob });
      } else if (record.bytes) {
        const face: UploadedFace = { family: record.family, weight: record.weight, fingerprint: fingerprint(record.bytes), blob: new Blob([record.bytes.slice().buffer]) };
        remember(face);
        converted.push({ id: record.id, family: face.family, weight: face.weight, fingerprint: face.fingerprint, blob: face.blob });
      }
    }
    if (converted.length > 0) await dbWrite((store) => { for (const record of converted) store.put(record); });
    if (stored.length > 0) notifyRasterFontsChanged();
  })();
  return restored;
}

export type UploadResult =
  | { ok: true; family: string; weight: number }
  | { ok: false; reason: FontFileError | UploadLimitError };

/** Which limit adding a face of `size` bytes would break; replacing a face of the same family and weight frees its
 *  own share first. `null` when the upload fits. */
function uploadLimitReached(family: string, weight: number, size: number): UploadLimitError | null {
  if (size > MAX_UPLOAD_FILE_BYTES) return "file-too-large";
  const replaced = uploaded.get(family)?.get(weight);
  const usage = uploadedUsage();
  if (!replaced && usage.faces + 1 > MAX_UPLOADED_FACES) return "too-many-fonts";
  if (usage.bytes - (replaced?.blob.size ?? 0) + size > MAX_UPLOADED_BYTES) return "storage-full";
  return null;
}

/** Which limit is already used up, so a file picker is not even worth opening; `null` while there is room for at
 *  least one more face. A later upload is still checked against its own size (`uploadLimitReached`). */
export function uploadCapacityExhausted(): UploadLimitError | null {
  const usage = uploadedUsage();
  if (usage.faces >= MAX_UPLOADED_FACES) return "too-many-fonts";
  if (usage.bytes >= MAX_UPLOADED_BYTES) return "storage-full";
  return null;
}

/** How many uploaded faces there are and how many bytes their files take. */
export function uploadedUsage(): { faces: number; bytes: number } {
  let faces = 0;
  let bytes = 0;
  for (const byWeight of uploaded.values()) for (const face of byWeight.values()) { faces++; bytes += face.blob.size; }
  return { faces, bytes };
}

/** Accepts a font file (TTF, OTF or WOFF): checks it parses, keeps it for the session and in IndexedDB. A
 *  face with the same family and weight is replaced. */
export async function addUploadedFont(file: Blob): Promise<UploadResult> {
  try {
    const sfnt = await toSfnt(await readBlobBytes(file));
    const info = readFontInfo(sfnt);
    if (!info) return { ok: false, reason: "corrupt" };
    // The Local Font Access API and the picker address normal-style faces only.
    if (info.italic) return { ok: false, reason: "unsupported-format" };
    const limit = uploadLimitReached(info.family, info.weight, sfnt.length);
    if (limit) return { ok: false, reason: limit };
    const face: UploadedFace = { family: info.family, weight: info.weight, fingerprint: fingerprint(sfnt), blob: new Blob([sfnt.slice().buffer]) };
    remember(face);
    void installBrowserFace(face, sfnt);
    await dbWrite((store) => { store.put({ id: storedId(face.family, face.weight), family: face.family, weight: face.weight, fingerprint: face.fingerprint, blob: face.blob } satisfies StoredFace); });
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
  await dbWrite((store) => { for (const weight of faces.keys()) store.delete(storedId(family, weight)); });
  notifyRasterFontsChanged();
}

/** Families the user uploaded, sorted. */
export function uploadedFamilies(): string[] {
  return [...uploaded.keys()].sort();
}

export function isUploadedFamily(family: string): boolean {
  return uploaded.has(family.trim());
}

// --- Script coverage of uploaded fonts ---------------------------------------------------------

const COVERAGE_KEY = "mazegen-uploaded-coverage";

function coverageEntryKey(family: string, sample: string): string | null {
  const faces = uploaded.get(family.trim());
  const first = faces ? [...faces.values()].sort((a, b) => a.weight - b.weight)[0] : undefined;
  return first ? `${first.fingerprint}|${sample}` : null;
}

function readCoverage(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COVERAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** Whether an uploaded font draws `sample` itself, as measured once with its face loaded and remembered in this
 *  browser keyed by the file's fingerprint (a replaced file is measured again). `undefined` while not measured, so
 *  a font that is never highlighted or probed is never read just to fill the "supports the language" badge. */
export function storedUploadedCoverage(family: string, sample: string): boolean | undefined {
  const key = coverageEntryKey(family, sample);
  const value = key === null ? undefined : readCoverage()[key];
  return typeof value === "boolean" ? value : undefined;
}

export function saveUploadedCoverage(family: string, sample: string, covers: boolean): void {
  const key = coverageEntryKey(family, sample);
  if (key === null) return;
  try {
    localStorage.setItem(COVERAGE_KEY, JSON.stringify({ ...readCoverage(), [key]: covers }));
  } catch {
    // The font is measured again next time.
  }
}

// --- Manually named fonts (GitHub issue #985) --------------------------------------------------

const MANUAL_NAMES_KEY = "mazegen-manual-fonts";

function readManualNames(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MANUAL_NAMES_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string" && name.trim() !== "") : []);
  } catch {
    return new Set();
  }
}

/** Names of installed fonts the user typed in because the machine's font list could not be read. Only the name
 *  is kept (in this browser's local storage, never in the project): the font file is out of reach, so such a
 *  font is drawn by the browser and never converted to an MSDF atlas. */
const manualNames = readManualNames();

/** Remembers an installed font family by name. Returns `false` for an empty name. */
export function addManualFontName(name: string): boolean {
  const family = name.trim();
  if (!family) return false;
  if (!manualNames.has(family)) {
    manualNames.add(family);
    try {
      localStorage.setItem(MANUAL_NAMES_KEY, JSON.stringify([...manualNames]));
    } catch {
      // The name then lives for this session only.
    }
    notifyRasterFontsChanged();
  }
  return true;
}

/** Whether the user typed `family` in by name as an installed font. */
export function isManualFontName(family: string): boolean {
  return manualNames.has(family.trim());
}

/** Families typed in by name, sorted. */
export function manualFontNames(): string[] {
  return [...manualNames].sort();
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
  if (upload) return `upload:${upload.fingerprint}`;
  return localFaces.get(name)?.has(weight) ? "local" : null;
}

/** The sfnt bytes of the face of `family` at exactly `weight`; `null` when no source has one. An uploaded
 *  file wins over an installed font of the same name. */
export async function rasterFaceBytes(family: string, weight: number): Promise<Uint8Array | null> {
  const name = family.trim();
  const upload = uploaded.get(name)?.get(weight);
  if (upload) return readBlobBytes(upload.blob);
  const local = localFaces.get(name)?.get(weight);
  if (!local) return null;
  try {
    const raw = await readBlobBytes(await local.blob());
    return await toSfnt(raw, { postscriptName: local.postscriptName, fullName: local.fullName });
  } catch (error) {
    if (error instanceof FontFileFailure) throw error;
    return null;
  }
}
