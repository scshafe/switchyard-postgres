import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), "switchyard-postgres-clone-"));
const clone = join(scratch, "candidate");

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: {
      ...process.env,
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
  // candidate's store so the offline install sees the same packages.
  const storeDir = (await run("pnpm", ["store", "path"])).trim();
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
