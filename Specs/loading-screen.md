# Loading screen

Maze Studio presents one visually consistent loading screen from the initial HTML response until the Pixi canvas and its MSDF fonts are ready. `index.html` owns the screen before JavaScript runs; the React `LoadingScreen` immediately replaces it after the app module mounts and fades out after readiness.

The screen reports these sequential stages: WASM engine, interface, graphics, and label fonts. The WASM stage tees the response body: one branch reports downloaded bytes when `Content-Length` is available, while the other preserves wasm-bindgen's streaming compilation. If the server omits that header, the same bar is indeterminate. The remaining stages use an indeterminate indicator because module evaluation and WebGL setup have no meaningful byte total.

Registry loading is deliberately outside this readiness gate. It runs in the background, and its existing notification/retry flow reports a failure without preventing use of the editor.
