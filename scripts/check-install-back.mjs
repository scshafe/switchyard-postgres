// Install-back check for the publish workflow: given a consumer directory in
// which `pnpm add --save-exact @scshafe/switchyard@<pinned>
// @scshafe/switchyard-postgres@<version>` has run (only this package's
// integrity is compared; the engine is not this repository's release),
// read the integrity pnpm recorded (and verified against the downloaded bytes)
// from the consumer's pnpm-lock.yaml and require it to equal every expected
// integrity passed on the command line (the local pack of the tag, the
// publish job's pack). Prints one JSON line on success.
//
// usage: node scripts/check-install-back.mjs <consumerDir> <sha512-...> [<sha512-...> ...]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readReleaseIdentity } from "./release-identity.mjs";

const [consumerArg, ...expected] = process.argv.slice(2);
if (consumerArg === undefined || expected.length === 0) {
  throw new Error("usage: check-install-back.mjs <consumerDir> <sha512-...> [...]");
}
for (const value of expected) {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) {
    throw new Error(`expected integrity is not a sha512 SRI value: ${JSON.stringify(value)}`);
  }
}

const { name, version } = await readReleaseIdentity();
const consumer = resolve(consumerArg);
const lockfile = await readFile(resolve(consumer, "pnpm-lock.yaml"), "utf8");
const lines = lockfile.split(/\r?\n/);
const unquote = (text) => text.trim().replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");

// importers: -> '.': -> dependencies: -> '<name>': -> version: <resolved>
let resolved;
{
  let section = "";
  let inRootImporter = false;
  let inDependency = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      inRootImporter = false;
      inDependency = false;
      continue;
    }
    if (section !== "importers") continue;
    if (/^ {2}\S/.test(line)) {
      inRootImporter = unquote(line.replace(/:\s*$/, "")) === ".";
      inDependency = false;
    } else if (inRootImporter && /^ {6}\S/.test(line)) {
      inDependency = unquote(line.replace(/:\s*$/, "")) === name;
    } else if (inRootImporter && inDependency && /^ {8}version:/.test(line)) {
      resolved = unquote(line.slice(line.indexOf(":") + 1));
      break;
    }
  }
}
if (resolved === undefined) {
  throw new Error(`${name} is not a dependency of the consumer's root importer`);
}
// pnpm appends the resolved peers to the importer's version, e.g.
// `0.5.1(elkjs@0.10.2)`; the `packages:` key carries the bare version.
const bare = resolved.replace(/\(.*\)$/, "");
if (bare !== version) {
  throw new Error(`consumer resolved ${name}@${resolved}, expected exactly ${version}`);
}

// packages: -> '<name>@<version>': -> resolution: {integrity: sha512-...}
const key = `${name}@${bare}`;
let integrity;
{
  let section = "";
  let inPackage = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      inPackage = false;
      continue;
    }
    if (section !== "packages") continue;
    if (/^ {2}\S/.test(line)) {
      inPackage = unquote(line.replace(/:\s*$/, "")) === key;
    } else if (inPackage && /^ {4}resolution:/.test(line)) {
      integrity = /integrity:\s*(sha512-[A-Za-z0-9+/=]+)/.exec(line)?.[1];
      if (/tarball:\s*file:/.test(line)) {
        throw new Error(`${key} resolved from a local file, not a registry`);
      }
      break;
    }
  }
}
if (integrity === undefined) {
  throw new Error(`no sha512 integrity recorded for ${key} in the consumer lockfile`);
}
const mismatched = expected.filter((value) => value !== integrity);
if (mismatched.length > 0) {
  throw new Error(
    `registry integrity ${integrity} differs from expected ${JSON.stringify(mismatched)}`
  );
}
console.log(JSON.stringify({ result: "pass", package: key, integrity }));
