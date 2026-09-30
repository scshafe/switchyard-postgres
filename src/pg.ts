// pg.ts — the narrow structural surface of `pg` the stores use.
//
// A `pg.Pool` satisfies PgPool and a checked-out `pg.PoolClient` satisfies
// PgClient; declaring the shape here keeps `pg` types out of the public
// declarations and lets tests pass fakes.

export type PgRow = Record<string, unknown>;

export interface PgQueryResult<Row extends PgRow = PgRow> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PgClient {
  query<Row extends PgRow = PgRow>(
    text: string,
    values?: unknown[]
  ): Promise<PgQueryResult<Row>>;
  release(error?: Error | boolean): void;
}

export interface PgPool {
  connect(): Promise<PgClient>;
}

export interface PgErrorShape {
  readonly code?: unknown;
  readonly detail?: unknown;
}

export function pgErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as PgErrorShape).code;
  return typeof code === "string" ? code : undefined;
}

/** The fenced-lease refusal raised by the unit-store routines. */
export function isPgLeaseLost(error: unknown): boolean {
  return pgErrorCode(error) === "P0002"
    && (error as PgErrorShape).detail === "turn_lease_lost";
}

/**
 * Errors raised before COMMIT that leave nothing behind and may be retried:
 * serialization failure, statement timeout, lock not available, deadlock.
 */
export function isPgRetryableBeforeCommit(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === "40001" || code === "40P01" || code === "57014" || code === "55P03";
}

/** Run one operation on one checked-out connection. */
export async function withClient<T>(
  pool: PgPool,
  operation: (client: PgClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

/** Run one operation in one READ COMMITTED transaction. */
export async function inTransaction<T>(
  pool: PgPool,
  operation: (client: PgClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
