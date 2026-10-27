// Event bus. Modules talk through these events instead of reaching into each other.
const subs = new Map();

export function on(type, fn) {
  if (!subs.has(type)) subs.set(type, new Set());
  subs.get(type).add(fn);
  return () => off(type, fn);
}

export const off = (type, fn) => subs.get(type)?.delete(fn);

// A failing listener is logged and does not stop the others.
export function emit(type, detail) {
  for (const fn of [...(subs.get(type) ?? [])]) {
    try { fn(detail); } catch (e) { console.error(e); }
  }
}
