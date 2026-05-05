export function recordPerfSpan(name, startMs, meta = null) {
  const root = globalThis.window;
  const store = root?.__FIELD_LAB_PERF__?.spans;
  if (!store) return;
  const elapsed = performance.now() - startMs;
  const bucket = store[name] ?? (store[name] = {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
    meta: null,
  });
  bucket.count++;
  bucket.totalMs += elapsed;
  bucket.maxMs = Math.max(bucket.maxMs, elapsed);
  bucket.lastMs = elapsed;
  if (meta) bucket.meta = meta;
}

export function perfNow() {
  return globalThis.window?.__FIELD_LAB_PERF__?.spans ? performance.now() : 0;
}
