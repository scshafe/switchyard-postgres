// scshafe-dev release script. Master copy: scshafe/scshafe-dev
// release/scripts/check-package-payload.mjs, copied verbatim into each
// library by `dev new` (D-5). Do not edit it in a library: the payload rules
// live in scripts/release.config.mjs (`payload`).
//
// The payload is exactly package.json's `files` whitelist, file by file: each
// listed file, and every file under each listed directory (which must have a
// rule in release.config.mjs `payload` saying what it may contain), plus
// package.json. No symlinks, no special files, no NUL bytes.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  PNPM_PACK_ARGS,
  projectRoot as root,
  readReleaseConfig,
  readReleaseIdentity,
  singlePackReport
} from "./release-identity.mjs";

async function run(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"]
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${code}`);
  }
  return stdout;
}

async function expectedFilesIn(directory, accepts) {
  const absolute = resolve(root, directory);
  const files = [];

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `symbolic link is not allowed in package payload: ${relative(root, path)}`
        );
      }
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `non-regular package payload entry: ${relative(root, path)}`
        );
      }
      const packagedPath = relative(root, path).split(sep).join("/");
      if (!accepts(packagedPath)) {
        throw new Error(`unexpected file type in ${directory}: ${packagedPath}`);
      }
      if ((await readFile(path)).includes(0)) {
        throw new Error(`raw NUL byte is not allowed in package source: ${packagedPath}`);
      }
      files.push(packagedPath);
    }
  }

  await walk(absolute);
  return files;
}

const { name, version, packageJson } = await readReleaseIdentity(root);
const config = await readReleaseConfig(root);
if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
  throw new Error("package.json must have a `files` whitelist (LIB-02)");
}
if (!packageJson.files.includes("CHANGELOG.md")) {
  throw new Error("package.json `files` must include CHANGELOG.md (LIB-02)");
}

const expected = new Set(["package.json"]);
for (const entry of packageJson.files) {
  if (typeof entry !== "string" || /[*?[\]{}!]/.test(entry) || entry.startsWith("/") || entry.split("/").includes("..")) {
    throw new Error(`package.json files entry must be a plain relative path, not ${JSON.stringify(entry)}`);
  }
  const stat = await lstat(resolve(root, entry)).catch(() => undefined);
  if (stat === undefined) throw new Error(`package.json files entry ${entry} does not exist (build first?)`);
  if (stat.isSymbolicLink()) throw new Error(`package.json files entry ${entry} is a symbolic link`);
  if (stat.isDirectory()) {
    const rule = config.payload[entry];
    if (typeof rule !== "string") {
      throw new Error(`release.config.mjs payload has no rule for the files directory ${entry}`);
    }
    const pattern = new RegExp(rule);
    for (const path of await expectedFilesIn(entry, (path) => pattern.test(path))) {
      expected.add(path);
    }
  } else if (stat.isFile()) {
    expected.add(entry);
  } else {
    throw new Error(`package.json files entry ${entry} is not a regular file or directory`);
  }
}

const report = singlePackReport(
  await run("pnpm", [...PNPM_PACK_ARGS, "--dry-run"])
);
if (report.name !== name || report.version !== version) {
  throw new Error("pnpm pack identity does not match package.json");
}

const actual = new Set(report.files?.map((entry) => entry.path) ?? []);
const missing = [...expected].filter((path) => !actual.has(path)).sort();
const unexpected = [...actual].filter((path) => !expected.has(path)).sort();
if (missing.length > 0 || unexpected.length > 0) {
  throw new Error(
    `package payload mismatch: ${JSON.stringify({ missing, unexpected })}`
  );
}

console.log(
  `${name} package payload passed (${actual.size} exact files).`
);
