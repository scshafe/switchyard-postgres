import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PNPM_PACK_ARGS, singlePackReport } from "./release-identity.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

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

const rootRules = new Map([
  ["src", (path) => path.endsWith(".ts")],
  ["lib", (path) => path.endsWith(".js") || path.endsWith(".d.ts")],
  ["sql", (path) => /^sql\/\d{3}_[a-z0-9_]+\.sql$/.test(path)]
]);

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

const expected = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
  "tsconfig.json"
]);
for (const [directory, accepts] of rootRules) {
  for (const path of await expectedFilesIn(directory, accepts)) {
    expected.add(path);
  }
}

const report = singlePackReport(
  await run("pnpm", [...PNPM_PACK_ARGS, "--dry-run"])
);
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8")
);
if (
  report.name !== packageJson.name
  || report.version !== packageJson.version
) {
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
  `switchyard-postgres package payload passed (${actual.size} exact files).`
);
