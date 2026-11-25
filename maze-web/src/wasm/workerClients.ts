/** Main-thread clients of the WASM workers: one `WorkerPool` per worker entry point. */
import { WorkerPool, type WorkerJob } from "./workerPool";
import { trackActivity } from "../activity/backgroundActivity";
import { compileWasmModule } from "./wasmLoader";
import type { PrintSizingAnswer, PrintSizingRequest } from "../pixi/printSizingJob";
import { validateSnapshot, type GenerateMazeResult } from "./mazeGeneration";
import type { GenerationRequest } from "./generationWorker";
import type { AnalyticsRequest } from "./analyticsWorker";
import type { NodeShapeStatisticsWorkerRequest } from "./nodeShapeStatisticsWorker";
import type { GenerateConfig, ComputeAnalyticsConfig, MazeSnapshot, NodeShapeStatisticsRequest, NodeShapeCountDto } from "./types";

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

const nodeShapeStatisticsPool = new WorkerPool<NodeShapeStatisticsWorkerRequest, NodeShapeCountDto[]>({
  create: () => new Worker(new URL("./nodeShapeStatisticsWorker.ts", import.meta.url), { type: "module" }),
  wasmModule: compileWasmModule,
  failureMessage: "Node shape statistics worker failed",
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
export function computeAnalyticsAsync(config: ComputeAnalyticsConfig, reportBackgroundActivity = true): Promise<MazeSnapshot> {
  analyticsPool.cancelAll(new Error("Analytics request superseded"));
  const work = analyticsPool.run({ config }).promise.then(validateSnapshot);
  return reportBackgroundActivity ? trackActivity("analytics", work) : work;
}

/** Calculates shape-aware cell statistics only on an explicit dialog open. */
export function nodeShapeStatisticsAsync(request: NodeShapeStatisticsRequest): Promise<NodeShapeCountDto[]> {
  // Only the latest dialog opening matters; do not let an older graph snapshot overwrite it.
  nodeShapeStatisticsPool.cancelAll(new Error("Node shape statistics request superseded"));
  return trackActivity("analytics", nodeShapeStatisticsPool.run({ request }).promise);
}

/** Terminates every worker. Called on page shutdown and on hot module replacement. */
export function disposeWorkers(): void {
  generationPool.dispose();
  analyticsPool.dispose();
  nodeShapeStatisticsPool.dispose();
  printSizingPool.dispose();
}

if (typeof window !== "undefined") window.addEventListener("pagehide", disposeWorkers);
(import.meta as { hot?: { dispose(callback: () => void): void } }).hot?.dispose(disposeWorkers);
