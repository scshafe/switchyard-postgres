// @scshafe/switchyard-postgres — PostgreSQL stores for @scshafe/switchyard.

import pg from "pg";

import { PostgresGraphStore } from "./graph-store.js";
import { PostgresHumanDecisions } from "./human-decisions.js";
import type { PgPool } from "./pg.js";
import { SwitchyardPostgresConfigError } from "./schema.js";
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
  /** The pool the stores use: the caller's, or the one opened from `connectionString`. */
  readonly pool: PgPool;
  /**
   * Close the pool opened from `connectionString`. A caller's own `pool` is
   * left open (the caller owns it), so this is then a no-op.
   */
  close(): Promise<void>;
}

export interface CreatePostgresStoresOptions
  extends Omit<PostgresUnitStoreOptions, "pool" | "schema"> {
  /** An existing pool (e.g. a `pg.Pool`); the caller keeps ownership. */
  readonly pool?: PgPool;
  /**
   * Instead of `pool`: open a `pg.Pool` for this URL. The stores own it;
   * call `close()` on shutdown.
   */
  readonly connectionString?: string;
  /** Maximum connections of the pool opened from `connectionString`. Default 10. */
  readonly maxConnections?: number;
  /**
   * Called when an idle client of the pool opened from `connectionString`
   * fails (pg's pool 'error' event). The pool replaces the client either way.
   * Default: ignore.
   */
  readonly onPoolError?: (error: Error) => void;
  readonly schema?: string;
}

function openOwnedPool(options: CreatePostgresStoresOptions): pg.Pool {
  const { connectionString, maxConnections, onPoolError } = options;
  if (typeof connectionString !== "string" || connectionString.trim().length === 0) {
    throw new SwitchyardPostgresConfigError("createPostgresStores requires a pool or a connectionString");
  }
  if (maxConnections !== undefined && (!Number.isSafeInteger(maxConnections) || maxConnections < 1)) {
    throw new SwitchyardPostgresConfigError("maxConnections must be a positive integer");
  }
  const pool = new pg.Pool({
    connectionString,
    max: maxConnections ?? 10,
    application_name: "switchyard-postgres"
  });
  pool.on("error", onPoolError ?? (() => undefined));
  return pool;
}

/**
 * The three stores over one pool and schema. Pass your own `pool`, or a
 * `connectionString` for a pool the stores open and `close()` ends.
 */
export function createPostgresStores(options: CreatePostgresStoresOptions): PostgresStores {
  const {
    pool: givenPool,
    connectionString,
    maxConnections,
    onPoolError,
    schema,
    ...unitOptions
  } = options;
  if (givenPool !== undefined && connectionString !== undefined) {
    throw new SwitchyardPostgresConfigError("createPostgresStores takes a pool or a connectionString, not both");
  }
  if (givenPool !== undefined && (maxConnections !== undefined || onPoolError !== undefined)) {
    throw new SwitchyardPostgresConfigError("maxConnections and onPoolError apply only with a connectionString");
  }
  const owned = givenPool === undefined ? openOwnedPool(options) : undefined;
  const pool: PgPool = givenPool ?? owned!;
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
  let closing: Promise<void> | undefined;
  return Object.freeze({
    graphStore,
    unitStore,
    humanDecisions,
    pool,
    close(): Promise<void> {
      if (owned === undefined) return Promise.resolve();
      closing ??= owned.end();
      return closing;
    }
  });
}
