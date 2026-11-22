# Loading screen

Maze Studio presents one visually consistent loading screen from the initial HTML response until the Pixi canvas and its default MSDF font are ready. `index.html` owns the screen before JavaScript runs; the React `LoadingScreen` immediately replaces it after the app module mounts and fades out after readiness. Both use the app background and matching text line heights, colors, and spacing so this ownership handoff does not darken or compress the layout.

The screen reports these sequential stages: WASM engine, interface, graphics, and label fonts. The WASM stage tees the response body: one branch reports downloaded bytes when `Content-Length` is available, while the other preserves wasm-bindgen's streaming compilation. If the server omits that header, the same bar is indeterminate. The remaining stages use an indeterminate indicator because module evaluation and WebGL setup have no meaningful byte total.

If the WASM stage fails, the screen stays up: the progress bar is replaced by a red, localized error message and a `loading.retry` button (`showBootScreenError`, `startup/bootScreen.ts`). `WasmLoadError` classifies the failure at its source: a failed request or ordinary HTTP failure is **Server unavailable**; HTTP 404 means the engine binary is missing, 401/403 means access is denied, a compilation failure means the binary is invalid, and JavaScript-module or WASM-instantiation failures describe the affected startup stage. The original reason goes to the console. Clicking the button restores the loading state and `main.tsx` tries again, repeating until the engine loads; the app is never mounted without it, because the store builds its initial field through WASM at module load. If the screen elements are missing, `showBootScreenError` waits one second before resolving so the retry loop cannot spin.

Registry loading is deliberately outside this readiness gate. It runs in the background, and its existing notification/retry flow reports a failure without preventing use of the editor, except for loading a project: `loadProject` waits for the registry and is refused with an error toast if it cannot be loaded (GitHub issue #967, see `Specs/project-file.md`).

When an opened project contains a generated maze, its deterministic regeneration uses the same
worker-backed `generateWithSeedAsync` path as an ordinary Generate action. The existing
`GenerationProgressOverlay` therefore covers the loading work too: it is titled **Loading project**
and stays open through the final analytics pass. That pass suppresses its ordinary background-task
card, so a large project never blocks the main thread before the familiar progress dialog can
render and no duplicate loading feedback or parallel overlay implementation is maintained. Loading
a project is not cancellable: cancelling only its regeneration worker could leave the newly-applied
project configuration without its required generated and analytics state, so the overlay shows no
Cancel button for the whole load.
(GitHub issue #1026).
