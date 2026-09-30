// Migrations: fresh database, idempotent re-run, targets, custom schemas,
// history guards, grants and the CLI.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { promisify } from "node:util";

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { createGraphDefinition, graphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import {
  LATEST_MIGRATION_VERSION,
  MIGRATIONS,
  MigrationError,
  PostgresGraphStore,
  PostgresUnitStore,
  SwitchyardPostgresConfigError,
  assertSchemaCurrent,
  loadMigrations,
  migrate,
  migrationStatus
} from "@scshafe/switchyard-postgres";

import {
  closeAdmin,
  ensureLoginRole,
  loginUrl,
  newPool,
  openEmptyDatabase,
  openScenarioDatabase,
  READER_LOGIN,
  RUNTIME_LOGIN
} from "./support/postgres.mjs";

const run = promisify(execFile);
after(closeAdmin);

const TURN = {
  idempotency: "per (unitId, nodeId, attemptNumber)",
  leaseMs: 1_000,
  maxAttempts: 2,
  retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
};

function oneNodeGraph(graphId) {
  return createGraphDefinition({
    graphId,
    version: 1,
    description: `Migration test graph ${graphId}.`,
    entry: "only",
    nodes: [{
      nodeId: "only",
      ref: { id: `${graphId}.only`, version: 1 },
      kind: "code",
      input: "migration-input.v1",
      outcomes: { version: 1, outcomes: ["done"] },
      principal: { id: "worker" },
      turn: TURN
    }],
    edges: [],
    terminals: [{ nodeId: "only", outcome: "done" }]
  });
}

async function tables(pool, schema) {
  const result = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = $1 ORDER BY table_name
  `, [schema]);
  return result.rows.map((row) => row.table_name);
}

// Always through newPool: pool.end() resolves before the backends have
// exited, so the scenario's DROP DATABASE ... WITH (FORCE) can still reach a
// backend of an ended pool. Its FATAL 57P01 arrives as a pool 'error' event,
// which without a listener is an uncaught exception that fails the test.
async function withPool(url, operation, purpose = "extra") {
  const pool = newPool({ connectionString: url, max: 2 }, purpose);
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

test("migration files match the pinned manifest", async () => {
  const loaded = await loadMigrations();
  assert.deepEqual(loaded.map((migration) => migration.version), [1, 2, 3]);
  assert.equal(LATEST_MIGRATION_VERSION, 3);
  for (const migration of MIGRATIONS) {
    const bytes = await readFile(new URL(`../sql/${migration.fileName}`, import.meta.url), "utf8");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), migration.checksum, migration.fileName);
    assert.doesNotMatch(bytes, /\b(email|gmail|mailbox|jobtrack|unsubscribe|substrate|mission_pipeline)\b/i);
  }
});

test("a fresh database migrates to the latest version and a re-run is a no-op", async () => {
  const database = await openEmptyDatabase("mig");
  try {
    const before = await migrationStatus({ pool: database.ownerPool });
    assert.equal(before.currentVersion, 0);
    assert.deepEqual(before.pending.map((migration) => migration.version), [1, 2, 3]);

    const first = await migrate({ pool: database.ownerPool });
    assert.deepEqual(first.applied, [1, 2, 3]);
    assert.equal(first.currentVersion, 3);
    assert.deepEqual(first.roles, { runtime: "switchyard_runtime", reader: "switchyard_reader" });
    assert.deepEqual(await tables(database.ownerPool, "switchyard"), [
      "artifacts", "dead_letters", "fairness_cursors", "graph_nodes", "graphs",
      "human_decisions", "join_progress", "node_definitions", "outbox",
      "pending_human_turns", "schema_migrations", "turn_attempts",
      "turn_completion_cache", "turn_failures", "turn_settlements", "turns",
      "unit_artifacts", "unit_journey", "unit_leases", "unit_queue", "units"
    ]);

    const recorded = await database.ownerPool.query(
      "SELECT version, name, checksum FROM switchyard.schema_migrations ORDER BY version"
    );
    assert.deepEqual(recorded.rows, MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum })));

    const second = await migrate({ pool: database.ownerPool });
    assert.deepEqual(second.applied, []);
    assert.equal(second.currentVersion, 3);
    const third = await migrate({ connectionString: database.url });
    assert.deepEqual(third.applied, []);
    assert.equal((await database.ownerPool.query("SELECT count(*)::int AS n FROM switchyard.schema_migrations")).rows[0].n, 3);

    const after = await migrationStatus({ connectionString: database.url });
    assert.equal(after.currentVersion, 3);
    assert.deepEqual(after.pending, []);
    await assertSchemaCurrent({ pool: database.ownerPool });
  } finally {
    await database.close();
  }
});

test("concurrent migrate calls serialize: one applies, the other finds it current", async () => {
  const database = await openEmptyDatabase("mig");
  try {
    const results = await Promise.all([
      migrate({ connectionString: database.url }),
      migrate({ connectionString: database.url })
    ]);
    const applied = results.map((result) => result.applied.join(",")).sort();
    assert.deepEqual(applied, ["", "1,2,3"]);
  } finally {
    await database.close();
  }
});

test("targetVersion stops early and a later run applies the rest", async () => {
  const database = await openEmptyDatabase("mig");
  try {
    const partial = await migrate({ pool: database.ownerPool, targetVersion: 1 });
    assert.deepEqual(partial.applied, [1]);
    await assert.rejects(assertSchemaCurrent({ pool: database.ownerPool }), MigrationError);
    const rest = await migrate({ pool: database.ownerPool });
    assert.deepEqual(rest.applied, [2, 3]);
    await assert.rejects(migrate({ pool: database.ownerPool, targetVersion: 2 }), /never run backwards/);
    await assert.rejects(migrate({ pool: database.ownerPool, targetVersion: 9 }), SwitchyardPostgresConfigError);
  } finally {
    await database.close();
  }
});

test("edited, unknown or gapped migration history is refused", async () => {
  const database = await openEmptyDatabase("mig");
  try {
    await migrate({ pool: database.ownerPool });
    await database.ownerPool.query(
      "UPDATE switchyard.schema_migrations SET checksum = repeat('0', 64) WHERE version = 2"
    );
    await assert.rejects(migrate({ pool: database.ownerPool }), /differs from this library's 002_store_routines\.sql/);
    await database.ownerPool.query(
      "UPDATE switchyard.schema_migrations SET checksum = $1 WHERE version = 2",
      [MIGRATIONS[1].checksum]
    );
    await database.ownerPool.query(
      "INSERT INTO switchyard.schema_migrations (version, name, checksum) VALUES (99, 'future', repeat('a', 64))"
    );
    await assert.rejects(migrationStatus({ pool: database.ownerPool }), /does not know; upgrade/);
  } finally {
    await database.close();
  }
});

test("schema names are validated and a custom schema coexists with the default", async () => {
  await assert.rejects(migrate({ connectionString: "postgres://unused", schema: "Bad-Name" }), SwitchyardPostgresConfigError);
  await assert.rejects(migrate({ connectionString: "postgres://unused", schema: "pg_things" }), SwitchyardPostgresConfigError);

  const database = await openScenarioDatabase("mig");
  try {
    const custom = await migrate({ pool: database.ownerPool, schema: "sy_custom" });
    assert.deepEqual(custom.applied, [1, 2, 3]);
    assert.deepEqual(custom.roles, { runtime: "sy_custom_runtime", reader: "sy_custom_reader" });
    await ensureLoginRole("sy_test_custom_runtime", "sy_custom_runtime");
    const customLogin = new URL(loginUrl(database.name, RUNTIME_LOGIN));
    customLogin.username = "sy_test_custom_runtime";

    await withPool(customLogin.toString(), async (customPool) => {
      const customGraphs = new PostgresGraphStore({ pool: customPool, schema: "sy_custom" });
      const defaultGraphs = new PostgresGraphStore({ pool: database.runtimePool });
      const graph = oneNodeGraph("migration.custom-schema");
      await customGraphs.publishGraph(graph);
      assert.deepEqual(await customGraphs.loadGraph(graphDefinitionRef(graph)), graph);
      assert.equal(await defaultGraphs.loadGraph(graphDefinitionRef(graph)), undefined);

      const units = new PostgresUnitStore({ pool: customPool, schema: "sy_custom" });
      const admitted = await units.admitUnit({
        unitId: "custom-unit",
        graph: graphDefinitionRef(graph),
        seedArtifact: createArtifactEnvelope("migration-input.v1", { hello: "custom" }),
        admittedAt: new Date().toISOString(),
        principalId: "admitter"
      });
      assert.equal(admitted.created, true);
      // The default schema's runtime role has no authority over sy_custom.
      await assert.rejects(
        database.runtimePool.query("SELECT sy_custom.load_graph('x', 1)"),
        (error) => error.code === "42501"
      );
    }, "custom-runtime");
    const counts = await database.ownerPool.query(`
      SELECT (SELECT count(*) FROM sy_custom.units)::int AS custom_units,
             (SELECT count(*) FROM switchyard.units)::int AS default_units
    `);
    assert.deepEqual(counts.rows[0], { custom_units: 1, default_units: 0 });
  } finally {
    await database.close();
  }
});

test("the runtime role only executes routines and the reader only reads", async () => {
  const database = await openScenarioDatabase("mig");
  try {
    for (const statement of [
      "SELECT * FROM switchyard.units",
      "SELECT * FROM switchyard.turns",
      "INSERT INTO switchyard.graphs (graph_id, graph_version, graph_digest, definition_json) VALUES ('x', 1, repeat('a', 64), '{}')",
      "DELETE FROM switchyard.unit_leases"
    ]) {
      await assert.rejects(database.runtimePool.query(statement), (error) => error.code === "42501", statement);
    }
    const loaded = await database.runtimePool.query("SELECT * FROM switchyard.load_graph('missing', 1)");
    assert.equal(loaded.rows.length, 0);

    const readable = await database.readerPool.query(
      "SELECT (SELECT count(*) FROM switchyard.units)::int AS units, (SELECT count(*) FROM switchyard.human_decisions)::int AS decisions"
    );
    assert.deepEqual(readable.rows[0], { units: 0, decisions: 0 });
    await assert.rejects(
      database.readerPool.query("SELECT switchyard.begin_unit_operation('read_unit', NULL, 'u', NULL, NULL, NULL, NULL, NULL, now())"),
      (error) => error.code === "42501"
    );
    await assert.rejects(
      database.readerPool.query("INSERT INTO switchyard.fairness_cursors VALUES ('a', 'b', 1, 'c', 1, repeat('a', 64), now())"),
      (error) => error.code === "42501"
    );
  } finally {
    await database.close();
  }
});

test("evidence is append-only even for the schema owner", async () => {
  const database = await openScenarioDatabase("mig");
  try {
    const graphs = new PostgresGraphStore({ pool: database.runtimePool });
    await graphs.publishGraph(oneNodeGraph("migration.append-only"));
    for (const statement of [
      "UPDATE switchyard.graphs SET published_at = now()",
      "DELETE FROM switchyard.graph_nodes",
      "TRUNCATE switchyard.node_definitions CASCADE"
    ]) {
      await assert.rejects(database.ownerPool.query(statement), (error) => error.code === "55000", statement);
    }
  } finally {
    await database.close();
  }
});

test("roles: false skips grants, leaving the store to the owner", async () => {
  const database = await openEmptyDatabase("mig");
  try {
    const result = await migrate({ pool: database.ownerPool, schema: "owner_only", roles: false });
    assert.equal(result.roles, null);
    const graphs = new PostgresGraphStore({ pool: database.ownerPool, schema: "owner_only" });
    const graph = oneNodeGraph("migration.owner-only");
    await graphs.publishGraph(graph);
    assert.deepEqual(await graphs.loadGraph(graphDefinitionRef(graph)), graph);
    const grants = await database.ownerPool.query(`
      SELECT count(*)::int AS n FROM information_schema.role_routine_grants
      WHERE routine_schema = 'owner_only' AND grantee <> current_user
    `);
    assert.equal(grants.rows[0].n, 0);
    await assert.rejects(
      migrate({ pool: database.ownerPool, schema: "owner_only", roles: { runtime: "sy_never_created" }, createRoles: false }),
      /role sy_never_created does not exist/
    );
  } finally {
    await database.close();
  }
});

test("the CLI migrates and reports status as JSON", async () => {
  const database = await openEmptyDatabase("cli");
  const cli = new URL("../lib/cli.js", import.meta.url).pathname;
  try {
    const env = { ...process.env, SWITCHYARD_DATABASE_URL: database.url };
    const status = JSON.parse((await run(process.execPath, [cli, "status", "--schema", "cli_schema"], { env })).stdout);
    assert.equal(status.currentVersion, 0);
    assert.equal(status.pending.length, 3);
    const migrated = JSON.parse((await run(process.execPath, [cli, "migrate", "--schema", "cli_schema", "--no-roles"], { env })).stdout);
    assert.deepEqual(migrated.applied, [1, 2, 3]);
    assert.equal(migrated.roles, null);
    const again = JSON.parse((await run(process.execPath, [cli, "migrate", "--url", database.url, "--schema", "cli_schema", "--no-roles"])).stdout);
    assert.deepEqual(again.applied, []);
    await assert.rejects(run(process.execPath, [cli, "frobnicate"], { env }), (error) => error.code === 2);
    await assert.rejects(
      run(process.execPath, [cli, "migrate", "--schema", "Nope"], { env }),
      (error) => error.code === 1 && /schema must match/.test(error.stderr)
    );
  } finally {
    await database.close();
  }
});

test("the reader login used by the tests cannot write", async () => {
  // Guard for the harness itself: conformance evidence is read by this login.
  const database = await openScenarioDatabase("mig");
  try {
    const whoami = await database.readerPool.query("SELECT current_user AS user");
    assert.equal(whoami.rows[0].user, READER_LOGIN);
    await assert.rejects(
      database.readerPool.query("INSERT INTO switchyard.schema_migrations VALUES (50, 'x', repeat('a', 64))"),
      (error) => error.code === "42501"
    );
  } finally {
    await database.close();
  }
});
