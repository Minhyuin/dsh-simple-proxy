/**
 * dsh-simple-proxy — the Host half's network layer.
 *
 * Three jobs, all of them deliberately small:
 *
 * 1. Turn the two settings fields the user types (`host`, `port`) into one
 *    proxy URL, refusing everything the `ProxyAgent` cannot use instead of
 *    handing it an unusable string at request time.
 * 2. Install that proxy as undici's global dispatcher. Node's built-in
 *    `fetch()` resolves the global dispatcher on every call, so this is what
 *    makes DSH's own outbound HTTP — the pi-ai provider stack, the MCP HTTP
 *    transport, `web_fetch` — go through the proxy, while `process.env` stays
 *    untouched and spawned child processes keep talking to the network
 *    directly.
 * 3. Probe a candidate proxy on demand so the settings page can answer "is
 *    this proxy actually working?" before the user trusts it with a model
 *    call.
 *
 * The dispatcher mirrors the policy agent shipped in
 * `@deepseek-ai/dsh-http-proxy`: loopback targets always stay direct, so a
 * local model server or the DSH web server never gets routed through the
 * proxy. The difference is the source of the policy — that package reads
 * `http_proxy` from the environment at boot, this one reads the settings
 * document the user edits at runtime.
 *
 * @module dsh-simple-proxy/proxy
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

/** Host assumed when the settings entry leaves the host blank. */
export const DEFAULT_HOST = "127.0.0.1";

/** Port assumed when the settings entry leaves the port blank. */
export const DEFAULT_PORT = 7890;

/** URL the "test connection" button fetches when the entry names none. */
export const DEFAULT_PROBE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/**
 * Hosts that stay direct unless the user says otherwise.
 *
 * `api.deepseek.com` answers from mainland China without any help, and a model
 * session that goes out through a foreign node is slower and takes a second
 * network dependency it does not need. The proxy exists for the providers that
 * are unreachable or slow from here, so the default is "tunnel only what needs
 * tunnelling"; clearing the field routes everything.
 */
export const DEFAULT_BYPASS = "deepseek.com";

/** How long one connection test may take before it is reported as a timeout. */
export const PROBE_TIMEOUT_MS = 10000;

/** Port numbers above this cannot be expressed as a TCP port. */
const MAX_PORT = 65535;

/**
 * Turn the settings entry's `host` and `port` into one proxy URL.
 *
 * Accepts what people actually paste: a bare host, `host:port`, or a full
 * `http://host:port` / `https://host:port`. A port embedded in the host wins
 * over the separate port field, because the more specific input is the more
 * deliberate one; the field is the fallback for people who fill two boxes.
 *
 * @param hostText - the settings entry's `host` value.
 * @param portText - the settings entry's `port` value.
 * @returns `{ok: true, url, host, port, scheme}`, or `{ok: false, message}`.
 */
export function parseProxyEndpoint(hostText, portText) {
  const raw = typeof hostText === "string" ? hostText.trim() : hostText === undefined || hostText === null ? "" : String(hostText).trim();
  if (raw === "") return { ok: false, message: "proxy host is empty" };

  let scheme = "http";
  let rest = raw;
  const schemeMatch = /^(https?):\/\//i.exec(rest);
  if (schemeMatch !== null) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    // Named before the plain-host check so "socks5://host" gets an answer that
    // explains the limitation instead of complaining about punctuation.
    return { ok: false, message: `only http:// and https:// proxies are supported, got ${JSON.stringify(raw)}` };
  }
  if (/[\s/\\@]/.test(rest.replace(/\/+$/, ""))) return { ok: false, message: `proxy host is not a plain host: ${JSON.stringify(raw)}` };
  rest = rest.replace(/\/+$/, "");

  let host = rest;
  let embeddedPort;
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1) return { ok: false, message: `unterminated IPv6 host: ${JSON.stringify(raw)}` };
    const tail = host.slice(close + 1);
    if (tail.startsWith(":")) embeddedPort = tail.slice(1);
    else if (tail !== "") return { ok: false, message: `unexpected text after the IPv6 host: ${JSON.stringify(raw)}` };
    host = host.slice(0, close + 1);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1) {
      // More than one colon without brackets is an unbracketed IPv6 literal,
      // which cannot carry a port; the port field is used instead.
      if (host.indexOf(":") === colon) {
        embeddedPort = host.slice(colon + 1);
        host = host.slice(0, colon);
      }
    }
  }
  if (host === "") return { ok: false, message: `proxy host is empty in ${JSON.stringify(raw)}` };

  const portSource = embeddedPort !== undefined && embeddedPort !== "" ? embeddedPort : portText;
  const port = normalizePort(portSource);
  if (port === undefined) return { ok: false, message: `proxy port must be an integer between 1 and ${MAX_PORT}, got ${JSON.stringify(portSource ?? "")}` };

  return { ok: true, url: `${scheme}://${host}:${port}`, host, port, scheme };
}

/** Coerce one port value; `undefined` when it is not a usable TCP port. */
function normalizePort(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= MAX_PORT ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^\d{1,5}$/u.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= MAX_PORT ? port : undefined;
}

/**
 * Whether one request target must bypass the proxy.
 *
 * The shipped policy agent always keeps loopback direct; a local model server,
 * the DSH web server, or an MCP server on the same machine would otherwise
 * become unreachable the moment a proxy is switched on. `0.0.0.0`/`::` are
 * included because they resolve to this machine on connect.
 *
 * @param hostname - a WHATWG URL hostname (IPv6 keeps its brackets).
 */
export function isDirectTarget(hostname) {
  if (typeof hostname !== "string" || hostname === "") return true;
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1" || host === "[::]" || host === "::") return true;
  if (host === "0.0.0.0") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4 !== null) {
    const first = Number(v4[1]);
    return first === 127 || first === 0;
  }
  return false;
}

/** How long one dispatcher/host-fetch compatibility probe may take. */
const COMPAT_PROBE_TIMEOUT_MS = 2000;

/**
 * Loopback port the compatibility probe connects to.
 *
 * Deliberately a legal, unassigned port: `fetch()` refuses a long list of
 * "bad ports" (1, 9, 25, 587, …) before it ever reaches the dispatcher, and a
 * refused probe would then say nothing about the handler protocol.
 */
const COMPAT_PROBE_URL = "http://127.0.0.1:45123/";

/**
 * The one symptom of an undici handler-protocol mismatch.
 *
 * undici 8 renamed the handler hook `onConnect` to `onRequestStart`, and each
 * dispatcher validates the handler it is given. A dispatcher from the wrong
 * major therefore rejects every request `fetch()` makes with
 * `UND_ERR_INVALID_ARG: invalid onRequestStart method` (or `invalid onConnect
 * method` in the other direction) — which is how a version mismatch is told
 * apart from a genuinely refused connection.
 */
const HANDLER_MISMATCH = /invalid (?:onRequestStart|onConnect|onError) method/iu;

/**
 * What an install verifies itself against.
 *
 * The protocol probe above only proves the dispatcher and `fetch` speak the
 * same handler shape; it never opens a tunnel. This request does, so a copy
 * that dies in the CONNECT/TLS handshake inside DSH's own runtime — which no
 * amount of testing outside that runtime can predict — is skipped in favour of
 * the next one.
 */
const VERIFY_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/**
 * Verification targets, tried in order until one answers, because a node can
 * reset one site while carrying another — measured on this very machine:
 * cloudflare sometimes drops the TLS handshake through the tunnel while
 * `api.deepseek.com` answers a 401 in a tenth of a second. A candidate is
 * accepted as soon as any target answers. Both targets are HTTPS, so a copy
 * that cannot do CONNECT/TLS still fails every one of them.
 */
const VERIFY_URLS = [VERIFY_URL, "https://api.deepseek.com/"];

/** How long one verification request may take. */
const VERIFY_TIMEOUT_MS = 6000;

/**
 * Load `undici` from the given base, or `undefined` when that base has none.
 *
 * @param base - a path or `file:` URL `createRequire` accepts.
 * @returns `{module, version}`, with `version` when the copy's manifest is
 *   readable — the version is what turns "some copy failed" into a diagnosable
 *   report.
 */
function requireFrom(base) {
  let load;
  try {
    load = createRequire(base);
  } catch {
    return undefined;
  }
  let module;
  try {
    module = load("undici");
  } catch {
    return undefined;
  }
  let version = null;
  try {
    const manifest = load("undici/package.json");
    if (typeof manifest?.version === "string") version = manifest.version;
  } catch {
    // A copy without a readable manifest is still usable; only the label goes.
  }
  return { module, version };
}

/**
 * The profile directory, whether or not this process was told about it.
 *
 * The desktop app starts the runtime without `DSH_PROFILE_DIR`, yet the
 * profile's `node_modules` is exactly where the user's own undici 7 lives —
 * which is the copy most likely to match the runtime's fetch. Reading the
 * environment first and falling back to `~/.dsh/profiles/<profile>` keeps the
 * shell case exact and makes the app case work at all.
 */
function profileDir() {
  const fromEnv = process.env.DSH_PROFILE_DIR;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  const home = homedir();
  if (typeof home !== "string" || home === "") return undefined;
  const name = typeof process.env.DSH_PROFILE === "string" && process.env.DSH_PROFILE !== "" ? process.env.DSH_PROFILE : "desktop";
  return path.join(home, ".dsh", "profiles", name);
}

/**
 * Every `undici` copy this process can reach, most host-like first.
 *
 * Why more than one: the plugin is imported by the DSH loader from inside the
 * application's module graph, so a bare `import("undici")` can resolve to the
 * copy bundled with DSH rather than the one the settings profile installs.
 * Those copies differ in major version (the desktop runtime ships undici 8,
 * the plugin's own dependency is undici 7), and a dispatcher only accepts
 * handlers from its own protocol. Choosing a copy by hand is therefore a
 * coin flip per runtime; {@link createProxyDispatcher} instead tries each one
 * against the fetch that will actually use it.
 *
 * @returns `{source, module, version}` entries, deduped by module identity.
 */
export async function undiciCandidates() {
  const candidates = [];
  const add = (source, found) => {
    const module = found?.module;
    if (module === undefined || module === null) return;
    if (typeof module.Agent !== "function") return;
    if (typeof module.getGlobalDispatcher !== "function") return;
    if (typeof module.setGlobalDispatcher !== "function") return;
    if (candidates.some((entry) => entry.module === module)) return;
    candidates.push({ source, module, version: found.version ?? null });
  };

  try {
    add("host", { module: await import("undici") });
  } catch {
    // No undici on the loader's resolution path; the explicit copies below
    // still cover the normal desktop and profile layouts.
  }
  if (typeof process.resourcesPath === "string") {
    add("dsh", requireFrom(path.join(process.resourcesPath, "app.asar", "dsh", "package.json")));
    add("dsh", requireFrom(path.join(process.resourcesPath, "app", "package.json")));
  }
  const profile = profileDir();
  if (profile !== undefined) {
    add("profile", requireFrom(path.join(profile, "package.json")));
    // The junction the dev install creates resolves to the plugin's own real
    // path, so this is the copy the plugin's `dependencies` actually name.
    add("profile", requireFrom(path.join(profile, "node_modules", "dsh-simple-proxy", "package.json")));
  }
  add("plugin", requireFrom(import.meta.url));

  // A bare `import("undici")` yields a different namespace object than
  // `require("undici")` for the same file, so identity cannot name it — but the
  // constructor it exports is the same function. Matching on it lets the
  // diagnostics report a version for the copy the loader actually handed us.
  for (const entry of candidates) {
    if (entry.version !== null) continue;
    const twin = candidates.find((other) => other.version !== null && other.module.Agent === entry.module.Agent);
    if (twin !== undefined) entry.version = twin.version;
  }
  return candidates;
}

/**
 * Turn the settings entry's `bypass` text into lower-case host suffixes.
 *
 * Accepts the forms people write: `deepseek.com, example.org`, one per line, or
 * `*.corp.lan`. `*.` is decorative — a suffix already covers subdomains — but
 * it is accepted because that is how `no_proxy` spells it.
 *
 * @param text - the settings entry's `bypass` value.
 * @returns a list of bare lower-case host suffixes.
 */
export function normalizeBypass(text) {
  const parts = String(text ?? "")
    .split(/[\s,;]+/u)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  return parts.map((entry) => (entry.startsWith("*.") ? entry.slice(2) : entry)).filter((entry) => entry !== "");
}

/**
 * Whether `hostname` is one of the bypassed hosts, or a subdomain of one.
 *
 * @param hostname - an origin's hostname.
 * @param bypass - {@link normalizeBypass} output.
 */
export function isBypassed(hostname, bypass) {
  if (!Array.isArray(bypass) || bypass.length === 0) return false;
  const host = String(hostname ?? "").toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  return bypass.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Build one proxy dispatcher from one undici copy.
 *
 * One `Agent` whose pool factory decides per origin: a `ProxyAgent` for
 * everything routable, a plain `Pool` for loopback and for the bypassed hosts.
 * `ProxyAgent` carries the CONNECT tunnel, so HTTPS targets work without any
 * certificate work here.
 *
 * @param module - an undici module namespace.
 * @param proxyUrl - a URL from {@link parseProxyEndpoint}.
 * @param bypass - host suffixes that stay direct; see {@link normalizeBypass}.
 */
function buildDispatcher(module, proxyUrl, bypass) {
  const { Agent, Pool, ProxyAgent } = module;
  return new Agent({
    factory(origin, options) {
      const target = origin instanceof URL ? origin : new URL(String(origin));
      const direct = isDirectTarget(target.hostname) || isBypassed(target.hostname, bypass);
      recordOrigin(target.origin, direct);
      if (direct) return new Pool(origin, options);
      return new ProxyAgent({ ...options, uri: proxyUrl });
    },
  });
}

/** How many entries each activity ring keeps. */
const ACTIVITY_LIMIT = 40;

/** How much of a failing response body the watcher keeps for diagnostics. */
const BODY_PREFIX_LIMIT = 300;

/** Origins this dispatcher decided about, newest last. */
const origins = [];

/** Requests `fetch()` was asked to make, newest last. */
const requests = [];

/** Latest decision per origin, so a request can be labelled without guessing. */
const routing = new Map();

function recordOrigin(origin, direct) {
  const via = direct ? "direct" : "proxy";
  origins.push({ at: Date.now(), origin, via });
  if (origins.length > ACTIVITY_LIMIT) origins.shift();
  routing.set(origin, via);
}

/** Origin of a URL, or the raw text when it does not parse. */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * What this process asked `fetch()` to do, and how this plugin routed it.
 *
 * The rings exist because every failure so far was invisible from outside the
 * process: the panel could say "installed" while the request that mattered went
 * somewhere else entirely. They answer "did that request go through here, and
 * what came back" without guessing.
 *
 * @returns the two activity rings, newest last.
 */
export function recentActivity() {
  return {
    requests: requests.slice(),
    origins: origins.slice(),
    routes: [...routing.entries()].map(([origin, via]) => ({ origin, via })),
  };
}

/**
 * Read at most `BODY_PREFIX_LIMIT` characters from a response clone.
 *
 * Errors are the only interesting bodies here, and they are small, but a proxy
 * can answer with something endless; the reader is cancelled after the prefix
 * so a diagnostic never holds a stream open.
 *
 * @param response - the response to peek at.
 * @returns the prefix, or "" when the body cannot be read.
 */
async function bodyPrefix(response) {
  const reader = response.clone?.().body?.getReader?.();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < BODY_PREFIX_LIMIT) {
      const { value, done } = await reader.read();
      if (done === true) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return text.slice(0, BODY_PREFIX_LIMIT);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cancelling a finished stream is not a problem.
    }
  }
  return text.slice(0, BODY_PREFIX_LIMIT);
}

/**
 * Record every `fetch()` in this process, delegating unchanged.
 *
 * Deliberately passive: the wrapper never rewrites a request, never reads a
 * body, and never touches headers, so it cannot change what a caller sends. It
 * only notes the URL, the status and the duration, which is enough to tell
 * "the model call never reached the proxy" from "the proxy returned 502".
 *
 * @returns a disposer restoring the previous `fetch`.
 */
export function watchFetch() {
  const original = globalThis.fetch;
  if (typeof original !== "function") return () => {};
  const wrapped = async function dshSimpleProxyFetch(input, init) {
    const started = Date.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? "");
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    try {
      const response = await Reflect.apply(original, globalThis, [input, init]);
      const entry = { at: started, method, url: url.slice(0, 300), status: response.status, ms: Date.now() - started, via: routing.get(originOf(url)) ?? null };
      if (response.status >= 400) entry.body = await bodyPrefix(response);
      requests.push(entry);
      if (requests.length > ACTIVITY_LIMIT) requests.shift();
      return response;
    } catch (error) {
      requests.push({ at: started, method, url: url.slice(0, 300), status: null, ms: Date.now() - started, error: describeError(error), via: routing.get(originOf(url)) ?? null });
      if (requests.length > ACTIVITY_LIMIT) requests.shift();
      throw error;
    }
  };
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}

/**
 * Install a throwaway dispatcher for one replay.
 *
 * @param mode - `direct` or `proxy`.
 * @param proxyUrl - proxy to tunnel through for `mode: "proxy"`.
 * @returns `{dispatcher, restore}`, the dispatcher to close afterwards.
 */
async function routeOnce(mode, proxyUrl) {
  if (mode === "proxy") {
    if (typeof proxyUrl !== "string" || proxyUrl === "") throw new Error("replayProvider needs a proxyUrl for mode=proxy");
    const { dispatcher, module } = await createProxyDispatcher(proxyUrl, { bypass: [] });
    return { dispatcher, restore: installTemporarily(module, dispatcher) };
  }
  const candidates = await undiciCandidates();
  if (candidates.length === 0) throw new Error("dsh-simple-proxy has no undici copy to build a direct dispatcher from");
  const { module } = candidates[0];
  const dispatcher = new module.Agent();
  return { dispatcher, restore: installTemporarily(module, dispatcher) };
}

/**
 * Ask the provider endpoint the same question DSH asks it, from this process.
 *
 * The credential is read from the environment the Host was started with and is
 * only ever placed in an `Authorization` header; the answer reports status,
 * timing and a body prefix, never the key. This is what makes "502 from the
 * gateway" distinguishable from "the request never left the machine".
 *
 * `mode` decides which route the probe takes, because "the plugin is on" and
 * "this request went through the plugin" are different questions:
 * `current` uses whatever is installed, `proxy` force-tunnels through
 * `proxyUrl` (bypass list ignored), `direct` bypasses the proxy entirely.
 *
 * @param request - `{url, model, input?, apiKeyEnv?, timeoutMs?, mode?, proxyUrl?}`.
 * @returns status, reason phrase, duration and a bounded body prefix.
 */
export async function replayProvider(request = {}) {
  const url = String(request.url ?? "");
  if (url === "") throw new Error("replayProvider needs a url");
  const apiKeyEnv = typeof request.apiKeyEnv === "string" && request.apiKeyEnv !== "" ? request.apiKeyEnv : "PIONEER_API_KEY";
  const key = process.env[apiKeyEnv];
  const timeoutMs = Number.isFinite(request.timeoutMs) ? Number(request.timeoutMs) : 20000;
  const payload = JSON.stringify({
    model: request.model,
    input: request.input ?? "hi",
    stream: false,
  });
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (typeof key === "string" && key !== "") headers.authorization = `Bearer ${key}`;
  const mode = request.mode === "direct" || request.mode === "proxy" ? request.mode : "current";
  let restore;
  let disposable;
  if (mode !== "current") {
    disposable = await routeOnce(mode, request.proxyUrl);
    restore = disposable.restore;
  }
  const started = Date.now();
  try {
    const response = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text().catch(() => "");
    return {
      url,
      model: request.model ?? null,
      mode,
      apiKeyEnv,
      keyPresent: typeof key === "string" && key !== "",
      status: response.status,
      reason: response.statusText,
      ms: Date.now() - started,
      body: text.slice(0, 800),
    };
  } catch (error) {
    return { url, model: request.model ?? null, mode, apiKeyEnv, keyPresent: typeof key === "string" && key !== "", status: null, reason: describeError(error), ms: Date.now() - started, body: "" };
  } finally {
    restore?.();
    if (disposable !== undefined) await closeQuietly(disposable.dispatcher);
  }
}

/**
 * Ask `fetch()` whether it can actually drive a dispatcher from `module`.
 *
 * The dispatcher is installed **globally** rather than passed as a request
 * option, because that is the path DSH's own requests take and the two differ:
 * undici 8's `setGlobalDispatcher` also publishes a v7-compatible wrapper under
 * the legacy global symbol, so a v8 dispatcher works for the process's (v7-era)
 * `fetch` as long as it is installed — while `fetch(url, {dispatcher})` with
 * that same raw dispatcher hands it a v7 handler and fails with
 * `UND_ERR_INVALID_ARG: invalid onRequestStart method`.
 *
 * The request goes to an unassigned loopback port, which the factory always
 * keeps direct, so this costs one refused connection and no proxy traffic. A
 * handler mismatch throws before anything reaches the socket; any other
 * outcome — `ECONNREFUSED`, a timeout, even a response — means the dispatcher
 * and the fetch agree on the handler protocol.
 *
 * @param module - the undici copy the dispatcher was built from.
 * @param dispatcher - the dispatcher to install for the probe; omit to probe
 *   whatever is installed right now.
 * @returns `{ok: true}` or `{ok: false, reason}`.
 */
async function servesHostFetch(module, dispatcher) {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: true };
  const restore = dispatcher === undefined ? undefined : installTemporarily(module, dispatcher);
  try {
    const response = await fetchImpl(COMPAT_PROBE_URL, {
      signal: AbortSignal.timeout(COMPAT_PROBE_TIMEOUT_MS),
    });
    try {
      await response.body?.cancel();
    } catch {
      // Irrelevant to the verdict.
    }
    return { ok: true };
  } catch (error) {
    const text = describeError(error);
    if (HANDLER_MISMATCH.test(text)) return { ok: false, reason: text };
    return { ok: true };
  } finally {
    restore?.();
  }
}

/**
 * Install `dispatcher` as the global one and return the undo.
 *
 * The undo leaves the dispatcher alone if something else took over in the
 * meantime, and falls back to a fresh direct `Agent` in the (never observed)
 * case where the process had no global dispatcher at all — restoring
 * `undefined` would throw, and leaving the probe's dispatcher installed would
 * hand later requests a closed agent.
 *
 * @param module - the undici copy `dispatcher` came from.
 * @param dispatcher - what to install.
 * @returns a function restoring the previous state.
 */
function installTemporarily(module, dispatcher) {
  const previous = module.getGlobalDispatcher();
  module.setGlobalDispatcher(dispatcher);
  return () => {
    if (module.getGlobalDispatcher() !== dispatcher) return;
    module.setGlobalDispatcher(previous ?? new module.Agent());
  };
}

/**
 * Build a dispatcher for `proxyUrl` from an undici copy the host fetch accepts.
 *
 * @param proxyUrl - a URL from {@link parseProxyEndpoint}.
 * @param options - `candidates` overrides {@link undiciCandidates} (tests);
 *   `bypass` is a {@link normalizeBypass} list.
 * @returns `{dispatcher, module, source, version}`; the caller closes it.
 */
export async function createProxyDispatcher(proxyUrl, options = {}) {
  const list = Array.isArray(options.candidates) ? options.candidates : await undiciCandidates();
  const failures = [];
  for (const { source, module, version } of list) {
    const dispatcher = buildDispatcher(module, proxyUrl, options.bypass);
    const verdict = await servesHostFetch(module, dispatcher);
    if (verdict.ok) return { dispatcher, module, source, version: version ?? null };
    failures.push(`${source}: ${verdict.reason}`);
    try {
      await dispatcher.close();
    } catch {
      // A pool that never opened a socket has nothing to close.
    }
  }
  const reason = failures.length === 0 ? "no undici copy was resolvable" : failures.join("; ");
  throw new Error(`dsh-simple-proxy needs an undici build the host's fetch accepts: ${reason}`);
}

/**
 * Route DSH's outbound HTTP through `proxyUrl` until `dispose` runs.
 *
 * Two checks per candidate undici copy, because they fail for different
 * reasons:
 *
 * 1. The handler-protocol check ({@link servesHostFetch}) rules out a copy
 *    whose dispatcher the process's `fetch` cannot drive at all.
 * 2. A real request through the proxy ({@link VERIFY_URLS}, tried in order)
 *    rules out a copy
 *    that talks to `fetch` but cannot carry TLS through the tunnel in this
 *    runtime — the failure mode that no local test can rule out, because it
 *    depends on the Node build DSH happens to embed.
 *
 * A copy that passes both wins. A copy that passes only the protocol check is
 * kept as a fallback, so a temporary network outage does not leave the user
 * with no proxy at all; the caller reports `verified: false` and the page says
 * so. Only when no copy passes the protocol check does this throw.
 *
 * The previous dispatcher is captured first and restored by identity, so
 * switching the proxy off gives back whatever was in charge before — a proxy
 * the launcher installed from `http_proxy`, or Node's own direct dispatcher.
 *
 * @param proxyUrl - a URL from {@link parseProxyEndpoint}.
 * @param options - `candidates` overrides {@link undiciCandidates} (tests);
 *   `bypass` is a {@link normalizeBypass} list; `verify` (default `true`) runs
 *   the real request; `verifyUrl` replaces {@link VERIFY_URLS} with one target.
 * @returns `{source, version, verified, dispose}` — `source` names the undici
 *   copy that was used (`host`, `dsh`, `profile`, `plugin`).
 */
export async function installProxyDispatcher(proxyUrl, options = {}) {
  const list = Array.isArray(options.candidates) ? options.candidates : await undiciCandidates();
  const verify = options.verify !== false;
  const explicitUrl = typeof options.verifyUrl === "string" && options.verifyUrl !== "";
  const targets = explicitUrl ? [options.verifyUrl] : VERIFY_URLS;
  const failures = [];
  let fallback;

  for (const { source, module, version } of list) {
    const dispatcher = buildDispatcher(module, proxyUrl, options.bypass);
    const previous = module.getGlobalDispatcher();
    module.setGlobalDispatcher(dispatcher);
    const verdict = await servesHostFetch(module);
    if (!verdict.ok) {
      if (module.getGlobalDispatcher() === dispatcher) module.setGlobalDispatcher(previous);
      await closeQuietly(dispatcher);
      failures.push(`${source}: ${verdict.reason}`);
      continue;
    }

    if (verify) {
      // Verification asks "does this tunnel carry traffic at all", which is a
      // different question from "which hosts should skip the tunnel". Running it
      // on the installed dispatcher would let a bypassed host answer directly
      // and certify a tunnel that carries nothing, so the probe gets its own
      // dispatcher built with no bypass list.
      const probe = buildDispatcher(module, proxyUrl, []);
      module.setGlobalDispatcher(probe);
      let live;
      try {
        for (const target of targets) {
          live = await probeThroughProxy(proxyUrl, target, { installed: true, timeoutMs: VERIFY_TIMEOUT_MS });
          if (live.ok) break;
        }
      } finally {
        if (module.getGlobalDispatcher() === probe) module.setGlobalDispatcher(dispatcher);
        await closeQuietly(probe);
      }
      if (!live.ok) {
        if (module.getGlobalDispatcher() === dispatcher) module.setGlobalDispatcher(previous);
        await closeQuietly(dispatcher);
        failures.push(`${source}: ${live.message}`);
        fallback ??= { source, module, version };
        continue;
      }
    }

    const dispose = makeDispose(module, dispatcher, previous);
    return { source, version: version ?? null, verified: verify, dispose };
  }

  if (fallback !== undefined) {
    const { source, module, version } = fallback;
    const dispatcher = buildDispatcher(module, proxyUrl, options.bypass);
    const previous = module.getGlobalDispatcher();
    module.setGlobalDispatcher(dispatcher);
    return { source, version: version ?? null, verified: false, dispose: makeDispose(module, dispatcher, previous) };
  }

  const reason = failures.length === 0 ? "no undici copy was resolvable" : failures.join("; ");
  throw new Error(`dsh-simple-proxy needs an undici build the host's fetch accepts: ${reason}`);
}

/** The undo for one installed dispatcher: restore by identity, then close. */
function makeDispose(module, dispatcher, previous) {
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    // Another plugin may have installed its own dispatcher after this one;
    // the proxy is still ours to close, but the active dispatcher is not ours
    // to hand back.
    if (module.getGlobalDispatcher() === dispatcher) module.setGlobalDispatcher(previous ?? new module.Agent());
    await closeQuietly(dispatcher);
  };
}

/** Close a dispatcher, ignoring the "nothing to release" case. */
async function closeQuietly(dispatcher) {
  try {
    await dispatcher.close();
  } catch {
    // Nothing was opened, or it is already closing; neither is a failure here.
  }
}

/**
 * Fetch `target` through `proxyUrl` (or directly when it is `undefined`).
 *
 * Any HTTP status counts as reachable: reaching `api.deepseek.com` through the
 * proxy and being told 401 still proves the tunnel works, which is exactly the
 * question the test button asks. Only a transport failure is a failure, and it
 * is reported with the underlying cause instead of just "fetch failed".
 *
 * The request is made through the **global** dispatcher, never through the
 * `dispatcher` request option: a dispatcher from the host's undici copy is
 * rejected when passed per request (see {@link servesHostFetch}), while
 * installing it works. When the endpoint is already the active one the probe
 * borrows the live dispatcher ({@link ProbeOptions.installed}) instead of
 * swapping, so a long stream running in DSH cannot lose its dispatcher to a
 * probe.
 *
 * @param proxyUrl - proxy URL, or `undefined` for a direct probe.
 * @param target - the URL to request.
 * @param options - `timeoutMs` overrides {@link PROBE_TIMEOUT_MS}; `installed`
 *   says `proxyUrl` is already the live endpoint; `bypass` is a
 *   {@link normalizeBypass} list.
 */
export async function probeThroughProxy(proxyUrl, target, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : PROBE_TIMEOUT_MS;
  let url;
  try {
    url = new URL(String(target ?? ""));
  } catch {
    return { ok: false, ms: 0, url: String(target ?? ""), message: `not a URL: ${JSON.stringify(target ?? "")}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, ms: 0, url: url.href, message: `not an http(s) URL: ${url.href}` };
  }

  const started = Date.now();
  let dispatcher;
  let restore;
  try {
    if (proxyUrl !== undefined && proxyUrl !== null && options.installed !== true) {
      const built = await createProxyDispatcher(proxyUrl, { bypass: options.bypass });
      dispatcher = built.dispatcher;
      restore = installTemporarily(built.module, dispatcher);
    }
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = response.status;
    try {
      await response.body?.cancel();
    } catch {
      // The body is irrelevant to the probe; a cancel that fails is not a result.
    }
    return { ok: true, status, ms: Date.now() - started, url: url.href, ...(proxyUrl ? { proxy: proxyUrl } : {}) };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      ms: Date.now() - started,
      url: url.href,
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
      message: timedOut ? `no response within ${timeoutMs}ms` : describeError(error),
    };
  } finally {
    restore?.();
    if (dispatcher !== undefined) {
      try {
        await dispatcher.close();
      } catch {
        // See above: nothing to release.
      }
    }
  }
}

/** Targets the diagnostic report probes, beyond the page's own test URL. */
const DIAG_TARGETS = ["https://www.cloudflare.com/cdn-cgi/trace", "https://api.deepseek.com/"];

/** What the process's `fetch` looks like, without calling it. */
function fetchFacts() {
  const fetchImpl = globalThis.fetch;
  const symbols = Object.getOwnPropertySymbols(globalThis)
    .map((symbol) => String(symbol))
    .filter((name) => name.includes("undici"));
  return {
    present: typeof fetchImpl === "function",
    name: typeof fetchImpl?.name === "string" ? fetchImpl.name : null,
    symbols,
  };
}

/**
 * Collect the facts needed to explain a proxy failure from inside the failing
 * process.
 *
 * Everything about this plugin that has ever gone wrong was a property of the
 * runtime it runs in — which undici copy `import("undici")` resolves to, which
 * handler protocol the embedded `fetch` speaks, whether that pair can carry TLS
 * through the tunnel. None of it is visible from outside, and all of it is
 * observable here: for each candidate copy the report says whether `fetch`
 * accepts it and whether real requests through the proxy succeed.
 *
 * The report deliberately costs one request per target per candidate; it is a
 * diagnostic, not something the page polls.
 *
 * @param proxyUrl - proxy URL to test, or `undefined` to leave the network alone.
 * @param options - `targets` overrides {@link DIAG_TARGETS}; `timeoutMs`
 *   overrides the verification timeout; `candidates` overrides
 *   {@link undiciCandidates} (tests); `bypass` is a {@link normalizeBypass} list.
 */
export async function diagnose(proxyUrl, options = {}) {
  const targets = Array.isArray(options.targets) && options.targets.length > 0 ? options.targets : DIAG_TARGETS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : VERIFY_TIMEOUT_MS;
  const candidates = Array.isArray(options.candidates) ? options.candidates : await undiciCandidates();
  const report = {
    versions: { ...process.versions },
    pid: process.pid,
    platform: process.platform,
    execPath: process.execPath,
    fetch: fetchFacts(),
    proxy: proxyUrl ?? null,
    targets,
    candidates: [],
  };

  for (const { source, module, version } of candidates) {
    const entry = { source, version: version ?? null, protocol: null, results: [] };
    let dispatcher;
    let previous;
    try {
      if (proxyUrl === undefined || proxyUrl === null) {
        for (const target of targets) entry.results.push(probeEntry(await probeThroughProxy(undefined, target, { timeoutMs })));
      } else {
        dispatcher = buildDispatcher(module, proxyUrl, options.bypass);
        previous = module.getGlobalDispatcher();
        module.setGlobalDispatcher(dispatcher);
        entry.protocol = await servesHostFetch(module);
        for (const target of targets) {
          const result = await probeThroughProxy(proxyUrl, target, { installed: true, timeoutMs, bypass: options.bypass });
          entry.results.push(probeEntry(result));
        }
      }
    } catch (error) {
      entry.error = describeError(error);
    } finally {
      if (dispatcher !== undefined) {
        if (module.getGlobalDispatcher() === dispatcher) module.setGlobalDispatcher(previous ?? new module.Agent());
        await closeQuietly(dispatcher);
      }
    }
    report.candidates.push(entry);
  }
  return report;
}

/** The reporting subset of one probe result. */
function probeEntry(result) {
  return { url: result.url, ok: result.ok, status: result.status ?? null, ms: result.ms, message: result.message ?? null };
}

/**
 * Flatten an error and its `cause` chain into one readable line.
 *
 * `fetch()` reports every transport failure as `TypeError: fetch failed` and
 * hides the reason in `cause` — the `ECONNREFUSED` that tells the user their
 * proxy port is wrong lives one level down.
 *
 * @param error - anything thrown.
 */
export function describeError(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    const code = typeof current.code === "string" ? current.code : undefined;
    const message = typeof current.message === "string" ? current.message : undefined;
    const text = code === undefined ? message : message === undefined || message === code ? code : `${code}: ${message}`;
    if (text !== undefined && text !== "" && parts.at(-1) !== text) parts.push(text);
    const nested = current instanceof AggregateError && Array.isArray(current.errors) ? current.errors[0] : undefined;
    current = current.cause ?? nested;
  }
  return parts.length === 0 ? "unknown error" : parts.join(" ← ");
}
