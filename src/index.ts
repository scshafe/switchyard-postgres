// @scshafe/switchyard-postgres — PostgreSQL stores for @scshafe/switchyard.

export {
  DEFAULT_SCHEMA,
  SwitchyardPostgresConfigError,
  defaultRoleNames,
  validateSchemaName,
  type SwitchyardRoleNames
} from "./schema.js";
export type { PgClient, PgPool, PgQueryResult, PgRow } from "./pg.js";
export {
  LATEST_MIGRATION_VERSION,
  MIGRATIONS,
  MigrationError,
  assertSchemaCurrent,
  loadMigrations,
  migrate,
  migrationStatus,
  type AppliedMigration,
  type LoadedMigration,
  type MigrateOptions,
  type MigrateResult,
  type MigrationConnectionOptions,
  type MigrationDescriptor,
  type MigrationStatus
} from "./migrations.js";
