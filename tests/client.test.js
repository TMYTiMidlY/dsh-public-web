import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { apply as applyHost } from "../lib/index.js";

class Clock {
  now = 0;
  next = 0;
  timers = new Map();
  setTimeout = (callback, delay) => {
    const id = ++this.next;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  };
  clearTimeout = (id) => { this.timers.delete(id); };
  advance(delay) {
    this.now += delay;
    for (const [id, timer] of this.timers) {
      if (timer.at > this.now) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

async function loadClient(path, dependencies = {}, overrides = {}) {
  let registration;
  const window = { URL, __ModuleLoader__: { load: (value) => { registration = value; } }, ...overrides.window };
  const scope = { window, URL: window.URL, console, performance, setTimeout, clearTimeout, ...overrides, window };
  runInNewContext(await readFile(new URL(path, import.meta.url), "utf8"), scope);
  const module = registration.factory((id) => {
    assert.ok(id in dependencies, `Unexpected module dependency: ${id}`);
    return dependencies[id];
  });
  return { module, window, id: registration.id };
}

async function helperBench() {
  const clock = new Clock();
  const warnings = [];
  const { module, window } = await loadClient("../lib/client.js", {}, {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    performance: { now: () => clock.now },
  });
  const diagnostics = module.createDiagnostics({ warn: (message) => warnings.push(message) }, () => clock.now);
  return { module, window, clock, diagnostics, warnings };
}

function trackedController() {
  const controller = new AbortController();
  const listeners = new Set();
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === "abort") listeners.add(listener);
    return add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") listeners.delete(listener);
    return remove(type, listener, options);
  };
  return { controller, signal, listeners };
}

class Notices {
  readyState = Promise.withResolvers();
  ready = this.readyState.promise;
  queue = [];
  binding = [];
  ended = false;
  disposed = 0;
  constructor(signal) {
    this.signal = signal;
    this.onAbort = () => this.dispose();
    signal.addEventListener("abort", this.onAbort, { once: true });
  }
  acknowledge() { this.readyState.resolve(true); }
  bind(path) { this.binding.push(path); }
  push(notice) { this.queue.push(notice); this.wake?.(); }
  dispose() {
    if (this.ended) return;
    this.disposed += 1;
    this.ended = true;
    this.signal.removeEventListener("abort", this.onAbort);
    this.readyState.resolve(false);
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length) yield this.queue.shift();
      else if (this.ended) return;
      else await new Promise((resolve) => { this.wake = resolve; });
    }
  }
}

function fileBench(bench, timeoutMs = 800, results) {
  const tracked = trackedController();
  const notices = new Notices(tracked.signal);
  let calls = 0;
  const stat = async () => {
    calls += 1;
    return results?.[calls - 1] || {
      ok: true,
      value: { absolutePath: "/PRIVATE_FILE_PATH", version: calls, content: "PRIVATE_CONTENT" },
    };
  };
  const stream = bench.module.openFileFrames(notices, stat, tracked.signal, {
    diagnostics: bench.diagnostics,
    watchAckTimeoutMs: timeoutMs,
    now: () => bench.clock.now,
  });
  return { ...tracked, notices, stream, calls: () => calls };
}

test("normal acknowledgement reads once and keeps live updates; timer/listener are removed", async () => {
  const bench = await helperBench();
  const file = fileBench(bench);
  const first = file.stream.next();
  bench.clock.advance(50);
  file.notices.acknowledge();
  assert.equal((await first).value.value.version, 1);
  assert.equal(file.calls(), 1);
  assert.equal(bench.clock.timers.size, 0);
  assert.equal(file.listeners.size, 1); // Only the follower's own lifetime listener.
  file.notices.push({ kind: "changed", version: 2 });
  assert.equal((await file.stream.next()).value.value.version, 2);
  const waiting = file.stream.next();
  file.controller.abort();
  assert.equal((await waiting).done, true);
  assert.equal(file.notices.disposed, 1);
  assert.equal(file.listeners.size, 0);
  assert.equal(bench.diagnostics.snapshot().counters["watch-ack-on-time"], 1);
  assert.equal(bench.warnings.length, 0);
});

test("late acknowledgement shows a snapshot, refreshes on recovery and retains the same live feed", async () => {
  const bench = await helperBench();
  const file = fileBench(bench, 125);
  const first = file.stream.next();
  bench.clock.advance(125);
  assert.equal((await first).value.value.version, 1);
  assert.equal(file.notices.disposed, 0);
  assert.equal(file.listeners.size, 1);
  const recovered = file.stream.next();
  bench.clock.advance(75);
  file.notices.acknowledge();
  assert.equal((await recovered).value.value.version, 2);
  file.notices.push({ kind: "changed", version: 3 });
  assert.equal((await file.stream.next()).value.value.version, 3);
  assert.equal(file.notices.binding.length, 3);
  await file.stream.return();
  assert.equal(file.notices.disposed, 1);
  assert.equal(file.listeners.size, 0);
  assert.equal(bench.clock.timers.size, 0);
  const snapshot = bench.diagnostics.snapshot();
  assert.equal(snapshot.counters["watch-ack-timeout"], 1);
  assert.equal(snapshot.counters["watch-ack-late"], 1);
  assert.equal(snapshot.events.find((event) => event.kind === "watch-ack-late").elapsedMs, 200);
  assert.equal(bench.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|path|content|sessionId|token/);
});

test("a watch that never acknowledges stays cancellable after the snapshot, without repeated polling", async () => {
  const bench = await helperBench();
  const file = fileBench(bench);
  const first = file.stream.next();
  bench.clock.advance(800);
  assert.equal((await first).value.value.version, 1);
  const waiting = file.stream.next();
  assert.equal(file.listeners.size, 2);
  bench.clock.advance(60000);
  assert.equal(file.calls(), 1);
  assert.equal(bench.clock.timers.size, 0);
  file.controller.abort();
  assert.equal((await waiting).done, true);
  assert.equal(file.notices.disposed, 1);
  assert.equal(file.listeners.size, 0);
});

test("returning immediately after the timeout snapshot releases an unacknowledged feed", async () => {
  const bench = await helperBench();
  const file = fileBench(bench);
  const first = file.stream.next();
  bench.clock.advance(800);
  await first;
  assert.equal((await file.stream.return()).done, true);
  assert.equal(file.notices.disposed, 1);
  assert.equal(file.listeners.size, 0);
  assert.equal(bench.clock.timers.size, 0);
});

test("aborting before acknowledgement cancels the timer and performs no stat", async () => {
  const bench = await helperBench();
  const file = fileBench(bench);
  const waiting = file.stream.next();
  file.controller.abort();
  assert.equal((await waiting).done, true);
  assert.equal(file.calls(), 0);
  assert.equal(file.listeners.size, 0);
  assert.equal(bench.clock.timers.size, 0);
});

test("an already-aborted signal does not leave an acknowledgement waiter", async () => {
  const bench = await helperBench();
  const tracked = trackedController();
  tracked.controller.abort();
  const result = await bench.module.waitForAcknowledgement(new Promise(() => {}), tracked.signal, 800);
  assert.equal(result.kind, "aborted");
  assert.equal(tracked.listeners.size, 0);
  assert.equal(bench.clock.timers.size, 0);
});

test("a rejected acknowledgement removes its timer and abort listener", async () => {
  const bench = await helperBench();
  const tracked = trackedController();
  const ready = Promise.withResolvers();
  const waiting = bench.module.waitForAcknowledgement(ready.promise, tracked.signal, 800);
  ready.reject(new Error("Programming failure"));
  await assert.rejects(waiting, /Programming failure/);
  assert.equal(tracked.listeners.size, 0);
  assert.equal(bench.clock.timers.size, 0);
});

test("a feed ending before acknowledgement preserves the official one-stat fallback", async () => {
  const bench = await helperBench();
  const file = fileBench(bench);
  const first = file.stream.next();
  file.notices.dispose();
  assert.equal((await first).value.value.version, 1);
  assert.equal((await file.stream.next()).done, true);
  assert.equal(file.calls(), 1);
  assert.equal(bench.clock.timers.size, 0);
  assert.equal(file.listeners.size, 0);
});

test("a failed timeout snapshot can recover after late acknowledgement", async () => {
  const bench = await helperBench();
  const file = fileBench(bench, 800, [{ ok: false, error: { code: "missing" } }]);
  const first = file.stream.next();
  bench.clock.advance(800);
  assert.equal((await first).value.ok, false);
  file.notices.acknowledge();
  assert.equal((await file.stream.next()).value.value.version, 2);
  await file.stream.return();
  assert.equal(file.listeners.size, 0);
});

test("timeout warnings are once per page and diagnostics retain at most 20 events", async () => {
  const bench = await helperBench();
  for (let index = 0; index < 12; index += 1) {
    const file = fileBench(bench, 1);
    const first = file.stream.next();
    bench.clock.advance(1);
    await first;
    await file.stream.return();
  }
  assert.equal(bench.warnings.length, 1);
  assert.equal(bench.diagnostics.snapshot().counters["watch-ack-timeout"], 12);
  assert.equal(bench.diagnostics.snapshot().events.length, 20);
  for (let index = 0; index < 70000; index += 1) bench.diagnostics.event("url-fallback");
  assert.equal(bench.diagnostics.snapshot().counters["url-fallback"], 65535);
  const copy = bench.diagnostics.snapshot();
  copy.events.length = 0;
  copy.counters["url-fallback"] = 0;
  assert.equal(bench.diagnostics.snapshot().events.length, 20);
  assert.equal(bench.diagnostics.snapshot().counters["url-fallback"], 65535);
});

test("native resource URL parsing remains native and reports not-needed", async () => {
  const bench = await helperBench();
  const resolver = bench.module.createResourceProtocolResolver(URL, bench.diagnostics);
  assert.equal(resolver.protocolOf("DSH-RESOURCE://File/session/s/a"), "file");
  assert.equal(resolver.protocolOf("dsh-resource://chat/node/1"), "chat");
  for (const address of ["https://file/a", "sidebar://guide", "file://sessions/s/a", "dsh-resource:///a", "/a", ""]) {
    assert.equal(resolver.protocolOf(address), undefined);
  }
  assert.equal(bench.diagnostics.snapshot().urlCompat, "not-needed");
  assert.equal(bench.window.URL, URL);
  resolver.dispose();
  assert.equal(bench.diagnostics.snapshot().urlCompat, "disposed");
});

test("a defective resource URL hostname is recovered only inside the resolver", async () => {
  const bench = await helperBench();
  function DefectiveURL(address) {
    const native = new URL(address);
    return { protocol: native.protocol, hostname: native.protocol === "dsh-resource:" ? "" : native.hostname };
  }
  const resolver = bench.module.createResourceProtocolResolver(DefectiveURL, bench.diagnostics);
  assert.equal(resolver.protocolOf("dsh-resource://file/session/s/a"), "file");
  assert.equal(resolver.protocolOf("DSH-RESOURCE://Chat/node/1"), "chat");
  for (const address of ["dsh-resource://user@file/a", "dsh-resource://file:9/a", "dsh-resource://fi le/a", "dsh-resource:///a", "https://file/a", "/a"]) {
    assert.equal(resolver.protocolOf(address), undefined);
  }
  assert.equal(bench.diagnostics.snapshot().urlCompat, "enabled");
  assert.equal(bench.diagnostics.snapshot().counters["url-fallback"], 2);
  assert.equal(bench.window.URL, URL);
  resolver.dispose();
  assert.equal(resolver.protocolOf("dsh-resource://file/session/s/a"), undefined);
});

test("a parser rejecting nonstandard URLs uses only the strict resource grammar", async () => {
  const bench = await helperBench();
  function RejectingURL(address) {
    if (/^dsh-resource:/i.test(address)) throw new TypeError("Unsupported scheme");
    return new URL(address);
  }
  const resolver = bench.module.createResourceProtocolResolver(RejectingURL, bench.diagnostics);
  assert.equal(resolver.protocolOf("dsh-resource://file/session/s/a"), "file");
  assert.equal(resolver.protocolOf("https://file/a"), undefined);
  assert.equal(bench.diagnostics.snapshot().urlCompat, "enabled");
  const unavailable = bench.module.createResourceProtocolResolver(undefined, bench.diagnostics);
  assert.equal(unavailable.protocolOf("dsh-resource://file/session/s/a"), undefined);
  assert.equal(bench.diagnostics.snapshot().urlCompat, "failed");
});

function contextBench() {
  const cleanups = [];
  const ctx = {
    effect(start) {
      const cleanup = start();
      let disposed = false;
      const dispose = async () => { if (!disposed) { disposed = true; await cleanup?.(); } };
      cleanups.push(dispose);
      return dispose;
    },
    reflect: { provide(name, value) { ctx[name] = value; return () => { delete ctx[name]; }; } },
    slots: { provideRoot(value) { ctx.rootHooks = value; } },
  };
  return { ctx, dispose: async () => { for (const cleanup of cleanups.toReversed()) await cleanup(); } };
}

test("diagnostics are installed and restored through the actual browser plugin lifetime", async () => {
  const bench = await helperBench();
  const ctx = contextBench();
  const previous = () => "previous";
  Object.defineProperty(bench.window, "__dshPublicWebDiagnostics", { configurable: true, value: previous });
  bench.module.apply(ctx.ctx);
  assert.equal(bench.window.__dshPublicWebDiagnostics().urlCompat, "pending");
  await ctx.dispose();
  assert.equal(bench.window.__dshPublicWebDiagnostics, previous);
  assert.equal(bench.window.URL, URL);
});

test("the vendored resource registry uses the local resolver and disposes it with its service", async () => {
  const bench = await helperBench();
  function DefectiveURL(address) { const native = new URL(address); return { protocol: native.protocol, hostname: "" }; }
  const store = {
    createSnapshotStore(initial) {
      let state = initial;
      return { getSnapshot: () => state, set: (next) => { state = next; }, subscribe: () => () => {} };
    },
  };
  const client = await loadClient("../vendor/resources/lib/client.js", {
    "@deepseek-ai/dsh-client-store": store,
    "dsh-public-web": { ...bench.module, createResourceProtocolResolver: (native) => bench.module.createResourceProtocolResolver(native, bench.diagnostics) },
  }, { window: { URL: DefectiveURL } });
  const ctx = contextBench();
  client.module.apply(ctx.ctx);
  const release = ctx.ctx.resources.register({ protocol: "file", async *open() {} });
  assert.equal(ctx.ctx.resources.source("dsh-resource://file/session/s/a").getSnapshot().status, "loading");
  assert.equal(ctx.ctx.resources.source("https://file/a").getSnapshot().status, "none");
  assert.equal(client.window.URL, DefectiveURL);
  await release();
  await ctx.dispose();
  assert.equal(ctx.ctx.resources, undefined);
  assert.equal(bench.diagnostics.snapshot().urlCompat, "disposed");
});

test("the vendored workspace provider passes browser config to the production helper", async () => {
  const bench = await helperBench();
  let seen;
  const client = await loadClient("../vendor/workspace-files/lib/client.js", {
    "@deepseek-ai/cordis": {},
    "dsh-public-web": {
      ...bench.module,
      async *openFileFrames(notices, stat, signal, options) {
        seen = options;
        try { yield await stat(); } finally { notices.dispose(); }
      },
    },
  }, { window: { __DSH_PUBLIC_WEB_CONFIG__: { watchAckTimeoutMs: 2345 } } });
  const ctx = contextBench();
  let provider;
  ctx.ctx.resources = { register(value) { provider = value; return () => {}; } };
  ctx.ctx.remote = {
    workspaceFiles: { stat: async () => ({ ok: true, value: { version: 1 } }) },
    $stream: () => ({ async *[Symbol.asyncIterator]() {}, dispose: () => Promise.resolve() }),
  };
  client.module.apply(ctx.ctx);
  const stream = provider.open("dsh-resource://file/session/s/a", { signal: new AbortController().signal });
  assert.equal((await stream.next()).value.value.version, 1);
  assert.equal(seen.watchAckTimeoutMs, 2345);
  await stream.return();
  await ctx.dispose();
});

test("the Host injects default/custom acknowledgement budgets even with no trusted hosts", () => {
  for (const [config, expected] of [[undefined, 800], [{ hosts: [], watchAckTimeoutMs: 1234 }, 1234]]) {
    const handlers = new Map();
    applyHost({ on: (event, callback) => handlers.set(event, callback) }, config);
    const rows = [];
    handlers.get("webserver/index-inject")(rows);
    assert.deepEqual(rows, [{ kind: "global", name: "__DSH_PUBLIC_WEB_CONFIG__", value: { watchAckTimeoutMs: expected } }]);
  }
});

test("Host rejects invalid acknowledgement budgets; browser defensively defaults malformed globals", async () => {
  const bench = await helperBench();
  for (const value of [0, -1, 60001, 1.5, "800", NaN, Infinity]) {
    assert.throws(() => applyHost({ on() {} }, { watchAckTimeoutMs: value }), /integer from 1 to 60000/);
    assert.equal(bench.module.watchAckTimeoutMs(value), 800);
  }
  assert.equal(bench.module.watchAckTimeoutMs(1), 1);
  assert.equal(bench.module.watchAckTimeoutMs(60000), 60000);
});
