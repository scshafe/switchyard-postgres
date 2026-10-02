// scshafe-dev release script. Master copy: scshafe/scshafe-dev
// release/scripts/check-pack-install.mjs, copied verbatim into each library
// by `dev new` (D-5). Do not edit it in a library: the package's own smokes
// live in test/smoke/, the peer phases in scripts/release.config.mjs.
//
// Pack the package, install the tarball into an empty consumer next to its
// peers at the exact versions this tree is verified against, and run smokes
// against the install, not the source tree:
//
//   - identity: the installed package.json has this name and version, and the
//     unscoped name (an unrelated npmjs.org package, perhaps) does not resolve;
//   - peers: every base-phase peer is a direct, exact dependency of the
//     consumer and resolves from it; no optional-phase peer is installed or
//     resolvable (pnpm 10 auto-installs optional peers unless told not to);
//   - JS: each test/smoke/*.smoke.mjs runs in the consumer (with this Node);
//   - TypeScript: test/smoke/*.smoke.ts typecheck against the shipped .d.ts.
//
// then, for each optional-peer phase in release.config.mjs, add that phase's
// peers and run test/smoke/<phase>/ the same way.
//
// With RELEASE_SMOKE_CONSUMER set to a directory that already has the package
// and its peers installed (the publish workflow's install-back of the registry
// version), skip pack+install and run one phase there, named by
// RELEASE_SMOKE_PHASE ("base" or a phase name).

import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PNPM_PACK_ARGS,
  phaseNames,
  projectRoot as root,
  readReleaseConfig,
  readReleaseIdentity,
  singlePackReport,
  smokePeerSpecs,
  unscopedName
} from "./release-identity.mjs";

const identity = await readReleaseIdentity(root);
const config = await readReleaseConfig(root);
const installedConsumer = process.env.RELEASE_SMOKE_CONSUMER;
const scratch = installedConsumer ? undefined : await mkdtemp(join(tmpdir(), `${identity.base}-pack-`));

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

async function pnpmStoreDir() {
  // The scratch consumer may sit on another filesystem (tmpdir), where pnpm
  // would pick a different, empty store; reuse the project's store.
  return (await run("pnpm", ["store", "path"], { capture: true })).trim();
}

async function packAndInstall(peers) {
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
  // The scope line only: @scshafe peers come from GitHub Packages with the
  // user's (or the job's) read token, never from registry.npmjs.org.
  await copyFile(resolve(root, ".npmrc"), join(consumer, ".npmrc"));
  await run("pnpm", [
    "add",
    // pnpm 10 auto-installs optional peers too (auto-install-peers=true); the
    // base consumer gets exactly the peers listed here (scshafe-ui 0.3.0).
    "--config.auto-install-peers=false",
    "--ignore-scripts",
    "--prefer-offline",
    "--store-dir",
    await pnpmStoreDir(),
    "--save-exact",
    join(scratch, packed.basename),
    ...peers.map((peer) => peer.spec)
  ], { cwd: consumer });
  return consumer;
}

async function addPeers(consumer, peers) {
  await run("pnpm", [
    "add", "--config.auto-install-peers=false", "--ignore-scripts", "--prefer-offline",
    "--store-dir", await pnpmStoreDir(), "--save-exact",
    ...peers.map((peer) => peer.spec)
  ], { cwd: consumer });
}

async function consumerJson(consumer) {
  return JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
}

async function probe(consumer, fileName, source) {
  await writeFile(join(consumer, fileName), source);
  await run(process.execPath, [fileName], { cwd: consumer });
}

// A peer "resolves" from the consumer if its root or its package.json is
// importable, or, for a package that exports only subpaths and no
// ./package.json (@tiptap/pm, scshafe-ui's editor phase), if its directory is
// linked into the consumer's node_modules. Shared by both probes below.
const PEER_PRESENT = `
  import { existsSync } from "node:fs";
  const present = (name) => {
    for (const specifier of [name, name + "/package.json"]) {
      try { import.meta.resolve(specifier); return true; } catch {}
    }
    return existsSync(new URL("./node_modules/" + name + "/package.json", import.meta.url));
  };
`;

// Every peer of this phase is a direct, exact dependency of the consumer and
// resolves from it: a peer pnpm only auto-installs is not importable from the
// consumer itself (switchyard-postgres 0.1.0's release job).
async function assertDirectPeers(consumer, peers) {
  const json = await consumerJson(consumer);
  const wrong = peers.filter((peer) => json.dependencies?.[peer.name] !== peer.version);
  if (wrong.length > 0) {
    throw new Error(
      `consumer ${consumer} must depend directly on ${wrong.map((peer) => peer.spec).join(", ")}` +
      ` (found ${JSON.stringify(json.dependencies ?? {})}); install the peers next to ${identity.name}`
    );
  }
  if (peers.length === 0) return;
  await probe(consumer, "peers-probe.mjs", `${PEER_PRESENT}
    const missing = ${JSON.stringify(peers.map((peer) => peer.name))}.filter((name) => !present(name));
    if (missing.length > 0) throw new Error("peers not resolvable from the consumer: " + missing.join(", "));
  `);
}

// Peers of optional phases not yet added must be absent: neither dependencies
// of, nor resolvable from, the consumer.
async function assertAbsentPeers(consumer, peers) {
  if (peers.length === 0) return;
  const json = await consumerJson(consumer);
  const present = peers.filter((peer) => json.dependencies?.[peer.name] !== undefined);
  if (present.length > 0) throw new Error(`consumer must not depend on ${present.map((peer) => peer.name).join(", ")} yet`);
  await probe(consumer, "absent-probe.mjs", `${PEER_PRESENT}
    const found = ${JSON.stringify(peers.map((peer) => peer.name))}.filter(present);
    if (found.length > 0) throw new Error("optional peers resolvable before their phase: " + found.join(", "));
  `);
}

async function assertIdentity(consumer) {
  await probe(consumer, "identity-probe.mjs", `
    import { readFileSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    const metadata = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(${JSON.stringify(`${identity.name}/package.json`)})), "utf8"));
    if (metadata.name !== ${JSON.stringify(identity.name)} || metadata.version !== ${JSON.stringify(identity.version)}) {
      throw new Error("installed identity " + metadata.name + "@" + metadata.version + " is not ${identity.name}@${identity.version}");
    }
    // The unscoped name is not this package (it may be an unrelated public
    // package on registry.npmjs.org) and must not resolve here.
    let resolved = true;
    try { import.meta.resolve(${JSON.stringify(unscopedName(identity.name))}); } catch { resolved = false; }
    if (resolved) throw new Error("the unscoped name ${unscopedName(identity.name)} resolves in the consumer");
  `);
}

async function smokeFiles(directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  return {
    js: files.filter((file) => file.endsWith(".smoke.mjs")),
    ts: files.filter((file) => file.endsWith(".smoke.ts"))
  };
}

async function runSmokes(consumer, phase) {
  const directory = phase === "base" ? "test/smoke" : `test/smoke/${phase}`;
  const { js, ts } = await smokeFiles(directory);
  if (phase === "base" && js.length === 0) {
    throw new Error("test/smoke has no *.smoke.mjs: the packed package is never imported");
  }
  const target = join(consumer, phase === "base" ? "smoke" : `smoke-${phase}`);
  await mkdir(target, { recursive: true });
  for (const file of [...js, ...ts]) await copyFile(resolve(root, directory, file), join(target, file));
  for (const file of js) {
    await run(process.execPath, [join(target, file)], { cwd: consumer });
  }
  if (ts.length > 0) {
    const tsconfig = join(consumer, `tsconfig.${phase}.json`);
    await writeFile(tsconfig, `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        lib: config.typeSmokeLib,
        strict: true,
        noEmit: true,
        skipLibCheck: config.typeSmokeSkipLibCheck,
        types: []
      },
      files: ts.map((file) => join(target, file))
    }, null, 2)}\n`);
    await run(process.execPath, [
      resolve(root, "node_modules/typescript/bin/tsc"),
      "--project",
      tsconfig
    ], { cwd: consumer });
  }
  console.log(`${identity.name} ${phase} smokes passed (${js.length} JS, ${ts.length} TypeScript).`);
}

try {
  const phases = phaseNames(config);
  const base = smokePeerSpecs(identity.packageJson, config, "base");
  const optional = Object.fromEntries(phases.map((phase) => [phase, smokePeerSpecs(identity.packageJson, config, phase)]));
  const requested = installedConsumer === undefined ? undefined : process.env.RELEASE_SMOKE_PHASE;
  if (installedConsumer !== undefined && !["base", ...phases].includes(requested)) {
    throw new Error(`with RELEASE_SMOKE_CONSUMER, set RELEASE_SMOKE_PHASE to one of ${["base", ...phases].join(", ")}`);
  }
  const consumer = installedConsumer === undefined ? await packAndInstall(base) : resolve(installedConsumer);
  const run_phases = requested === undefined ? ["base", ...phases] : [requested];
  const added = [];
  for (const phase of run_phases) {
    if (phase === "base") {
      await assertIdentity(consumer);
      await assertDirectPeers(consumer, base);
      await assertAbsentPeers(consumer, Object.values(optional).flat());
    } else {
      if (installedConsumer === undefined) await addPeers(consumer, optional[phase]);
      added.push(...optional[phase]);
      await assertDirectPeers(consumer, [...base, ...added]);
    }
    await runSmokes(consumer, phase);
  }
  console.log(
    installedConsumer === undefined
      ? `${identity.name} packed-install smokes passed (${run_phases.join(", ")}).`
      : `${identity.name} installed-consumer ${requested} smokes passed (${consumer}).`
  );
} finally {
  if (scratch !== undefined) await rm(scratch, { force: true, recursive: true });
}
