// Run the test suite against a real PostgreSQL.
//
// With SWITCHYARD_POSTGRES_TEST_URL set (a superuser URL, e.g. the CI service
// container), the tests use that server. Otherwise this script starts a
// throwaway PostgreSQL 18 container (pinned by digest, data on tmpfs, bound to
// 127.0.0.1 on a random port), runs the tests, and removes the container.
//
// usage: node scripts/test-postgres.mjs [extra node --test args / files]

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import pg from "pg";

// postgres:18.6 (official image, multi-arch index digest).
export const POSTGRES_TEST_IMAGE =
  "postgres:18.6@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722";
const URL_ENV = "SWITCHYARD_POSTGRES_TEST_URL";

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await delay(250);
    }
  }
  throw new Error(`PostgreSQL did not become ready: ${lastError?.message ?? "timeout"}`);
}

async function startContainer() {
  const name = `switchyard-postgres-test-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  await capture("docker", [
    "run", "--detach", "--rm",
    "--name", name,
    "--label", "switchyard-postgres-test=1",
    "--env", `POSTGRES_PASSWORD=${password}`,
    "--publish", "127.0.0.1::5432",
    "--tmpfs", "/var/lib/postgresql:rw",
    POSTGRES_TEST_IMAGE,
    "-c", "fsync=off",
    "-c", "synchronous_commit=off",
    "-c", "full_page_writes=off",
    "-c", "max_connections=300"
  ]);
  const mapped = await capture("docker", ["port", name, "5432/tcp"]);
  const port = /:(\d+)\s*$/.exec(mapped.split("\n")[0] ?? "")?.[1];
  if (port === undefined) throw new Error(`cannot read the mapped port from ${JSON.stringify(mapped)}`);
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  return { name, url };
}

async function removeContainer(name) {
  await capture("docker", ["rm", "--force", "--volumes", name]).catch((error) => {
    process.stderr.write(`warning: could not remove ${name}: ${error.message}\n`);
  });
}

const extraArgs = process.argv.slice(2);
let container;
const cleanup = async () => {
  if (container !== undefined) {
    const { name } = container;
    container = undefined;
    await removeContainer(name);
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanup().finally(() => process.exit(130));
  });
}

let exitCode = 1;
try {
  let url = process.env[URL_ENV];
  if (url === undefined || url.length === 0) {
    container = await startContainer();
    url = container.url;
    process.stdout.write(`started ${container.name} (${POSTGRES_TEST_IMAGE.split("@")[0]})\n`);
  }
  await waitForServer(url);
  const files = extraArgs.some((arg) => arg.endsWith(".mjs")) ? [] : ["test/*.test.mjs"];
  const child = spawn(process.execPath, ["--test", "--test-concurrency=4", ...extraArgs, ...files], {
    stdio: "inherit",
    env: { ...process.env, [URL_ENV]: url }
  });
  const [code] = await once(child, "close");
  exitCode = code ?? 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exitCode = exitCode;
