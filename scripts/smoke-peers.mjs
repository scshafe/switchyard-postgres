// scshafe-dev release script. Master copy: scshafe/scshafe-dev
// release/scripts/smoke-peers.mjs, copied verbatim into each library by
// `dev new` (D-5). Do not edit it in a library.
//
// Print the exact peer specs (one per line) a consumer installs next to the
// package, so the publish workflow installs them as direct dependencies:
//
//   node scripts/smoke-peers.mjs                 # base phase (may print nothing)
//   node scripts/smoke-peers.mjs --phase editor  # an optional-peer phase
//   node scripts/smoke-peers.mjs --phases        # the optional phase names
import { phaseNames, readReleaseConfig, readReleaseIdentity, smokePeerSpecs } from "./release-identity.mjs";

const args = process.argv.slice(2);
const { packageJson } = await readReleaseIdentity();
const config = await readReleaseConfig();
if (args.length === 1 && args[0] === "--phases") {
  for (const name of phaseNames(config)) console.log(name);
} else if (args.length === 0 || (args.length === 2 && args[0] === "--phase")) {
  for (const { spec } of smokePeerSpecs(packageJson, config, args[1] ?? "base")) console.log(spec);
} else {
  throw new Error("usage: smoke-peers.mjs [--phase <name> | --phases]");
}
