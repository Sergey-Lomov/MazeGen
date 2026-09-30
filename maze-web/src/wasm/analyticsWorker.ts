import { getWasm, initWasm } from "./wasmLoader";
import type { ComputeAnalyticsConfig } from "./types";

interface AnalyticsRequest {
  config: ComputeAnalyticsConfig;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<AnalyticsRequest>) => void) | null;
  postMessage(message: unknown): void;
}

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = async (event: MessageEvent<AnalyticsRequest>) => {
  try {
    await initWasm();
    workerScope.postMessage(getWasm().compute_analytics(event.data.config));
  } catch (error) {
    workerScope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
