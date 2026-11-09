/** Request/response envelope shared by `WorkerPool` and `serveWorker` (`workerHost.ts`). */
export interface WorkerRequestMessage<Req> {
  id: number;
  payload: Req;
  /** Compiled WASM module, attached to the first request of a fresh worker only. */
  wasmModule?: WebAssembly.Module;
}

export type WorkerResponseMessage<Res> =
  | { id: number; result: Res }
  | { id: number; error: string };

export interface WorkerPoolOptions {
  /** Creates one module worker. Called only when no idle worker is available. */
  create: () => Worker;
  /** Supplies the compiled WASM module (compiled once, shared by all workers). When set, a fresh
   *  worker receives it with its first request and only instantiates it. */
  wasmModule?: () => Promise<WebAssembly.Module>;
  /** Idle workers kept alive for reuse; extra ones are terminated on release. Default 1. */
  maxIdle?: number;
  /** Used when a worker fails with an event that carries no message. */
  failureMessage?: string;
}

export interface WorkerJob<Res> {
  promise: Promise<Res>;
  /** Terminates the worker running the job (a synchronous WASM call cannot be interrupted any
   *  other way) and rejects `promise` with `reason`. No-op once the job settled. */
  cancel(reason: Error): void;
}

interface PooledWorker {
  worker: Worker;
  cancel: ((reason: Error) => void) | null;
}

/** Lifecycle policy for every worker that hosts the WASM module: a worker initializes WASM once
 *  and then serves many requests, one at a time. A worker is retired (terminated, never reused)
 *  after a failure or a cancellation, because its WASM instance may be mid-call or corrupted.
 *  New worker consumers should create a pool rather than calling `new Worker` directly. */
export class WorkerPool<Req, Res> {
  private readonly idle: PooledWorker[] = [];
  private readonly busy = new Set<PooledWorker>();
  private readonly maxIdle: number;
  private nextId = 1;

  constructor(private readonly options: WorkerPoolOptions) {
    this.maxIdle = options.maxIdle ?? 1;
  }

  /** Workers currently alive, idle or running a job. */
  get size(): number {
    return this.idle.length + this.busy.size;
  }

  run(payload: Req, transfer: Transferable[] = []): WorkerJob<Res> {
    let cancel: (reason: Error) => void = () => {};
    const promise = new Promise<Res>((resolve, reject) => {
      const reused = this.idle.pop();
      const entry = reused ?? this.adopt(this.options.create());
      this.busy.add(entry);
      const id = this.nextId++;
      let settled = false;

      const finish = (outcome: "reuse" | "retire", callback: () => void): void => {
        if (settled) return;
        settled = true;
        entry.worker.onmessage = null;
        entry.worker.onerror = null;
        entry.cancel = null;
        this.busy.delete(entry);
        if (outcome === "reuse" && this.idle.length < this.maxIdle) {
          this.idle.push(entry);
          this.watchIdle(entry);
        } else entry.worker.terminate();
        callback();
      };

      entry.cancel = (reason) => finish("retire", () => reject(reason));
      cancel = entry.cancel;

      entry.worker.onmessage = (event: MessageEvent<WorkerResponseMessage<Res>>) => {
        const message = event.data;
        if (message.id !== id) return;
        if ("error" in message) finish("retire", () => reject(new Error(message.error)));
        else finish("reuse", () => resolve(message.result));
      };
      entry.worker.onerror = (event) => {
        finish("retire", () => reject(new Error(event.message || this.options.failureMessage || "Worker failed")));
      };
      const send = (wasmModule?: WebAssembly.Module): void => {
        try {
          entry.worker.postMessage({ id, payload, wasmModule } satisfies WorkerRequestMessage<Req>, transfer);
        } catch (error) {
          finish("retire", () => reject(error));
        }
      };
      if (reused || !this.options.wasmModule) send();
      else {
        this.options.wasmModule().then(
          (module) => { if (!settled) send(module); },
          (error: unknown) => finish("retire", () => reject(error)),
        );
      }
    });
    return { promise, cancel: (reason) => cancel(reason) };
  }

  /** An idle worker that errors is dropped at once, so the next request never lands on a dead one. */
  private adopt(worker: Worker): PooledWorker {
    return { worker, cancel: null };
  }

  private watchIdle(entry: PooledWorker): void {
    entry.worker.onerror = () => {
      const index = this.idle.indexOf(entry);
      if (index < 0) return;
      this.idle.splice(index, 1);
      entry.worker.terminate();
    };
  }

  /** Rejects every running job with `reason` and terminates its worker; idle workers stay. */
  cancelAll(reason: Error): void {
    for (const entry of [...this.busy]) entry.cancel?.(reason);
  }

  /** Application shutdown: cancels running jobs and terminates idle workers. The pool stays usable
   *  and spawns fresh workers on demand (a page restored from the back/forward cache needs that). */
  dispose(): void {
    this.cancelAll(new Error("Worker pool disposed"));
    for (const entry of this.idle.splice(0)) entry.worker.terminate();
  }
}
