/** Main-thread clients of the WASM workers: one `WorkerPool` per worker entry point. */
import { WorkerPool } from "./workerPool";
import { validateSnapshot, type GenerateMazeResult } from "./mazeGeneration";
import type { GenerationRequest } from "./generationWorker";
import type { AnalyticsRequest } from "./analyticsWorker";
import type { GenerateConfig, ComputeAnalyticsConfig, MazeSnapshot } from "./types";

const generationPool = new WorkerPool<GenerationRequest, GenerateMazeResult>({
  create: () => new Worker(new URL("./generationWorker.ts", import.meta.url), { type: "module" }),
  failureMessage: "Generation worker failed",
});

const analyticsPool = new WorkerPool<AnalyticsRequest, unknown>({
  create: () => new Worker(new URL("./analyticsWorker.ts", import.meta.url), { type: "module" }),
  failureMessage: "Analytics worker failed",
});

/** Runs generation off the main thread so long WASM calls can provide responsive UI feedback. The
 *  worker stays alive afterwards, so WASM is initialized once per worker rather than per run. */
export function generateMazeAsync(seed: number, config: GenerateConfig): Promise<GenerateMazeResult> {
  return generationPool.run({ seed, config }).promise;
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
}

if (typeof window !== "undefined") window.addEventListener("pagehide", disposeWorkers);
(import.meta as { hot?: { dispose(callback: () => void): void } }).hot?.dispose(disposeWorkers);
