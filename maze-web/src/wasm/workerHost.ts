import { initWasm } from "./wasmLoader";
import type { WorkerRequestMessage, WorkerResponseMessage } from "./workerPool";

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequestMessage<unknown>>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface WorkerHandlerResult<Res> {
  result: Res;
  /** Buffers moved to the main thread instead of copied. */
  transfer?: Transferable[];
}

/** Worker-side half of `WorkerPool`: initializes WASM once (`initWasm` is memoized per worker),
 *  then answers each request through `handler`. A thrown error becomes an error response. */
export function serveWorker<Req, Res>(handler: (payload: Req) => WorkerHandlerResult<Res>): void {
  const scope = self as unknown as WorkerScope;
  scope.onmessage = async (event) => {
    const { id, payload, wasmModule } = event.data;
    try {
      // Only the first request of a worker carries the module; later calls hit the memoized init.
      await initWasm(wasmModule);
      const { result, transfer = [] } = handler(payload as Req);
      scope.postMessage({ id, result } satisfies WorkerResponseMessage<Res>, transfer);
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponseMessage<Res>);
    }
  };
}
