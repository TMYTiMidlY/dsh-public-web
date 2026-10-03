window.__ModuleLoader__.load({
  id: "dsh-public-web",
  factory: () => {
    const MAX_COUNT = 65535;
    const MAX_EVENTS = 20;
    const DEFAULT_WATCH_ACK_TIMEOUT_MS = 800;

    /** Only aggregate browser diagnostics: never retain an address or file data. */
    function createDiagnostics(log = console, now = () => Date.now()) {
      const counters = Object.create(null);
      const events = [];
      const warned = new Set();
      let urlCompat = "pending";
      return {
        event(kind, elapsedMs) {
          counters[kind] = Math.min(MAX_COUNT, (counters[kind] || 0) + 1);
          const event = { kind, at: now() };
          if (Number.isFinite(elapsedMs)) event.elapsedMs = Math.min(86400000, Math.max(0, Math.round(elapsedMs)));
          events.push(event);
          if (events.length > MAX_EVENTS) events.shift();
        },
        urlStatus(status) {
          urlCompat = status;
          this.event(`url-${status}`);
        },
        warnOnce(kind, message) {
          if (warned.has(kind)) return;
          warned.add(kind);
          log?.warn?.(`[dsh-public-web] ${message}`);
        },
        snapshot() {
          return {
            urlCompat,
            counters: { ...counters },
            events: events.map((event) => ({ ...event })),
          };
        },
      };
    }

    const diagnostics = createDiagnostics();

    function watchAckTimeoutMs(value) {
      return Number.isInteger(value) && value >= 1 && value <= 60000 ? value : DEFAULT_WATCH_ACK_TIMEOUT_MS;
    }

    /** ResourceRegistry's local resolver. The browser's URL constructor is untouched. */
    function createResourceProtocolResolver(NativeURL, report = diagnostics) {
      let compatible = false;
      let disposed = false;
      if (typeof NativeURL !== "function") {
        report.urlStatus("failed");
        report.warnOnce("url-failed", "Resource URL compatibility could not start: URL parser unavailable.");
      } else {
        try {
          const probe = new NativeURL("dsh-resource://file/__dsh_probe__/x");
          compatible = probe.protocol !== "dsh-resource:" || probe.hostname !== "file";
        } catch {
          compatible = true;
        }
        report.urlStatus(compatible ? "enabled" : "not-needed");
        if (compatible) report.warnOnce("url-enabled", "Resource URL compatibility enabled for this browser's resource resolver.");
      }
      return {
        protocolOf(address) {
          try {
            const parsed = new NativeURL(address);
            if (parsed.protocol === "dsh-resource:" && parsed.hostname) return parsed.hostname.toLowerCase();
            if (parsed.protocol !== "dsh-resource:" && !compatible) return undefined;
          } catch {
            if (!compatible) return undefined;
          }
          if (!compatible || disposed || typeof address !== "string") return undefined;
          // Only the resource authority grammar; no userinfo, port, whitespace,
          // relative URL or other scheme is accepted by this fallback.
          const match = /^dsh-resource:\/\/([a-z][a-z0-9_-]*)(?=\/|[?#]|$)/i.exec(address);
          if (!match) return undefined;
          report.event("url-fallback");
          return match[1].toLowerCase();
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          report.urlStatus("disposed");
        },
      };
    }

    /** Race a ready promise with cancellation and optionally one cleaned-up timer. */
    function waitForAcknowledgement(ready, signal, timeoutMs) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (value, error, failed = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", stop);
          if (failed) reject(error);
          else resolve(value);
        };
        const stop = () => finish({ kind: "aborted" });
        if (signal.aborted) {
          stop();
          return;
        }
        signal.addEventListener("abort", stop, { once: true });
        if (timeoutMs !== undefined) timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
        ready.then((value) => finish(value), (error) => finish(undefined, error, true));
      });
    }

    /** Production file stream shared by the vendored provider and its tests. */
    async function* openFileFrames(notices, stat, signal, options = {}) {
      const report = options.diagnostics || diagnostics;
      const timeoutMs = watchAckTimeoutMs(options.watchAckTimeoutMs);
      const now = options.now || (() => performance.now());
      const started = now();
      const ready = Promise.resolve(notices.ready).then((acknowledged) => ({
        kind: acknowledged ? "ack" : "ended",
        elapsedMs: now() - started,
      }));
      let current;
      report.event("watch-open");
      try {
        let acknowledgement = await waitForAcknowledgement(ready, signal, timeoutMs);
        if (acknowledgement.kind === "aborted" || signal.aborted) return;
        const timedOut = acknowledgement.kind === "timeout";
        if (timedOut) {
          report.event("watch-ack-timeout", timeoutMs);
          report.warnOnce("watch-ack-timeout", "File watch acknowledgement is slow; showing a snapshot while continuing to wait for live updates.");
        } else {
          report.event(acknowledgement.kind === "ack" ? "watch-ack-on-time" : "watch-ended-before-ack", acknowledgement.elapsedMs);
        }

        const first = await stat();
        if (signal.aborted) return;
        if (first.ok) {
          notices.bind(first.value.absolutePath);
          current = first.value;
        }
        yield first;
        if (acknowledgement.kind === "ended" || signal.aborted) return;

        if (timedOut) {
          // Keep the original follower: a timeout does not discard the subscription.
          acknowledgement = await waitForAcknowledgement(ready, signal);
          if (acknowledgement.kind === "aborted" || signal.aborted) return;
          if (acknowledgement.kind === "ended") {
            report.event("watch-ended-before-ack", acknowledgement.elapsedMs);
            return;
          }
          report.event("watch-ack-late", acknowledgement.elapsedMs);
          // A change may fall between the snapshot and the delayed Host watch.
          // Read once again after acknowledgement, then consume queued changes.
          const refreshed = await stat();
          if (signal.aborted) return;
          current = refreshed.ok ? refreshed.value : undefined;
          if (refreshed.ok) notices.bind(refreshed.value.absolutePath);
          yield refreshed;
        }

        for await (const notice of notices) {
          if (signal.aborted) return;
          if (current === undefined) {
            if (notice.kind === "absent") continue;
          } else if (notice.kind === "changed" && notice.version === current.version) continue;
          const again = await stat();
          if (signal.aborted) return;
          current = again.ok ? again.value : undefined;
          if (again.ok) notices.bind(again.value.absolutePath);
          yield again;
        }
      } finally {
        if (signal.aborted) report.event("watch-aborted");
        report.event("watch-closed");
        notices.dispose();
      }
    }

    function apply(ctx) {
      ctx.effect(() => {
        const previous = Object.getOwnPropertyDescriptor(window, "__dshPublicWebDiagnostics");
        const snapshot = () => diagnostics.snapshot();
        Object.defineProperty(window, "__dshPublicWebDiagnostics", {
          configurable: true,
          value: snapshot,
        });
        return () => {
          if (window.__dshPublicWebDiagnostics !== snapshot) return;
          if (previous) Object.defineProperty(window, "__dshPublicWebDiagnostics", previous);
          else delete window.__dshPublicWebDiagnostics;
        };
      }, "dsh-public-web: browser diagnostics");
    }

    return {
      inject: [],
      apply,
      diagnostics,
      createDiagnostics,
      createResourceProtocolResolver,
      watchAckTimeoutMs,
      waitForAcknowledgement,
      openFileFrames,
    };
  },
});
