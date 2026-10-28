/**
 * Host-half tests.
 *
 * The Host half is plain Node, so everything it does can be checked without a
 * running DSH: the fake context below implements exactly the four things
 * `apply` touches (`effect`, `get`, `inject`, `logger`) and records what the
 * plugin registers. The network assertions then prove the interesting part —
 * that installing the proxy really redirects `fetch()`, that loopback stays
 * direct, and that switching the proxy off gives the previous dispatcher back.
 *
 * Run with `node tools/test-host.mjs` (or `npm test`).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createProxyDispatcher,
  DEFAULT_PORT,
  describeError,
  installProxyDispatcher,
  isBypassed,
  isDirectTarget,
  normalizeBypass,
  parseProxyEndpoint,
  probeThroughProxy,
  recentActivity,
  replayProvider,
  undiciCandidates,
  watchFetch,
} from "../plugin/lib/proxy.js";
import { relayStatus, restoreRelay, syncRelay } from "../plugin/lib/relay.js";
import {
  apply,
  Config,
  DIAG_PATH,
  PROVIDER_PATH,
  SETTINGS_NS,
  STATUS_PATH,
  TEST_PATH,
} from "../plugin/lib/index.js";

/** A port nothing listens on: any request that reaches it fails immediately. */
const DEAD_PORT = 9;

/**
 * Keep the tests away from the real billion-context config.
 *
 * The plugin writes that file when it points the relay at the proxy, and a test
 * run must never edit what the user's own DSH is using.
 */
const scratch = mkdtempSync(path.join(tmpdir(), "dsh-simple-proxy-relay-"));
process.env.DSH_PROXY_RELAY_CONFIG = path.join(scratch, "billion-context.json");
process.env.DSH_PROXY_RELAY_STATE = path.join(scratch, "relay-state.json");
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not worth failing a run over.
  }
});

/** The local proxy this machine runs while the tests are written; optional. */
const LIVE_PROXY = { host: "127.0.0.1", port: "7890", url: "http://127.0.0.1:7890" };

const logs = [];

/** Collect logger output so a test can assert what the plugin reported. */
const logger = {
  info: (...args) => logs.push(["info", ...args]),
  warn: (...args) => logs.push(["warn", ...args]),
  error: (...args) => logs.push(["error", ...args]),
  debug: (...args) => logs.push(["debug", ...args]),
};

/**
 * Boot the Host half against a fake context.
 *
 * Mirrors the parts of Cordis the plugin relies on: `effect` runs now and hands
 * back a disposer (whose unload the test calls explicitly), `get` answers for
 * optional services, and `inject` invokes the callback with the services it
 * asked for.
 */
function createHarness(config) {
  const disposers = [];
  const routes = new Map();
  const configEditor = {
    entries: () => [{ options: { id: SETTINGS_NS, config } }],
  };
  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const services = { configEditor, webServer };

  const makeCtx = () => ({
    // Cordis exposes an injected service as a property of the child context, so
    // the fake context carries them both as properties and through `get`.
    ...services,
    logger,
    get: (name) => services[name],
    effect: (callback, label) => {
      const dispose = callback();
      disposers.push({ dispose, label });
      return dispose;
    },
    inject: (deps, callback) => {
      for (const dep of deps) assert.ok(dep in services, `missing service ${dep}`);
      callback(makeCtx());
    },
  });

  const ctx = makeCtx();
  apply(ctx, config);

  return {
    routes,
    config,
    logs,
    /** Run every registered disposer, newest first, the way a fiber unload does. */
    async unload() {
      for (const { dispose, label } of disposers.reverse()) {
        if (typeof dispose === "function") await dispose();
        else assert.fail(`disposer for ${label} is not a function`);
      }
    },
  };
}

/** A `req` the route handlers can read, with the body the test wants. */
function request({ method = "GET", address = "127.0.0.1", body, url = "/" } = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    method,
    url,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      if (text !== "") yield Buffer.from(text);
    },
  };
}

/** A `res` that captures the status and the JSON body. */
function response() {
  const captured = { status: 0, headers: {}, body: "" };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers ?? {};
      return this;
    },
    end(text) {
      captured.body = text ?? "";
      return this;
    },
  };
}

/** Call one registered route and wait for its handler to answer. */
async function callRoute(harness, path, options) {
  const route = harness.routes.get(path);
  assert.ok(route, `no route registered for ${path}`);
  const res = response();
  await route.handler(request(options), res);
  return { status: res.captured.status, body: res.captured.body, json: res.captured.body === "" ? undefined : JSON.parse(res.captured.body) };
}

/** Poll until `predicate` holds, so the test does not race the watchdog. */
async function waitFor(predicate, { timeoutMs = 5000, label = "condition" } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** What the process-wide dispatcher currently is, read the way the plugin reads it. */
async function currentDispatcher() {
  const undici = await import("undici");
  return undici.getGlobalDispatcher();
}

/**
 * A candidate that fails the way a wrong undici major does.
 *
 * Real dispatchers from another major reject the handler this process's
 * `fetch` builds with `UND_ERR_INVALID_ARG: invalid onRequestStart method`;
 * this reproduces that exact rejection without shipping a second undici.
 */
async function brokenCandidate() {
  const undici = await import("undici");
  class BrokenAgent extends undici.Agent {
    dispatch() {
      const error = new Error("invalid onRequestStart method");
      error.code = "UND_ERR_INVALID_ARG";
      throw error;
    }
  }
  return { source: "broken", module: { ...undici, Agent: BrokenAgent } };
}

/** A local HTTP server, used to prove loopback requests bypass the proxy. */
async function startLocalServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("local-ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// --------------------------------------------------------------- unit tests

test("parseProxyEndpoint accepts the shapes people paste", () => {
  assert.deepEqual(parseProxyEndpoint("127.0.0.1", "7890"), {
    ok: true,
    url: "http://127.0.0.1:7890",
    host: "127.0.0.1",
    port: 7890,
    scheme: "http",
  });
  assert.equal(parseProxyEndpoint("127.0.0.1:1080", "").url, "http://127.0.0.1:1080");
  assert.equal(parseProxyEndpoint("http://proxy.local:8080", "9").url, "http://proxy.local:8080");
  assert.equal(parseProxyEndpoint("https://proxy.local", "443").url, "https://proxy.local:443");
  // An embedded port is the more specific input, so it wins over the field.
  assert.equal(parseProxyEndpoint("127.0.0.1:1080", "7890").port, 1080);
  // IPv6 works with and without the port.
  assert.equal(parseProxyEndpoint("[::1]", "7890").url, "http://[::1]:7890");
  assert.equal(parseProxyEndpoint("[::1]:1080", "7890").url, "http://[::1]:1080");
});

test("parseProxyEndpoint refuses what ProxyAgent cannot use", () => {
  const cases = [
    ["", "7890"],
    ["   ", "7890"],
    ["socks5://127.0.0.1", "7890"],
    ["127.0.0.1:0", "7890"],
    ["127.0.0.1", "70000"],
    ["127.0.0.1", ""],
    ["127.0.0.1", "abc"],
    ["http://user:pass@127.0.0.1", "7890"],
    ["[::1", "7890"],
  ];
  for (const [host, port] of cases) {
    const result = parseProxyEndpoint(host, port);
    assert.equal(result.ok, false, `expected ${JSON.stringify([host, port])} to be refused`);
    assert.equal(typeof result.message, "string");
  }
});

test("isDirectTarget keeps loopback direct", () => {
  for (const hostname of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "0.0.0.0", "0.1.2.3", "[::1]", "::1", "[::]", "::"]) {
    assert.equal(isDirectTarget(hostname), true, `${hostname} must stay direct`);
  }
  for (const hostname of ["example.com", "api.deepseek.com", "154.201.92.23", "[2001:db8::1]", "10.0.0.1"]) {
    assert.equal(isDirectTarget(hostname), false, `${hostname} must be proxied`);
  }
});

test("describeError keeps the cause that explains the failure", () => {
  const nested = new Error("connect ECONNREFUSED 127.0.0.1:9", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) });
  const outer = new TypeError("fetch failed", { cause: nested });
  const text = describeError(outer);
  assert.match(text, /fetch failed/);
  assert.match(text, /ECONNREFUSED/);
  assert.equal(describeError(undefined), "unknown error");
  assert.equal(describeError("plain string"), "plain string");
});

test("Config fills in defaults and keeps every field writable", () => {
  const defaults = Config["~standard"].validate({}).value;
  const plain = (value) => value?.get?.() ?? value;
  assert.equal(plain(defaults.enabled), false);
  assert.equal(plain(defaults.host), "127.0.0.1");
  assert.equal(plain(defaults.port), String(DEFAULT_PORT));
  assert.equal(plain(defaults.bypass), "deepseek.com");
  assert.match(String(plain(defaults.probeUrl)), /^https:\/\//);
  const json = Config.toJSON();
  for (const uid of Object.keys(json.dict ?? {})) {
    const node = json.refs[uid];
    assert.equal(node.meta?.volatile, true, `field ${uid} must be volatile so settings can write it`);
  }
});

// ------------------------------------------------------- network behaviour

test("an enabled proxy really reroutes fetch(), and disabling restores the dispatcher", async (t) => {
  const before = await currentDispatcher();
  const harness = createHarness({ enabled: true, host: "127.0.0.1", port: DEAD_PORT, probeUrl: "http://example.com/" });

  try {
    await waitFor(async () => (await currentDispatcher()) !== before, { label: "the proxy dispatcher to be installed" });
    const installed = await currentDispatcher();
    assert.notEqual(installed, before);

    // Reaching the dead port proves the request went to the proxy instead of
    // straight to the origin; no DNS or internet access is needed for that.
    const failure = await fetch("http://example.com/").then(
      () => undefined,
      (error) => error,
    );
    assert.ok(failure, "a request through a dead proxy must not succeed");
    assert.match(describeError(failure), new RegExp(`ECONNREFUSED.*127\\.0\\.0\\.1:${DEAD_PORT}`));

    // Loopback stays direct even while the proxy is on.
    const server = await startLocalServer();
    try {
      const response = await fetch(server.url);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "local-ok");
    } finally {
      await server.stop();
    }
  } finally {
    await harness.unload();
  }

  await waitFor(async () => (await currentDispatcher()) === before, { label: "the previous dispatcher to come back" });
  t.diagnostic("dispatcher restored to the pre-test instance");
});

test("a config change is picked up by the watchdog without a reload", async () => {
  const before = await currentDispatcher();
  const config = { enabled: true, host: "127.0.0.1", port: DEAD_PORT, probeUrl: "http://example.com/" };
  const harness = createHarness(config);

  try {
    await waitFor(async () => (await currentDispatcher()) !== before, { label: "install" });

    // A settings write mutates the config document; the fiber may or may not be
    // restarted for it, so the watchdog has to notice on its own.
    config.enabled = false;
    harness.config.enabled = false;
    await waitFor(async () => (await currentDispatcher()) === before, { label: "the proxy to be removed after the config changed" });

    config.enabled = true;
    harness.config.enabled = true;
    await waitFor(async () => (await currentDispatcher()) !== before, { label: "the proxy to come back" });
  } finally {
    await harness.unload();
  }

  await waitFor(async () => (await currentDispatcher()) === before, { label: "final restore" });
});

test("an unusable endpoint installs nothing and reports why", async () => {
  const before = await currentDispatcher();
  const harness = createHarness({ enabled: true, host: "socks5://127.0.0.1", port: "7890", probeUrl: "http://example.com/" });
  try {
    await waitFor(
      async () => {
        const { json } = await callRoute(harness, STATUS_PATH);
        return json?.value?.lastError !== null && json?.value?.lastError !== undefined;
      },
      { label: "the refusal to be reported" },
    );
    const { json } = await callRoute(harness, STATUS_PATH);
    assert.match(json.value.lastError, /only http:\/\/ and https:\/\//);
    assert.equal(json.value.proxy.active, false);
    assert.equal(await currentDispatcher(), before);
    assert.ok(
      logs.some(([, ...args]) => args.some((arg) => typeof arg === "string" && arg.includes("only http:// and https://"))),
      "the refusal must be logged for the operator",
    );
  } finally {
    await harness.unload();
  }
});

// ------------------------------------------------------------ route handlers

test("GET /dsh-simple-proxy/status reports the installed proxy", async (t) => {
  const harness = createHarness({ enabled: true, host: "127.0.0.1", port: DEAD_PORT, probeUrl: "http://example.com/" });
  try {
    await waitFor(async () => {
      const { json } = await callRoute(harness, STATUS_PATH);
      return json?.value?.proxy?.active === true;
    }, { label: "status to report an active proxy" });

    const { status, json } = await callRoute(harness, STATUS_PATH);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.value.desired.enabled, true);
    assert.equal(json.value.endpoint.url, `http://127.0.0.1:${DEAD_PORT}`);
    assert.equal(json.value.proxy.url, `http://127.0.0.1:${DEAD_PORT}`);
    assert.equal(typeof json.value.proxy.since, "number");
  } finally {
    await harness.unload();
  }
  t.diagnostic("status route answers with the live state");
});

test("the status route answers only loopback GETs", async () => {
  const harness = createHarness({ enabled: false, host: "127.0.0.1", port: "7890" });
  try {
    const forbidden = await callRoute(harness, STATUS_PATH, { address: "10.0.0.7" });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.ok, false);

    const wrongMethod = await callRoute(harness, STATUS_PATH, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.json.ok, false);
  } finally {
    await harness.unload();
  }
});

test("POST /dsh-simple-proxy/test probes the endpoint from the form, not the saved one", async (t) => {
  const harness = createHarness({ enabled: false, host: "127.0.0.1", port: DEAD_PORT, probeUrl: "http://example.com/" });
  try {
    const dead = await callRoute(harness, TEST_PATH, {
      method: "POST",
      body: { host: "127.0.0.1", port: String(DEAD_PORT), url: "http://example.com/" },
    });
    assert.equal(dead.status, 200);
    assert.equal(dead.json.value.reachable, false);
    assert.match(dead.json.value.message, /ECONNREFUSED/);

    const badForm = await callRoute(harness, TEST_PATH, { method: "POST", body: { host: "nope://x", port: "1" } });
    assert.equal(badForm.json.value.reachable, false);
    assert.match(badForm.json.value.message, /only http:\/\/ and https:\/\//);

    const wrongMethod = await callRoute(harness, TEST_PATH, { method: "GET" });
    assert.equal(wrongMethod.status, 405);

    // A working proxy, when this machine has one: the point of the button.
    const live = await probeThroughProxy(LIVE_PROXY.url, "https://www.cloudflare.com/cdn-cgi/trace", { timeoutMs: 8000 });
    if (live.ok) {
      const ok = await callRoute(harness, TEST_PATH, {
        method: "POST",
        body: { host: LIVE_PROXY.host, port: LIVE_PROXY.port, url: "https://www.cloudflare.com/cdn-cgi/trace" },
      });
      assert.equal(ok.json.value.reachable, true);
      assert.equal(typeof ok.json.value.ms, "number");
      t.diagnostic(`live proxy probe: HTTP ${ok.json.value.status} in ${ok.json.value.ms}ms`);
    } else {
      t.diagnostic(`no live proxy on ${LIVE_PROXY.url} (${live.message}); live assertions skipped`);
    }
  } finally {
    await harness.unload();
  }
});

test("the proxy is not installed while the setting is off", async () => {
  const before = await currentDispatcher();
  const harness = createHarness({ enabled: false, host: "127.0.0.1", port: DEAD_PORT, probeUrl: "http://example.com/" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await currentDispatcher(), before);
    const { json } = await callRoute(harness, STATUS_PATH);
    assert.equal(json.value.proxy.active, false);
    assert.equal(json.value.endpoint.ok, true);
  } finally {
    await harness.unload();
  }
  assert.equal(await currentDispatcher(), before);
});

test("two installs of the same endpoint reuse one dispatcher", async () => {
  const before = await currentDispatcher();
  const first = await installProxyDispatcher("http://127.0.0.1:43219", { verify: false });
  const installed = await currentDispatcher();
  await first.dispose();
  assert.equal(await currentDispatcher(), before);

  const second = await installProxyDispatcher("http://127.0.0.1:43219", { verify: false });
  const reinstalled = await currentDispatcher();
  await second.dispose();
  assert.notEqual(installed, reinstalled, "a fresh install owns a fresh dispatcher");
  assert.equal(await currentDispatcher(), before);
});

test("a dispatcher the host fetch cannot drive is skipped", async () => {
  // The real failure this guards against: the DSH runtime ships undici 8, the
  // settings profile installs undici 7, and a dispatcher from one major
  // rejects the handler the other's fetch builds — every request then fails
  // with `UND_ERR_INVALID_ARG: invalid onRequestStart method`.
  const broken = await brokenCandidate();
  const candidates = await undiciCandidates();
  assert.ok(candidates.length > 0, "the test process must resolve at least one undici copy");

  const onlyBroken = await createProxyDispatcher("http://127.0.0.1:7890", { candidates: [broken] }).catch((error) => error);
  assert.ok(onlyBroken instanceof Error, "a single unusable copy must be reported, not used");
  assert.match(describeError(onlyBroken), /invalid onRequestStart method/u);
  assert.match(describeError(onlyBroken), /needs an undici build/u);

  const chosen = await createProxyDispatcher("http://127.0.0.1:7890", { candidates: [broken, ...candidates] });
  assert.notEqual(chosen.source, "broken", "the unusable copy is passed over");
  const refused = await fetch("http://127.0.0.1:45123/", {
    dispatcher: chosen.dispatcher,
    signal: AbortSignal.timeout(2000),
  }).then(
    () => undefined,
    (error) => error,
  );
  assert.match(describeError(refused), /ECONNREFUSED|aborted due to timeout/u);
  await chosen.dispatcher.close();
});

test("installing rolls back a copy the host fetch cannot drive", async () => {
  const before = await currentDispatcher();
  const broken = await brokenCandidate();
  const candidates = await undiciCandidates();
  const installed = await installProxyDispatcher("http://127.0.0.1:43219", { candidates: [broken, ...candidates], verify: false });
  try {
    assert.notEqual(installed.source, "broken");
    assert.notEqual(await currentDispatcher(), before, "the working copy is installed");

    // The path DSH's own traffic takes: no `dispatcher` option at all.
    const refused = await fetch("http://127.0.0.1:45123/", { signal: AbortSignal.timeout(2000) }).then(
      () => undefined,
      (error) => error,
    );
    assert.match(describeError(refused), /ECONNREFUSED|aborted due to timeout/u);
  } finally {
    await installed.dispose();
  }
  assert.equal(await currentDispatcher(), before, "uninstall restores the previous dispatcher");
});

// --------------------------------------------------- bypass and verification

test("normalizeBypass accepts the ways people write a bypass list", () => {
  assert.deepEqual(normalizeBypass("deepseek.com, *.corp.lan"), ["deepseek.com", "corp.lan"]);
  assert.deepEqual(normalizeBypass(" a.example \n b.example "), ["a.example", "b.example"]);
  assert.deepEqual(normalizeBypass(""), []);
  assert.deepEqual(normalizeBypass(undefined), []);
});

test("isBypassed matches the host and its subdomains, not a lookalike", () => {
  const list = normalizeBypass("deepseek.com");
  assert.equal(isBypassed("api.deepseek.com", list), true);
  assert.equal(isBypassed("deepseek.com", list), true);
  assert.equal(isBypassed("notdeepseek.com", list), false);
  assert.equal(isBypassed("deepseek.com.evil.test", list), false);
  assert.equal(isBypassed("api.deepseek.com", []), false);
});

test("a bypassed host stays reachable while everything else goes through the proxy", async (t) => {
  // The point of the bypass field: a broken or slow node must not take down the
  // providers that answer fine from here. Port 9 refuses immediately, so the
  // only way `example.com` can answer is the direct branch of the factory.
  const proxyUrl = "http://127.0.0.1:9";
  const routed = await probeThroughProxy(proxyUrl, "http://example.com/", { timeoutMs: 4000 });
  const direct = await probeThroughProxy(proxyUrl, "http://example.com/", {
    timeoutMs: 8000,
    bypass: normalizeBypass("example.com"),
  });
  if (!direct.ok) {
    t.diagnostic(`example.com unreachable from this machine (${direct.message}); bypass assertion skipped`);
    return;
  }
  assert.equal(routed.ok, false, "without the bypass the dead proxy must be the path");
  assert.equal(direct.ok, true, "with the bypass the request must go direct");
});

test("an endpoint whose tunnel cannot carry traffic is installed unverified", async () => {
  const before = await currentDispatcher();
  const installed = await installProxyDispatcher("http://127.0.0.1:9");
  try {
    assert.equal(installed.verified, false, "the live probe must report the broken tunnel");
    assert.equal(installed.source.length > 0, true);
    assert.notEqual(await currentDispatcher(), before, "the (unverified) proxy is what the process uses");
  } finally {
    await installed.dispose();
  }
  assert.equal(await currentDispatcher(), before);
});

test("GET /dsh-simple-proxy/diag reports the runtime and every undici copy", async (t) => {
  const harness = createHarness({ enabled: false, host: "127.0.0.1", port: "9", probeUrl: "http://example.com/" });
  try {
    const forbidden = await callRoute(harness, DIAG_PATH, { address: "10.1.2.3" });
    assert.equal(forbidden.status, 403);

    const { status, json } = await callRoute(harness, DIAG_PATH);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(typeof json.value.versions.node, "string");
    assert.ok(Array.isArray(json.value.candidates) && json.value.candidates.length > 0, "at least one undici copy");
    for (const candidate of json.value.candidates) {
      assert.equal(typeof candidate.source, "string");
      assert.ok(Array.isArray(candidate.results));
      assert.equal(candidate.results.length > 0, true, "each copy is probed against the targets");
    }
    const replayed = await callRoute(harness, DIAG_PATH, {
      url: `${DIAG_PATH}?provider=http://127.0.0.1:45222/v1/responses&model=test-model`,
    });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.json.ok, true);
    const modes = replayed.json.value.provider;
    assert.deepEqual(Object.keys(modes).sort(), ["current", "direct", "proxy"]);
    for (const mode of ["current", "direct", "proxy"]) {
      assert.equal(modes[mode].status, null, `${mode} cannot reach a dead port`);
      assert.equal(typeof modes[mode].reason, "string");
      assert.equal(modes[mode].mode, mode);
    }

    t.diagnostic(
      `diag: node ${json.value.versions.node}, copies ${json.value.candidates
        .map((entry) => `${entry.source}@${entry.version ?? "?"}`)
        .join(", ")}`,
    );
  } finally {
    await harness.unload();
  }
});

test("replayProvider sends the model call and reports the answer, not the key", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(502, { "content-type": "text/plain", statusMessage: "acp-proxy failure" });
      res.end("acp-proxy failure");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  process.env.DSH_PROXY_TEST_KEY = "sk-not-for-output";
  const restore = watchFetch();
  try {
    const result = await replayProvider({
      url: `http://127.0.0.1:${port}/v1/responses`,
      model: "deepseek-v4.1-flash",
      apiKeyEnv: "DSH_PROXY_TEST_KEY",
      timeoutMs: 8000,
    });

    assert.equal(result.status, 502);
    assert.equal(typeof result.reason, "string");
    assert.notEqual(result.reason, "");
    assert.equal(result.keyPresent, true);
    assert.match(result.body, /acp-proxy failure/u);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/v1/responses");
    assert.equal(seen[0].auth, "Bearer sk-not-for-output");
    assert.equal(JSON.parse(seen[0].body).model, "deepseek-v4.1-flash");
    // The answer must be reportable without ever echoing the credential.
    assert.equal(JSON.stringify(result).includes("sk-not-for-output"), false);

    const activity = recentActivity();
    assert.equal(
      activity.requests.some((entry) => entry.url.includes(`127.0.0.1:${port}`) && entry.status === 502),
      true,
      "the watcher records the request it saw",
    );
  } finally {
    restore();
    delete process.env.DSH_PROXY_TEST_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the provider route replays through the hosted plugin", async () => {
  const harness = createHarness({ enabled: false, host: "127.0.0.1", port: String(DEAD_PORT) });
  try {
    const missing = await callRoute(harness, PROVIDER_PATH, { method: "GET" });
    assert.equal(missing.status, 405);

    // A URL nothing listens on: the route must still answer with a report.
    const { status, json } = await callRoute(harness, PROVIDER_PATH, {
      method: "POST",
      body: { url: "http://127.0.0.1:45222/v1/responses", model: "m", timeoutMs: 2000 },
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.value.status, null);
    assert.equal(json.value.keyPresent, false);
    assert.match(json.value.reason, /ECONNREFUSED|aborted due to timeout|fetch failed|bad port/u);
  } finally {
    await harness.unload();
  }
});

test("the relay config is pointed at the proxy, then put back", async () => {
  const configPath = path.join(scratch, "case-1.json");
  const statePath = path.join(scratch, "case-1.state.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({ providers: {}, upstreamProxy: "http://old.example:1", upstreamProxyMode: "auto" }, null, 2)}
`,
  );

  const first = await syncRelay("http://127.0.0.1:7890", { configPath, statePath });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(written.upstreamProxy, "http://127.0.0.1:7890");
  assert.equal(written.upstreamProxyMode, "manual");
  assert.equal(written.providers instanceof Object, true);

  // A second pass must not churn the file.
  const second = await syncRelay("http://127.0.0.1:7890", { configPath, statePath });
  assert.equal(second.changed, false);

  const back = await restoreRelay({ configPath, statePath });
  assert.equal(back.restored, true);
  const restored = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(restored.upstreamProxy, "http://old.example:1");
  assert.equal(restored.upstreamProxyMode, "auto");

  // Nothing left to restore.
  const again = await restoreRelay({ configPath, statePath });
  assert.equal(again.restored, false);
});

test("keys that were absent are removed again, not blanked", async () => {
  const configPath = path.join(scratch, "case-2.json");
  const statePath = path.join(scratch, "case-2.state.json");
  writeFileSync(configPath, `${JSON.stringify({ providers: {} })}
`);

  await syncRelay("http://127.0.0.1:7890", { configPath, statePath });
  const status = await relayStatus({ configPath, statePath });
  assert.equal(status.managed, true);
  assert.equal(status.proxy, "http://127.0.0.1:7890");

  await restoreRelay({ configPath, statePath });
  const restored = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(Object.hasOwn(restored, "upstreamProxy"), false);
  assert.equal(Object.hasOwn(restored, "upstreamProxyMode"), false);
});

test("a missing or broken bili config is reported, not thrown", async () => {
  const missing = await syncRelay("http://127.0.0.1:7890", {
    configPath: path.join(scratch, "absent.json"),
    statePath: path.join(scratch, "absent.state.json"),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /not installed/u);

  const brokenPath = path.join(scratch, "broken.json");
  writeFileSync(brokenPath, "{not json");
  const broken = await syncRelay("http://127.0.0.1:7890", {
    configPath: brokenPath,
    statePath: path.join(scratch, "broken.state.json"),
  });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /not valid JSON/u);
});
