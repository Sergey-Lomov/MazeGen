import { generateMaze } from "./mazeGeneration";
import { serveWorker } from "./workerHost";
import type { GenerateConfig } from "./types";

export interface GenerationRequest {
  seed: number;
  config: GenerateConfig;
}

serveWorker(({ seed, config }: GenerationRequest, reportProgress) => {
  const result = generateMaze(seed, config, reportProgress);
  const transfer: ArrayBuffer[] = [];
  if (result.debugTape) {
    transfer.push(result.debugTape.nodeTable.buffer, result.debugTape.payload.buffer);
  }
  return { result, transfer };
});
