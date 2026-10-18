# Element Tools (Presets and Post-Edit)

GitHub issue #748. Shared interaction rules for the tools that place, move, and configure maze
elements in the Preset Connections card (`Specs/preset-connections.md`) and the Post-Edit card
(`Specs/post-edit.md`). Where those specs describe older click semantics, this document wins.

"Element" means a point-anchored entity: start, finish, generation source (presets only), a
teleport endpoint, a vertical-passage endpoint, an elevator stop, a lock (presets only), or a whole
split tile.

## Placement tools

Placement tools (`set_start`, `set_finish`, `gen_source`, teleport, vertical-passage, elevator, and
lock tools) only create elements. They never edit an existing one.

- **Every click adds an element.** A cell may hold any number of elements; there are no allowed or
  forbidden combinations. Clicking a cell that already holds elements adds the tool's own element
  next to them — a second teleport start, a second vertical passage to the same floor, a second
  elevator at the same point. A start, finish, or generation source is a single marker, so clicking
  places (or re-places) that marker; it never clears it.
- **No toggles.** `gen_source` no longer clears the source on a second click, and a lock tool
  always sets its own kind (it never removes a lock of the same kind). Removal is RMB or the
  `clear`/`delete` tools; changing a lock's kind is the settings tool's job.
- **The one-way tool creates or reverses.** It turns a wall/passage/undecided edge into a forward
  one-way edge, and a repeated click on a one-way edge reverses it. The settings tool reverses too
  (`one_way_flip` edge mode — `applyTool` on presets, `applyPostEditToolAt` on post-edit), but never
  changes an edge that is not one-way.
- **Vertical passages** offer every direction that has a cell on the adjacent floor, regardless of
  passages already there. Two passages between the same nodes are two elements; opposite one-way
  passages together behave as a two-way connection. If neither adjacent floor has a cell at the
  selected point, placement does not change the maze and shows a notice explaining that no
  neighboring floor has a cell to connect.
- **Press-drag still moves.** A press on an existing element arms a drag of the first element by
  the hit-test priority (start, finish, teleport, vertical passage, elevator). Releasing in the same
  cell is a click (adds the tool's element at the pressed cell); leaving the cell, even off the
  field, makes it a drag and never a placement.
- **Lock tools drag locks.** A lock-tool press on a cell whose original node holds a user lock arms
  a drag of that lock (`draggingLock`, `lock` drag override). Released in place it is a click and
  sets the tool's kind; dropped elsewhere it moves the lock with its kind (`movePresetLockTo`). A
  lock already on the target node is replaced. On a split tile the press still opens the node
  picker; locks on split nodes are moved with the move tool. The live preview substitutes the lock
  through `lockedNodesWithMovedLock` (`fieldEditUtils.ts`).
- Split tiles keep the node picker: a left click on a split tile asks which node the new element
  attaches to before placing anything.

## Toolbar order

`move` and `settings` sit at the end of the tool row, right before the removal tool (`clear` on
presets, `delete` on post-edit).

## Move tool

`move` (four-arrow glyph) relocates elements, including elements on any node of a split tile.

- A left press on a cell lists the cell's movable elements across every node of a split tile
  (`presetEntitiesForPurpose`/`postEditEntitiesForPurpose`, `pixi/entityToolKinds.ts`): start,
  finish, generation source (presets), teleport endpoints, vertical-passage endpoints, and elevator
  stops, and user locks (presets). Auto locks, edges, and split tiles are not movable.
- **One element:** the press picks it up. Dragging and releasing elsewhere drops it there in one
  gesture. Releasing without leaving the cell starts **carrying**: the element follows the pointer
  with no button held, and the next left click drops it.
- **Several elements:** the press opens the pick dialog (`presetEntityPickPrompt` /
  `postEditEntityPickPrompt`, `PresetEntityPickDialog` / `PostEditEntityPickDialog`); the chosen
  element is carried immediately (`presetMoveRequest` / `postEditMoveRequest`, taken by the
  controller on its next pointer event).
- **Cancel:** Escape or a right click while carrying cancels without changing anything. Switching
  tools also cancels, and so does switching the active floor (both controllers subscribe to
  `activeFloorId`): an element never drops onto another floor's coordinates.
- The preview uses the same drag override as press-drag (`presetDragOverride` /
  `postEditDragOverride`). Nothing is committed until the drop, so cancelling leaves no trace.
  Preset teleport endpoint drags use the `teleportEndpoint` override too; they are committed once on
  release (`movePresetTeleportEndpointTo`).
- **Dropping on a split tile** opens the node picker for the landing node(s), exactly like a fresh
  placement. On presets this covers start, finish, the generation source (`movePresetMarker`), and
  teleport endpoints (`move_teleport_endpoint` split-target action), and locks (`move_lock`);
  vertical passages and elevators already used it. The drop preview stays visible until the pick or cancel.
- Drop rules match placement: an element can be dropped on any cell, whatever it holds. The
  existing structural limits remain: a teleport endpoint cannot land on its own other endpoint, and
  a vertical passage or elevator cannot move to a point missing on one of its other floors.
- A teleport endpoint may land on the split tile that holds its other endpoint: the node picker
  leaves out the other endpoint's node (`excluded` on presets, `excludedNodeId` on post-edit,
  filtered by `shownSplitTargets`, which keeps every other node's own color and name), and when a
  single node remains it is used without a prompt. So both endpoints of one teleport can sit on
  different nodes of the same split tile.

## Settings tool

`settings` (gear glyph; tooltip just "Settings") edits the parameters of existing elements.

- **Hover** highlights only configurable targets: a one-way edge between unsplit cells when the
  cursor is near it, otherwise the cell when it holds a configurable element. Walls, passages, and
  cells without configurable elements are not highlighted. The edge vertex dead zone suppresses the
  cell fallback. The per-cell check is cached per store snapshot and cell, since hover runs on every
  pointer move.
- **One-way edge:** a click reverses its direction.
- **Cell:** a click lists the configurable elements across every node of a split tile. One element
  opens its settings directly; several open the pick dialog first.
- The pick dialog (both tools) keeps every row on one line and is exactly as wide as its widest
  row (`compact` mode of `EntityChoiceDialog`, the `fit` dialog size); the short hint wraps to that
  width instead of widening it.
  - **Teleport / vertical passage** — `ConnectionSettingsDialog`: two-way, one-way `from -> to`,
    or one-way `to -> from`, with the current option highlighted. Picking applies and closes. The
    rows form a table (a CSS subgrid): every row shows the `from` bubble first and the `to` bubble
    second at the same x, and only the arrow (`<->`, `->`, `<-`) shows the direction. The last
    column takes any spare width, so the rows span the whole dialog when the title is wider. Vertical
    passage bubbles show only the floor (`L2`), since both endpoints share their coordinates.
    Presets: `setPresetTeleportDirection` / `setPresetVerticalPassageDirection`. Post-edit:
    `setPostEditTeleportDirection` / `setPostEditVerticalPassageDirection`, which append an
    `absolute` direction command (see below).
  - **Elevator** — the existing floor dialog in edit mode (`editPresetElevator` /
    `editPostEditElevator`), seeded with the elevator's current floors.
  - **Lock** (presets) — `PresetLockSettingsDialog` ("Lock settings"; "Настройки блокировки" in
    Russian): in, out, or full lock
    (`setPresetLockKind`).
  - **Split tile** — switches to the `manage_split_nodes` tool and opens its panel for the point.
    The split-node tool stays: it is the only way to create a split.
  - Start, finish, and the generation source have no settings and are not listed.

## Post-edit absolute direction commands

`setTeleportDirection` and `setVerticalPassageDirection` carry an optional `absolute: true`. With
it, `direction` is the resulting direction and replay applies it as-is, so it can switch between
two-way and one-way. Without it, the command keeps its original meaning (a forward/backward flip;
for vertical passages `direction` is the pre-click value). Compaction treats an absolute command as
superseding every earlier direction command of the same entity; only flips after the latest
absolute command still pair up. Project files store the flag; it is validated as `true` when
present.

## Dialog lifecycle

The pick dialog and the settings dialogs block canvas pointer input while open, close on Escape,
and are reset by a tool switch, `resetPresetConnections`/`resetPostEdit`, a tessellation-kind
change, an orientation flip, and project load. Post-edit additionally closes them when leaving the
card.
