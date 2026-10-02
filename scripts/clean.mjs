// scshafe-dev release script. Master copy: scshafe/scshafe-dev
// release/scripts/clean.mjs, copied verbatim into each library by `dev new`
// (D-5). Do not edit it in a library: list extra build directories in
// scripts/release.config.mjs (`clean`).
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { projectRoot, readReleaseConfig } from "./release-identity.mjs";

const { clean } = await readReleaseConfig();
for (const directory of clean) {
  if (typeof directory !== "string" || directory.startsWith("/") || directory.split("/").includes("..")) {
    throw new Error(`release.config.mjs clean entry is not a relative directory: ${JSON.stringify(directory)}`);
  }
}
await Promise.all(clean.map((directory) => rm(resolve(projectRoot, directory), { force: true, recursive: true })));
