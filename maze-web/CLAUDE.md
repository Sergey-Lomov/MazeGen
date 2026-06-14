# Web Client Architecture Notes

## Feature-Renderer ownership rule

Each feature has exactly one feature-renderer that owns its canvas layers. No feature-renderer may use or depend on another feature's renderer.

If two feature-renderers share logic, extract that logic into a base class or utility — do not share renderer instances.

Examples:
- `GenerationRenderer` — owned by Generation feature only
- `AnalyticsRenderer` — owned by Analytics feature only

If `AnalyticsRenderer` and `GenerationRenderer` share rendering patterns, extract shared code into an abstract base class (e.g., `BaseFeatureRenderer`) that both inherit from.

## GridRenderer — base renderer, never used directly

`GridRenderer` is a low-level primitive. It is **never instantiated directly** from outside the renderer layer.

- `TessellationRenderer` wraps `GridRenderer` for the Tessellation feature. It manages its own visibility (shows grid when no feature card is open). It is the **only** feature-renderer for the tessellation feature.
- All other feature-renderers (GenerationRenderer, AnalyticsRenderer, etc.) **include their own `GridRenderer` instance as the bottom-most layer** directly inside themselves — `new GridRenderer(container)`. NOT via `TessellationRenderer`.
- `TessellationRenderer` is **never used** inside other feature-renderers. No exceptions.
