import wasmUrl from "@playcanvas/msdfgen-wasm/msdfgen.wasm?url";
import { createMsdfEngine, type GlyphBitmap, type MsdfEngine } from "./msdfEngine";

/** Worker side of the raster font MSDF pipeline (GitHub issue #966). It keeps the loaded fonts between
 *  requests, so a glyph added later does not resend the font file. */

export type MsdfWorkerRequest =
  | { id: number; type: "load"; key: string; bytes: Uint8Array }
  | { id: number; type: "unload"; key: string }
  | { id: number; type: "generate"; key: string; codepoints: number[] };

export type MsdfWorkerResponse =
  | { id: number; ok: true; loaded?: boolean; glyphs?: Array<GlyphBitmap | null> }
  | { id: number; ok: false; error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<MsdfWorkerRequest>) => void) | null;
  postMessage(message: MsdfWorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let engine: Promise<MsdfEngine> | null = null;

scope.onmessage = async (event) => {
  const request = event.data;
  try {
    engine ??= createMsdfEngine(wasmUrl);
    const ready = await engine;
    if (request.type === "load") {
      scope.postMessage({ id: request.id, ok: true, loaded: ready.load(request.key, request.bytes) });
    } else if (request.type === "unload") {
      ready.unload(request.key);
      scope.postMessage({ id: request.id, ok: true });
    } else {
      const glyphs = ready.generate(request.key, request.codepoints);
      scope.postMessage({ id: request.id, ok: true, glyphs }, glyphs.flatMap((glyph) => (glyph && glyph.rgba.length > 0 ? [glyph.rgba.buffer] : [])));
    }
  } catch (error) {
    engine = null;
    scope.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
