# Maze

## Purpose

Central data container. Pairs a Field with a Graph — neither is meaningful without the other. The result of generation, the input to validation, rules, and IO.

## Type

```rust
pub struct Maze<F: Field> {
    pub field: F,
    pub graph: Graph,
}
```

Generic over `F: Field` — supports any tessellation and topology without code changes in validation, rules, or IO (except tessellation-specific renderers).

## Lifecycle

1. Create field and populate node mappings: `let field = SquareField::new(size, &mut ids)`
2. Create graph and register nodes: `let mut graph = Graph::new(); field.build_nodes(&mut graph)`
3. Wrap: `let mut maze = Maze { field, graph }`
4. Generate edges: `generate_maze(&mut maze.graph, &maze.field, seed, start)`
5. Validate: `is_connected(&maze.graph, start)`
6. Render / export / apply rules

## Design Notes

- `Maze` is a data container, not an orchestrator. It does not own the pipeline.
- Caller is responsible for the sequence: build → generate → validate.
- Future: rules operate on `&mut Maze`, may add nodes and edges beyond the original field topology.
