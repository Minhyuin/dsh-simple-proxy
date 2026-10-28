/**
 * dsh-simple-proxy — the Client half.
 *
 * One page under Settings → Plugins. It edits this plugin's own settings
 * document (the Host half reacts to the write by installing or restoring the
 * proxy dispatcher) and shows two facts that only the Host knows: whether the
 * proxy is live right now, and whether a candidate endpoint carries a request.
 *
 * The page has no build step: it is a plain module loaded by the client's
 * module loader, so it hand-rolls its markup with `jsx()` calls and ships its
 * own stylesheet, colouring everything with the theme's design tokens so it
 * looks native in both light and dark themes.
 */

window.__ModuleLoader__.load({
  id: "dsh-simple-proxy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { Button, Switch } = require("@deepseek-ai/dsh-client-ui-primitives");

    /** Must match the Host half: a settings document is addressed by plugin id. */
    const SETTINGS_NS = "dsh-simple-proxy";
    const STATUS_PATH = "/dsh-simple-proxy/status";
    const TEST_PATH = "/dsh-simple-proxy/test";
    const READ_TIMEOUT_MS = 12000;
    const STATUS_INTERVAL_MS = 2000;

    const CSS = `
.dpx-root{display:flex;flex-direction:column;gap:16px;max-width:760px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dpx-head{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dpx-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dpx-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent}
.dpx-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dpx-grid{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:12px}
.dpx-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dpx-label{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dpx-input{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dpx-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dpx-input[disabled]{opacity:.55}
.dpx-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dpx-actions{display:flex;align-items:center;gap:8px}
.dpx-note{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dpx-note[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
.dpx-note[data-ok="true"]{color:var(--dsw-alias-state-business-primary)}
.dpx-live{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md)}
.dpx-live-line{display:flex;align-items:center;gap:8px}
.dpx-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.dpx-dot[data-on="true"]{background:var(--dsw-alias-state-business-primary)}
.dpx-dot[data-bad="true"]{background:var(--dsw-alias-state-error-primary)}
.dpx-mono{font-family:var(--dsw-font-mono);font-size:12px}
.dpx-empty{padding:12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary)}
`;

    // ---------------------------------------------------------------- helpers

    /** Plain-object test: every payload here comes from JSON. */
    function isRecord(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    /** A descriptor's config value, tolerating a schema wrapper. */
    function plainValue(value) {
      return value?.get?.() ?? value;
    }

    /** Reject after `ms` so one stalled read cannot freeze the page. */
    function withTimeout(promise, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${READ_TIMEOUT_MS}ms`));
        }, READ_TIMEOUT_MS);
        promise.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    }

    /** Unwrap the `{ok, value}` / `{ok:false, error}` envelope Host routes answer with. */
    function unwrap(response, label) {
      if (!isRecord(response) || typeof response.ok !== "boolean") return response;
      if (response.ok === true) return response.value;
      const message = isRecord(response.error) && typeof response.error.message === "string" ? response.error.message : `${label} failed`;
      throw new Error(message);
    }

    /** Every settings document the Host serves, from either describe() shape. */
    function namespaceNames(payload) {
      const namespaces = isRecord(payload) && Array.isArray(payload.namespaces) ? payload.namespaces : Array.isArray(payload) ? payload : [];
      return namespaces.map((entry) => (isRecord(entry) ? entry.ns : undefined)).filter((ns) => typeof ns === "string");
    }

    /** This plugin's own settings descriptor, if the Host serves one. */
    function descriptorOf(payload, ns) {
      const namespaces = isRecord(payload) && Array.isArray(payload.namespaces) ? payload.namespaces : Array.isArray(payload) ? payload : [];
      return namespaces.find((entry) => isRecord(entry) && entry.ns === ns);
    }

    /** Inject the stylesheet once; React strict mode and reloads both re-run apply. */
    function installStyles() {
      const doc = globalThis.document;
      if (doc === undefined) return;
      if (doc.querySelector("style[data-dsh-simple-proxy]") !== null) return;
      const style = doc.createElement("style");
      style.dataset.dshSimpleProxy = "";
      style.textContent = CSS;
      doc.head.append(style);
    }

    /** Coerce a config value to the string the form shows. */
    function text(value, fallback) {
      const plain = plainValue(value);
      if (typeof plain === "string") return plain;
      if (typeof plain === "number") return String(plain);
      return fallback;
    }

    /** Coerce a config value to the boolean the form shows. */
    function flag(value) {
      const plain = plainValue(value);
      if (typeof plain === "boolean") return plain;
      if (typeof plain === "string") return ["true", "1", "yes", "on"].includes(plain.trim().toLowerCase());
      return false;
    }

    /** The editable fields, from a settings descriptor's value. */
    function configOf(value) {
      const source = isRecord(value) ? value : {};
      return {
        enabled: flag(source.enabled),
        host: text(source.host, "127.0.0.1"),
        port: text(source.port, "7890"),
        bypass: text(source.bypass, "deepseek.com"),
        probeUrl: text(source.probeUrl, "https://www.cloudflare.com/cdn-cgi/trace"),
      };
    }

    /** Whether two drafts would write the same document. */
    function sameConfig(left, right) {
      return (
        left.enabled === right.enabled &&
        left.host === right.host &&
        left.port === right.port &&
        left.bypass === right.bypass &&
        left.probeUrl === right.probeUrl
      );
    }

    /** One JSON request to a Host route, with the envelope unwrapped. */
    async function fetchJson(path, init) {
      const response = await fetch(path, {
        cache: "no-store",
        headers: { accept: "application/json" },
        ...init,
      });
      const body = await response.text();
      let payload;
      try {
        payload = body === "" ? {} : JSON.parse(body);
      } catch {
        throw new Error(`${path} answered HTTP ${response.status} with a non-JSON body`);
      }
      if (!response.ok) {
        const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return unwrap(payload, path);
    }

    /**
     * The primitives' toggle, with a checkbox fallback.
     *
     * `Switch` has been part of the primitives for every shipped settings page,
     * but a page that throws because one export went missing would take the
     * whole Plugins section down with it; a checkbox is still a working switch.
     */
    const SwitchControl =
      typeof Switch === "function"
        ? Switch
        : function FallbackSwitch(props) {
            return jsx("input", {
              type: "checkbox",
              checked: props.checked === true,
              disabled: props.disabled === true,
              "aria-label": typeof props.label === "string" ? props.label : undefined,
              onChange: (event) => {
                props.onChange?.(event.target.checked);
              },
            });
          };

    /** Local wall-clock time for the "since" note, or an empty string. */
    function formatTime(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "";
      const date = new Date(value);
      const pad = (part) => String(part).padStart(2, "0");
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    // ------------------------------------------------------------- the page

    /**
     * The settings page.
     *
     * @param props.t - the locale-bound translator for this namespace.
     * @param props.remote - the client's remote namespaces (`settings` is used).
     */
    function ProxySettings({ t: translate, remote }) {
      const t = typeof translate === "function" ? translate : (key) => key;
      const remoteRef = react.useRef(remote);
      remoteRef.current = remote;
      const revisionRef = react.useRef(undefined);

      const [saved, setSaved] = react.useState(null);
      const [draft, setDraft] = react.useState(null);
      const [status, setStatus] = react.useState("loading");
      const [writable, setWritable] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [note, setNote] = react.useState(null);
      const [live, setLive] = react.useState(null);
      const [liveError, setLiveError] = react.useState(null);
      const [saving, setSaving] = react.useState(false);
      const [testing, setTesting] = react.useState(false);

      // The saved document and the in-progress form live in refs as well as in
      // state: `load` must be able to decide "is the user mid-edit?" without
      // taking either as a dependency, or every successful read would change
      // the callback identity and re-trigger the effect that called it.
      const savedRef = react.useRef(null);
      const draftRef = react.useRef(null);
      draftRef.current = draft;

      const load = react.useCallback(
        async (reason) => {
          if (reason === "initial") setStatus("loading");
          try {
            const described = unwrap(await withTimeout(remoteRef.current.settings.describe(), "settings.describe"), "settings.describe");
            const own = descriptorOf(described, SETTINGS_NS);
            if (own === undefined) {
              setStatus("missing");
              setError(`${t("noDocument")} [ns: ${namespaceNames(described).join(", ") || "-"}]`);
              setWritable(false);
              return;
            }
            const next = configOf(own.value);
            const current = draftRef.current;
            const editing = current !== null && savedRef.current !== null && !sameConfig(current, savedRef.current);
            revisionRef.current = own.revision;
            savedRef.current = next;
            setSaved(next);
            if (!editing) setDraft(next);
            setWritable(described?.writable !== false);
            setStatus("ready");
            setError(null);
          } catch (failure) {
            setStatus("failed");
            setError(failure instanceof Error ? failure.message : String(failure));
            setWritable(false);
          }
        },
        [t],
      );

      react.useEffect(() => {
        void load("initial");
        // The Host restarts this plugin whenever its config changes; re-reading
        // once more keeps the form in step with a write made elsewhere.
        const timer = setInterval(() => void load("quiet"), 5000);
        return () => clearInterval(timer);
      }, [load]);

      react.useEffect(() => {
        let stopped = false;
        const tick = async () => {
          try {
            const payload = await fetchJson(STATUS_PATH);
            if (stopped) return;
            setLive(payload);
            setLiveError(null);
          } catch (failure) {
            if (stopped) return;
            setLive(null);
            setLiveError(failure instanceof Error ? failure.message : String(failure));
          }
        };
        void tick();
        const timer = setInterval(() => void tick(), STATUS_INTERVAL_MS);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, []);

      const dirty = saved !== null && draft !== null && !sameConfig(saved, draft);
      const ready = status === "ready";
      const readOnly = !writable || !ready;
      const busy = saving || testing;

      const update = (patch) => {
        setDraft((current) => (current === null ? current : { ...current, ...patch }));
        setNote(null);
      };

      const save = async () => {
        if (draft === null) return;
        setSaving(true);
        setNote(null);
        try {
          const patch = {
            enabled: draft.enabled,
            host: draft.host.trim(),
            port: draft.port.trim(),
            bypass: draft.bypass.trim(),
            probeUrl: draft.probeUrl.trim(),
          };
          await unwrap(await remoteRef.current.settings.update(SETTINGS_NS, patch, revisionRef.current), "settings.update");
          await load("keep");
          setNote({ kind: "ok", text: t("saved") });
        } catch (failure) {
          setNote({ kind: "error", text: failure instanceof Error ? failure.message : String(failure) });
        } finally {
          setSaving(false);
        }
      };

      const test = async () => {
        if (draft === null) return;
        setTesting(true);
        setNote(null);
        try {
          const result = await fetchJson(TEST_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              host: draft.host.trim(),
              port: draft.port.trim(),
              url: draft.probeUrl.trim(),
              bypass: draft.bypass.trim(),
            }),
          });
          if (result !== null && result !== undefined && result.reachable === true) {
            setNote({ kind: "ok", text: t("testOk", { status: String(result.status ?? "?"), ms: String(result.ms ?? "?") }) });
          } else {
            setNote({ kind: "error", text: t("testFailed", { message: String(result?.message ?? t("unknownFailure")) }) });
          }
        } catch (failure) {
          setNote({ kind: "error", text: failure instanceof Error ? failure.message : String(failure) });
        } finally {
          setTesting(false);
        }
      };

      // ------------------------------------------------------------- render

      const activeProxy = isRecord(live?.proxy) ? live.proxy : null;
      const activeEndpoint = isRecord(live?.endpoint) ? live.endpoint : null;
      const proxyOn = activeProxy?.active === true;
      const endpointOk = activeEndpoint?.ok !== false;
      const dotState = proxyOn ? "on" : liveError !== null || !endpointOk || live?.lastError ? "bad" : "off";

      const children = [
        jsx("h2", { key: "head", className: "dpx-head", children: t("title") }),
        jsx("p", { key: "sub", className: "dpx-sub", children: t("subtitle") }),
      ];

      if (status === "missing" || status === "failed") {
        children.push(jsx("div", { key: "empty", className: "dpx-empty", children: error ?? t("noDocument") }));
      }

      if (draft !== null) {
        children.push(
          jsxs(
            "div",
            {
              key: "card",
              className: "dpx-card",
              children: [
                jsxs(
                  "label",
                  {
                    key: "toggle",
                    className: "dpx-row",
                    children: [
                      jsxs("span", {
                        key: "text",
                        children: [
                          jsx("span", { key: "label", children: t("enable") }),
                          jsx("br", { key: "br" }),
                          jsx("span", { key: "hint", className: "dpx-hint", children: t("enableHint") }),
                        ],
                      }),
                      jsx(SwitchControl, {
                        key: "switch",
                        checked: draft.enabled,
                        disabled: readOnly || busy,
                        label: t("enable"),
                        onChange: (checked) => update({ enabled: checked === true }),
                      }),
                    ],
                  },
                  "toggle",
                ),
                jsxs(
                  "div",
                  {
                    key: "hostport",
                    className: "dpx-grid",
                    children: [
                      jsxs(
                        "label",
                        {
                          key: "host",
                          className: "dpx-field",
                          children: [
                            jsx("span", { key: "l", className: "dpx-label", children: t("host") }),
                            jsx("input", {
                              key: "i",
                              className: "dpx-input",
                              value: draft.host,
                              disabled: readOnly || busy,
                              spellCheck: false,
                              placeholder: "127.0.0.1",
                              onChange: (event) => update({ host: event.target.value }),
                            }),
                          ],
                        },
                        "host",
                      ),
                      jsxs(
                        "label",
                        {
                          key: "port",
                          className: "dpx-field",
                          children: [
                            jsx("span", { key: "l", className: "dpx-label", children: t("port") }),
                            jsx("input", {
                              key: "i",
                              className: "dpx-input",
                              value: draft.port,
                              disabled: readOnly || busy,
                              inputMode: "numeric",
                              spellCheck: false,
                              placeholder: "7890",
                              onChange: (event) => update({ port: event.target.value }),
                            }),
                          ],
                        },
                        "port",
                      ),
                    ],
                  },
                  "hostport",
                ),
                jsxs(
                  "label",
                  {
                    key: "bypass",
                    className: "dpx-field",
                    children: [
                      jsx("span", { key: "l", className: "dpx-label", children: t("bypass") }),
                      jsx("input", {
                        key: "i",
                        className: "dpx-input",
                        value: draft.bypass,
                        disabled: readOnly || busy,
                        spellCheck: false,
                        placeholder: "deepseek.com",
                        onChange: (event) => update({ bypass: event.target.value }),
                      }),
                      jsx("span", { key: "h", className: "dpx-hint", children: t("bypassHint") }),
                    ],
                  },
                  "bypass",
                ),
                jsxs(
                  "label",
                  {
                    key: "probe",
                    className: "dpx-field",
                    children: [
                      jsx("span", { key: "l", className: "dpx-label", children: t("probeUrl") }),
                      jsx("input", {
                        key: "i",
                        className: "dpx-input",
                        value: draft.probeUrl,
                        disabled: readOnly || busy,
                        spellCheck: false,
                        onChange: (event) => update({ probeUrl: event.target.value }),
                      }),
                    ],
                  },
                  "probe",
                ),
                jsx("p", { key: "hint", className: "dpx-hint", children: t("hint") }),
              ],
            },
            "card",
          ),
        );

        children.push(
          jsxs(
            "div",
            {
              key: "actions",
              className: "dpx-actions",
              children: [
                jsx(Button, {
                  key: "save",
                  variant: "primary",
                  disabled: readOnly || busy || !dirty,
                  onClick: () => void save(),
                  children: saving ? t("saving") : t("save"),
                }),
                jsx(Button, {
                  key: "test",
                  variant: "outline",
                  disabled: !ready || busy,
                  onClick: () => void test(),
                  children: testing ? t("testing") : t("test"),
                }),
                jsx(Button, {
                  key: "reset",
                  variant: "ghost",
                  disabled: !dirty || busy,
                  onClick: () => {
                    setDraft(saved);
                    setNote(null);
                  },
                  children: t("reset"),
                }),
              ],
            },
            "actions",
          ),
        );

        if (note !== null) {
          children.push(
            jsx("span", {
              key: "note",
              className: "dpx-note",
              "data-error": note.kind === "error" ? "true" : undefined,
              "data-ok": note.kind === "ok" ? "true" : undefined,
              children: note.text,
            }),
          );
        }
      }

      const liveLine = (() => {
        if (liveError !== null) return t("statusUnavailable", { message: liveError });
        if (live === null) return t("statusReading");
        if (proxyOn) return t("statusOn", { url: String(activeProxy?.url ?? "") });
        if (!endpointOk) return t("statusInvalid", { message: String(activeEndpoint?.message ?? "") });
        if (typeof live?.lastError === "string" && live.lastError !== "") return t("statusError", { message: live.lastError });
        return t("statusOff");
      })();

      const liveDetail =
        live?.lastProbe !== null && live?.lastProbe !== undefined && isRecord(live.lastProbe)
          ? t("lastProbe", {
              url: String(live.lastProbe.url ?? ""),
              outcome: live.lastProbe.reachable === true ? `${live.lastProbe.status ?? "?"} · ${live.lastProbe.ms ?? "?"}ms` : String(live.lastProbe.message ?? "?"),
            })
          : null;

      children.push(
        jsxs(
          "div",
          {
            key: "live",
            className: "dpx-live",
            children: [
              jsxs("div", {
                key: "line",
                className: "dpx-live-line",
                children: [
                  jsx("span", { key: "dot", className: "dpx-dot", "data-on": dotState === "on" ? "true" : undefined, "data-bad": dotState === "bad" ? "true" : undefined }),
                  jsx("span", { key: "text", children: liveLine }),
                ],
              }),
              proxyOn
                ? jsx("div", {
                    key: "detail",
                    className: "dpx-hint",
                    children: t("statusDetail", {
                      proxy: String(activeProxy?.url ?? ""),
                      since: formatTime(activeProxy?.since),
                    }),
                  })
                : null,
              proxyOn && typeof activeProxy?.undici === "string"
                ? jsx("div", {
                    key: "undici",
                    className: "dpx-hint dpx-mono",
                    children: t("undiciSource", { source: activeProxy.undici }),
                  })
                : null,
              proxyOn && activeProxy?.verified === false
                ? jsx("div", { key: "unverified", className: "dpx-hint", "data-error": "true", children: t("unverified") })
                : null,
              proxyOn && isRecord(live?.relay) && live.relay.managed === true
                ? jsx("div", { key: "relay", className: "dpx-hint", children: t("relayManaged") })
                : null,
              proxyOn && isRecord(live?.relay) && live.relay.present === false
                ? jsx("div", { key: "relayMissing", className: "dpx-hint", children: t("relayMissing") })
                : null,
              liveDetail === null ? null : jsx("div", { key: "probe", className: "dpx-hint dpx-mono", children: liveDetail }),
            ],
          },
          "live",
        ),
      );

      return jsx("div", { className: "dpx-root", children });
    }

    // ---------------------------------------------------------- dictionaries

    const zh = {
      title: "网络代理",
      subtitle: "让 DSH 自己的网络请求走本机代理，不需要在启动前设置代理环境变量，也不会影响其他程序。",
      enable: "启用代理",
      enableHint: "保存后立即生效；关闭时恢复为原来的网络设置。",
      host: "代理地址",
      port: "端口",
      bypass: "直连域名",
      bypassHint: "这些域名及其子域不走代理，逗号分隔；留空表示全部走代理。",
      probeUrl: "测试地址",
      hint: "支持 http:// 与 https:// 代理（不支持 socks）。本机地址（localhost / 127.0.0.1）始终直连。",
      save: "保存",
      saving: "保存中…",
      test: "测试连接",
      testing: "测试中…",
      reset: "撤销修改",
      saved: "已保存，代理设置已更新。",
      testOk: "连接成功：HTTP {status}，用时 {ms}ms。",
      testFailed: "连接失败：{message}",
      unknownFailure: "未知错误",
      statusOn: "代理已开启，当前流量经 {url} 转发。",
      statusOff: "代理未开启，网络直连。",
      statusInvalid: "代理地址无效：{message}",
      statusError: "代理未能生效：{message}",
      statusReading: "正在读取代理状态…",
      statusUnavailable: "无法读取代理状态：{message}",
      statusDetail: "已安装：{proxy}（{since} 起生效）",
      undiciSource: "undici 模块来源：{source}",
      unverified: "这条代理未能通过实际请求验证（可能是代理不通或需要登录），已按最近的可用副本安装。",
      relayManaged: "billion-context 的中转也已指向这条代理；它在自己的进程里发请求，需要重启 DSH 才生效。",
      relayMissing: "没有找到 billion-context 的配置，模型流量若经它中转，需要单独设置它的上游代理。",
      lastProbe: "上次测试：{url} → {outcome}",
      noDocument: "找不到这个插件的设置项，可能没有在 cordis.patch.yml 中挂载。",
    };

    const en = {
      title: "Network proxy",
      subtitle: "Send DSH's own network requests through a local proxy — no proxy environment variables before launch, and no effect on other programs.",
      enable: "Enable proxy",
      enableHint: "Takes effect as soon as it is saved; switching it off restores the previous network settings.",
      host: "Proxy host",
      port: "Port",
      bypass: "Direct-only hosts",
      bypassHint: "These hosts and their subdomains skip the proxy, comma separated. Leave empty to proxy everything.",
      probeUrl: "Test URL",
      hint: "http:// and https:// proxies are supported (not socks). Loopback addresses (localhost / 127.0.0.1) always stay direct.",
      save: "Save",
      saving: "Saving…",
      test: "Test connection",
      testing: "Testing…",
      reset: "Discard changes",
      saved: "Saved. The proxy setting is live.",
      testOk: "Reachable: HTTP {status} in {ms}ms.",
      testFailed: "Not reachable: {message}",
      unknownFailure: "unknown failure",
      statusOn: "Proxy is on — traffic is going through {url}.",
      statusOff: "Proxy is off — traffic goes out directly.",
      statusInvalid: "The proxy address is unusable: {message}",
      statusError: "The proxy did not take effect: {message}",
      statusReading: "Reading proxy status…",
      statusUnavailable: "Cannot read proxy status: {message}",
      statusDetail: "Installed: {proxy} (live since {since})",
      undiciSource: "undici module: {source}",
      unverified: "This proxy did not pass a real request (it may be down or need credentials); installed with the best compatible copy.",
      relayManaged: "billion-context's relay points at this proxy too; it sends requests from its own process, so restart DSH for that to take effect.",
      relayMissing: "No billion-context config found; if model traffic is relayed through it, set its upstream proxy separately.",
      lastProbe: "Last test: {url} → {outcome}",
      noDocument: "This plugin has no settings document — it may not be mounted in cordis.patch.yml.",
    };

    // ---------------------------------------------------------- registration

    const NS = SETTINGS_NS;
    let boundT = (key) => key;

    const inject = ["slots", "locale", "remote", "remote.settings"];

    function apply(ctx) {
      installStyles();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-simple-proxy: dictionaries");

      const remote = { settings: ctx.remote.settings };
      const t = ctx.locale.bind(NS);
      boundT = t;

      ctx.slots.inject("settings.plugins.tab", () =>
        ctx.slots.register(
          {
            name: "settings.plugins.tab",
            id: "dsh-simple-proxy",
            order: 45,
            label: () => t("title"),
            locale: NS,
            inject: () => ({ t, remote }),
          },
          ProxySettings,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
