// scshafe-dev release script. Master copy: scshafe/scshafe-dev
// release/scripts/check-fresh-clone.mjs, copied verbatim into each library by
// `dev new` (D-5). Do not edit it in a library.
//
// LIB-03: the committed HEAD alone builds and verifies. Clone the clean
// candidate into a scratch directory, install offline from the same store,
// build lib/ from src/ (it is never committed), run verify, and require the
// clone to stay clean.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRoot as root, readReleaseIdentity } from "./release-identity.mjs";

const { base } = await readReleaseIdentity(root);
const scratch = await mkdtemp(join(tmpdir(), `${base}-clone-`));
const clone = join(scratch, "candidate");

let storeEnv = {};

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: {
      ...process.env,
      ...storeEnv,
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false"
    },
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
    throw new Error(
      `${command} ${args.join(" ")} exited ${code}:\n${stdout}\n${stderr}`
    );
  }
  return stdout;
}

try {
  const status = await run("git", ["status", "--porcelain=v1"]);
  if (status.length !== 0) {
    throw new Error("fresh-clone gate requires an exact clean committed candidate");
  }
  const commit = (await run("git", ["rev-parse", "HEAD"])).trim();
  const tree = (await run("git", ["rev-parse", "HEAD^{tree}"])).trim();
  await run("git", ["clone", "--no-local", "--no-tags", root, clone]);
  await run("git", ["checkout", "--detach", commit], { cwd: clone });
  // The scratch clone may sit on another filesystem than the candidate
  // (tmpdir), where pnpm would pick a different, empty store; reuse the
  // candidate's store so the offline install sees the same packages. The
  // store is also exported to every nested pnpm (the packed-install check
  // inside verify installs a scratch consumer offline from the same store).
  const storeDir = (await run("pnpm", ["store", "path"])).trim();
  storeEnv = { npm_config_store_dir: storeDir };
  await run(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--offline",
      "--ignore-scripts",
      "--store-dir",
      storeDir
    ],
    { cwd: clone }
  );
  // lib/ is not committed: build it from src/ before verifying.
  await run("pnpm", ["run", "build"], { cwd: clone });
  await run("pnpm", ["run", "verify"], { cwd: clone });
  const cloneStatus = await run("git", ["status", "--porcelain=v1"], {
    cwd: clone
  });
  if (cloneStatus.length !== 0) {
    throw new Error(`fresh clone became dirty after verify:\n${cloneStatus}`);
  }
  console.log(JSON.stringify({ result: "pass", commit, tree }));
} finally {
  await rm(scratch, { force: true, recursive: true });
}
