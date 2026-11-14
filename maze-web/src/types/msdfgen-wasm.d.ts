declare module "@playcanvas/msdfgen-wasm" {
  export function createMsdfgen(options?: { moduleOverrides?: Record<string, unknown> }): Promise<{
    loadFont(bytes: Uint8Array | ArrayBuffer): unknown;
  }>;
}

declare module "@playcanvas/msdfgen-wasm/msdfgen.wasm?url" {
  const url: string;
  export default url;
}
