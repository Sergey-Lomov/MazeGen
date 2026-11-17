import { serveWorker } from "./workerHost";
import { computePrintSizing, type PrintSizingRequest } from "../pixi/printSizingJob";

serveWorker((request: PrintSizingRequest) => ({ result: computePrintSizing(request) }));
