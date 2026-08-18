# Decomposition review — open questions

Questions I could not resolve myself while decomposing/refactoring. Only real blockers go here.

## Pre-existing tsc errors (not mine, found while typechecking qualityI18n split)

`src/debug/algorithmRegistry.ts:56` and `:778` — "Function lacks ending return statement" — confirmed pre-existing (present before any of my changes, via git stash check). Not touched. Flag for separate fix if wanted.

## Found duplication (not fixed, out of scope for a decomposition pass)

`mazeSelectors/walls.ts` (buildMazeWalls) and `mazeSelectors/corridors.ts` (buildCorridorSegments) both build a near-identical `directed` edge-pair Set by filtering out teleport edges and mapping to `"x,y->x,y"` string keys. Could share a helper. Left as-is since deduping changes behavior-adjacent code, not just moving it — wanted to flag rather than risk it silently.
