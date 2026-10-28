/**
 * Point a profile's `node_modules` at this workspace's plugin package.
 *
 * A `link:` dependency is what a dev install looks like: the profile resolves
 * `dsh-simple-proxy` to `E:\agent\DSH\dsh-proxy\plugin` instead of copying the files,
 * so an edit is live after a DSH restart. On Windows a junction is used rather
 * than a symlink, because a junction needs no elevation.
 *
 * Usage: node tools/link.mjs <target-dir> <link-path>
 */

import fs from "node:fs";
import path from "node:path";

const [targetArgument, linkArgument] = process.argv.slice(2);
if (targetArgument === undefined || linkArgument === undefined) {
  console.error("usage: node tools/link.mjs <target-dir> <link-path>");
  process.exit(2);
}

const target = path.resolve(targetArgument);
const link = path.resolve(linkArgument);

if (fs.existsSync(link)) {
  const existing = fs.lstatSync(link);
  console.log(`${link} already exists (${existing.isSymbolicLink() ? "link" : "directory"}); nothing to do`);
  process.exit(0);
}

fs.symlinkSync(target, link, "junction");
console.log(`${link} -> ${target}`);
