/**
 * Client-half tests.
 *
 * The page has no build step and no browser here, so the test supplies the
 * smallest environment the module actually uses: a `window.__ModuleLoader__`
 * that captures the factory, a React stub with the four hooks the page calls, a
 * `document` that records the stylesheet, and a `fetch` that answers the two
 * Host routes. Rendering then runs the real component, which is what makes this
 * worth doing — a typo in the page would otherwise only surface in a browser.
 *
 * Run with `node tools/test-client.mjs`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// --------------------------------------------------------------- environment

// The page polls on intervals; unref them so a finished test run can exit.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const timer = realSetInterval(...args);
  timer.unref?.();
  return timer;
};

let captured = null;
globalThis.document = createDocument();
globalThis.window = { __ModuleLoader__: { load: (spec) => (captured = spec) } };

/** A `document` with just enough surface for `installStyles`. */
function createDocument() {
  const styles = [];
  return {
    styles,
    querySelector(selector) {
      if (selector === "style[data-dsh-simple-proxy]") return styles.find((style) => "dshSimpleProxy" in style.dataset) ?? null;
      return null;
    },
    createElement(tag) {
      return { tag, dataset: {}, textContent: "" };
    },
    head: {
      append(node) {
        styles.push(node);
      },
    },
  };
}

/** The hooks runtime: one instance at a time, which is all a page needs. */
function createReact() {
  let instance = null;
  // State updates land after the render that scheduled them (an await, an
  // event handler), so re-rendering must key off the mounted instance rather
  // than the one currently being rendered.
  let mounted = null;
  const schedule = () => {
    if (mounted !== null) mounted.dirty = true;
  };

  const slot = (init) => {
    const hooks = instance.hooks;
    const index = instance.cursor;
    instance.cursor += 1;
    if (hooks[index] === undefined) hooks[index] = init();
    return hooks[index];
  };

  const sameDeps = (left, right) =>
    Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

  return {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length <= 1 ? children[0] : children } }),
    useState(initial) {
      const store = slot(() => ({ kind: "state", value: typeof initial === "function" ? initial() : initial }));
      return [
        store.value,
        (next) => {
          store.value = typeof next === "function" ? next(store.value) : next;
          schedule();
        },
      ];
    },
    useRef(initial) {
      return slot(() => ({ kind: "ref", value: { current: initial } })).value;
    },
    useCallback(callback, deps) {
      const store = slot(() => ({ kind: "callback", callback, deps }));
      if (!sameDeps(store.deps, deps)) {
        store.callback = callback;
        store.deps = deps;
      }
      return store.callback;
    },
    useEffect(effect, deps) {
      slot(() => ({ kind: "effect", effect, deps, cleanup: undefined, ran: false }));
    },
    /** Run one render pass and then the effects whose dependencies changed. */
    render(Component, props, nextInstance) {
      mounted = nextInstance;
      instance = nextInstance;
      instance.cursor = 0;
      instance.dirty = false;
      const tree = Component(props);
      for (const store of instance.hooks) {
        if (store?.kind !== "effect") continue;
        const first = store.ran === false;
        if (!first && sameDeps(store.deps, store.lastDeps)) continue;
        if (typeof store.cleanup === "function") store.cleanup();
        store.cleanup = store.effect();
        store.lastDeps = store.deps;
        store.ran = true;
      }
      instance = null;
      return tree;
    },
    unmount(nextInstance) {
      for (const store of nextInstance.hooks) {
        if (store?.kind === "effect" && typeof store.cleanup === "function") store.cleanup();
      }
    },
    instance: () => instance,
  };
}

/** Walk a rendered tree into elements, invoking the stateless stubs as it goes. */
function flatten(tree, out = []) {
  if (tree === null || tree === undefined || typeof tree === "boolean") return out;
  if (Array.isArray(tree)) {
    for (const child of tree) flatten(child, out);
    return out;
  }
  if (typeof tree === "string" || typeof tree === "number") return out;
  const props = tree.props ?? {};
  if (typeof tree.type === "function") return flatten(tree.type(props), out);
  out.push({ type: tree.type, props });
  flatten(props.children, out);
  return out;
}

/** All text below one element, in document order. */
function textOf(tree) {
  if (tree === null || tree === undefined || typeof tree === "boolean") return "";
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  const props = tree.props ?? {};
  if (typeof tree.type === "function") return textOf(tree.type(props));
  return textOf(props.children);
}

/** Elements of one tag, with the text they contain. */
function find(tree, predicate) {
  return flatten(tree).filter(predicate);
}

/** A fake fetch that answers the two Host routes and records the requests. */
function createFetch({ status, test }) {
  const calls = [];
  const impl = async (path, init) => {
    calls.push({ path, init });
    if (path === "/dsh-simple-proxy/status") {
      return jsonResponse(200, { ok: true, value: status() });
    }
    if (path === "/dsh-simple-proxy/test") {
      const body = init?.body === undefined ? {} : JSON.parse(init.body);
      return jsonResponse(200, { ok: true, value: test(body) });
    }
    return jsonResponse(404, { ok: false, error: { message: `unexpected ${path}` } });
  };
  return { impl, calls };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

/** Let pending promises and the page's state updates settle. */
async function settle(react, render) {
  for (let round = 0; round < 8; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const instance = render.current;
    if (instance !== undefined && instance.dirty === true) {
      render.tree = react.render(render.Component, render.props, instance);
    }
  }
  return render.tree;
}

// ------------------------------------------------------------------- the load

await import("../plugin/lib/client.js");
assert.ok(captured !== null, "the module must register itself with the client loader");
assert.equal(captured.id, "dsh-simple-proxy");

/** The settings document the Host serves for a mounted plugin. */
async function defaultDescribe() {
  return [
    {
      ns: "dsh-simple-proxy",
      revision: 7,
      applies: "live",
      value: { enabled: false, host: "127.0.0.1", port: "7890", bypass: "deepseek.com", probeUrl: "https://example.test/" },
    },
  ];
}

/**
 * Instantiate the factory with stubs and hand back the registration it made.
 *
 * @param options.withSwitch - set to false to exercise the checkbox fallback.
 * @param options.describe - replaces `remote.settings.describe()`.
 */
function createPlugin({ withSwitch = true, describe = defaultDescribe } = {}) {
  const react = createReact();
  const primitives = {
    Button: (props) => ({ type: "button", props }),
    ...(withSwitch ? { Switch: (props) => ({ type: "switch", props }) } : {}),
  };
  const module = captured.factory((specifier) => {
    if (specifier === "react") return react;
    if (specifier === "react/jsx-runtime") {
      return {
        jsx: (type, props) => ({ type, props: props ?? {} }),
        jsxs: (type, props) => ({ type, props: props ?? {} }),
      };
    }
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  });
  assert.equal(typeof module.apply, "function");
  assert.deepEqual(module.inject.slice(0, 3), ["slots", "locale", "remote"]);

  const calls = [];
  const dictionaries = new Map();
  const registrations = [];
  const translate = (ns, key, params) => {
    const template = dictionaries.get(ns)?.[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
  const ctx = {
    effect: (callback) => callback(),
    locale: {
      register: (ns, dict) => {
        dictionaries.set(ns, dict.zh);
        return () => dictionaries.delete(ns);
      },
      bind: (ns) => (key, params) => translate(ns, key, params),
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (registration, Component) => {
        registrations.push({ registration, Component });
        return () => {};
      },
    },
    remote: {
      settings: {
        describe,
        update: async (ns, patch, revision) => {
          calls.push({ ns, patch, revision });
          return { ok: true, value: {} };
        },
      },
    },
  };
  module.apply(ctx);
  assert.equal(registrations.length, 1, "apply must register exactly one page");

  return {
    module,
    react,
    registrations,
    calls,
    registration: registrations[0].registration,
    Component: registrations[0].Component,
    dictionaries,
  };
}

// --------------------------------------------------------------------- tests

test("the page registers itself as its own Plugins settings tab", () => {
  const plugin = createPlugin();
  const { registration } = plugin;
  assert.equal(registration.name, "settings.plugins.tab");
  assert.equal(registration.id, "dsh-simple-proxy");
  assert.equal(typeof registration.order, "number");
  assert.equal(registration.locale, "dsh-simple-proxy");
  assert.equal(registration.label(), "网络代理");
  assert.ok(plugin.dictionaries.get("dsh-simple-proxy").title);
  assert.ok(globalThis.document.styles.some((style) => "dshSimpleProxy" in style.dataset), "the stylesheet is injected once");
  assert.equal(globalThis.document.styles.length, 1, "injecting twice must not add a second stylesheet");
});

test("the page renders the saved config into its fields", async () => {
  const plugin = createPlugin();
  const fetch = createFetch({
    status: () => ({ desired: { enabled: false }, endpoint: { ok: true }, proxy: { active: false }, lastError: null, lastProbe: null }),
    test: () => ({ reachable: true, status: 204, ms: 12, url: "https://example.test/" }),
  });
  globalThis.fetch = fetch.impl;

  const render = { current: { hooks: [], cursor: 0, dirty: false }, Component: plugin.Component, props: plugin.registration.inject() };
  render.tree = plugin.react.render(plugin.Component, render.props, render.current);
  await settle(plugin.react, render);

  const inputs = find(render.tree, (element) => element.type === "input");
  assert.equal(inputs.length, 4, "host, port, bypass list and probe URL");
  assert.equal(inputs[0].props.value, "127.0.0.1");
  assert.equal(inputs[1].props.value, "7890");
  assert.equal(inputs[2].props.value, "deepseek.com");
  assert.equal(inputs[3].props.value, "https://example.test/");
  const switches = find(render.tree, (element) => element.type === "switch");
  assert.equal(switches.length, 1);
  assert.equal(switches[0].props.checked, false);
  assert.match(textOf(render.tree), /网络代理/);
  assert.match(textOf(render.tree), /代理未开启/);
  plugin.react.unmount(render.current);
});

test("editing a field and saving writes the settings document", async () => {
  const plugin = createPlugin();
  const fetch = createFetch({
    status: () => ({ desired: { enabled: true }, endpoint: { ok: true }, proxy: { active: true, url: "http://127.0.0.1:8080", since: Date.now() }, lastError: null, lastProbe: null }),
    test: () => ({ reachable: true, status: 200, ms: 5, url: "https://example.test/" }),
  });
  globalThis.fetch = fetch.impl;

  const render = { current: { hooks: [], cursor: 0, dirty: false }, Component: plugin.Component, props: plugin.registration.inject() };
  render.tree = plugin.react.render(plugin.Component, render.props, render.current);
  await settle(plugin.react, render);

  // Type a new proxy into both fields.
  const inputs = find(render.tree, (element) => element.type === "input");
  inputs[0].props.onChange({ target: { value: "192.168.1.10" } });
  await settle(plugin.react, render);
  const portInput = find(render.tree, (element) => element.type === "input")[1];
  portInput.props.onChange({ target: { value: "8080" } });
  await settle(plugin.react, render);

  const save = find(render.tree, (element) => element.type === "button" && textOf(element) === "保存");
  assert.equal(save.length, 1, "the save button is enabled once the form is dirty");
  assert.equal(save[0].props.disabled, false);
  save[0].props.onClick();
  await settle(plugin.react, render);

  const write = plugin.calls.find((entry) => entry.patch !== undefined);
  assert.ok(write, "settings.update must be called");
  assert.equal(write.ns, "dsh-simple-proxy");
  assert.equal(write.revision, 7, "the write carries the revision it read");
  assert.deepEqual(write.patch, { enabled: false, host: "192.168.1.10", port: "8080", bypass: "deepseek.com", probeUrl: "https://example.test/" });
  assert.match(textOf(render.tree), /已保存/);
  plugin.react.unmount(render.current);
});

test("the toggle and the test button reach the Host", async () => {
  const plugin = createPlugin();
  const fetch = createFetch({
    status: () => ({ desired: { enabled: true }, endpoint: { ok: true }, proxy: { active: true, url: "http://127.0.0.1:7890", since: Date.now() }, lastError: null, lastProbe: null }),
    test: (body) => ({ reachable: true, status: 204, ms: 9, url: body.url, proxy: `http://${body.host}:${body.port}` }),
  });
  globalThis.fetch = fetch.impl;

  const render = { current: { hooks: [], cursor: 0, dirty: false }, Component: plugin.Component, props: plugin.registration.inject() };
  render.tree = plugin.react.render(plugin.Component, render.props, render.current);
  await settle(plugin.react, render);

  // The status poll already told the page the proxy is live.
  assert.match(textOf(render.tree), /代理已开启/);

  const toggle = find(render.tree, (element) => element.type === "switch")[0];
  toggle.props.onChange(true);
  await settle(plugin.react, render);
  assert.equal(find(render.tree, (element) => element.type === "switch")[0].props.checked, true);

  const probe = find(render.tree, (element) => element.type === "button" && textOf(element) === "测试连接");
  assert.equal(probe.length, 1);
  probe[0].props.onClick();
  await settle(plugin.react, render);

  const posted = fetch.calls.find((call) => call.path === "/dsh-simple-proxy/test");
  assert.ok(posted, "the test button must post to the Host route");
  assert.deepEqual(JSON.parse(posted.init.body), { host: "127.0.0.1", port: "7890", url: "https://example.test/", bypass: "deepseek.com" });
  assert.match(textOf(render.tree), /连接成功：HTTP 204，用时 9ms/);
  plugin.react.unmount(render.current);
});

test("a failing probe is reported, not swallowed", async () => {
  const plugin = createPlugin();
  const fetch = createFetch({
    status: () => ({ desired: { enabled: true }, endpoint: { ok: false, message: "proxy port must be an integer between 1 and 65535, got \"\"" }, proxy: { active: false }, lastError: "proxy endpoint unusable", lastProbe: null }),
    test: () => ({ reachable: false, message: "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:7890" }),
  });
  globalThis.fetch = fetch.impl;

  const render = { current: { hooks: [], cursor: 0, dirty: false }, Component: plugin.Component, props: plugin.registration.inject() };
  render.tree = plugin.react.render(plugin.Component, render.props, render.current);
  await settle(plugin.react, render);

  assert.match(textOf(render.tree), /代理地址无效/);

  const probe = find(render.tree, (element) => element.type === "button" && textOf(element) === "测试连接")[0];
  probe.props.onClick();
  await settle(plugin.react, render);
  assert.match(textOf(render.tree), /连接失败：ECONNREFUSED/);
  plugin.react.unmount(render.current);
});

test("the page degrades to a checkbox when the primitives have no Switch", async () => {
  const plugin = createPlugin({ withSwitch: false });
  globalThis.fetch = createFetch({
    status: () => ({ desired: { enabled: false }, endpoint: { ok: true }, proxy: { active: false }, lastError: null, lastProbe: null }),
    test: () => ({ reachable: false, message: "n/a" }),
  }).impl;

  const render = { current: { hooks: [], cursor: 0, dirty: false }, Component: plugin.Component, props: plugin.registration.inject() };
  render.tree = plugin.react.render(plugin.Component, render.props, render.current);
  await settle(plugin.react, render);

  const checkboxes = find(render.tree, (element) => element.type === "input" && element.props.type === "checkbox");
  assert.equal(checkboxes.length, 1);
  assert.equal(checkboxes[0].props.checked, false);
  plugin.react.unmount(render.current);
});

test("a missing settings document is explained instead of rendered blank", async () => {
  const plugin = createPlugin({ describe: async () => [] });
  globalThis.fetch = createFetch({
    status: () => ({ desired: {}, endpoint: { ok: false }, proxy: { active: false }, lastError: null, lastProbe: null }),
    test: () => ({ reachable: false }),
  }).impl;

  const render = { current: { hooks: [], cursor: 0, dirty: false }, Component: plugin.Component, props: plugin.registration.inject() };
  render.tree = plugin.react.render(plugin.Component, render.props, render.current);
  await settle(plugin.react, render);

  assert.match(textOf(render.tree), /找不到这个插件的设置项/);
  assert.equal(find(render.tree, (element) => element.type === "input").length, 0, "no controls without a document");
  plugin.react.unmount(render.current);
});

test("an install that failed its live probe says so", async () => {
  const plugin = createPlugin();
  const fetch = createFetch({
    status: () => ({
      desired: { enabled: true },
      endpoint: { ok: true },
      proxy: { active: true, url: "http://127.0.0.1:7890", since: Date.now(), undici: "host", verified: false },
      lastError: null,
      lastProbe: null,
    }),
    test: () => ({ reachable: false, message: "ECONNRESET" }),
  });
  globalThis.fetch = fetch.impl;

  const render = { current: { hooks: [], cursor: 0, dirty: false }, Component: plugin.Component, props: plugin.registration.inject() };
  render.tree = plugin.react.render(plugin.Component, render.props, render.current);
  await settle(plugin.react, render);

  const body = textOf(render.tree);
  assert.match(body, /undici 模块来源：host/);
  assert.match(body, /未能通过实际请求验证/);
  plugin.react.unmount(render.current);
});

test("the page says when billion-context's relay was pointed at the proxy", async () => {
  const plugin = createPlugin();
  const fetch = createFetch({
    status: () => ({
      desired: { enabled: true },
      endpoint: { ok: true },
      proxy: { active: true, url: "http://127.0.0.1:7890", since: Date.now(), undici: "host", verified: true },
      relay: { present: true, managed: true, path: "C:/Users/x/.config/billion-context/billion-context.json", proxy: "http://127.0.0.1:7890", mode: "manual" },
      lastError: null,
      lastProbe: null,
    }),
    test: () => ({ reachable: true, status: 200, ms: 5, url: "https://example.test/" }),
  });
  globalThis.fetch = fetch.impl;

  const render = { current: { hooks: [], cursor: 0, dirty: false }, Component: plugin.Component, props: plugin.registration.inject() };
  render.tree = plugin.react.render(plugin.Component, render.props, render.current);
  await settle(plugin.react, render);

  assert.match(textOf(render.tree), /billion-context 的中转也已指向这条代理/);
  plugin.react.unmount(render.current);
});
