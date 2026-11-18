# Zones

A zone is a named set of cells with a stable id and a kind. Consumers (the zones feature renderer,
the export renderer, QC rules) reference a zone by id and ask which zones a cell belongs to
(GitHub issue #1029). UI, editing and persistence are out of scope and tracked separately.

## Core model

Module: `maze-core/src/space/zone.rs`, generic over the tessellation's `CellId`.

- **`ZoneId(u32)`** — stable id minted by the `ZoneSet`; never reused, never renumbered when other
  zones are added or removed. `ZoneSet::from_zones` restores zones that already carry ids (a client
  snapshot), rejects a duplicate id and mints later ids above every given one.
- **`ZoneKind`** — `Auto` (derived by the application) or `Manual` (drawn by the user).
- **`ZoneCell { floor, cell }`** — `floor` is the index in the client's `floors` array (the position
  in `MultiLevelField::levels_ordered`, not a `LevelId`: zones are built before any field exists
  and wasm is stateless). It is valid only until floors are added, removed or reordered.
- **`Zone`** — id, `name`, `kind` and a deduplicated, ordered cell set. An empty zone is allowed.
- **`ZoneSet`** — zones in insertion order. Zones may overlap. `zones_of(floor, cell)` scans.
- **`ZoneIndex::build(&ZoneSet)`** — cell-to-zones lookup for repeated queries (hover, per-cell
  consumers); returns ids in zone order, empty for a cell in no zone.

## WASM API (`maze-wasm/src/zones.rs`)

Stateless: the web store owns the zones and sends them with every call. Cells are `[floor, x, y]`
(`[x, y]` is the tessellation's wire point); every `[x, y]` must be a cell of the tessellation.

- `zones_normalize({ tessellation, zones })` → zones with cells deduplicated and in core order.
  Errors: `zone <id>: invalid cell [x, y]`, `invalid floor <n>`, `duplicate zone id <id>`.
- `zones_of_cells({ tessellation, zones, cells })` → `number[][]`, entry `i` the zone ids of
  `cells[i]` in zone order.

## Field filtering

Core rejects a cell outside the field, so the web drops such cells before sending zones, the same
approach as the preset filters (`buildValidPresetConnections`): `filterZonesToField(zones,
resolveFieldAt)` (`pixi/fieldValidity.ts`) removes cells whose point is not a cell of their floor's
field or whose floor no longer exists. Zone ids, names, kinds and order are kept; a zone left with
no cells stays, so its id remains stable.

## Web mirror

`maze-web/src/wasm/mazeService.ts`: `Zone`, `ZoneKind`, `ZoneCellWire`, `normalizeZones`,
`getZonesOfCells`.
