# Teleport connector routing

How a teleport pair's connecting line is drawn on the web canvas, for the `"orthogonal"` `TeleportConnectorStyle` (GitHub issue #293). Display-only routing concern — not something `maze-core` has any notion of.

## Location

`maze-web/src/pixi/renderers/teleportConnectorAxes.ts` — bend axes per tessellation.
`maze-web/src/pixi/renderers/teleportConnectorRouter.ts` — `TeleportConnectorRouter`, all collision-avoidance routing.
`maze-web/src/pixi/renderers/teleportConnectorRouting.ts` — `routeStraightConnectors` (the `"straight"` style, no bends/collision-avoidance) and arrow placement.
`maze-web/src/pixi/renderers/TeleportRenderer.ts` — draws the routed result.

## Connector styles

- `"straight"` — a direct 2-point line, center to center. No collision avoidance; two collinear connectors can visually overlap.
- `"orthogonal"` — a single-bend polyline (3 points: start, bend, end), bending along one of the active tessellation's own face normals. Collisions between connectors sharing a corridor are avoided via offsetting (see below).

## Bend axes

An orthogonal connector's single bend must run along an axis *perpendicular* to the tessellation's own cell faces (a connector crossing a wall head-on, not running alongside it):

- **Square** — 2 axes, 0°/90° (horizontal/vertical).
- **Hex** — 3 axes, 60° apart. Axis set depends on `orientation`: `flat_top` faces run along {0°,60°,120°} so their normals are {30°,90°,150°}; `pointy_top` is `flat_top` rotated 30°, so its faces run along {30°,90°,150°} and its normals land back on {0°,60°,120°}. The two orientations do **not** share one axis set.
- **Triangle** — 3 axes, {0°,60°,120°}, the same set for every orientation (`r0`/`r90`/`r180`/`r270`).
- **Other kinds** — see `CONNECTOR_AXES` in `teleportConnectorAxes.ts`. Every set must satisfy one rule: no axis line through a cell center may run along a cell edge (a connector would then lie on a wall). Truncated hexagonal (3.12.12) therefore uses only {0°,60°,120°}, the lattice directions; 30°/90°/150° would lie on the shared walls of lattice-neighbor dodecagons. A web test checks this rule for that kind. Truncated trihexagonal (4.6.12) uses {0°,60°,120°} too, checked by a web test.

0°/90° use exact `{1,0}`/`{0,1}` vectors rather than `Math.cos`/`Math.sin` (which land on e.g. `6.123e-17` instead of `0`) — square's offset math relies on an exactly-zero component to keep coordinates exact integers for axis-aligned input.

## Candidate paths and selection

For a connector between `from` and `to`, a candidate single-bend path exists for every ordered pair of distinct (non-parallel) axes from the tessellation's axis set: first leg from `from` along the pair's first axis to the bend (the two axis-lines' intersection), second leg from the bend along the second axis to `to`. Square gives 2 candidates (h-then-v / v-then-h); hex/triangle give 6 (3 axes × 2 ordered non-equal pairs... actually 3×2=6 ordered pairs excluding same-axis pairs).

Selection is **greedy**, not a global optimum:

1. **First pass** — each connector picks its best candidate weighed against every *other* connector's full candidate set (not yet resolved to a single choice), so the first pass doesn't depend on connector processing order.
2. **Refinement passes** (2 more, so 3 total) — each connector re-picks against a *snapshot* of every other connector's actual chosen path from the previous pass (not live-updating mid-pass, to stay order-independent within a pass). Resolves cases where a connector avoided a neighbor's candidate the neighbor never actually chose, missing a cheaper joint rearrangement both would agree to.
3. Capped at a small fixed count rather than iterating to a fixpoint — can still settle into a local optimum, or in principle oscillate, but empirically resolves what a single pass leaves on the table.

"Best" candidate = fewest weighted collisions (see below), ties broken toward shorter total path length, remaining ties toward axis-pair order (earlier pairing wins).

## Collision weighting

Two segments (from possibly-different connectors) collide when they share an axis, the same perpendicular offset from the origin (within floating-point epsilon), and their spans along that axis overlap. Each such overlap counts as 1 collision.

**Endpoint weighting**: a candidate whose actual leg (as a finite line, independent of axis/parallelism — checked via clamped point-to-segment distance, not just same-axis overlap) passes within `endpointRadius` of another connector's own `from`/`to` marker point adds a flat `ENDPOINT_COLLISION_WEIGHT` (3) penalty on top of ordinary mid-path collisions, per colliding other-connector. This makes a path that would visually cut through someone else's marker strongly disfavored even at the cost of a couple of ordinary mid-path overlaps elsewhere.

`endpointRadius` (`endpointCollisionRadius`) = `(markerRadius + markerBorderWidth + connectorGapWidth + connectorWidth/2) * 1.25` — sum of everything that visually extends the marker's on-screen footprint, padded 25% so a colliding path never merely grazes the marker's exact boundary. `TeleportRenderer` folds `TeleportLineStyle.edgeGapWidth` (GitHub issue #302 — the marker's own floor-colored gap ring, see `image-export.md`) into `markerBorderWidth` when building this style, so a connector correctly avoids cutting through the gap ring too, not just the marker/border proper. Computed once per `route()` call, not per candidate/pass comparison. Endpoint weighting is skipped entirely (radius 0) when the caller has no marker style in hand.

**Waypoint weighting** (GitHub issue #300, always on, independent of "avoid field exit"): the same `ENDPOINT_COLLISION_WEIGHT` penalty applies, once per waypoint marker (`route()`'s `waypoints` param), when a candidate's own leg passes within `endpointRadius` of that waypoint's world position — same clamped point-to-segment check as the endpoint weighting above, just against a plain point instead of another connector's own `from`/`to`. `route()` itself has no notion of what a waypoint "is" — every caller builds its own `waypoints` array from whatever markers it renders, so the avoidance set only ever covers what that specific canvas actually draws. As of GitHub issue #518, every `TeleportRenderer` caller that has the relevant marker data in hand feeds it in: start/finish markers (GitHub issue #300, `buildMazeMarkers`'s own `.pos`), vertical passage/elevator markers (`buildVerticalConnectionMarkers`'s own `.pos`), one-way indicator centers (`buildOneWayWallIndicatorPositions` for "Vector by walls"'/the live canvas's wall chevron/arrow/triangle, `buildOneWayCorridorIndicatorPositions` for "Vector by corridors"' chevron row — both the same segment midpoint the renderer itself draws the indicator at), and split junction hub centers (`buildSplitJunctionPositions`, one per distinct `SplitPassage.pointKey`). A caller with no such markers of its own (e.g. the preset-connections canvas has no one-way wall indicator concept) simply omits that source — nothing to avoid there.

All six call sites assemble their `waypoints` array through one shared helper, `buildTeleportAvoidanceWaypoints` (`selectors/mazeSelectors/teleport.ts`), rather than each hand-rolling the same concatenation: it takes each source above as an independent optional field (`markers`, `verticalMarkers`, `oneWayWallEdges` + `cfg`, `oneWayCorridorSegments`, `splitPassages`) and flattens whichever ones are provided into the final array, so a caller only has to pass the sources it actually has.

## Avoid field exit (GitHub issue #300)

An optional top-priority penalty, off by default, toggled via Export → Vector by walls → Teleports → Connector's "Avoid field exit" (only shown while `teleportConnectorStyle` is `"orthogonal"`). When on, a candidate whose path strays outside the maze field's own cell footprint at any point gets a flat `FIELD_EXIT_WEIGHT` (1,000,000) penalty — large enough to outrank every other weight (mid-path collisions, endpoint/waypoint collisions, length) combined, so a connector prefers any in-field detour over stepping outside, falling back to an out-of-field path only when every candidate leaves the field.

"Inside the field" is checked against the union of the maze's own cell polygons (`getCellVertices`, `tessellationGeometry.ts`), not a bounding box — a non-rectangular field (hex/triangle shapes, custom field outlines) is respected exactly. A candidate's own two segments are sampled at fixed intervals (`FIELD_EXIT_SAMPLE_STEP`, 10 world units — a quarter tile) plus both segment endpoints; a candidate "leaves the field" if any sampled point falls outside every cell's polygon (ray-casting point-in-polygon, inclusive of a cell's own edge). Sampling (rather than an endpoint-only check) is what catches a bend that cuts across a concave notch in the field's own outline mid-leg, not just at its ends.

`route()`'s `fieldCells` param (the maze's own node cell coordinates) backs this check; empty or omitted with `avoidFieldExit` on is the same as leaving the toggle off — nothing to be outside of, so no candidate is ever penalized.

**Checked against the drawn line's own visual width, not its centerline.** A connector draws as a real stroked line, `connectorWidth / 2 + connectorGapWidth` wide on each side of its centerline (see `TeleportRenderer`'s own `connectorWidth + connectorGapWidth * 2` full-width draw call) — the field-exit check offsets each sampled point perpendicular to its own segment's axis by that half-width (`fieldExitLineHalfWidth`) and requires *both* offset points to stay inside the field, not just the centerline itself. A candidate whose centerline stays just inside the field but whose drawn border would visibly poke outside it (e.g. running flush along the field's own edge) is still flagged as leaving the field. `fieldExitLineHalfWidth` derives from the same `endpointStyle` (`connectorWidth`/`connectorGapWidth`) `route()` already takes for endpoint-collision weighting — omitted entirely, the check falls back to the centerline only.

Sampling against `cellPolygons` is a plain linear scan per point, no spatial index — cheap for the maze sizes exercised so far, but scales with cell count × sample count × candidate count × refinement passes when the toggle is on; worth a spatial bucket (keyed by cell coordinate) if a large maze with this toggle enabled turns out slow in practice.

## Corridor offsetting

Once every connector's path is chosen, segments that share an axis, perpendicular offset, and overlapping span are clustered together via union-find across all connectors (not within a single connector). Each cluster's members are offset symmetrically perpendicular to their shared axis by `gap * (localIndex - (clusterSize - 1) / 2)`, ordered by connector index for determinism. A segment with nothing to share a corridor with stays in a cluster of size 1 (zero offset) — the majority of connectors draw exactly on-grid.

A connector's bend point is nudged by both of its segments' own offsets in sequence (unclamped — no marker to stay inside at the bend). Its start/end points are nudged only by their own segment's offset, clamped to `maxEndpointOffset` (the teleport marker's own true visual radius — fill radius plus border plus edge gap width, GitHub issue #302: `size*TILE_SIZE + borderWidth + edgeGapWidth`, not just the fill radius) so a large cluster can't visibly drift a connector's endpoint outside its own marker (gap ring included).

## Degenerate bend snapping

When `from`/`to` are collinear with one of the two candidate axes, that axis's own leg is geometrically degenerate (zero length) — but the bend point is computed via `axisIntersection`'s line-intersection division, which can land a few ULPs off the exact `from`/`to` coordinate instead of exactly on it. A stroked segment with a sub-epsilon but nonzero length still has *some* direction (pure floating-point noise), which a round line-join draws as a visible spike jutting out from the shared endpoint.

Fix: once a computed bend point is numerically within `AXIS_EPSILON` (1e-6) of `from` or `to`, it is snapped exactly onto that point — collapsing the degenerate leg to a true zero-length point, so the renderer draws a clean two-point line instead of a spike.

## Caching

`TeleportConnectorRouter` caches its last result against a structural (value-based, not reference-based) key of `(edges, gap, maxEndpointOffset, cfg, endpointStyle, waypoints, avoidFieldExit, fieldCells)`. Building the key is O(edge count), cheap relative to the routing itself (O(edge count² × axis count²) for the first pass alone) — cheap enough that a caller rebuilding its own `edges` array from scratch every render (same content, different reference) still gets a cache hit without needing to keep a stable array reference itself. One `TeleportConnectorRouter` instance lives per `TeleportRenderer`.

## Connector and floor badge color

Without group customization a connector is drawn in `style.connectorColor` and a cross-floor badge in `style.floorBadge.fillColor`/`borderColor`. With group customization on (`TeleportRenderer`'s `groupCustomization`), both always follow the group's border: `override.borderColor` when the (resolved, see `store/teleportGroupLinks.ts`) group override carries one, otherwise the common marker border (`style.edgeBorderColor`). A connector between two groups' endpoints takes the first endpoint's override. The common connector/badge colors therefore do not apply to teleports while customization is on, and toggling a group's border link can never change a connector's color on its own (GitHub issue #729). In the settings panel the common connector color row (and the floor badge fill/border rows) are disabled with an explanatory tooltip while customization is on.
