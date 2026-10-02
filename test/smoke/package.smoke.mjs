// Packed-install smoke (scripts/check-pack-install.mjs copies it into an empty
// consumer that installed the packed tarball next to its peer
// @scshafe/switchyard, then runs it there): exports, the shipped SQL against
// the migration manifest, the stores' options, and that the peer resolves.
// (The installed name/version, the unscoped name and the peer as a direct,
// exact dependency are the master script's checks.)
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as api from "@scshafe/switchyard-postgres";
import metadata from "@scshafe/switchyard-postgres/package.json" with { type: "json" };
import { MemoryGraphStore } from "@scshafe/switchyard/store/memory-graph-store";

const installedRoot = dirname(fileURLToPath(import.meta.resolve("@scshafe/switchyard-postgres/package.json")));
const installedSql = readdirSync(join(installedRoot, "sql")).sort();

const loaded = await api.loadMigrations();
if (loaded.length !== api.MIGRATIONS.length || api.LATEST_MIGRATION_VERSION !== loaded.at(-1).version) {
  throw new Error("shipped migrations do not match the manifest");
}
if (JSON.stringify(loaded.map((m) => m.fileName)) !== JSON.stringify(installedSql)) {
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
if (metadata.name !== "@scshafe/switchyard-postgres") throw new Error("package name mismatch");
console.log(`${metadata.name}@${metadata.version} JS smoke passed.`);
