import { generateMaze } from "./mazeService";
import { initWasm } from "./wasmLoader";
import type { GenerateConfig } from "./types";

interface GenerationRequest {
  seed: number;
  config: GenerateConfig;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<GenerationRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = async (event: MessageEvent<GenerationRequest>) => {
  try {
    await initWasm();
    const result = generateMaze(event.data.seed, event.data.config);
    const transfer: ArrayBuffer[] = [];
    if (result.debugTape) {
      transfer.push(result.debugTape.nodeTable.buffer, result.debugTape.payload.buffer);
    }
    workerScope.postMessage(result, transfer);
  } catch (error) {
    workerScope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
