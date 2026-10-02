// Packed-install CLI smoke: the package's bin is linked into the consumer
// (scripts/check-pack-install.mjs runs this with the consumer as the working
// directory) and prints its usage.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const bin = join(process.cwd(), "node_modules/.bin/switchyard-postgres");
const help = execFileSync(bin, ["--help"], { encoding: "utf8" });
if (!help.includes("usage: switchyard-postgres <migrate|status>")) {
  throw new Error("switchyard-postgres bin did not print its usage");
}
console.log("switchyard-postgres CLI smoke passed.");
