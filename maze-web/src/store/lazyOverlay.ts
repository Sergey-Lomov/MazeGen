/** `base` with some top-level properties replaced by values computed on first read (GitHub issue #928).
 *
 *  Every other read, `in` check and key listing goes straight to `base`, so over a dependency-tracked
 *  `base` (`trackedMemo`) a consumer subscribes only to what it touches — a plain `{ ...base, key }` copy
 *  would read every field of `base` up front. Replaced properties appear in `base`'s own key order. */
export function lazyOverlay<S extends object>(base: S, replacements: { [K in keyof S]?: () => S[K] }): S {
  const computed = new Map<PropertyKey, unknown>();
  const replaced = (key: PropertyKey): key is keyof S => Object.prototype.hasOwnProperty.call(replacements, key);
  const valueOf = (key: keyof S): unknown => {
    if (!computed.has(key)) computed.set(key, (replacements as Record<PropertyKey, () => unknown>)[key]());
    return computed.get(key);
  };
  return new Proxy({}, {
    get: (_target, key) => (replaced(key) ? valueOf(key) : Reflect.get(base, key)),
    has: (_target, key) => Reflect.has(base, key),
    ownKeys: () => Reflect.ownKeys(base),
    getOwnPropertyDescriptor: (_target, key) => {
      const desc = Reflect.getOwnPropertyDescriptor(base, key);
      if (!desc) return undefined;
      if (replaced(key)) (desc as { value?: unknown }).value = valueOf(key);
      desc.configurable = true;
      return desc;
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(base),
    // Read-only, like the settings it stands for.
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  }) as S;
}
