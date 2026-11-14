/** Main-thread clients of the WASM workers: one `WorkerPool` per worker entry point. */
import { WorkerPool, type WorkerJob } from "./workerPool";
import { compileWasmModule } from "./wasmLoader";
import type { PrintSizingAnswer, PrintSizingRequest } from "../pixi/printSizingJob";
import { validateSnapshot, type GenerateMazeResult } from "./mazeGeneration";
import type { GenerationRequest } from "./generationWorker";
import type { AnalyticsRequest } from "./analyticsWorker";
import type { GenerateConfig, ComputeAnalyticsConfig, MazeSnapshot } from "./types";

const generationPool = new WorkerPool<GenerationRequest, GenerateMazeResult>({
  create: () => new Worker(new URL("./generationWorker.ts", import.meta.url), { type: "module" }),
  wasmModule: compileWasmModule,
  failureMessage: "Generation worker failed",
});

const analyticsPool = new WorkerPool<AnalyticsRequest, unknown>({
  create: () => new Worker(new URL("./analyticsWorker.ts", import.meta.url), { type: "module" }),
  wasmModule: compileWasmModule,
  failureMessage: "Analytics worker failed",
});

const printSizingPool = new WorkerPool<PrintSizingRequest, PrintSizingAnswer>({
  create: () => new Worker(new URL("./printSizingWorker.ts", import.meta.url), { type: "module" }),
  wasmModule: compileWasmModule,
  failureMessage: "Print sizing worker failed",
});

/** Starts the print field size and cell size calculation in a worker (GitHub issue #949). The
 *  caller cancels the job when its parameters change or its dialog closes; a cancelled job
 *  terminates its worker, because a synchronous WASM call cannot be interrupted. */
export function startPrintSizing(request: PrintSizingRequest): WorkerJob<PrintSizingAnswer> {
  return printSizingPool.run(request);
}

/** Runs generation off the main thread so long WASM calls can provide responsive UI feedback. The
 *  worker stays alive afterwards, so WASM is initialized once per worker rather than per run. */
export function startGenerateMaze(seed: number, config: GenerateConfig, onProgress: (progress: number) => void): WorkerJob<GenerateMazeResult> {
  return generationPool.run({ seed, config }, [], onProgress);
}

export function generateMazeAsync(seed: number, config: GenerateConfig): Promise<GenerateMazeResult> {
  return startGenerateMaze(seed, config, () => {}).promise;
}

/** Runs the expensive analytics-only WASM call off the UI thread. A newer request supersedes the
 * previous one, so rapid rule edits do not leave a pool of stale cycle analyses running in the
 * background. `confirmPostEdit`'s request id still protects the store from a result that raced
 * with another state change after the worker completed. */
export function computeAnalyticsAsync(config: ComputeAnalyticsConfig): Promise<MazeSnapshot> {
  analyticsPool.cancelAll(new Error("Analytics request superseded"));
  return analyticsPool.run({ config }).promise.then(validateSnapshot);
}

/** Terminates every worker. Called on page shutdown and on hot module replacement. */
export function disposeWorkers(): void {
  generationPool.dispose();
  analyticsPool.dispose();
  printSizingPool.dispose();
}

if (typeof window !== "undefined") window.addEventListener("pagehide", disposeWorkers);
(import.meta as { hot?: { dispose(callback: () => void): void } }).hot?.dispose(disposeWorkers);
