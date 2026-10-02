// scshafe-dev release script. Master copy: scshafe/scshafe-dev
// release/scripts/write-release-manifest.mjs, copied verbatim into each
// library by `dev new` (D-5). Do not edit it in a library.
//
// Write release/<scope>-<name>-<version>.payload.sha256 from a fresh pack:
// one line per packed entry, `<sha256>  <path>`, in code-unit path order. The
// digests are taken from the packed bytes exactly as check-release-artifact.mjs
// reads them back, so the manifest and the check cannot disagree about what a
// release contains. Run after `build` and before committing a payload change;
// the check then pins it.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PNPM_PACK_ARGS,
  projectRoot as root,
  readReleaseIdentity,
  singlePackReport
} from "./release-identity.mjs";

const identity = await readReleaseIdentity(root);
const scratch = await mkdtemp(join(tmpdir(), `${identity.base}-manifest-`));

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }
  return stdout;
}

async function manifestLines(tarball) {
  const entries = (await run("tar", ["-tzf", tarball]))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith("package/")) throw new Error(`package entry lacks package/ root: ${entry}`);
      const path = entry.slice("package/".length);
      if (path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(`unsafe package entry path: ${entry}`);
      }
      return path;
    })
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (new Set(entries).size !== entries.length) throw new Error("package archive contains duplicate paths");

  const lines = [];
  for (const path of entries) {
    // Payload entries are text (the payload check rejects NUL bytes); hash the
    // same UTF-8 bytes check-release-artifact.mjs hashes when it reads them back.
    const content = await run("tar", ["-xOzf", tarball, `package/${path}`]);
    lines.push(`${createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex")}  ${path}`);
  }
  return lines;
}

try {
  const report = singlePackReport(
    await run("pnpm", [...PNPM_PACK_ARGS, "--pack-destination", scratch])
  );
  if (report.name !== identity.name || report.version !== identity.version) {
    throw new Error("packed identity does not match package.json");
  }
  const lines = await manifestLines(join(scratch, report.basename));
  await mkdir(resolve(root, "release"), { recursive: true });
  await writeFile(resolve(root, identity.manifest), `${lines.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({ result: "written", manifest: identity.manifest, fileCount: lines.length }));
} finally {
  await rm(scratch, { force: true, recursive: true });
}
