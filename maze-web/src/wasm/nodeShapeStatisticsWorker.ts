import { getWasm } from "./wasmLoader";
import { serveWorker } from "./workerHost";
import type { NodeShapeStatisticsRequest, NodeShapeCountDto } from "./types";

export interface NodeShapeStatisticsWorkerRequest { request: NodeShapeStatisticsRequest; }

serveWorker(({ request }: NodeShapeStatisticsWorkerRequest) => ({
  result: getWasm().node_shape_statistics(request) as NodeShapeCountDto[],
}));
