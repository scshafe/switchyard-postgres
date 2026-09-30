// Pack the package, install it into an empty consumer next to its peer
// @scshafe/switchyard, and run JS and TypeScript smokes against the install
// (not the source tree): exports, shipped SQL with pinned checksums, the CLI
// bin, and that the stores satisfy switchyard's store interfaces.
//
// With SWITCHYARD_POSTGRES_SMOKE_CONSUMER set to a directory that already has
// the package installed (the publish workflow's install-back of the registry
// version), skip pack+install and run the same smokes there. Either way the
// consumer must depend directly on the engine at the version pinned in
// devDependencies, as a user installs it: a peer that pnpm only auto-installs
// is not importable from the consumer (0.1.0's release job).

import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNPM_PACK_ARGS, singlePackReport } from "./release-identity.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const installedConsumer = process.env.SWITCHYARD_POSTGRES_SMOKE_CONSUMER;
const scratch = installedConsumer
  ? undefined
  : await mkdtemp(join(tmpdir(), "switchyard-postgres-pack-"));

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit"
  });
  let stdout = "";
  if (options.capture) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
  }
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}`);
  return stdout;
}

/**
 * The peer to install beside the package: the vendored engine tarball while
 * pnpm-workspace.yaml still overrides it, otherwise the exact registry
 * version from devDependencies (auth comes from the user's npmrc / CI).
 */
async function peerSpec(packageJson) {
  const workspace = await readFile(resolve(root, "pnpm-workspace.yaml"), "utf8");
  const vendored = /@scshafe\/switchyard"?\s*:\s*file:(vendor\/[^\s]+\.tgz)/.exec(workspace)?.[1];
  if (vendored !== undefined) return { spec: resolve(root, vendored) };
  const version = packageJson.devDependencies?.["@scshafe/switchyard"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("devDependencies @scshafe/switchyard must be an exact version");
  }
  return { spec: `@scshafe/switchyard@${version}` };
}

async function packAndInstall(packageJson) {
  const packed = singlePackReport(await run("pnpm", [
    ...PNPM_PACK_ARGS,
    "--pack-destination",
    scratch
  ], { capture: true }));

  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`
  );
  await copyFile(resolve(root, ".npmrc"), join(consumer, ".npmrc"));
  const peer = await peerSpec(packageJson);
  // The scratch consumer may sit on another filesystem (tmpdir), where pnpm
  // would pick a different, empty store; reuse the project's store.
  const storeDir = (await run("pnpm", ["store", "path"], { capture: true })).trim();
  await run("pnpm", [
    "add",
    "--ignore-scripts",
    "--prefer-offline",
    "--store-dir",
    storeDir,
    "--save-exact",
    join(scratch, packed.basename),
    peer.spec
  ], { cwd: consumer });
  return consumer;
}

/** The consumer lists the engine itself, at the version this tree pins. */
async function assertDirectEngineDependency(consumer, packageJson) {
  const consumerJson = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
  const declared = consumerJson.dependencies?.["@scshafe/switchyard"];
  const { spec } = await peerSpec(packageJson);
  const expected = spec.startsWith("@scshafe/switchyard@") ? spec.slice("@scshafe/switchyard@".length) : undefined;
  if (declared === undefined || (expected !== undefined && declared !== expected)) {
    throw new Error(
      `consumer ${consumer} must depend directly on @scshafe/switchyard${expected === undefined ? "" : `@${expected}`}` +
      ` (found ${declared === undefined ? "no dependency" : JSON.stringify(declared)}); install it next to` +
      " @scshafe/switchyard-postgres as the README does, not only as an auto-installed peer"
    );
  }
}

try {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const consumer = installedConsumer === undefined
    ? await packAndInstall(packageJson)
    : resolve(installedConsumer);
  await assertDirectEngineDependency(consumer, packageJson);

  const installedSql = (await readdir(join(consumer, "node_modules/@scshafe/switchyard-postgres/sql"))).sort();
  const smoke = `
    import * as api from "@scshafe/switchyard-postgres";
    import metadata from "@scshafe/switchyard-postgres/package.json" with { type: "json" };
    import { MemoryGraphStore } from "@scshafe/switchyard/store/memory-graph-store";

    const loaded = await api.loadMigrations();
    if (loaded.length !== api.MIGRATIONS.length || api.LATEST_MIGRATION_VERSION !== loaded.at(-1).version) {
      throw new Error("shipped migrations do not match the manifest");
    }
    if (JSON.stringify(loaded.map((m) => m.fileName)) !== ${JSON.stringify(JSON.stringify(installedSql))}) {
      throw new Error("sql/ payload does not match the manifest");
    }
    for (const name of [
      "migrate", "migrationStatus", "assertSchemaCurrent", "createPostgresStores",
      "PostgresGraphStore", "PostgresUnitStore", "PostgresHumanDecisions", "loadGraphOnClient"
    ]) {
      if (typeof api[name] !== "function") throw new Error("missing export " + name);
    }
    const pool = { connect: async () => { throw new Error("no database in the smoke"); } };
    const stores = api.createPostgresStores({ pool, schema: "smoke_schema" });
    if (stores.unitStore.schema !== "smoke_schema" || stores.humanDecisions.schema !== "smoke_schema") {
      throw new Error("schema option not applied");
    }
    let refused = false;
    try { new api.PostgresUnitStore({ pool, schema: "Bad Name" }); } catch (error) {
      refused = error instanceof api.SwitchyardPostgresConfigError;
    }
    if (!refused) throw new Error("invalid schema name accepted");
    if (typeof MemoryGraphStore !== "function") throw new Error("peer @scshafe/switchyard not resolvable");
    if (metadata.version !== ${JSON.stringify(packageJson.version)}) {
      throw new Error("package version mismatch");
    }
  `;
  await writeFile(join(consumer, "smoke.mjs"), smoke);
  await run("node", ["smoke.mjs"], { cwd: consumer });

  const help = await run(join(consumer, "node_modules/.bin/switchyard-postgres"), ["--help"], {
    cwd: consumer,
    capture: true
  });
  if (!help.includes("usage: switchyard-postgres <migrate|status>")) {
    throw new Error("switchyard-postgres bin did not print its usage");
  }

  const typeSmoke = `
    import {
      createPostgresStores,
      migrate,
      PostgresGraphStore,
      PostgresHumanDecisions,
      PostgresUnitStore,
      type MigrateResult,
      type PendingHumanTurn,
      type PgPool
    } from "@scshafe/switchyard-postgres";
    import type { GraphStore } from "@scshafe/switchyard/store/graph-store";
    import type { UnitStore } from "@scshafe/switchyard/store/unit-store";
    import type { ExternalTurnRunnerStore } from "@scshafe/switchyard/execute/unit-runner";

    declare const pool: PgPool;
    const stores = createPostgresStores({ pool, now: () => new Date() });
    const graphStore: GraphStore = stores.graphStore;
    const unitStore: UnitStore = stores.unitStore;
    const external: ExternalTurnRunnerStore = new PostgresUnitStore({ pool });
    const decisions: PostgresHumanDecisions = stores.humanDecisions;
    const direct: GraphStore = new PostgresGraphStore({ pool, schema: "custom" });
    const result: Promise<MigrateResult> = migrate({ pool, roles: false });
    const pending: Promise<readonly PendingHumanTurn[]> = decisions.listPending({ limit: 10 });
    // @ts-expect-error a pool is required
    new PostgresUnitStore({ schema: "switchyard" });
    // @ts-expect-error decisions need an outcome and an actor
    void decisions.record({ queueId: "q" });
    void graphStore; void unitStore; void external; void direct; void result; void pending;
  `;
  await writeFile(join(consumer, "smoke.ts"), typeSmoke);
  await writeFile(join(consumer, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2022",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: []
    },
    files: ["smoke.ts"]
  }, null, 2)}\n`);
  await run(process.execPath, [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--project",
    "tsconfig.json"
  ], { cwd: consumer });
  console.log(
    installedConsumer === undefined
      ? "switchyard-postgres packed-install runtime + CLI + TypeScript smoke passed."
      : `switchyard-postgres installed-consumer runtime + CLI + TypeScript smoke passed (${consumer}).`
  );
} finally {
  if (scratch !== undefined) await rm(scratch, { force: true, recursive: true });
}
