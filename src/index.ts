// @scshafe/switchyard-postgres — PostgreSQL stores for @scshafe/switchyard.

import { PostgresGraphStore } from "./graph-store.js";
import { PostgresHumanDecisions } from "./human-decisions.js";
import type { PgPool } from "./pg.js";
import { PostgresUnitStore, type PostgresUnitStoreOptions } from "./unit-store.js";

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
export {
  PostgresGraphStore,
  loadGraphOnClient,
  type PostgresGraphStoreOptions
} from "./graph-store.js";
export {
  PostgresUnitStore,
  type PostgresUnitStoreCheckpointContext,
  type PostgresUnitStoreOptions,
  type SettlePhase
} from "./unit-store.js";
export {
  HumanTurnNotPendingError,
  InvalidHumanAnswerError,
  MAX_HUMAN_DECISION_PAGE,
  PostgresHumanDecisions,
  type HumanDecisionRecord,
  type HumanTurnSelector,
  type ListHumanDecisionsInput,
  type ListPendingHumanTurnsInput,
  type PendingHumanTurn,
  type PostgresHumanDecisionsOptions,
  type RecordHumanAnswerInput,
  type RecordHumanDecisionInput,
  type RecordedHumanAnswer,
  type RecordedHumanDecision
} from "./human-decisions.js";

export interface PostgresStores {
  readonly graphStore: PostgresGraphStore;
  readonly unitStore: PostgresUnitStore;
  readonly humanDecisions: PostgresHumanDecisions;
}

export interface CreatePostgresStoresOptions
  extends Omit<PostgresUnitStoreOptions, "pool" | "schema"> {
  readonly pool: PgPool;
  readonly schema?: string;
}

/** The three stores over one pool and schema. */
export function createPostgresStores(options: CreatePostgresStoresOptions): PostgresStores {
  const { pool, schema, ...unitOptions } = options;
  const graphStore = new PostgresGraphStore({ pool, ...(schema === undefined ? {} : { schema }) });
  const unitStore = new PostgresUnitStore({
    pool,
    ...(schema === undefined ? {} : { schema }),
    ...unitOptions
  });
  const humanDecisions = new PostgresHumanDecisions({
    pool,
    schema: unitStore.schema,
    unitStore,
    ...(unitOptions.now === undefined ? {} : { now: unitOptions.now })
  });
  return Object.freeze({ graphStore, unitStore, humanDecisions });
}
