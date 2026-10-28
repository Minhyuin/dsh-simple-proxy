/**
 * Read `/dsh-simple-proxy/diag` and print the parts that matter.
 *
 * The report is large and mostly JSON noise: twenty candidates' worth of
 * metadata would bury the three lines that answer "did the model call go
 * through the proxy, and what did the gateway say". This prints those lines and
 * nothing else.
 *
 * Usage:
 *   node tools/diag.mjs --port 53867
 *   node tools/diag.mjs --port 53867 --provider http://154.201.92.23:8317/v1/responses --model deepseek-v4.1-flash
 *   node tools/diag.mjs --url http://127.0.0.1:53867      # base origin instead of a port
 */

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const base = option("url") ?? `http://127.0.0.1:${option("port") ?? "53867"}`;
const provider = option("provider");
const model = option("model");
const url = new URL("/dsh-simple-proxy/diag", base);
if (provider !== undefined) url.searchParams.set("provider", provider);
if (model !== undefined) url.searchParams.set("model", model);

const started = Date.now();
const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
const json = await response.json();
if (json.ok !== true) {
  console.log(`diag failed: ${json.error?.message ?? "unknown"}`);
  process.exit(1);
}

const report = json.value;
const line = (text) => console.log(text);

line(`HTTP ${response.status} in ${Date.now() - started}ms — pid ${report.pid}, node ${report.versions.node}, electron ${report.versions.electron ?? "-"}`);
line(`fetch: ${report.fetch?.name ?? "?"} — symbols ${(report.fetch?.symbols ?? []).join(", ") || "none"}`);
line(`bypass: ${report.proxy?.bypass?.join(", ") ?? "(all proxied)"}`);
line("");
line("candidates");
for (const candidate of report.candidates ?? []) {
  const protocol = candidate.protocol?.ok === true ? "protocol ok" : `protocol FAIL (${candidate.protocol?.reason ?? "?"})`;
  line(`  ${candidate.source}@${candidate.version ?? "?"} — ${protocol}`);
  for (const result of candidate.results ?? []) {
    const verdict = result.ok === true ? `HTTP ${result.status}` : result.message;
    line(`    ${result.url} → ${verdict} (${result.ms}ms)`);
  }
}
line("");
line("installed");
line(`  ${JSON.stringify(report.proxy ?? {})}`);
line("");
line("activity.requests (newest last)");
for (const entry of report.activity?.requests ?? []) {
  const target = entry.url.length > 110 ? `${entry.url.slice(0, 110)}…` : entry.url;
  const status = entry.status ?? entry.error ?? "-";
  const body = entry.body === undefined ? "" : `\n        body: ${entry.body.replace(/\s+/gu, " ").slice(0, 200)}`;
  line(`  ${entry.method} ${target} → ${status} [${entry.via ?? "unrouted"}] ${entry.ms}ms${body}`);
}
line("");
line("activity.routes (origin → direct/proxy)");
for (const entry of report.activity?.routes ?? []) line(`  ${entry.origin} → ${entry.via}`);

if (report.provider !== undefined) {
  line("");
  line(`provider replay: ${provider}`);
  for (const [mode, answer] of Object.entries(report.provider)) {
    const status = answer.status ?? answer.reason;
    line(`  ${mode.padEnd(8)} ${status} (${answer.ms}ms)`);
    if (answer.body !== undefined && answer.body !== "") {
      line(`           ${answer.body.replace(/\s+/gu, " ").slice(0, 300)}`);
    }
  }
}
