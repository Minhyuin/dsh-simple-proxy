#!/usr/bin/env node
/**
 * Minimal asar reader — the DSH desktop install ships its packages inside
 * app.asar, which only Electron's patched fs can open. Plain Node can still
 * read the archive: 16-byte preamble (4, headerSize, jsonSize, jsonLength),
 * then a JSON directory listing, then raw file bytes at absolute offsets.
 *
 * Usage:
 *   node tools/asar.mjs list [regex]        list matching paths
 *   node tools/asar.mjs cat <path>          print one file
 *   node tools/asar.mjs grep <regex> [pathRegex]  search text files in place
 *   node tools/asar.mjs extract <prefix> <destDir>  copy a subtree out
 */
import { open } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ASAR = process.env.DSH_ASAR ?? "D:/DeepSeek Harness/resources/app.asar";

const handle = await open(ASAR, "r");
const head = Buffer.alloc(16);
await handle.read(head, 0, 16, 0);
if (head.readUInt32LE(0) !== 4) throw new Error("not an asar archive");
const jsonLength = head.readUInt32LE(12);
const dataStart = 8 + head.readUInt32LE(4);
const jsonBuf = Buffer.alloc(jsonLength);
await handle.read(jsonBuf, 0, jsonLength, 16);
const header = JSON.parse(jsonBuf.toString("utf8"));

/** Flatten the directory tree into `[path, {offset, size}]` pairs. */
function flatten(node, prefix = "") {
  if (node.files === undefined) return [[prefix, node]];
  const out = [];
  for (const [name, child] of Object.entries(node.files)) out.push(...flatten(child, `${prefix}/${name}`));
  return out;
}

const entries = new Map(flatten(header));

/** Whether an entry carries readable file bytes (not a directory or symlink). */
function isReadable(entry) {
  return Number.isFinite(Number(entry.offset)) && Number.isFinite(Number(entry.size)) && entry.link === undefined;
}

async function cat(path) {
  const entry = entries.get(path);
  if (entry === undefined) throw new Error(`no such entry: ${path}`);
  if (entry.link !== undefined) return cat(entry.link);
  if (!isReadable(entry)) throw new Error(`not a readable file: ${path}`);
  const buf = Buffer.alloc(entry.size);
  await handle.read(buf, 0, entry.size, dataStart + Number(entry.offset));
  return buf;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "list") {
  const pattern = rest[0] === undefined ? undefined : new RegExp(rest[0]);
  for (const path of entries.keys()) {
    if (pattern === undefined || pattern.test(path)) console.log(path);
  }
} else if (cmd === "cat") {
  process.stdout.write(await cat(rest[0]));
} else if (cmd === "grep") {
  const pattern = new RegExp(rest[0]);
  const pathPattern = rest[1] === undefined ? undefined : new RegExp(rest[1]);
  for (const [path, entry] of entries) {
    if (!/\.(?:js|mjs|cjs|json|md|ts|yml|yaml|css|html|txt)$/.test(path)) continue;
    if (pathPattern !== undefined && !pathPattern.test(path)) continue;
    if (!isReadable(entry) || Number(entry.size) > 4_000_000) continue;
    const text = (await cat(path)).toString("utf8");
    text.split("\n").forEach((line, index) => {
      if (pattern.test(line)) console.log(`${path}:${index + 1}:${line.slice(0, 300)}`);
    });
  }
} else if (cmd === "extract") {
  const prefix = rest[0].replace(/\/+$/, "");
  const dest = rest[1];
  if (prefix === undefined || dest === undefined) {
    console.error("usage: asar.mjs extract <path-prefix> <dest-dir>");
    process.exit(2);
  }
  let count = 0;
  for (const [path, entry] of entries) {
    if (!path.startsWith(`${prefix}/`) || !isReadable(entry)) continue;
    const target = join(dest, path.slice(prefix.length + 1));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await cat(path));
    count += 1;
  }
  console.log(`extracted ${count} files from ${prefix} to ${dest}`);
} else {
  console.error("usage: asar.mjs list|cat|grep|extract ...");
  process.exit(2);
}

await handle.close();
