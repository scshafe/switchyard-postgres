// Pin each sql/ migration's SHA-256 into src/migrations.ts. Run after editing
// an UNRELEASED migration; released migrations never change (add a new one).

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const source = new URL("../src/migrations.ts", import.meta.url);
let text = await readFile(source, "utf8");
const entries = [...text.matchAll(/fileName: "([^"]+\.sql)",\n\s+checksum: "([^"]+)"/g)];
if (entries.length === 0) throw new Error("no migration entries found in src/migrations.ts");
for (const [, file, pinned] of entries) {
  const bytes = await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8");
  const actual = createHash("sha256").update(bytes, "utf8").digest("hex");
  if (actual !== pinned) {
    text = text.replace(`fileName: "${file}",\n    checksum: "${pinned}"`, `fileName: "${file}",\n    checksum: "${actual}"`);
    console.log(`${file}: ${actual}`);
  }
}
await writeFile(source, text);
