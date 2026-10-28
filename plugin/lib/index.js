/**
 * dsh-simple-proxy — the Host half.
 *
 * The settings page writes `enabled` / `host` / `port` / `probeUrl` into this
 * plugin's config document. A write reloads this plugin, `apply` runs again and
 * {@link reconcile} makes the network match the config: a proxy dispatcher
 * installed, or the previous dispatcher restored. A one-second watchdog exists
 * only for config changes that never reach this fiber (a hand-edited
 * `cordis.patch.yml` reconciled by someone else); it is idempotent, so the
 * normal reload path changes nothing.
 *
 * Two loopback-only routes give the settings page the two facts it cannot read
 * from the config document: whether the proxy is live right now, and whether a
 * candidate proxy endpoint actually carries a request. They are plain `fetch`
 * targets (`GET /dsh-simple-proxy/status`, `POST /dsh-simple-proxy/test`) rather than a
 * custom `ctx.remote.*` namespace, because a remote namespace needs generated
 * typert schemas while the web server only asks for a path and a handler.
 *
 * @module dsh-simple-proxy
 */

import z from "@deepseek-ai/schemastery";

import {
  DEFAULT_BYPASS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PROBE_URL,
  describeError,
  diagnose,
  installProxyDispatcher,
  normalizeBypass,
  parseProxyEndpoint,
  probeThroughProxy,
  recentActivity,
  replayProvider,
  watchFetch,
} from "./proxy.js";
import { relayStatus, restoreRelay, syncRelay } from "./relay.js";

/**
 * Settings namespace of this plugin.
 *
 * A settings document is addressed by its loader entry id, so this must stay
 * identical to the `id` in `cordis.patch.yml`.
 */
export const SETTINGS_NS = "dsh-simple-proxy";

/** Route the settings page reads the live state from. */
export const STATUS_PATH = "/dsh-simple-proxy/status";

/** Route the settings page posts a candidate endpoint to. */
export const TEST_PATH = "/dsh-simple-proxy/test";

/** Route that reports what this runtime's network stack looks like. */
export const DIAG_PATH = "/dsh-simple-proxy/diag";

/** Route that replays one provider request from inside the Host process. */
export const PROVIDER_PATH = "/dsh-simple-proxy/provider";

/** How often the watchdog re-reads the config, in milliseconds. */
const WATCH_INTERVAL_MS = 1000;

/** Largest request body the test route accepts. */
const MAX_BODY_BYTES = 8192;

/**
 * Fields the settings page can write.
 *
 * Every field is volatile — that is what lets `dsh-settings` write it — and
 * every field has a default so the page has something to show before the user
 * has saved anything. The proxy starts off: loading a plugin is not permission
 * to route someone's traffic through a port they have not confirmed.
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile().description("Route DSH's outbound HTTP through the proxy below."),
  host: z.string().default(DEFAULT_HOST).volatile().description("Proxy host, or host:port."),
  port: z.string().default(String(DEFAULT_PORT)).volatile().description("Proxy port, used when the host carries none."),
  bypass: z
    .string()
    .default(DEFAULT_BYPASS)
    .volatile()
    .description("Host suffixes that stay direct, comma separated. Empty routes everything."),
  probeUrl: z.string().default(DEFAULT_PROBE_URL).volatile().description("URL the connection test requests through the proxy."),
  relay: z
    .boolean()
    .default(true)
    .volatile()
    .description(
      "Also point billion-context's relay at this proxy. That relay is a child process and carries all model traffic, so it cannot be reached by an in-process dispatcher; it takes effect the next time its daemon starts.",
    ),
});

export const name = "dsh-simple-proxy";

/** Nothing is a hard dependency: the plug-in still loads without a web server. */
export const inject = [];

/**
 * Module-level install bookkeeping.
 *
 * Deliberately outside `apply`: a config write restarts the fiber, and the
 * module cache is what survives that, so a reload can tell "the proxy I already
 * installed" apart from "a different proxy" without tearing down a working
 * agent on every unrelated settings save.
 */
const active = { url: null, dispose: null, since: null, source: null, verified: false };

/** Generation counter: a disposer only tears down the install it owns. */
let generation = 0;

/**
 * What the settings page is shown.
 *
 * `desired` is the config, `endpoint` the parsed form of it, `proxy` what is
 * actually installed right now. Keeping the three apart is what makes a
 * mismatch (typed but not saved, saved but rejected) visible instead of silent.
 */
const state = {
  desired: {
    enabled: false,
    host: DEFAULT_HOST,
    port: String(DEFAULT_PORT),
    bypass: DEFAULT_BYPASS,
    probeUrl: DEFAULT_PROBE_URL,
  },
  endpoint: { ok: false, message: "not read yet" },
  proxy: { active: false, url: null, since: null },
  lastError: null,
  lastProbe: null,
  relay: { present: false, managed: false, path: null, proxy: null, mode: null },
};

/**
 * Load the Host half.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - this plugin's config document.
 */
export function apply(ctx, config = {}) {
  const ownGeneration = ++generation;

  /** One config value, tolerating both a plain value and a schema wrapper. */
  const field = (key) => {
    const value = config?.[key];
    return value?.get?.() ?? value;
  };

  /**
   * The persisted raw config, when the config editor can see it.
   *
   * `describe()` hands back the resolved value with defaults applied, which
   * cannot distinguish "the user typed 7890" from "7890 is the default". The
   * raw patch document can, and it is also what a reload delivers, so it is
   * preferred when present.
   */
  const rawConfig = () => {
    try {
      const rows = ctx.get("configEditor")?.entries?.();
      if (!Array.isArray(rows)) return undefined;
      const row = rows.find((entry) => entry?.options?.id === SETTINGS_NS);
      const raw = row?.options?.config;
      return isRecord(raw) ? raw : undefined;
    } catch {
      return undefined;
    }
  };

  const readConfig = () => {
    const raw = rawConfig();
    const pick = (key, fallback) => {
      const fromRaw = raw?.[key];
      if (fromRaw !== undefined && fromRaw !== null) return fromRaw;
      const fromField = field(key);
      if (fromField !== undefined && fromField !== null) return fromField;
      return fallback;
    };
    return {
      enabled: toBoolean(pick("enabled", false)),
      host: String(pick("host", DEFAULT_HOST)).trim(),
      port: String(pick("port", String(DEFAULT_PORT))).trim(),
      bypass: String(pick("bypass", DEFAULT_BYPASS)).trim(),
      probeUrl: String(pick("probeUrl", DEFAULT_PROBE_URL)).trim(),
      relay: toBoolean(pick("relay", true)),
    };
  };

  const log = (level, text, ...args) => {
    try {
      ctx.logger?.[level]?.(`[dsh-simple-proxy] ${text}`, ...args);
    } catch {
      // A logger that rejects an unknown level must not break routing.
    }
  };

  /**
   * Record why the proxy is not doing what the settings ask, logging once per
   * distinct reason — the watchdog asks again every second, and a repeated
   * message would bury the first answer under a thousand copies of itself.
   */
  function noteError(text) {
    const changed = state.lastError !== text;
    state.lastError = text;
    if (changed && text !== null) log("error", "%s", text);
  }

  /**
   * Make the network match the config.
   *
   * Idempotent by construction: it compares the wanted proxy URL with the
   * installed one and does nothing when they agree. That is what makes it safe
   * to call from `apply`, from the watchdog, and from a settings write that
   * restarted the fiber — every caller asks the same question.
   */
  /**
   * Keep billion-context's relay config in step with this plugin.
   *
   * Deliberately best-effort: a profile without bili, or a bili config that
   * cannot be read, must not stop the dispatcher from working. The outcome is
   * reported through the status route instead of thrown.
   */
  const applyRelay = async (url, wanted) => {
    if (!wanted) {
      const restored = await restoreRelay();
      if (restored.restored) log("info", "billion-context relay config restored");
      state.relay = await relayStatus();
      return;
    }
    const synced = await syncRelay(url);
    if (synced.changed) {
      log("info", "billion-context relay pointed at %s (%s)", url, synced.path);
    } else if (!synced.ok && synced.message !== "billion-context is not installed") {
      log("warn", "could not configure the billion-context relay: %s", synced.message);
    }
    state.relay = await relayStatus();
  };

  async function reconcile() {
    const desired = readConfig();
    state.desired = desired;
    const parsed = parseProxyEndpoint(desired.host, desired.port);
    state.endpoint = parsed;

    if (!desired.enabled) {
      await uninstall("disabled in settings");
      noteError(null);
      return;
    }
    if (!parsed.ok) {
      await uninstall(`invalid endpoint: ${parsed.message}`);
      noteError(`proxy endpoint unusable: ${parsed.message}`);
      return;
    }
    if (active.url === parsed.url && active.dispose !== null) {
      await applyRelay(parsed.url, desired.relay);
      noteError(null);
      return;
    }
    await uninstall("switching proxy");
    try {
      const installed = await installProxyDispatcher(parsed.url, { bypass: normalizeBypass(desired.bypass) });
      active.url = parsed.url;
      active.dispose = installed.dispose;
      active.source = installed.source;
      active.verified = installed.verified;
      active.since = Date.now();
      state.proxy = { active: true, url: parsed.url, since: active.since };
      noteError(null);
      log("info", "routing DSH traffic through %s (undici from %s)", parsed.url, installed.source);
      await applyRelay(parsed.url, desired.relay);
      // Verification makes an install slow enough to outlive the settings that
      // asked for it: an unload, a disable, or a new endpoint can all arrive
      // while the live probe is still in flight. Whatever the config wants now
      // wins, so the freshly installed dispatcher is torn down immediately
      // instead of lingering behind a stale `active.url`.
      const latest = readConfig();
      const wantedNow = latest.enabled ? parseProxyEndpoint(latest.host, latest.port) : { ok: false };
      if (!wantedNow.ok || wantedNow.url !== parsed.url) {
        await uninstall("superseded while installing");
      }
    } catch (error) {
      noteError(`could not install the proxy: ${describeError(error)}`);
      state.proxy = { active: false, url: null, since: null };
    }
  }

  /** Give the network back, unless another fiber generation already replaced it. */
  async function uninstall(reason) {
    const dispose = active.dispose;
    const url = active.url;
    active.url = null;
    active.dispose = null;
    active.since = null;
    active.source = null;
    active.verified = false;
    state.proxy = { active: false, url: null, since: null };
    if (dispose === null) return;
    try {
      await dispose();
      const restored = await restoreRelay();
      if (restored.restored) log("info", "billion-context relay config restored");
      state.relay = await relayStatus();
      log("info", "proxy %s removed (%s)", url ?? "?", reason);
    } catch (error) {
      log("error", "could not remove the proxy: %s", describeError(error));
    }
  }

  /**
   * Serialize reconciles.
   *
   * Two callers can ask at once (a settings write and the watchdog tick), and
   * interleaving an install with an uninstall would leave the disposer of one
   * generation restoring a dispatcher the other just installed.
   */
  let chain = Promise.resolve();
  const schedule = (reason) => {
    chain = chain
      .then(() => reconcile())
      .catch((error) => {
        state.lastError = describeError(error);
        log("error", "reconcile failed (%s): %s", reason, state.lastError);
      });
    return chain;
  };

  const statusPayload = () => ({
    ns: SETTINGS_NS,
    desired: state.desired,
    endpoint: state.endpoint,
    proxy: {
      active: active.dispose !== null,
      url: active.url,
      since: active.since,
      undici: active.source,
      verified: active.verified,
    },
    relay: state.relay,
    runtime: { node: process.versions.node ?? null, electron: process.versions.electron ?? null },
    lastError: state.lastError,
    lastProbe: state.lastProbe,
    generation,
  });

  // Passive observation, not routing: it records what this process asks
  // `fetch()` to do so a failure can be read instead of guessed at.
  ctx.effect(() => watchFetch(), "dsh-simple-proxy: fetch watcher");

  ctx.effect(() => {
    void schedule("apply");

    const timer = setInterval(() => {
      void schedule("watchdog");
    }, WATCH_INTERVAL_MS);
    // The desktop app keeps a session alive for hours; an unref'd timer must
    // not be the reason the process stays busy, and the host keeps running
    // regardless.
    timer.unref?.();

    return () => {
      clearInterval(timer);
      // A newer generation owns the network now; only the last one hands it
      // back, which is what stops a reload from flickering the dispatcher.
      // The undo goes through the same chain as the installs, because an
      // install that is still verifying would otherwise finish *after* this
      // cleanup and leave its dispatcher installed for good.
      if (generation === ownGeneration) {
        chain = chain.then(() => uninstall("plugin unloaded")).catch(() => {});
      }
    };
  }, "dsh-simple-proxy: network reconciliation");

  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;

    webCtx.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: STATUS_PATH,
          handler: (req, res) => handleStatus(req, res),
        }),
      "dsh-simple-proxy: status route",
    );

    webCtx.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: TEST_PATH,
          handler: (req, res) => handleTest(req, res),
        }),
      "dsh-simple-proxy: test route",
    );

    webCtx.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: DIAG_PATH,
          handler: (req, res) => handleDiag(req, res),
        }),
      "dsh-simple-proxy: diagnostics route",
    );

    webCtx.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: PROVIDER_PATH,
          handler: (req, res) => handleProvider(req, res),
        }),
      "dsh-simple-proxy: provider replay route",
    );
  });

  /** Answer with the live state; the browser polls this while the page is open. */
  async function handleStatus(req, res) {
    if (!isLoopback(req)) {
      send(res, 403, { ok: false, error: { message: "dsh-simple-proxy routes are loopback-only" } });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { ok: false, error: { message: `method ${req.method} is not allowed here` } });
      return;
    }
    // Re-read before answering: the page is asking "what is true now?", and the
    // watchdog tick may be up to a second old.
    await schedule("status");
    send(res, 200, { ok: true, value: statusPayload() });
  }

  /**
   * Probe a candidate endpoint.
   *
   * The body may carry the form's unsaved `host` / `port` / `url`, so the user
   * can test a proxy before trusting it. Probing uses a dedicated dispatcher,
   * never the installed one: a test must not perturb live traffic, and must
   * work while the proxy is still switched off.
   */
  async function handleTest(req, res) {
    if (!isLoopback(req)) {
      send(res, 403, { ok: false, error: { message: "dsh-simple-proxy routes are loopback-only" } });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { ok: false, error: { message: `method ${req.method} is not allowed here` } });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      send(res, 400, { ok: false, error: { message: describeError(error) } });
      return;
    }

    const current = readConfig();
    const host = typeof body.host === "string" && body.host.trim() !== "" ? body.host : current.host;
    const port = typeof body.port === "string" || typeof body.port === "number" ? body.port : current.port;
    const target = typeof body.url === "string" && body.url.trim() !== "" ? body.url.trim() : current.probeUrl;
    const bypass = typeof body.bypass === "string" ? body.bypass : current.bypass;

    const parsed = parseProxyEndpoint(host, port);
    if (!parsed.ok) {
      const value = { reachable: false, message: parsed.message, url: target };
      state.lastProbe = { ...value, at: Date.now() };
      send(res, 200, { ok: true, value: state.lastProbe });
      return;
    }

    log("info", "probing %s through %s", target, parsed.url);
    // The live endpoint is already installed globally, so reuse it instead of
    // swapping a fresh dispatcher in and out underneath running traffic.
    const result = await probeThroughProxy(parsed.url, target, {
      installed: active.url === parsed.url,
      bypass: normalizeBypass(bypass),
    });
    const value = {
      reachable: result.ok,
      status: result.status ?? null,
      ms: result.ms ?? null,
      url: result.url ?? target,
      proxy: parsed.url,
      message: result.message ?? null,
    };
    state.lastProbe = { ...value, at: Date.now() };
    send(res, 200, { ok: true, value: state.lastProbe });
  }

  /**
   * Report the runtime facts behind a proxy failure.
   *
   * This route exists because every failure so far has been a property of the
   * process DSH runs in — which undici copy `import("undici")` resolves to,
   * which handler protocol the embedded `fetch` speaks, whether that pair
   * carries TLS through the tunnel. None of it is visible from outside the
   * app, and a screenshot of the panel cannot capture it.
   */
  async function handleDiag(req, res) {
    if (!isLoopback(req)) {
      send(res, 403, { ok: false, error: { message: "dsh-simple-proxy routes are loopback-only" } });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { ok: false, error: { message: `method ${req.method} is not allowed here` } });
      return;
    }
    const desired = readConfig();
    const parsed = parseProxyEndpoint(desired.host, desired.port);
    const proxyUrl = parsed.ok ? parsed.url : undefined;
    const targets = [desired.probeUrl, "https://api.deepseek.com/"].filter(
      (value, index, all) => typeof value === "string" && value !== "" && all.indexOf(value) === index,
    );
    const provider = new URL(req.url ?? "/", "http://loopback").searchParams.get("provider");
    try {
      const report = await diagnose(proxyUrl, {
        targets,
        bypass: normalizeBypass(desired.bypass),
      });
      const value = { ...report, activity: recentActivity() };
      if (typeof provider === "string" && provider !== "" && proxyUrl !== undefined) {
        value.provider = await replayModes(proxyUrl, provider, new URL(req.url ?? "/", "http://loopback").searchParams.get("model") ?? undefined);
      }
      send(res, 200, { ok: true, value });
    } catch (error) {
      send(res, 200, { ok: false, error: { message: describeError(error) } });
    }
  }

  /**
   * Replay one provider request through whatever is installed right now.
   *
   * The panel can prove the tunnel carries an HTTPS GET; it cannot prove the
   * provider answers the *model* call. This route closes that gap by sending
   * the same shape DSH sends, from the same process, with the credential the
   * Host was started with — reported back as status, reason phrase, duration
   * and a body prefix, never as the key itself.
   */
  async function handleProvider(req, res) {
    if (!isLoopback(req)) {
      send(res, 403, { ok: false, error: { message: "dsh-simple-proxy routes are loopback-only" } });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { ok: false, error: { message: `method ${req.method} is not allowed here` } });
      return;
    }
    try {
      const body = await readJson(req);
      const current = readConfig();
      const parsed = parseProxyEndpoint(current.host, current.port);
      const value = await replayProvider({
        url: body.url,
        model: body.model,
        input: body.input,
        apiKeyEnv: body.apiKeyEnv,
        timeoutMs: body.timeoutMs,
        mode: body.mode,
        proxyUrl: typeof body.proxyUrl === "string" && body.proxyUrl !== "" ? body.proxyUrl : parsed.ok ? parsed.url : undefined,
      });
      send(res, 200, { ok: true, value });
    } catch (error) {
      send(res, 200, { ok: false, error: { message: describeError(error) } });
    }
  }
}

/**
 * Replay one provider call three ways and report all three.
 *
 * `current` is what the plugin actually does, `proxy` forces the tunnel past the
 * bypass list, `direct` skips the proxy. The three answers together separate
 * "the tunnel is fine but this host was bypassed" from "the gateway dislikes
 * this egress" — a distinction no single probe can make.
 *
 * @param proxyUrl - the proxy the plugin is configured with.
 * @param url - the provider endpoint to replay.
 * @param model - model id to ask for; the route's caller supplies one.
 */
async function replayModes(proxyUrl, url, model) {
  const modes = {};
  for (const mode of ["current", "proxy", "direct"]) {
    modes[mode] = await replayProvider({ url, model, mode, proxyUrl, timeoutMs: 12000 });
  }
  return modes;
}

/** Coerce one settings value to a boolean, accepting the strings a YAML file may hold. */
function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  if (typeof value === "number") return value !== 0;
  return false;
}

/** Whether a request arrived on loopback, which is the only place these routes answer. */
function isLoopback(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== "string") return false;
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.") ||
    normalized === "::ffff:7f00:1"
  );
}

/** Write one JSON envelope; `{ok, value}` and `{ok:false, error}` are what the client unwraps. */
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Read a small JSON request body; an empty body is an empty object. */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  const parsed = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

/** Plain-object test, since every payload here comes from JSON. */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
