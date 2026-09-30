// Test databases on the server named by SWITCHYARD_POSTGRES_TEST_URL.
//
// Each scenario gets its own database, copied from a template that was
// migrated once (per migration-checksum set) under a server-wide advisory
// lock. Stores run as a LOGIN role that is only a member of
// switchyard_runtime, and evidence is read as a member of switchyard_reader,
// so every conformance scenario also exercises the least-privilege grants.

import { createHash, randomBytes } from "node:crypto";

import pg from "pg";

import { MIGRATIONS, migrate } from "@scshafe/switchyard-postgres";

export const URL_ENV = "SWITCHYARD_POSTGRES_TEST_URL";
export const RUNTIME_LOGIN = "sy_test_runtime";
export const READER_LOGIN = "sy_test_reader";
const LOGIN_PASSWORD = "switchyard-test-only";

export function adminUrl(database = "postgres") {
  const raw = process.env[URL_ENV];
  if (raw === undefined || raw.length === 0) {
    throw new Error(`${URL_ENV} is not set; run the tests with \`pnpm test\` (starts PostgreSQL in Docker)`);
  }
  const url = new URL(raw);
  url.pathname = `/${database}`;
  return url.toString();
}

export function loginUrl(database, user) {
  const url = new URL(adminUrl(database));
  url.username = user;
  url.password = LOGIN_PASSWORD;
  return url.toString();
}

function quote(identifier) {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

const templateName = `sy_tpl_${createHash("sha256")
  .update(MIGRATIONS.map((migration) => migration.checksum).join(":"))
  .digest("hex")
  .slice(0, 16)}`;

let adminPool;
function admin() {
  adminPool ??= new pg.Pool({ connectionString: adminUrl(), max: 2 });
  return adminPool;
}

/** Run `operation` holding a server-wide test lock (serializes DDL). */
export async function withServerLock(operation) {
  const client = await admin().connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('switchyard-postgres-test'))");
    try {
      return await operation(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('switchyard-postgres-test'))");
    }
  } finally {
    client.release();
  }
}

async function ensureLogin(client, login, role) {
  await client.query(`
    DO $login$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${login}') THEN
        CREATE ROLE ${quote(login)} LOGIN PASSWORD '${LOGIN_PASSWORD}';
      END IF;
    END
    $login$
  `);
  await client.query(`GRANT ${quote(role)} TO ${quote(login)}`);
}

/** Create a login role that is a member of `role` (for custom-schema tests). */
export async function ensureLoginRole(login, role) {
  await withServerLock((client) => ensureLogin(client, login, role));
}

let templateReady;
async function ensureTemplate() {
  templateReady ??= withServerLock(async (client) => {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [templateName]);
    if (found.rows.length === 0) {
      const building = `${templateName}_building_${randomBytes(3).toString("hex")}`;
      await client.query(`CREATE DATABASE ${quote(building)}`);
      await migrate({ connectionString: adminUrl(building) });
      await client.query(`ALTER DATABASE ${quote(building)} RENAME TO ${quote(templateName)}`);
    }
    await ensureLogin(client, RUNTIME_LOGIN, "switchyard_runtime");
    await ensureLogin(client, READER_LOGIN, "switchyard_reader");
  });
  return templateReady;
}

function scenarioName(prefix) {
  return `sy_${prefix}_${process.pid}_${randomBytes(4).toString("hex")}`.slice(0, 60);
}

async function dropDatabase(name) {
  await admin().query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
}

/**
 * A fresh, migrated database (default schema "switchyard") with pools for the
 * owner (superuser), the runtime login and the reader login.
 */
export async function openScenarioDatabase(prefix = "s") {
  await ensureTemplate();
  const name = scenarioName(prefix);
  await withServerLock((client) =>
    client.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(templateName)}`)
  );
  const pools = {
    ownerPool: new pg.Pool({ connectionString: adminUrl(name), max: 4 }),
    runtimePool: new pg.Pool({ connectionString: loginUrl(name, RUNTIME_LOGIN), max: 4 }),
    readerPool: new pg.Pool({ connectionString: loginUrl(name, READER_LOGIN), max: 2 })
  };
  return {
    name,
    ...pools,
    async close() {
      await Promise.allSettled(Object.values(pools).map((pool) => pool.end()));
      await dropDatabase(name);
    }
  };
}

/** A fresh, empty database (nothing migrated) with an owner pool. */
export async function openEmptyDatabase(prefix = "e") {
  const name = scenarioName(prefix);
  await withServerLock((client) => client.query(`CREATE DATABASE ${quote(name)}`));
  const ownerPool = new pg.Pool({ connectionString: adminUrl(name), max: 4 });
  return {
    name,
    ownerPool,
    url: adminUrl(name),
    async close() {
      await ownerPool.end().catch(() => undefined);
      await dropDatabase(name);
    }
  };
}

export async function closeAdmin() {
  const pool = adminPool;
  adminPool = undefined;
  await pool?.end();
}
