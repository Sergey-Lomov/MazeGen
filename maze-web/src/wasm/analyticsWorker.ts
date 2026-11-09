import { getWasm } from "./wasmLoader";
import { serveWorker } from "./workerHost";
import type { ComputeAnalyticsConfig } from "./types";

export interface AnalyticsRequest {
  config: ComputeAnalyticsConfig;
}

serveWorker(({ config }: AnalyticsRequest) => ({ result: getWasm().compute_analytics(config) }));
