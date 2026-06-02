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

1. Create field: `let mut field = SquareField::new(size)`
2. Build graph (nodes only): `let graph = field.build_graph(&mut ids)`
3. Wrap: `let mut maze = Maze { field, graph }`
4. Generate edges: `generate_maze(&mut maze.graph, &maze.field, seed, start)`
5. Validate: `is_connected(&maze, start)`
6. Render / export / apply rules

## Design Notes

- `Maze` is a data container, not an orchestrator. It does not own the pipeline.
- Caller is responsible for the sequence: build → generate → validate.
- Borrow checker: to call `generate_maze`, destructure maze first:
  ```rust
  let Maze { ref mut graph, ref field } = maze;
  generate_maze(graph, field, seed, start);
  ```
- Future: rules operate on `&mut Maze`, may add nodes and edges beyond the original field topology.
