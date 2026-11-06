/** Dependency-tracked memoization of a function of one "settings" tree (GitHub issue #928).
 *
 *  `trackedMemo(slot, inputs, settings, compute)` runs `compute` against a read-recording view of
 *  `settings`. The recorded reads (leaf values, key sets, `in` checks) are the function's dependency
 *  set; the next call with the same `slot` returns the cached result as long as every recorded read
 *  still yields the same observation in the new `settings` and `inputs` (shallow, `Object.is`) are
 *  unchanged. A change to any field the function never read cannot invalidate it, so callers do not
 *  maintain dependency lists by hand.
 *
 *  Contract:
 *  - `settings` is immutable (plain objects and arrays, replaced rather than mutated, like the store's
 *    state). Anything else a function reads must be listed in `inputs`.
 *  - The view is only live while `compute` runs; afterwards it passes reads through unrecorded. A result
 *    must not contain view objects (checked in paranoid mode).
 *  - Class instances, Maps, Sets, functions are not wrapped: they count as one leaf compared by identity.
 *  - One memo call never runs inside another. */

type Entry = { node: ReadNode } | { leaf: unknown };

interface ReadNode {
  /** The object last verified against this node's reads; equal reference means nothing below changed. */
  ref: object;
  isArray: boolean;
  children: Map<string, Entry>;
  has: Map<string, boolean>;
  /** Own string keys observed through `ownKeys` (spread, `Object.keys`, `for in`, ...). */
  keys: string[] | null;
}

interface Slot<R> {
  inputs: readonly unknown[];
  root: ReadNode;
  result: R;
}

export interface TrackedMemoSlotStats {
  hits: number;
  misses: number;
  /** Why the last miss happened: `"first"`, `"input <i>"` or the settings path that changed. */
  lastMiss: string | null;
}

const MAX_SLOTS = 4096;
const slots = new Map<string, Slot<unknown>>();
const stats = new Map<string, TrackedMemoSlotStats>();
let paranoid = false;
let running = false;

const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

function isTrackable(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownStringKeys(target: object): string[] {
  return Reflect.ownKeys(target).filter((key): key is string => typeof key === "string");
}

const trackedViews = new WeakSet<object>();

function readOnly(): never {
  throw new TypeError("tracked settings are read-only");
}

function createView(node: ReadNode, ctx: { active: boolean }): object {
  const childViews = new Map<string, object>();
  const raw = node.ref as Record<string, unknown>;
  const childNode = (key: string, value: object): ReadNode => {
    const existing = node.children.get(key);
    if (existing && "node" in existing) return existing.node;
    const created: ReadNode = { ref: value, isArray: Array.isArray(value), children: new Map(), has: new Map(), keys: null };
    node.children.set(key, { node: created });
    return created;
  };
  const read = (key: string): unknown => {
    if (!hasOwn(raw, key)) {
      if (key in raw) return Reflect.get(raw, key);
      if (ctx.active) node.children.set(key, { leaf: undefined });
      return undefined;
    }
    const value = raw[key];
    if (!ctx.active) return value;
    if (isTrackable(value)) {
      let view = childViews.get(key);
      if (!view) {
        view = createView(childNode(key, value), ctx);
        childViews.set(key, view);
      }
      return view;
    }
    node.children.set(key, { leaf: value });
    return value;
  };
  const view = new Proxy(Array.isArray(raw) ? [] : {}, {
    get: (_target, key) => (typeof key === "symbol" ? Reflect.get(raw, key) : read(key)),
    has: (_target, key) => {
      const result = Reflect.has(raw, key);
      if (ctx.active && typeof key === "string") node.has.set(key, result);
      return result;
    },
    ownKeys: () => {
      const keys = Reflect.ownKeys(raw);
      if (ctx.active) node.keys = keys.filter((key): key is string => typeof key === "string");
      return keys;
    },
    getOwnPropertyDescriptor: (_target, key) => {
      const desc = Reflect.getOwnPropertyDescriptor(raw, key);
      if (typeof key === "symbol") return desc;
      if (!desc) {
        if (ctx.active && !(key in raw)) node.children.set(key, { leaf: undefined });
        return undefined;
      }
      if ("value" in desc) desc.value = read(key);
      // The empty stand-in target forbids reporting a property as non-configurable unless it has one: only an array's `length`.
      if (!(Array.isArray(raw) && key === "length")) desc.configurable = true;
      return desc;
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(raw),
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
    setPrototypeOf: readOnly,
    preventExtensions: readOnly,
  });
  trackedViews.add(view);
  return view;
}

/** The failing settings path, or null when every read of `node` still holds in `current`. */
function validate(node: ReadNode, current: object, path: string): string | null {
  if (current === node.ref) return null;
  const target = current as Record<string, unknown>;
  if (node.keys) {
    const keys = ownStringKeys(target);
    if (keys.length !== node.keys.length || keys.some((key, i) => key !== node.keys![i])) return `${path}.<keys>`;
  }
  for (const [key, present] of node.has) {
    if (Reflect.has(target, key) !== present) return `${path}.<has ${key}>`;
  }
  for (const [key, entry] of node.children) {
    const childPath = path === "" ? key : `${path}.${key}`;
    const own = hasOwn(target, key);
    if (!own && key in target) return childPath;
    const value = own ? target[key] : undefined;
    if ("node" in entry) {
      if (!isTrackable(value) || Array.isArray(value) !== entry.node.isArray) return childPath;
      const failure = validate(entry.node, value, childPath);
      if (failure !== null) return failure;
    } else if (!Object.is(value, entry.leaf)) {
      return childPath;
    }
  }
  node.ref = current;
  return null;
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
  return -1;
}

function statsOf(slot: string): TrackedMemoSlotStats {
  let entry = stats.get(slot);
  if (!entry) {
    entry = { hits: 0, misses: 0, lastMiss: null };
    stats.set(slot, entry);
  }
  return entry;
}

function containsView(value: unknown, seen: Set<unknown>): boolean {
  if (value === null || typeof value !== "object") return false;
  if (trackedViews.has(value)) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const child of Object.values(value)) if (containsView(child, seen)) return true;
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => hasOwn(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function run<S extends object, R>(settings: S, compute: (tracked: S) => R, slotName: string): { result: R; root: ReadNode } {
  if (running) throw new Error(`trackedMemo "${slotName}" runs inside another trackedMemo`);
  const root: ReadNode = { ref: settings, isArray: Array.isArray(settings), children: new Map(), has: new Map(), keys: null };
  const ctx = { active: true };
  running = true;
  try {
    const result = compute(createView(root, ctx) as S);
    if (containsView(result, new Set())) throw new Error(`trackedMemo "${slotName}": the result holds a tracked settings view`);
    return { result, root };
  } finally {
    ctx.active = false;
    running = false;
  }
}

/** Memoizes `compute(settings)` under `slot`; see the file header for the contract. Keep one slot per
 *  distinct computation and per entity it runs for (the last value of each slot is all that is kept). */
export function trackedMemo<S extends object, R>(slot: string, inputs: readonly unknown[], settings: S, compute: (tracked: S) => R): R {
  const entry = statsOf(slot);
  const cached = slots.get(slot) as Slot<R> | undefined;
  let reason = "first";
  if (cached) {
    const changedInput = sameInputs(cached.inputs, inputs);
    if (changedInput >= 0) reason = `input ${changedInput}`;
    else {
      const failure = validate(cached.root, settings, "");
      if (failure === null) {
        entry.hits++;
        slots.delete(slot);
        slots.set(slot, cached);
        if (paranoid) {
          const fresh = run(settings, compute, slot).result;
          if (!deepEqual(fresh, cached.result)) throw new Error(`trackedMemo "${slot}": cached result is stale (a read escaped tracking)`);
        }
        return cached.result;
      }
      reason = failure === "" ? "<root>" : failure;
    }
  }
  entry.misses++;
  entry.lastMiss = reason;
  const { result, root } = run(settings, compute, slot);
  slots.delete(slot);
  slots.set(slot, { inputs, root, result });
  if (slots.size > MAX_SLOTS) {
    const evicted = slots.keys().next().value as string;
    slots.delete(evicted);
    stats.delete(evicted);
  }
  return result;
}

const inputSlots = new Map<string, { inputs: readonly unknown[]; value: unknown }>();

/** Memoizes `compute()` on `inputs` alone (last value per slot) — for a value derived from maze data that no settings field
 *  feeds. Reads nothing through a tracked view, so it may run inside a {@link trackedMemo} call; its inputs must then be plain
 *  values read from the view, never view objects. */
export function inputMemo<R>(slot: string, inputs: readonly unknown[], compute: () => R): R {
  const cached = inputSlots.get(slot);
  if (cached && sameInputs(cached.inputs, inputs) < 0) return cached.value as R;
  const value = compute();
  inputSlots.set(slot, { inputs, value });
  return value;
}

/** Drops every cached value and the counters. */
export function resetTrackedMemo(): void {
  slots.clear();
  inputSlots.clear();
  stats.clear();
}

/** Paranoid mode: every hit recomputes the value and throws when it differs from the cached one. For tests and debugging. */
export function setTrackedMemoParanoid(value: boolean): void {
  paranoid = value;
}

/** Per-slot hit/miss counters and last miss reason (a settings path), for tests and diagnostics. */
export function getTrackedMemoStats(): ReadonlyMap<string, Readonly<TrackedMemoSlotStats>> {
  return stats;
}

/** Misses summed over the slots whose name starts with `prefix`. */
export function trackedMemoMisses(prefix = ""): number {
  let total = 0;
  for (const [slot, entry] of stats) if (slot.startsWith(prefix)) total += entry.misses;
  return total;
}
