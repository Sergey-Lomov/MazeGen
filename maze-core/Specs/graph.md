# Graph

## Purpose

Pure connectivity structure. No geometry, no coordinates, no tessellation knowledge. Owns nodes and edges.

## Types

### Node

`{ id: NodeId }` — identity only. Coordinates live in `Field`, not here.

### EdgeKind

Enum describing the semantic type of a connection:
- `Basic` — standard passage, current default
- Future variants: `Bridge`, `Teleport`, `Door` — added when rules are implemented

### Edge

`{ id: EdgeId, from: NodeId, to: NodeId, kind: EdgeKind }` — directed connection from one node to another.

### Graph

Internal structure:
- `nodes: Vec<Node>` — all nodes
- `edges: Vec<Option<Edge>>` — source of truth; `None` = tombstone (removed edge)
- `outgoing: HashMap<NodeId, Vec<EdgeId>>` — maps NodeId → EdgeIds of edges leaving that node
- `incoming: HashMap<NodeId, Vec<EdgeId>>` — maps NodeId → EdgeIds of edges entering that node

`outgoing` and `incoming` are always consistent with `edges`. Only `add_edge` and `remove_edge` mutate them — no external access.

## API

- `add_node(id)` — registers a node; initializes empty outgoing and incoming lists
- `add_edge(from, to, kind) -> EdgeId` — directed: pushes EdgeId into `outgoing[from]` and `incoming[to]` only
- `add_bidirectional_edge(a, b, kind) -> (EdgeId, EdgeId)` — calls `add_edge(a,b,kind)` then `add_edge(b,a,kind)`; returns both EdgeIds. Caller manages lifecycle of both edges independently.
- `remove_edge(id)` — tombstone: sets `edges[id] = None`, removes id from `outgoing[edge.from]` and `incoming[edge.to]`. Does not touch the reverse edge — caller is responsible for managing pairs.
- `outgoing_neighbors(node) -> Iterator<NodeId>` — nodes reachable via outgoing edges
- `incoming_neighbors(node) -> Iterator<NodeId>` — nodes that have an edge pointing to this node
- `edge_between(from, to) -> Option<EdgeId>` — O(degree) scan through `outgoing[from]`
- `node_count() -> usize`
- `nodes() -> Iterator<&Node>`
- `edges() -> Iterator<&Edge>` — filters tombstones

## Invariants

- Every edge is directed: `from` → `to`.
- A bidirectional corridor is represented as two independent directed edges — there is no implicit reverse.
- EdgeId is stable: tombstone on removal, never swap-remove.
- Graph does not generate NodeIds — it accepts them from outside (Field via IdGenerator).
- `debug_assert!` in `add_edge` verifies both endpoints exist in the graph (zero-cost in release).
