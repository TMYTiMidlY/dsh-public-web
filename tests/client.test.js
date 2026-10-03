import assert from "node:assert/strict";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { apply as applyHost } from "../lib/index.js";

const script = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
const SETTINGS = "@deepseek-ai/dsh-client-ui-settings";
const RESOURCES = "@deepseek-ai/dsh-client-resources";
const FILES = "@deepseek-ai/dsh-api-workspace-files";

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

async function flush() {
  for (let count = 0; count < 20; count += 1) await Promise.resolve();
}

function bench({ NativeURL = URL, timeoutMs = 800 } = {}) {
  const clock = new Clock();
  const warnings = [];
  const window = { URL: NativeURL, __DSH_PUBLIC_WEB_CONFIG__: { watchAckTimeoutMs: timeoutMs } };
  const scope = {
    window, URL: NativeURL, __DSH_PUBLIC_WEB_CONFIG__: window.__DSH_PUBLIC_WEB_CONFIG__,
    console: { warn: (message) => warnings.push(message) },
    performance: { now: () => clock.now }, Date, Promise, AbortController, AbortSignal,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  };
  const api = runInNewContext(script, scope);
  return { api, clock, warnings, window, scope };
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

/** Scripted official-shaped stream; cancellation settles every pending pull. */
class Stream {
  tracked = trackedController();
  signal = this.tracked.signal;
  queue = [];
  pending = [];
  pulls = 0;
  disposals = 0;
  restarts = 0;
  accepted = 0;
  ended = false;
  enqueue(value, generation = 1) {
    const item = { generation, signal: this.signal, value, accept: () => { this.accepted += 1; } };
    if (this.pending.length) this.pending.shift().resolve({ done: false, value: item });
    else this.queue.push(item);
    return item;
  }
  fail(error) { this.pending.shift()?.reject(error); }
  end() {
    this.ended = true;
    for (const pending of this.pending.splice(0)) pending.resolve({ done: true });
  }
  restart() { this.restarts += 1; }
  async dispose() {
    if (!this.signal.aborted) {
      this.disposals += 1;
      this.tracked.controller.abort();
      this.end();
    }
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        this.pulls += 1;
        if (this.queue.length) return Promise.resolve({ done: false, value: this.queue.shift() });
        if (this.ended) return Promise.resolve({ done: true });
        const state = Promise.withResolvers();
        this.pending.push(state);
        return state.promise;
      },
      return: async () => { await this.dispose(); return { done: true }; },
    };
  }
}

function wrapStream(b, stream = new Stream(), timeoutMs = 800) {
  return {
    stream,
    wrapped: b.api.wrapWatchStream(stream, {
      watchAckTimeoutMs: timeoutMs,
      diagnostics: b.api.diagnostics,
      now: () => b.clock.now,
    }),
  };
}

test("the early hook preserves window.URL and intercepts both queue and live registrations", () => {
  const b = bench();
  assert.equal(b.window.URL, URL);
  assert.equal(b.scope.URL, URL);
  const queue = [];
  const loader = { load: (registration) => queue.push(registration) };
  b.window.__ModuleLoader__ = loader;
  const registration = { id: SETTINGS, factory: () => ({ inject: ["remote"], apply: (ctx) => ctx.remote.$host.isLoopback }) };
  loader.load(registration);
  assert.equal(queue.length, 1);
  const remote = { $host: { home: "/private/home", isLoopback: false } };
  assert.equal(queue[0].factory(() => {}).apply({ remote }), true);
  assert.equal(remote.$host.isLoopback, false);
  const live = [];
  loader.load = (value) => live.push(value);
  loader.load(registration);
  assert.equal(live.length, 1);
  assert.equal(live[0].factory(() => {}).apply({ remote }), true);
  const other = { id: "other", factory: () => ({ apply() {} }) };
  loader.load(other);
  assert.equal(live[1], other);
  loader.load({ ...registration, chunk: "other.js" });
  assert.equal(live[2].chunk, "other.js");
});

test("reload registrations call the newly supplied official implementation", () => {
  const b = bench();
  const registrations = [];
  b.window.__ModuleLoader__ = { load: (value) => registrations.push(value) };
  for (const version of ["old", "upgraded"]) {
    b.window.__ModuleLoader__.load({ id: SETTINGS, factory: () => ({ apply: (ctx) => `${version}:${ctx.remote.$host.isLoopback}` }) });
  }
  const ctx = { remote: { $host: { isLoopback: false } } };
  assert.equal(registrations[0].factory(() => {}).apply(ctx), "old:true");
  assert.equal(registrations[1].factory(() => {}).apply(ctx), "upgraded:true");
});

test("pending registrations drained through the live load accessor are decorated once", () => {
  const b = bench();
  let factories = 0;
  const registration = { id: SETTINGS, factory: () => { factories += 1; return { apply: (ctx) => ctx.remote.$host.isLoopback }; } };
  const loader = { pendingQueue: [registration], load(value) { this.pendingQueue.push(value); } };
  b.window.__ModuleLoader__ = loader;
  const pending = loader.pendingQueue.splice(0);
  const live = [];
  loader.load = (value) => live.push(value);
  for (const value of pending) loader.load(value);
  assert.equal(live[0].factory(() => {}).apply({ remote: { $host: { isLoopback: false } } }), true);
  assert.equal(factories, 1);
  assert.equal(b.api.diagnostics.snapshot().counters["settings-host"], 1);
});

test("a readonly Host fact is adapted without modifying the official fact object", () => {
  const b = bench();
  const host = Object.freeze({ isLoopback: false, home: "/PRIVATE_HOME" });
  const ctx = { remote: { $host: host } };
  const scoped = b.api.adaptContext(SETTINGS, ctx);
  assert.equal(scoped.remote.$host.isLoopback, true);
  assert.equal(scoped.remote.$host.home, host.home);
  assert.equal(ctx.remote.$host, host);
  assert.equal(ctx.remote.$host.isLoopback, false);
});

test("unknown registration and apply shapes continue through the official loader", () => {
  const b = bench();
  const queue = [];
  b.window.__ModuleLoader__ = { load: (value) => queue.push(value) };
  const value = { id: FILES, factory: () => ({ marker: 123 }) };
  b.window.__ModuleLoader__.load(value);
  assert.equal(queue[0].factory(() => {}).marker, 123);
  const foreign = { id: "unrelated", factory: () => ({ value: 123 }) };
  b.window.__ModuleLoader__.load(foreign);
  assert.equal(queue[1], foreign);
});

test("frozen apply exports are left usable when the official shape cannot be wrapped", () => {
  const b = bench();
  const original = Object.freeze({ apply: () => "official", inject: [] });
  const registration = b.api.wrapRegistration({ id: SETTINGS, factory: () => original });
  assert.equal(registration.factory(() => {}), original);
  assert.equal(original.apply(), "official");
});

test("unrecognized resource and watch service shapes retain the official implementations", () => {
  const b = bench({ NativeURL: DefectiveURL });
  const ctx = contextBench();
  const resources = { source: () => "official" };
  b.api.adaptContext(RESOURCES, ctx.ctx).reflect.provide("resources", resources);
  assert.equal(ctx.ctx.resources, resources);
  assert.equal(ctx.ctx.resources.source(), "official");
  const unknown = { async *[Symbol.asyncIterator]() {} };
  const remote = { $stream: () => unknown };
  const scoped = b.api.adaptContext(FILES, { remote });
  assert.equal(scoped.remote.$stream({ name: "workspace file changes of s", open() {} }), unknown);
  const actual = new Stream();
  const unrelated = b.api.adaptContext(FILES, { remote: { $stream: () => actual } });
  assert.equal(unrelated.remote.$stream({ name: "unrelated stream", open() {} }), actual);
});

test("a frozen official resource implementation remains unchanged", () => {
  const b = bench({ NativeURL: DefectiveURL });
  const ctx = contextBench();
  const create = () => ({ protocol: undefined });
  const resources = Object.freeze({ create, providerOf() {} });
  b.api.adaptContext(RESOURCES, ctx.ctx).reflect.provide("resources", resources);
  assert.equal(ctx.ctx.resources, resources);
  assert.equal(resources.create, create);
});

test("an on-time acknowledgement remains the actual item and accepts only actual transport", async () => {
  const b = bench();
  const { stream, wrapped } = wrapStream(b);
  const iterator = wrapped[Symbol.asyncIterator]();
  const pending = iterator.next();
  b.clock.advance(25);
  const item = stream.enqueue({ kind: "ready" });
  assert.equal((await pending).value, item);
  item.accept();
  assert.equal(stream.accepted, 1);
  assert.equal(b.clock.timers.size, 0);
  assert.equal(stream.tracked.listeners.size, 0);
  assert.equal(wrapped.signal, stream.signal);
  wrapped.restart();
  assert.equal(stream.restarts, 1);
  await iterator.return();
  assert.equal(stream.disposals, 1);
});

test("timeout releases a local first read while retaining the same pending real acknowledgement", async () => {
  const b = bench();
  const { stream, wrapped } = wrapStream(b, new Stream(), 125);
  const iterator = wrapped[Symbol.asyncIterator]();
  const first = iterator.next();
  b.clock.advance(125);
  const synthetic = (await first).value;
  assert.equal(synthetic.value.kind, "ready");
  synthetic.accept();
  assert.equal(stream.accepted, 0);
  assert.equal(stream.pulls, 1);
  const recovered = iterator.next();
  b.clock.advance(75);
  const real = stream.enqueue({ kind: "ready" });
  assert.equal((await recovered).value, real);
  assert.equal(stream.pulls, 1);
  real.accept();
  assert.equal(stream.accepted, 1);
  const change = stream.enqueue({ kind: "change", change: { version: "v2", absolutePath: "/PRIVATE_FILE" } });
  assert.equal((await iterator.next()).value, change);
  await iterator.return();
  assert.equal(stream.disposals, 1);
  assert.equal(stream.tracked.listeners.size, 0);
  const snapshot = b.api.diagnostics.snapshot();
  assert.equal(snapshot.counters["watch-ack-timeout"], 1);
  assert.equal(snapshot.counters["watch-ack-late"], 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|absolutePath|sessionId|cookie|token/);
});

test("a missing acknowledgement is cancellable without repeated timeout snapshots", async () => {
  const b = bench();
  const { stream, wrapped } = wrapStream(b);
  const iterator = wrapped[Symbol.asyncIterator]();
  const first = iterator.next();
  b.clock.advance(800);
  await first;
  const waiting = iterator.next();
  b.clock.advance(60000);
  assert.equal(stream.pulls, 1);
  assert.equal(b.clock.timers.size, 0);
  await wrapped.dispose();
  assert.equal((await waiting).done, true);
  assert.equal(stream.disposals, 1);
  assert.equal(stream.tracked.listeners.size, 0);
});

test("return after a timeout snapshot closes an unacknowledged official stream", async () => {
  const b = bench();
  const { stream, wrapped } = wrapStream(b);
  const iterator = wrapped[Symbol.asyncIterator]();
  const first = iterator.next();
  b.clock.advance(800);
  await first;
  assert.equal((await iterator.return()).done, true);
  assert.equal(stream.disposals, 1);
  assert.equal(b.clock.timers.size, 0);
  assert.equal(stream.tracked.listeners.size, 0);
});

test("cancellation, error and normal end clean the initial acknowledgement timer", async () => {
  for (const operation of ["dispose", "end", "error"]) {
    const b = bench();
    const { stream, wrapped } = wrapStream(b);
    const iterator = wrapped[Symbol.asyncIterator]();
    const pending = iterator.next();
    await flush();
    if (operation === "error") {
      stream.fail(new Error("Program error"));
      await assert.rejects(pending, /Program error/);
    } else {
      if (operation === "dispose") await wrapped.dispose();
      else stream.end();
      assert.equal((await pending).done, true);
    }
    assert.equal(b.clock.timers.size, 0);
    assert.equal(stream.tracked.listeners.size, 0);
  }
});

test("later connection generations pass through without a second synthetic acknowledgement", async () => {
  const b = bench();
  const { stream, wrapped } = wrapStream(b);
  const iterator = wrapped[Symbol.asyncIterator]();
  const initial = iterator.next();
  const ready = stream.enqueue({ kind: "ready" }, 1);
  assert.equal((await initial).value, ready);
  const waiting = iterator.next();
  b.clock.advance(3000);
  assert.equal(b.clock.timers.size, 0);
  const reconnected = stream.enqueue({ kind: "ready" }, 2);
  assert.equal((await waiting).value, reconnected);
  await iterator.return();
  assert.equal(b.api.diagnostics.snapshot().counters["watch-ack-timeout"], undefined);
});

test("diagnostics are bounded, independent snapshots and do not retain file identifiers", () => {
  const b = bench();
  for (let index = 0; index < 70000; index += 1) b.api.diagnostics.event("url-fallback");
  const first = b.api.diagnostics.snapshot();
  assert.equal(first.events.length, 20);
  assert.equal(first.counters["url-fallback"], 65535);
  first.events.length = 0;
  first.counters["url-fallback"] = 0;
  assert.equal(b.api.diagnostics.snapshot().events.length, 20);
  assert.equal(b.api.diagnostics.snapshot().counters["url-fallback"], 65535);
  assert.equal(typeof b.window.__dshPublicWebDiagnostics, "function");
});

test("resource compatibility is dormant with a normal parser and preserves the native constructor", () => {
  const b = bench();
  const resolver = b.api.createResourceProtocolResolver(URL, b.api.diagnostics);
  assert.equal(resolver.protocolOf("DSH-RESOURCE://File/session/s/a"), "file");
  assert.equal(resolver.protocolOf("https://file/a"), undefined);
  assert.equal(b.api.diagnostics.snapshot().urlCompat, "not-needed");
  assert.equal(b.window.URL, URL);
});

function DefectiveURL(address) {
  const native = new URL(address);
  return { protocol: native.protocol, hostname: native.protocol === "dsh-resource:" ? "" : native.hostname };
}

test("resource compatibility accepts only a strict authority when the custom-scheme parser fails", () => {
  const b = bench({ NativeURL: DefectiveURL });
  const resolver = b.api.createResourceProtocolResolver(DefectiveURL, b.api.diagnostics);
  assert.equal(resolver.protocolOf("dsh-resource://file/session/s/a"), "file");
  assert.equal(resolver.protocolOf("DSH-RESOURCE://Chat/node/1"), "chat");
  for (const address of ["https://file/a", "dsh-resource://user@file/a", "dsh-resource://file:9/a", "dsh-resource://fi le/a", "dsh-resource:///a", "/a"]) {
    assert.equal(resolver.protocolOf(address), undefined);
  }
  assert.equal(b.window.URL, DefectiveURL);
});

test("a future official resource resolver that already supplies its protocol is preserved", () => {
  const b = bench({ NativeURL: DefectiveURL });
  const ctx = contextBench();
  const snapshot = { status: "official-new-status" };
  const record = {
    address: "dsh-resource://file/session/s/a", protocol: "file",
    store: { getSnapshot: () => snapshot, set: () => { throw new Error("An already resolved record must not be changed"); } },
  };
  const resources = { create: () => record, providerOf: () => ({}) };
  b.api.adaptContext(RESOURCES, ctx.ctx).reflect.provide("resources", resources);
  assert.equal(resources.create(record.address), record);
  assert.equal(record.store.getSnapshot(), snapshot);
});

const store = {
  createSnapshotStore(initial) {
    let state = initial;
    const listeners = new Set();
    return {
      getSnapshot: () => state,
      set: (next) => { state = next; for (const listener of listeners) listener(); },
      update: (update) => { state = { ...state }; update(state); for (const listener of listeners) listener(); },
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
  },
};

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
    on() { return () => {}; },
    reflect: { provide(name, value) { ctx[name] = value; return () => { delete ctx[name]; }; } },
    slots: { provideRoot(value) { ctx.rootHooks = value; } },
  };
  return { ctx, dispose: async () => { for (const cleanup of cleanups.toReversed()) await cleanup(); } };
}

class Service {
  constructor(ctx, name) {
    this.ctx = ctx;
    ctx[name] = this;
    ctx.effect(() => () => { delete ctx[name]; });
  }
}

let installedRequire;
let installedSkip;
try {
  const binary = await realpath(process.env.DSH_BIN || "/usr/local/bin/dsh");
  installedRequire = createRequire(binary);
  await Promise.all([SETTINGS, RESOURCES, FILES].map(id => access(installedRequire.resolve(`${id}/client`))));
} catch (error) {
  installedSkip = `An installed DSH runtime is needed for official client integration: ${error.code || error.message}`;
}

async function officialClient(b, id, dependencies = {}) {
  assert.ok(installedRequire);
  const registrations = [];
  b.window.__ModuleLoader__ = { load: (registration) => registrations.push(registration) };
  runInNewContext(await readFile(installedRequire.resolve(`${id}/client`), "utf8"), b.scope);
  const registration = registrations.find((value) => value.id === id && value.chunk === undefined);
  assert.ok(registration, `${id} must register its currently installed client`);
  return registration.factory((dependency) => {
    if (Object.hasOwn(dependencies, dependency)) return dependencies[dependency];
    if (dependency === "@deepseek-ai/cordis") return { Service };
    if (dependency === "@deepseek-ai/dsh-client-store") return store;
    throw new Error(`Unexpected official client dependency: ${dependency}`);
  });
}

test("current official Settings selects Host persistence only in its own wrapped context", { skip: installedSkip }, async () => {
  const b = bench();
  const module = await officialClient(b, SETTINGS);
  const ctx = contextBench();
  let reads = 0;
  const remote = {
    $host: { home: "/PRIVATE_HOME", isLoopback: false },
    $on: () => () => {},
    settings: { describe: async () => { reads += 1; return { ok: true, value: { namespaces: [], writable: true, hasDocument: true } }; } },
  };
  ctx.ctx.remote = remote;
  module.apply(ctx.ctx);
  await ctx.ctx.configForms.describe().ensure();
  assert.equal(ctx.ctx.configForms.describe().getSnapshot().status, "ready");
  assert.equal(ctx.ctx.configForms.get("test").getSnapshot().mode, "host");
  assert.ok(reads > 0);
  assert.equal(ctx.ctx.remote, remote);
  assert.equal(remote.$host.isLoopback, false);
  await ctx.dispose();
});

test("current official resources keeps its own registry while the defective parser record is repaired", { skip: installedSkip }, async () => {
  const b = bench({ NativeURL: DefectiveURL });
  const module = await officialClient(b, RESOURCES);
  const ctx = contextBench();
  module.apply(ctx.ctx);
  const registry = ctx.ctx.resources;
  assert.equal(registry.constructor.name, "ResourceRegistry");
  const release = registry.register({ protocol: "file", async *open() {} });
  const source = registry.source("dsh-resource://file/session/s/a");
  assert.equal(source.getSnapshot().status, "loading");
  assert.equal(registry.source("dsh-resource://file/session/s/a"), source);
  assert.equal(registry.source("https://file/a").getSnapshot().status, "none");
  assert.equal(b.window.URL, DefectiveURL);
  assert.equal(b.scope.URL, DefectiveURL);
  await release();
  await ctx.dispose();
});

async function officialFilesBench(timeoutMs = 800) {
  const b = bench({ timeoutMs });
  const module = await officialClient(b, FILES);
  const ctx = contextBench();
  let provider;
  let calls = 0;
  let opens = 0;
  const official = new Stream();
  ctx.ctx.resources = { register(value) { provider = value; return () => {}; } };
  const remote = {
    workspaceFiles: {
      stat: async () => ({ ok: true, value: { version: `v${++calls}`, absolutePath: "/PRIVATE_FILE" } }),
      changes() { throw new Error("The scripted supervisor owns the physical opener"); },
    },
    $stream(options) {
      assert.match(options.name, /^workspace file changes of /);
      opens += 1;
      return official;
    },
  };
  ctx.ctx.remote = remote;
  module.apply(ctx.ctx);
  const abort = trackedController();
  const iterator = provider.open("dsh-resource://file/session/PRIVATE_SESSION/a", { signal: abort.signal });
  return { ...b, ...ctx, ...abort, official, iterator, remote, calls: () => calls, opens: () => opens };
}

test("current official file provider owns snapshots and live changes after timely acknowledgement", { skip: installedSkip }, async () => {
  const b = await officialFilesBench();
  const first = b.iterator.next();
  b.official.enqueue({ kind: "ready" });
  assert.equal((await first).value.value.version, "v1");
  assert.equal(b.official.accepted, 1);
  b.official.enqueue({ kind: "change", change: { absolutePath: "/PRIVATE_FILE", version: "v2" } });
  assert.equal((await b.iterator.next()).value.value.version, "v2");
  assert.equal(b.opens(), 1);
  assert.equal(b.ctx.remote, b.remote);
  await b.iterator.return();
  await b.dispose();
  assert.equal(b.official.disposals, 1);
  assert.equal(b.listeners.size, 0);
});

test("current official file provider reads on timeout, then rereads on late acknowledgement and later generations", { skip: installedSkip }, async () => {
  const b = await officialFilesBench(125);
  const first = b.iterator.next();
  await flush();
  b.clock.advance(125);
  assert.equal((await first).value.value.version, "v1");
  assert.equal(b.official.accepted, 0);
  assert.equal(b.calls(), 1);
  const recovered = b.iterator.next();
  b.official.enqueue({ kind: "ready" });
  assert.equal((await recovered).value.value.version, "v2");
  assert.equal(b.official.accepted, 1);
  b.official.enqueue({ kind: "ready" }, 2);
  assert.equal((await b.iterator.next()).value.value.version, "v3");
  b.official.enqueue({ kind: "change", change: { absolutePath: "/PRIVATE_FILE", version: "v4" } }, 2);
  assert.equal((await b.iterator.next()).value.value.version, "v4");
  assert.equal(b.opens(), 1);
  await b.iterator.return();
  await b.dispose();
  assert.equal(b.official.disposals, 1);
  assert.equal(b.clock.timers.size, 0);
  assert.equal(b.listeners.size, 0);
});

test("current official file provider with a missing acknowledgement stays cancellable after one stat", { skip: installedSkip }, async () => {
  const b = await officialFilesBench(125);
  const first = b.iterator.next();
  await flush();
  b.clock.advance(125);
  await first;
  const waiting = b.iterator.next();
  b.clock.advance(60000);
  assert.equal(b.calls(), 1);
  b.controller.abort();
  assert.equal((await waiting).done, true);
  await b.dispose();
  assert.equal(b.official.disposals, 1);
  assert.equal(b.listeners.size, 0);
});

test("official Settings service ownership also works with the installed Cordis Context", { skip: installedSkip }, async () => {
  const cordis = await import(pathToFileURL(installedRequire.resolve("@deepseek-ai/cordis")).href);
  const b = bench();
  const module = await officialClient(b, SETTINGS, { "@deepseek-ai/cordis": cordis });
  const root = new cordis.Context();
  const remote = {
    $host: Object.freeze({ isLoopback: false, home: "/PRIVATE_HOME" }),
    $on: () => () => {},
    settings: { describe: async () => ({ ok: true, value: { namespaces: [], writable: true, hasDocument: true } }) },
  };
  root.provide("remote", remote);
  root.provide("remote.settings", remote.settings);
  const fiber = root.plugin(module);
  try {
    await fiber;
    const forms = root.get("configForms");
    assert.ok(forms, "the official provider must publish its service through actual Cordis");
    await forms.describe().ensure();
    assert.equal(forms.describe().getSnapshot().status, "ready");
    assert.equal(forms.get("test").getSnapshot().mode, "host");
    assert.equal(root.get("remote").$host.isLoopback, false);
  } finally { await fiber.dispose(); await root.fiber.dispose(); }
});

test("official resources and file clients preserve Cordis ownership while recovering a late acknowledgement", { skip: installedSkip }, async () => {
  const cordis = await import(pathToFileURL(installedRequire.resolve("@deepseek-ai/cordis")).href);
  const b = bench({ NativeURL: DefectiveURL, timeoutMs: 125 });
  const resources = await officialClient(b, RESOURCES, { "@deepseek-ai/cordis": cordis });
  const files = await officialClient(b, FILES, { "@deepseek-ai/cordis": cordis });
  const root = new cordis.Context();
  const official = new Stream();
  let calls = 0;
  const remote = {
    workspaceFiles: {
      stat: async () => ({ ok: true, value: { absolutePath: "/PRIVATE_FILE", version: `v${++calls}` } }),
      changes() {},
    },
    $stream: () => official,
  };
  root.provide("slots", { provideRoot() {} });
  root.provide("remote", remote);
  root.provide("remote.workspaceFiles", remote.workspaceFiles);
  const resourceFiber = root.plugin(resources);
  const fileFiber = root.plugin(files);
  let release;
  try {
    await resourceFiber;
    await fileFiber;
    const registry = root.get("resources");
    assert.ok(registry);
    const source = registry.source("dsh-resource://file/session/PRIVATE_SESSION/a");
    release = source.subscribe(() => {});
    await flush();
    b.clock.advance(125);
    await flush();
    assert.equal(source.getSnapshot().status, "live");
    assert.equal(source.getSnapshot().value.version, "v1");
    assert.equal(official.accepted, 0);
    official.enqueue({ kind: "ready" });
    await flush();
    assert.equal(source.getSnapshot().value.version, "v2");
    assert.equal(official.accepted, 1);
    assert.equal(b.window.URL, DefectiveURL);
  } finally {
    release?.();
    await fileFiber.dispose();
    await resourceFiber.dispose();
    await root.fiber.dispose();
  }
  assert.equal(official.disposals, 1);
  assert.equal(b.clock.timers.size, 0);
});

test("the Host places configuration and early hook ahead of the official facade", () => {
  for (const [config, expected] of [[undefined, 800], [{ hosts: [], watchAckTimeoutMs: 1234 }, 1234]]) {
    const handlers = new Map();
    applyHost({ on: (event, callback) => handlers.set(event, callback) }, config);
    const official = { kind: "script", placement: "head", text: "window.__ModuleLoader__={load(){}}" };
    const rows = [official];
    handlers.get("webserver/index-inject")(rows);
    assert.equal(rows[0].kind, "global");
    assert.equal(rows[0].name, "__DSH_PUBLIC_WEB_CONFIG__");
    assert.equal(rows[0].value.watchAckTimeoutMs, expected);
    assert.equal(rows[1].kind, "script");
    assert.equal(rows[1].placement, "head");
    assert.equal(rows[2], official);
    assert.doesNotMatch(rows[1].text, /<\/script/i);
  }
});

test("Host rejects invalid acknowledgement budgets while the browser defaults malformed globals", () => {
  const b = bench();
  for (const value of [0, -1, 60001, 1.5, "800", NaN, Infinity]) {
    assert.throws(() => applyHost({ on() {} }, { watchAckTimeoutMs: value }), /integer from 1 to 60000/);
    assert.equal(b.api.watchAckTimeoutMs(value), 800);
  }
  assert.equal(b.api.watchAckTimeoutMs(1), 1);
  assert.equal(b.api.watchAckTimeoutMs(60000), 60000);
});
