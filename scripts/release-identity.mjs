// scshafe-dev release script. Master copy: scshafe/scshafe-dev
// release/scripts/release-identity.mjs, copied verbatim into each library by
// `dev new` (D-5). Do not edit it in a library: put repository-specific
// choices in scripts/release.config.mjs, or change the master.
//
// The release identity (package name, version, payload-manifest path) is
// derived from package.json, so a rename or version bump never leaves a stale
// hardcoded path behind in the release checks.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

// `@scope/name` -> `scope-name`, the same base npm/pnpm use for the tarball.
export function releaseBaseName(name) {
  if (typeof name !== "string" || !/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name)) {
    throw new Error(`unexpected release package name: ${String(name)}`);
  }
  return name.replace(/^@/, "").replace("/", "-");
}

// `@scope/name` -> `name`: the unscoped name, which on registry.npmjs.org may
// be an unrelated package (graphpaper 0.5.x); the smokes prove it never
// resolves in a consumer of this package.
export function unscopedName(name) {
  return name.replace(/^@[^/]+\//, "");
}

// `pnpm pack --json` prints one object; tolerate an array of one for safety.
// The filename is absolute when --pack-destination is given, relative
// otherwise; callers join the basename with their own destination.
export function singlePackReport(stdout) {
  const parsed = JSON.parse(stdout);
  const reports = Array.isArray(parsed) ? parsed : [parsed];
  if (reports.length !== 1 || typeof reports[0]?.filename !== "string") {
    throw new Error("pnpm pack did not report exactly one artifact");
  }
  const report = reports[0];
  return { ...report, basename: report.filename.split("/").pop() };
}

// Lifecycle scripts are skipped when packing inside the checks: the caller
// has already built lib/, and prepack would rebuild it mid-check (and a
// lifecycle script's output would precede the JSON).
export const PNPM_PACK_ARGS = ["pack", "--json", "--config.ignore-scripts=true"];

export async function readReleaseIdentity(root = projectRoot) {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const { name, version } = packageJson;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`package.json version must be a release version (got ${String(version)})`);
  }
  if (packageJson.private === true) {
    throw new Error("package.json must not be private: true (LIB-02)");
  }
  const base = releaseBaseName(name);
  const manifest = `release/${base}-${version}.payload.sha256`;
  return { name, version, base, manifest, packageJson };
}

const DEFAULT_CONFIG = {
  // Payload rules: each directory in package.json `files` and the paths it
  // may contain (a RegExp source tested against the packaged path).
  payload: { src: "\\.ts$", lib: "\\.(?:js|d\\.ts)$" },
  // Directories `pnpm run clean` removes (build output, never committed).
  clean: ["lib"],
  // Packages the smokes need beside the peers, at their exact devDependencies.
  smokeExtraPackages: [],
  // Optional-peer phases: [{ name, peers: [names] }]. The base phase installs
  // every other peer and proves these are NOT resolvable; each phase then
  // adds its peers and runs test/smoke/<name>/ (scshafe-ui 0.3.0's editor).
  phases: [],
  // The TypeScript smoke checks the shipped .d.ts files, and with this false
  // also the peers' declarations (graphpaper, switchyard-postgres). DOM is in
  // the lib because peers' declarations name AbortSignal and friends.
  typeSmokeSkipLibCheck: false,
  typeSmokeLib: ["ES2022", "DOM"]
};

export async function readReleaseConfig(root = projectRoot) {
  const url = pathToFileURL(resolve(root, "scripts/release.config.mjs")).href;
  let loaded = {};
  try {
    loaded = (await import(url)).default ?? {};
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  const config = { ...DEFAULT_CONFIG, ...loaded };
  for (const phase of config.phases) {
    if (typeof phase?.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(phase.name) || phase.name === "base") {
      throw new Error(`release.config.mjs: bad phase name ${JSON.stringify(phase?.name)}`);
    }
    if (!Array.isArray(phase.peers) || phase.peers.length === 0) {
      throw new Error(`release.config.mjs: phase ${phase.name} lists no peers`);
    }
  }
  return config;
}

// The peers a consumer installs next to the package for the install checks and
// the publish workflow's install-back, each at the exact devDependencies
// version this tree is verified against. A peer that pnpm only auto-installs
// is not importable from the consumer itself (switchyard-postgres 0.1.0), so
// each is a direct, exact dependency of the consumer.
function exactSpecs(packageJson, names) {
  return names.map((name) => {
    const version = packageJson.devDependencies?.[name];
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`devDependencies ${name} must be an exact version (got ${String(version)})`);
    }
    return { name, version, spec: `${name}@${version}` };
  });
}

export function phaseNames(config) {
  return config.phases.map((phase) => phase.name);
}

// phase "base": every peer not claimed by an optional phase, plus the extra
// smoke packages (may be empty: a peerless library installs nothing beside
// itself). phase "<name>": that phase's peers.
export function smokePeerSpecs(packageJson, config, phase = "base") {
  const peers = Object.keys(packageJson.peerDependencies ?? {});
  const claimed = new Set(config.phases.flatMap((entry) => entry.peers));
  for (const name of claimed) {
    if (!peers.includes(name)) throw new Error(`release.config.mjs phase peer ${name} is not a peerDependency`);
  }
  if (phase === "base") {
    return exactSpecs(packageJson, [...peers.filter((name) => !claimed.has(name)), ...config.smokeExtraPackages]);
  }
  const entry = config.phases.find((candidate) => candidate.name === phase);
  if (entry === undefined) throw new Error(`unknown smoke phase ${phase}`);
  return exactSpecs(packageJson, entry.peers);
}
