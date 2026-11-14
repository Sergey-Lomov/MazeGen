import type { GlyphBitmap } from "./msdfEngine";
import type { MsdfWorkerRequest, MsdfWorkerResponse } from "./msdfWorker";

/** Main-thread access to MSDF glyph generation (GitHub issue #966). The generator is a WebAssembly module
 *  in a dedicated worker, so converting a font never blocks the UI. The worker holds the loaded font files
 *  between requests (a glyph added later does not resend the font), which the shared `WorkerPool` of the
 *  maze WASM workers does not offer: its workers are stateless, retired after any failure, and initialize
 *  the maze module, which this one does not use. */
export interface MsdfGlyphService {
  /** Loads font bytes under `key`; resolves `false` when the file is not a usable font. */
  load(key: string, bytes: Uint8Array): Promise<boolean>;
  unload(key: string): void;
  /** Glyphs of `codepoints` in order; `null` for a codepoint the font does not draw. */
  generate(key: string, codepoints: readonly number[]): Promise<Array<GlyphBitmap | null>>;
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

class WorkerMsdfService implements MsdfGlyphService {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (response: MsdfWorkerResponse & { ok: true }) => void; reject: (error: Error) => void }>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./msdfWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<MsdfWorkerResponse>) => {
      const entry = this.pending.get(event.data.id);
      if (!entry) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data);
      else entry.reject(new Error(event.data.error));
    };
    // A crashed worker lost every loaded font: fail what is in flight and start a fresh one next time.
    worker.onerror = () => this.fail(new Error("MSDF worker failed"));
    this.worker = worker;
    return worker;
  }

  private fail(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private send(request: DistributiveOmit<MsdfWorkerRequest, "id">, transfer: Transferable[] = []): Promise<MsdfWorkerResponse & { ok: true }> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...request, id }, transfer);
    });
  }

  async load(key: string, bytes: Uint8Array): Promise<boolean> {
    // The caller keeps its bytes (they may be needed again after a worker restart), so the worker gets a copy.
    const copy = bytes.slice();
    return (await this.send({ type: "load", key, bytes: copy }, [copy.buffer])).loaded === true;
  }

  unload(key: string): void {
    if (!this.worker) return;
    void this.send({ type: "unload", key }).catch(() => {});
  }

  async generate(key: string, codepoints: readonly number[]): Promise<Array<GlyphBitmap | null>> {
    return (await this.send({ type: "generate", key, codepoints: [...codepoints] })).glyphs ?? [];
  }
}

/** Runs the generator on the calling thread: for environments without workers (tests). */
class InlineMsdfService implements MsdfGlyphService {
  private readonly engine = import("./msdfEngine").then((module) => module.createMsdfEngine());

  async load(key: string, bytes: Uint8Array): Promise<boolean> {
    return (await this.engine).load(key, bytes);
  }

  unload(key: string): void {
    void this.engine.then((engine) => engine.unload(key));
  }

  async generate(key: string, codepoints: readonly number[]): Promise<Array<GlyphBitmap | null>> {
    return (await this.engine).generate(key, codepoints);
  }
}

let service: MsdfGlyphService | null = null;

export function getMsdfService(): MsdfGlyphService {
  service ??= typeof Worker === "undefined" ? new InlineMsdfService() : new WorkerMsdfService();
  return service;
}

/** Replaces the generator, or restores the default with `null`. For tests. */
export function setMsdfServiceForTests(next: MsdfGlyphService | null): void {
  service = next;
}
