# Graph

## Purpose

Pure connectivity structure. No geometry, no coordinates, no tessellation knowledge. Owns nodes and edges.

## Types

### Node

`{ id: NodeId }` — identity only. Coordinates live in `Field`, not here.

### EdgeKind

Enum describing the semantic type of a connection:
- `Basic` — standard passage, current default
- Future variants: `Bridge`, `Teleport`, `OneWay`, `Door` — added when rules are implemented

### Edge

`{ id: EdgeId, a: NodeId, b: NodeId, kind: EdgeKind }` — undirected connection between two nodes.

### Graph

Internal structure:
- `nodes: Vec<Node>` — all nodes
- `edges: Vec<Option<Edge>>` — source of truth; `None` = tombstone (removed edge)
- `adjacency: Vec<Vec<EdgeId>>` — index: `adjacency[node_index]` = list of EdgeIds for that node
- `node_index: HashMap<NodeId, usize>` — maps NodeId → index in nodes/adjacency

## API

- `add_node(id)` — registers a node with a given NodeId (provided by Field)
- `add_edge(a, b, kind) -> EdgeId` — undirected: writes EdgeId into adjacency of both nodes
- `remove_edge(id)` — tombstone: sets `edges[id] = None`, removes id from adjacency of both endpoints
- `neighbors(node) -> Iterator<NodeId>` — via adjacency → live edges → other endpoint
- `edge_between(a, b) -> Option<EdgeId>` — O(degree) scan through adjacency[a]
- `node_count() -> usize`
- `nodes() -> Iterator<&Node>`
- `edges() -> Iterator<&Edge>` — filters tombstones

## Invariants

- Graph is undirected: every edge appears in adjacency of both endpoints.
- EdgeId is stable: tombstone on removal, never swap-remove.
- Graph does not generate NodeIds — it accepts them from outside (Field via IdGenerator).
