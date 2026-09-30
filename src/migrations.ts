// migrations.ts — versioned, checksummed schema migrations and grants.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";

import { checkout, pgErrorCode, type PgClient, type PgPool } from "./pg.js";
import {
  DEFAULT_SCHEMA,
  SwitchyardPostgresConfigError,
  defaultRoleNames,
  qualified,
  quoteIdentifier,
  renderMigrationSql,
  validateRoleName,
  validateSchemaName,
  type SwitchyardRoleNames
} from "./schema.js";

export interface MigrationDescriptor {
  readonly version: number;
  readonly name: string;
  /** File name under the package's sql/ directory. */
  readonly file: string;
  /** SHA-256 of the file's template bytes (before schema substitution). */
  readonly checksum: string;
}

/**
 * The ordered migration manifest. Applied migrations are immutable: a
 * released file never changes, and a new behaviour is a new version.
 */
export const MIGRATIONS: readonly MigrationDescriptor[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "engine_schema",
    file: "001_engine_schema.sql",
    checksum: "f01a0da1e3827129fcecb371527554ceee8624b72caaffcc58feda111ba25710"
  }),
  Object.freeze({
    version: 2,
    name: "store_routines",
    file: "002_store_routines.sql",
    checksum: "096b6ee8a0f37f8a9946e8add8f0cd3f4b16fbab9f42951b2a7984b38bd4b57a"
  }),
  Object.freeze({
    version: 3,
    name: "human_decisions_and_views",
    file: "003_human_decisions_and_views.sql",
    checksum: "d4cfee7bd82ff2496e00b1df43b77ecc10360a36cb40e68ee6b218da54e8337f"
  })
]);

export const LATEST_MIGRATION_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Routines the runtime role may execute, by the migration that adds them. */
const RUNTIME_ROUTINES: readonly { readonly since: number; readonly signature: string }[] = [
  { since: 2, signature: "publish_graph(text, bigint, text, text, jsonb)" },
  { since: 2, signature: "load_graph(text, bigint)" },
  {
    since: 2,
    signature: "begin_unit_operation(text, text, text, text, text, text, text, text, timestamptz)"
  },
  {
    since: 2,
    signature: "apply_unit_delta(text, text, text, text, text, text, text, text, timestamptz)"
  },
  { since: 2, signature: "has_claimable_worker_turns(text, text)" },
  { since: 3, signature: "list_pending_human_turns(text, text, text, bigint, integer)" },
  { since: 3, signature: "inspect_pending_human_turn(uuid)" },
  { since: 3, signature: "list_human_decisions(text, bigint, integer)" }
];

const SQL_DIRECTORY = new URL("../sql/", import.meta.url);

export class MigrationError extends Error {
  readonly code = "switchyard_postgres_migration";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export interface LoadedMigration extends MigrationDescriptor {
  readonly template: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Read every migration template and prove it matches the pinned checksum. */
export async function loadMigrations(): Promise<readonly LoadedMigration[]> {
  return Promise.all(MIGRATIONS.map(async (migration) => {
    const template = await readFile(new URL(migration.file, SQL_DIRECTORY), "utf8");
    const actual = sha256(template);
    if (actual !== migration.checksum) {
      throw new MigrationError(
        `migration ${migration.file} does not match its pinned checksum (${actual} != ${migration.checksum})`
      );
    }
    return Object.freeze({ ...migration, template });
  }));
}

export interface MigrationConnectionOptions {
  /** An existing pool; the caller keeps ownership. */
  readonly pool?: PgPool;
  /** Used when no pool is given; a one-connection pool is opened and closed. */
  readonly connectionString?: string;
  /** Schema to create and migrate. Default "switchyard". */
  readonly schema?: string;
}

export interface MigrateOptions extends MigrationConnectionOptions {
  /**
   * Least-privilege roles to grant. Default: `<schema>_runtime` (EXECUTE on
   * the store routines only) and `<schema>_reader` (SELECT on tables and
   * views). `false` skips grants: only the schema owner can use the store.
   */
  readonly roles?: false | Partial<SwitchyardRoleNames>;
  /** Create missing roles as NOLOGIN (needs CREATEROLE). Default true. */
  readonly createRoles?: boolean;
  /** Stop after this version. Default: the latest. */
  readonly targetVersion?: number;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrateResult {
  readonly schema: string;
  /** Versions applied by this call, in order (empty when already current). */
  readonly applied: readonly number[];
  readonly currentVersion: number;
  /** Roles granted by this call, or null when grants were skipped. */
  readonly roles: SwitchyardRoleNames | null;
}

export interface MigrationStatus {
  readonly schema: string;
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationDescriptor[];
  readonly currentVersion: number;
}

async function withMigrationClient<T>(
  options: MigrationConnectionOptions,
  operation: (client: PgClient) => Promise<T>
): Promise<T> {
  if (options.pool !== undefined) {
    const lease = await checkout(options.pool);
    try {
      return await operation(lease.client);
    } finally {
      lease.release();
    }
  }
  const connectionString = options.connectionString;
  if (typeof connectionString !== "string" || connectionString.trim().length === 0) {
    throw new SwitchyardPostgresConfigError("migrate requires a pool or a connectionString");
  }
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    application_name: "switchyard-postgres-migrate"
  });
  pool.on("error", () => undefined);
  try {
    const lease = await checkout(pool);
    try {
      return await operation(lease.client);
    } finally {
      lease.release();
    }
  } finally {
    await pool.end();
  }
}

function lockKey(schema: string): string {
  return `switchyard-postgres:migrate:${schema}`;
}

async function readApplied(client: PgClient, schema: string): Promise<readonly AppliedMigration[]> {
  const exists = await client.query<{ present: boolean }>(
    "SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present",
    [`${quoteIdentifier(schema)}.schema_migrations`]
  );
  if (exists.rows[0]?.present !== true) return [];
  const result = await client.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
  }>(`
    SELECT version, name, checksum, applied_at
    FROM ${qualified(schema, "schema_migrations")}
    ORDER BY version
  `);
  return result.rows.map((row) => Object.freeze({
    version: Number(row.version),
    name: row.name,
    checksum: row.checksum,
    appliedAt: new Date(row.applied_at).toISOString()
  }));
}

function assertAppliedHistory(
  applied: readonly AppliedMigration[],
  migrations: readonly MigrationDescriptor[]
): void {
  for (const row of applied) {
    const known = migrations.find((migration) => migration.version === row.version);
    if (known === undefined) {
      throw new MigrationError(
        `database has migration ${row.version} (${row.name}) which this library does not know; upgrade @scshafe/switchyard-postgres`
      );
    }
    if (known.checksum !== row.checksum || known.name !== row.name) {
      throw new MigrationError(
        `applied migration ${row.version} (${row.name}) differs from this library's ${known.file}; applied migrations are immutable`
      );
    }
  }
  const versions = applied.map((row) => row.version);
  versions.forEach((version, index) => {
    if (version !== index + 1) {
      throw new MigrationError(`applied migrations are not contiguous from 1: ${versions.join(", ")}`);
    }
  });
}

function resolveRoles(schema: string, roles: MigrateOptions["roles"]): SwitchyardRoleNames | null {
  if (roles === false) return null;
  const defaults = defaultRoleNames(schema);
  const runtime = validateRoleName(roles?.runtime ?? defaults.runtime, "roles.runtime");
  const reader = validateRoleName(roles?.reader ?? defaults.reader, "roles.reader");
  if (runtime === reader) {
    throw new SwitchyardPostgresConfigError("roles.runtime and roles.reader must differ");
  }
  return Object.freeze({ runtime, reader });
}

async function ensureRole(client: PgClient, role: string, create: boolean): Promise<void> {
  const found = await client.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS present",
    [role]
  );
  if (found.rows[0]?.present === true) return;
  if (!create) {
    throw new MigrationError(
      `role ${role} does not exist; create it (NOLOGIN) or run migrate with createRoles: true or roles: false`
    );
  }
  try {
    // Two databases in one cluster may migrate concurrently; roles are
    // cluster-wide, so a concurrent creation is not an error.
    await client.query(`
      DO $create_role$
      BEGIN
        CREATE ROLE ${quoteIdentifier(role)} NOLOGIN;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
      END
      $create_role$
    `);
  } catch (error) {
    if (pgErrorCode(error) === "42501") {
      throw new MigrationError(
        `cannot create role ${role} (the migrating user lacks CREATEROLE); create it first, or pass roles: false`,
        { cause: error }
      );
    }
    throw error;
  }
}

async function applyGrants(
  client: PgClient,
  schema: string,
  roles: SwitchyardRoleNames,
  version: number
): Promise<void> {
  const schemaName = quoteIdentifier(schema);
  const runtime = quoteIdentifier(roles.runtime);
  const reader = quoteIdentifier(roles.reader);
  await client.query("BEGIN");
  try {
    await client.query(`REVOKE ALL ON SCHEMA ${schemaName} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schemaName} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schemaName} FROM PUBLIC`);
    await client.query(`GRANT USAGE ON SCHEMA ${schemaName} TO ${runtime}, ${reader}`);
    for (const routine of RUNTIME_ROUTINES) {
      if (routine.since > version) continue;
      await client.query(
        `GRANT EXECUTE ON FUNCTION ${schemaName}.${routine.signature} TO ${runtime}`
      );
    }
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schemaName} TO ${reader}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * Create or upgrade the switchyard schema. Idempotent: an up-to-date schema
 * applies nothing and re-asserts the grants. Each migration runs in its own
 * transaction together with its schema_migrations row; concurrent callers
 * serialize on a session advisory lock. Run it as the role that should own
 * the schema (not as the runtime role).
 */
export async function migrate(options: MigrateOptions = {}): Promise<MigrateResult> {
  const schema = validateSchemaName(options.schema ?? DEFAULT_SCHEMA);
  const roles = resolveRoles(schema, options.roles);
  const migrations = await loadMigrations();
  const target = options.targetVersion ?? LATEST_MIGRATION_VERSION;
  if (!Number.isSafeInteger(target) || target < 1 || target > LATEST_MIGRATION_VERSION) {
    throw new SwitchyardPostgresConfigError(
      `targetVersion must be 1..${LATEST_MIGRATION_VERSION} (got ${String(options.targetVersion)})`
    );
  }

  return withMigrationClient(options, async (client) => {
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1, 0))",
      [lockKey(schema)]
    );
    try {
      await client.query("BEGIN");
      try {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
        await client.query(`REVOKE ALL ON SCHEMA ${quoteIdentifier(schema)} FROM PUBLIC`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${qualified(schema, "schema_migrations")} (
            version integer PRIMARY KEY CHECK (version > 0),
            name text NOT NULL,
            checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
            applied_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
          )
        `);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new MigrationError(`cannot prepare schema ${schema}`, { cause: error });
      }

      const before = await readApplied(client, schema);
      assertAppliedHistory(before, migrations);
      const current = before.length === 0 ? 0 : before[before.length - 1]!.version;
      if (current > target) {
        throw new MigrationError(
          `schema ${schema} is at version ${current}, beyond the requested target ${target}; migrations never run backwards`
        );
      }

      const applied: number[] = [];
      for (const migration of migrations) {
        if (migration.version <= current || migration.version > target) continue;
        await client.query("BEGIN");
        try {
          await client.query(renderMigrationSql(migration.template, schema));
          await client.query(
            `INSERT INTO ${qualified(schema, "schema_migrations")} (version, name, checksum) VALUES ($1, $2, $3)`,
            [migration.version, migration.name, migration.checksum]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw new MigrationError(
            `migration ${migration.version} (${migration.name}) failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
        applied.push(migration.version);
      }
      const currentVersion = applied.length > 0 ? applied[applied.length - 1]! : current;

      if (roles !== null) {
        const create = options.createRoles ?? true;
        await ensureRole(client, roles.runtime, create);
        await ensureRole(client, roles.reader, create);
        await applyGrants(client, schema, roles, currentVersion);
      }

      return Object.freeze({
        schema,
        applied: Object.freeze(applied),
        currentVersion,
        roles
      });
    } finally {
      await client.query(
        "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0))",
        [lockKey(schema)]
      ).catch(() => undefined);
    }
  });
}

/** Report applied and pending migrations without changing anything. */
export async function migrationStatus(
  options: MigrationConnectionOptions = {}
): Promise<MigrationStatus> {
  const schema = validateSchemaName(options.schema ?? DEFAULT_SCHEMA);
  return withMigrationClient(options, async (client) => {
    const applied = await readApplied(client, schema);
    assertAppliedHistory(applied, MIGRATIONS);
    const currentVersion = applied.length === 0 ? 0 : applied[applied.length - 1]!.version;
    return Object.freeze({
      schema,
      applied: Object.freeze(applied),
      pending: Object.freeze(MIGRATIONS.filter((migration) => migration.version > currentVersion)),
      currentVersion
    });
  });
}

/**
 * Throw unless the schema is exactly at the version this library expects.
 * Stores do not migrate on their own; call this at startup to fail fast.
 */
export async function assertSchemaCurrent(options: MigrationConnectionOptions): Promise<void> {
  const status = await migrationStatus(options);
  if (status.currentVersion !== LATEST_MIGRATION_VERSION) {
    throw new MigrationError(
      `schema ${status.schema} is at version ${status.currentVersion}; this library needs ${LATEST_MIGRATION_VERSION} (run switchyard-postgres migrate)`
    );
  }
}
