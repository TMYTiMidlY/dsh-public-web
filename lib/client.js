/* Page adapter for the currently installed official clients. */
(function installPublicWeb(window, config = {}) {
  const MAX_COUNT = 65535;
  const MAX_EVENTS = 20;
  const SETTINGS = "@deepseek-ai/dsh-client-ui-settings";
  const RESOURCES = "@deepseek-ai/dsh-client-resources";
  const FILES = "@deepseek-ai/dsh-api-workspace-files";

  function createDiagnostics(log = console, now = () => Date.now()) {
    const counters = Object.create(null), events = [], warned = new Set();
    let urlCompat = "pending";
    return {
      event(kind, elapsedMs) {
        counters[kind] = Math.min(MAX_COUNT, (counters[kind] || 0) + 1);
        const event = { kind, at: now() };
        if (Number.isFinite(elapsedMs)) event.elapsedMs = Math.min(86400000, Math.max(0, Math.round(elapsedMs)));
        events.push(event);
        if (events.length > MAX_EVENTS) events.shift();
      },
      urlStatus(status) { urlCompat = status; this.event(`url-${status}`); },
      warnOnce(kind, message) {
        if (warned.has(kind)) return;
        warned.add(kind);
        log?.warn?.(`[dsh-public-web] ${message}`);
      },
      snapshot() { return { urlCompat, counters: { ...counters }, events: events.map(event => ({ ...event })) }; },
    };
  }
  const diagnostics = createDiagnostics();
  const now = () => performance.now();
  function watchAckTimeoutMs(value) {
    return Number.isInteger(value) && value >= 1 && value <= 60000 ? value : 800;
  }
  function unsupported(kind) {
    diagnostics.event(`${kind}-unsupported`);
    diagnostics.warnOnce(`${kind}-unsupported`, `${kind} compatibility entry unavailable; continuing with the official client.`);
  }

  function createResourceProtocolResolver(NativeURL, report = diagnostics) {
    let compatible = false;
    try {
      const probe = new NativeURL("dsh-resource://file/__dsh_probe__/x");
      compatible = probe.protocol !== "dsh-resource:" || probe.hostname !== "file";
    } catch { compatible = typeof NativeURL === "function"; }
    report.urlStatus(typeof NativeURL !== "function" ? "failed" : compatible ? "enabled" : "not-needed");
    return {
      compatible,
      protocolOf(address) {
        try {
          const parsed = new NativeURL(address);
          if (parsed.protocol === "dsh-resource:" && parsed.hostname) return parsed.hostname.toLowerCase();
        } catch {}
        if (!compatible || typeof address !== "string") return undefined;
        const match = /^dsh-resource:\/\/([a-z][a-z0-9_-]*)(?=\/|[?#]|$)/i.exec(address);
        if (!match) return undefined;
        report.event("url-fallback");
        return match[1].toLowerCase();
      },
    };
  }

  function waitForAcknowledgement(ready, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const finish = (value, error, failed = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        if (failed) reject(error); else resolve(value);
      };
      const stop = () => finish({ kind: "aborted" });
      if (signal.aborted) { stop(); return; }
      signal.addEventListener("abort", stop, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
      ready.then(value => finish({ kind: "item", value }), error => finish(undefined, error, true));
    });
  }

  /** Let the official feed read a snapshot without accepting a Host acknowledgement. */
  function wrapWatchStream(stream, options = {}) {
    const report = options.diagnostics || diagnostics;
    if (!stream?.signal || typeof stream.signal.addEventListener !== "function"
      || typeof stream.dispose !== "function" || typeof stream[Symbol.asyncIterator] !== "function") {
      unsupported("watch");
      return stream;
    }
    const clock = options.now || now;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, stream.signal]);
    let closing, taken = false;
    function dispose() {
      if (!closing) {
        lifetime.abort();
        closing = Promise.resolve().then(() => stream.dispose());
      }
      return closing;
    }
    async function* read() {
      const started = clock();
      report.event("watch-open");
      try {
        const iterator = stream[Symbol.asyncIterator]();
        const pending = Promise.resolve().then(() => iterator.next());
        let first = await waitForAcknowledgement(pending, signal, watchAckTimeoutMs(options.watchAckTimeoutMs));
        if (first.kind === "aborted") return;
        const timedOut = first.kind === "timeout";
        if (timedOut) {
          report.event("watch-ack-timeout", clock() - started);
          report.warnOnce("watch-ack-timeout", "File watch acknowledgement is slow; the official client can read a snapshot while the subscription remains open.");
          // This local ready item has no transport acceptance side effect.
          // The official feed treats the later real ready as a refresh.
          yield { value: { kind: "ready" }, generation: 0, signal, accept() {} };
          first = await waitForAcknowledgement(pending, signal);
          if (first.kind === "aborted") return;
        }
        let item = first.value;
        if (item.done) {
          report.event("watch-ended-before-ack", clock() - started);
          return;
        }
        if (item.value?.value?.kind === "ready") {
          report.event(timedOut ? "watch-ack-late" : "watch-ack-on-time", clock() - started);
        } else unsupported("watch-frame");
        while (!signal.aborted && !item.done) {
          yield item.value;
          const next = await waitForAcknowledgement(Promise.resolve().then(() => iterator.next()), signal);
          if (next.kind === "aborted") return;
          item = next.value;
        }
      } finally {
        if (signal.aborted) report.event("watch-aborted");
        report.event("watch-closed");
        await dispose();
      }
    }
    return scopedProxy(stream, key => {
      if (key === "dispose") return { value: dispose };
      if (key === Symbol.asyncIterator) return { value: () => {
        if (taken) throw new Error("dsh-public-web: file stream already has a consumer");
        taken = true;
        return read();
      } };
    });
  }

  /** Preserve receiver binding for official Context and service implementations. */
  function scopedProxy(target, override) {
    const bound = new Map();
    return new Proxy(target, {
      get(object, key) {
        const replacement = override(key);
        if (replacement) return replacement.value;
        const value = Reflect.get(object, key, object);
        if (typeof value !== "function") return value;
        if (bound.get(key)?.original !== value) bound.set(key, { original: value, value: value.bind(object) });
        return bound.get(key).value;
      },
    });
  }

  function patchResources(resources, ctx) {
    const resolver = createResourceProtocolResolver(window.URL);
    if (!resolver.compatible) return;
    if (typeof resources?.create !== "function" || typeof resources.providerOf !== "function") {
      unsupported("resources"); return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(resources, "create");
    if (descriptor?.writable === false || (!descriptor && !Object.isExtensible(resources))) {
      unsupported("resources"); return;
    }
    const original = resources.create;
    const patched = function(address, ...args) {
      const record = original.call(this, address, ...args);
      // A fixed upstream resolver already supplies protocol: leave its result alone.
      if (record?.protocol !== undefined && record.protocol !== "") return record;
      const protocol = resolver.protocolOf(address);
      if (protocol === undefined) return record;
      if (record?.address !== address || typeof record.store?.set !== "function"
        || typeof record.store?.getSnapshot !== "function") { unsupported("resources-record"); return record; }
      record.protocol = protocol;
      record.store.set({ ...record.store.getSnapshot(), status: this.providerOf(protocol) === undefined ? "none" : "loading" });
      return record;
    };
    ctx.effect(() => {
      resources.create = patched;
      return () => { if (resources.create === patched) resources.create = original; };
    }, "dsh-public-web: resource address compatibility");
  }

  function adaptContext(id, ctx) {
    if (id === SETTINGS) {
      const remote = ctx.remote;
      if (!remote?.$host || typeof remote.$host.isLoopback !== "boolean") { unsupported("settings"); return ctx; }
      const host = { ...remote.$host, isLoopback: true };
      const scopedRemote = scopedProxy(remote, key => key === "$host" ? { value: host } : undefined);
      diagnostics.event("settings-host");
      return scopedProxy(ctx, key => key === "remote" ? { value: scopedRemote } : undefined);
    }
    if (id === FILES) {
      const remote = ctx.remote;
      if (typeof remote?.$stream !== "function") { unsupported("watch"); return ctx; }
      const scopedRemote = scopedProxy(remote, key => key === "$stream" ? { value: options => {
        const stream = remote.$stream(options);
        if (typeof options?.name !== "string" || !options.name.startsWith("workspace file changes of ")
          || typeof options.open !== "function") { unsupported("watch-entry"); return stream; }
        return wrapWatchStream(stream, { watchAckTimeoutMs: config.watchAckTimeoutMs });
      } } : undefined);
      return scopedProxy(ctx, key => key === "remote" ? { value: scopedRemote } : undefined);
    }
    if (id === RESOURCES) {
      const reflect = ctx.reflect;
      if (typeof reflect?.provide !== "function" || typeof ctx.effect !== "function") { unsupported("resources"); return ctx; }
      const scopedReflect = scopedProxy(reflect, key => key === "provide" ? { value: (name, value, ...rest) => {
        if (name === "resources") {
          try { patchResources(value, ctx); } catch { unsupported("resources"); }
        }
        return reflect.provide(name, value, ...rest);
      } } : undefined);
      return scopedProxy(ctx, key => key === "reflect" ? { value: scopedReflect } : undefined);
    }
    return ctx;
  }

  const factories = new WeakMap();
  function wrapRegistration(registration) {
    if (!registration || ![SETTINGS, RESOURCES, FILES].includes(registration.id)
      || typeof registration.factory !== "function") return registration;
    const original = registration.factory;
    if (!factories.has(original)) {
      const factory = function(...args) {
        const exports = original.apply(this, args);
        if (typeof exports?.apply !== "function") { unsupported("client-apply"); return exports; }
        const descriptor = Object.getOwnPropertyDescriptor(exports, "apply");
        if (descriptor?.configurable === false && descriptor.writable === false) {
          unsupported("client-apply"); return exports;
        }
        const apply = exports.apply;
        const wrapped = function(ctx, ...rest) {
          let adapted = ctx;
          try { adapted = adaptContext(registration.id, ctx); } catch { unsupported("client-context"); }
          return apply.call(this, adapted, ...rest);
        };
        return new Proxy(exports, { get(target, key, receiver) {
          return key === "apply" ? wrapped : Reflect.get(target, key, receiver);
        } });
      };
      factories.set(original, factory);
      factories.set(factory, factory);
    }
    return { ...registration, factory: factories.get(original) };
  }

  const loaders = new WeakSet();
  function installLoader(loader) {
    if (!loader || typeof loader.load !== "function" || loaders.has(loader)) return loader;
    const descriptor = Object.getOwnPropertyDescriptor(loader, "load");
    if (descriptor && descriptor.configurable === false) { unsupported("loader"); return loader; }
    let load = loader.load;
    const wrapped = registration => load.call(loader, wrapRegistration(registration));
    Object.defineProperty(loader, "load", {
      configurable: true, enumerable: descriptor?.enumerable ?? true,
      get: () => wrapped, set: value => { load = value; },
    });
    if (Array.isArray(loader.pendingQueue)) {
      for (let index = 0; index < loader.pendingQueue.length; index++) loader.pendingQueue[index] = wrapRegistration(loader.pendingQueue[index]);
    }
    loaders.add(loader);
    return loader;
  }

  const descriptor = Object.getOwnPropertyDescriptor(window, "__ModuleLoader__");
  if (!descriptor || descriptor.configurable) {
    let loader = installLoader(window.__ModuleLoader__);
    Object.defineProperty(window, "__ModuleLoader__", {
      configurable: true, enumerable: descriptor?.enumerable ?? true,
      get: () => loader, set: value => { loader = installLoader(value); },
    });
  } else { installLoader(window.__ModuleLoader__); }
  window.__dshPublicWebDiagnostics = () => diagnostics.snapshot();
  return { createDiagnostics, createResourceProtocolResolver, waitForAcknowledgement, wrapWatchStream,
    adaptContext, wrapRegistration, installLoader, diagnostics, watchAckTimeoutMs };
})(window, globalThis.__DSH_PUBLIC_WEB_CONFIG__);
