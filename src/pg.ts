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

interface EventfulClient {
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

function isEventful(client: unknown): client is EventfulClient {
  return typeof (client as Partial<EventfulClient>).on === "function"
    && typeof (client as Partial<EventfulClient>).off === "function";
}

/**
 * Keep a lost connection (backend terminated, server restart) from surfacing
 * as an unhandled 'error' event while a client is checked out: pg removes the
 * pool's idle listener on checkout. The failure still reaches the caller
 * through the next query. Returns the detach function.
 */
export function guardCheckedOutClient(client: PgClient): () => void {
  if (!isEventful(client)) return () => undefined;
  const listener = (): void => undefined;
  client.on("error", listener);
  return () => {
    client.off("error", listener);
  };
}

/** Check out a client with the error guard attached. */
export async function checkout(pool: PgPool): Promise<{ client: PgClient; release(destroy?: boolean): void }> {
  const client = await pool.connect();
  const detach = guardCheckedOutClient(client);
  let released = false;
  return {
    client,
    release(destroy = false) {
      if (released) return;
      released = true;
      detach();
      client.release(destroy ? true : undefined);
    }
  };
}

/** Run one operation on one checked-out connection. */
export async function withClient<T>(
  pool: PgPool,
  operation: (client: PgClient) => Promise<T>
): Promise<T> {
  const lease = await checkout(pool);
  try {
    return await operation(lease.client);
  } finally {
    lease.release();
  }
}

/** Run one operation in one READ COMMITTED transaction. */
export async function inTransaction<T>(
  pool: PgPool,
  operation: (client: PgClient) => Promise<T>
): Promise<T> {
  const lease = await checkout(pool);
  const client = lease.client;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    const rolledBack = await client.query("ROLLBACK").then(() => true, () => false);
    lease.release(!rolledBack);
    throw error;
  } finally {
    lease.release();
  }
}
