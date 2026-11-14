/** Reads what the font picker needs from a TTF/OTF/WOFF font file without loading it into the
 *  browser: the family name, the weight, whether it is italic and the vertical line metrics used to lay
 *  out an MSDF atlas built from it (GitHub issue #966). */

export interface FontFileInfo {
  family: string;
  /** CSS weight 100..900 (`usWeightClass` of the OS/2 table, snapped to a hundred). */
  weight: number;
  italic: boolean;
  /** Ascender, descender (negative) and line gap in em units. */
  ascender: number;
  descender: number;
  lineGap: number;
}

const SFNT_TAGS = new Set([0x00010000, 0x4f54544f, 0x74727565]); // 1.0, 'OTTO', 'true'
const WOFF_SIGNATURE = 0x774f4646; // 'wOFF'
const WOFF2_SIGNATURE = 0x774f4632; // 'wOF2'
const TTC_SIGNATURE = 0x74746366; // 'ttcf'

/** Why a file could not be turned into an sfnt font. */
export type FontFileError = "unsupported-format" | "corrupt";

export class FontFileFailure extends Error {
  constructor(readonly reason: FontFileError) {
    super(reason);
  }
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Inflates a zlib stream with the platform decompressor. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new FontFileFailure("unsupported-format");
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } });
  const stream = source.pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The bytes of a file or blob. `Blob.arrayBuffer` is missing in older engines and in jsdom. */
export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Rebuilds the plain sfnt a WOFF 1.0 file wraps (its tables, each optionally zlib-compressed). */
async function unwrapWoff(bytes: Uint8Array): Promise<Uint8Array> {
  const v = view(bytes);
  const flavor = v.getUint32(4);
  const numTables = v.getUint16(12);
  const records: Array<{ tag: number; checksum: number; data: Uint8Array }> = [];
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    const offset = v.getUint32(at + 4);
    const compLength = v.getUint32(at + 8);
    const origLength = v.getUint32(at + 12);
    if (offset + compLength > bytes.length) throw new FontFileFailure("corrupt");
    const raw = bytes.subarray(offset, offset + compLength);
    records.push({
      tag: v.getUint32(at),
      checksum: v.getUint32(at + 16),
      data: compLength < origLength ? await inflate(raw) : raw,
    });
  }
  records.sort((a, b) => a.tag - b.tag);
  const headerSize = 12 + numTables * 16;
  const total = records.reduce((sum, r) => sum + ((r.data.length + 3) & ~3), headerSize);
  const out = new Uint8Array(total);
  const o = view(out);
  o.setUint32(0, flavor);
  o.setUint16(4, numTables);
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * 2 ** entrySelector;
  o.setUint16(6, searchRange);
  o.setUint16(8, entrySelector);
  o.setUint16(10, numTables * 16 - searchRange);
  let cursor = headerSize;
  records.forEach((record, i) => {
    const at = 12 + i * 16;
    o.setUint32(at, record.tag);
    o.setUint32(at + 4, record.checksum);
    o.setUint32(at + 8, cursor);
    o.setUint32(at + 12, record.data.length);
    out.set(record.data, cursor);
    cursor += (record.data.length + 3) & ~3;
  });
  return out;
}

/** The plain sfnt bytes of a font file: TTF and OTF as they are, WOFF unwrapped. WOFF2 needs a Brotli
 *  decoder the browser does not expose and font collections hold several faces, so both are refused. */
export async function toSfnt(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 12) throw new FontFileFailure("corrupt");
  const tag = view(bytes).getUint32(0);
  if (SFNT_TAGS.has(tag)) return bytes;
  if (tag === WOFF_SIGNATURE) return unwrapWoff(bytes);
  if (tag === WOFF2_SIGNATURE || tag === TTC_SIGNATURE) throw new FontFileFailure("unsupported-format");
  throw new FontFileFailure("unsupported-format");
}

export function findTable(v: DataView, tag: string): { offset: number; length: number } | null {
  const count = v.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (at + 16 > v.byteLength) return null;
    const name = String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
    if (name === tag) return { offset: v.getUint32(at + 8), length: v.getUint32(at + 12) };
  }
  return null;
}

/** The family name of the `name` table: the typographic family (id 16) before the legacy one (id 1),
 *  a Windows Unicode record before a Mac Roman one. */
function readFamilyName(v: DataView, table: { offset: number; length: number }): string {
  const count = v.getUint16(table.offset + 2);
  const stringsAt = table.offset + v.getUint16(table.offset + 4);
  const candidates = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const at = table.offset + 6 + i * 12;
    const platform = v.getUint16(at);
    const nameId = v.getUint16(at + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = v.getUint16(at + 8);
    const start = stringsAt + v.getUint16(at + 10);
    if (start + length > v.byteLength) continue;
    let text = "";
    if (platform === 0 || platform === 3) {
      for (let p = 0; p + 1 < length; p += 2) text += String.fromCharCode(v.getUint16(start + p));
    } else if (platform === 1) {
      for (let p = 0; p < length; p++) text += String.fromCharCode(v.getUint8(start + p));
    } else continue;
    // Windows/Unicode records beat Mac ones for the same id.
    if (!candidates.has(nameId) || platform !== 1) candidates.set(nameId, text.trim());
  }
  return candidates.get(16) || candidates.get(1) || "";
}

/** Family, weight, slant and line metrics of an sfnt font, or `null` when it lacks the tables. */
export function readFontInfo(sfnt: Uint8Array): FontFileInfo | null {
  try {
    const v = view(sfnt);
    const head = findTable(v, "head");
    const hhea = findTable(v, "hhea");
    const name = findTable(v, "name");
    if (!head || !hhea || !name) return null;
    const unitsPerEm = v.getUint16(head.offset + 18);
    if (unitsPerEm === 0) return null;
    const macStyle = v.getUint16(head.offset + 44);
    const os2 = findTable(v, "OS/2");
    let weight = macStyle & 1 ? 700 : 400;
    let italic = (macStyle & 2) !== 0;
    if (os2 && os2.length >= 64) {
      const weightClass = v.getUint16(os2.offset + 4);
      if (weightClass >= 1) weight = Math.min(900, Math.max(100, Math.round(weightClass / 100) * 100));
      italic = italic || (v.getUint16(os2.offset + 62) & 1) !== 0;
    }
    const family = readFamilyName(v, name);
    if (!family) return null;
    return {
      family,
      weight,
      italic,
      ascender: v.getInt16(hhea.offset + 4) / unitsPerEm,
      descender: v.getInt16(hhea.offset + 6) / unitsPerEm,
      lineGap: v.getInt16(hhea.offset + 8) / unitsPerEm,
    };
  } catch {
    return null;
  }
}
