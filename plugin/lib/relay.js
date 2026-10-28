/**
 * billion-context interop.
 *
 * Why this exists: in a profile that bundles `billion-context`, DSH's model
 * traffic never leaves the DSH process. bili rewrites every provider base URL to
 * its own relay (`POST http://127.0.0.1:<port>/bili/<original url>`) and the
 * real upstream request is made by that relay — a **separate node process**,
 * spawned by bili's DSH plugin. An undici dispatcher installed inside DSH
 * cannot reach it, which is why model calls still failed while this plugin's own
 * test button succeeded.
 *
 * bili has documented knob for exactly this: its config `upstreamProxy` (plus
 * `upstreamProxyMode: "manual"`) is what its own dashboard editor writes.
 * Writing those two keys before bili starts makes the relay forward through our
 * proxy too. bili reads its config when its daemon starts, so the change lands
 * on the next daemon start, not instantly — hence "restart DSH once" rather
 * than a live switch.
 *
 * Everything here is reversible: the first write records what it overwrote in a
 * sidecar file, and disabling the proxy puts those values back.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** The config key bili's dashboard writes for a manually chosen upstream. */
export const RELAY_PROXY_KEY = "upstreamProxy";

/** The companion key that tells bili to use the manual value. */
export const RELAY_MODE_KEY = "upstreamProxyMode";

/** `manual` is the mode the dashboard uses: only the stored value, no discovery. */
export const RELAY_MODE_VALUE = "manual";

/** Sidecar that remembers what we overwrote, so a disable can undo it. */
const STATE_FILE = ".dsh-simple-proxy-relay.json";

/**
 * bili's config file.
 *
 * bili resolves it as "the XDG location" — on Windows that is
 * `<home>/.config/billion-context/billion-context.json` (verified by
 * `bili start --help` printing the path). `DSH_PROXY_RELAY_CONFIG` exists for
 * tests and for a bili installed somewhere else.
 */
export function relayConfigPath(env = process.env) {
  const override = env.DSH_PROXY_RELAY_CONFIG?.trim();
  if (override) return override;
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  return path.join(base, "billion-context", "billion-context.json");
}

/** Where the "what did we overwrite" record lives. */
export function relayStatePath(env = process.env) {
  const override = env.DSH_PROXY_RELAY_STATE?.trim();
  if (override) return override;
  const home = env.DSH_HOME?.trim() || path.join(homedir(), ".dsh");
  return path.join(home, STATE_FILE);
}

/** Read a JSON file, distinguishing "missing" from "broken". */
async function readJson(file) {
  const text = await readFile(file, "utf8");
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${file} does not hold a JSON object`);
  }
  return value;
}

/** Write JSON through a temp file, so a crash cannot leave half a config. */
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

/** Reasonable message for the failures this module can hit. */
function describeFailure(error) {
  if (error?.code === "ENOENT") return "billion-context is not installed";
  if (error instanceof SyntaxError) return `not valid JSON: ${error.message}`;
  return error?.message ?? String(error);
}

/**
 * Point bili's relay at `proxyUrl`.
 *
 * Idempotent: a config that already carries both values is left untouched, so
 * the watchdog can call this on every tick without churning the file.
 *
 * @param proxyUrl - the proxy bili should forward through.
 * @param options - `{configPath, statePath}` overrides, for tests.
 * @returns `{ok, path, changed, message}` — never throws.
 */
export async function syncRelay(proxyUrl, options = {}) {
  const configPath = options.configPath ?? relayConfigPath();
  const statePath = options.statePath ?? relayStatePath();
  let config;
  try {
    config = await readJson(configPath);
  } catch (error) {
    return { ok: false, path: configPath, changed: false, message: describeFailure(error) };
  }

  if (config[RELAY_PROXY_KEY] === proxyUrl && config[RELAY_MODE_KEY] === RELAY_MODE_VALUE) {
    return { ok: true, path: configPath, changed: false, message: "already routed" };
  }

  let state = null;
  try {
    state = await readJson(statePath);
  } catch {
    // No record yet, or an unreadable one: treat it as "nothing recorded", which
    // only means a later disable restores nothing rather than something wrong.
    state = null;
  }
  if (state === null || state.path !== configPath) {
    state = {
      path: configPath,
      // `present` is what makes a disable able to delete a key instead of
      // restoring an empty string that means "explicitly direct" to bili.
      previous: {
        present: Object.hasOwn(config, RELAY_PROXY_KEY),
        value: config[RELAY_PROXY_KEY] ?? null,
        modePresent: Object.hasOwn(config, RELAY_MODE_KEY),
        mode: config[RELAY_MODE_KEY] ?? null,
      },
    };
  }

  config[RELAY_PROXY_KEY] = proxyUrl;
  config[RELAY_MODE_KEY] = RELAY_MODE_VALUE;
  try {
    await writeJson(statePath, state);
    await writeJson(configPath, config);
  } catch (error) {
    return { ok: false, path: configPath, changed: false, message: describeFailure(error) };
  }
  return { ok: true, path: configPath, changed: true, message: `routed through ${proxyUrl}` };
}

/**
 * Put bili's config back the way it was found.
 *
 * Safe to call when nothing was recorded (no bili, never enabled): it reports
 * `restored: false` and touches nothing.
 */
export async function restoreRelay(options = {}) {
  const statePath = options.statePath ?? relayStatePath();
  let state;
  try {
    state = await readJson(statePath);
  } catch (error) {
    const missing = error?.code === "ENOENT";
    return { ok: missing, restored: false, path: null, message: missing ? "nothing recorded" : describeFailure(error) };
  }
  const configPath = state.path ?? options.configPath ?? relayConfigPath();
  let config;
  try {
    config = await readJson(configPath);
  } catch (error) {
    return { ok: false, restored: false, path: configPath, message: describeFailure(error) };
  }

  const previous = state.previous ?? {};
  if (previous.present === true) config[RELAY_PROXY_KEY] = previous.value ?? "";
  else delete config[RELAY_PROXY_KEY];
  if (previous.modePresent === true) config[RELAY_MODE_KEY] = previous.mode ?? "";
  else delete config[RELAY_MODE_KEY];

  try {
    await writeJson(configPath, config);
    await rm(statePath, { force: true });
  } catch (error) {
    return { ok: false, restored: false, path: configPath, message: describeFailure(error) };
  }
  return { ok: true, restored: true, path: configPath, message: "restored" };
}

/** What the settings page reports about the relay, read fresh from disk. */
export async function relayStatus(options = {}) {
  const configPath = options.configPath ?? relayConfigPath();
  const statePath = options.statePath ?? relayStatePath();
  let managed = false;
  try {
    managed = (await readJson(statePath)).path === configPath;
  } catch {
    managed = false;
  }
  try {
    const config = await readJson(configPath);
    return {
      present: true,
      managed,
      path: configPath,
      proxy: typeof config[RELAY_PROXY_KEY] === "string" ? config[RELAY_PROXY_KEY] : null,
      mode: typeof config[RELAY_MODE_KEY] === "string" ? config[RELAY_MODE_KEY] : null,
    };
  } catch (error) {
    return { present: false, managed, path: configPath, proxy: null, mode: null, message: describeFailure(error) };
  }
}
