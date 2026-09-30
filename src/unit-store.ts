// unit-store.ts — PostgreSQL implementation of switchyard's UnitStore.
//
// Every method runs one SERIALIZABLE transaction that (1) reads the scoped,
// normalized state of the units the operation can touch (begin_unit_operation,
// which also takes the schema's operation lock), (2) replays the operation in
// the engine's own MemoryUnitStore hydrated from that state, and (3) appends
// the resulting delta (apply_unit_delta) before COMMIT. The engine therefore
// owns every semantic rule — routing, joins, envelopes, retries, fencing,
// fairness — and this adapter owns durability and atomicity. A settle writes
// its delta in the engine's named checkpoint phases, all inside the one
// transaction, so a crash at any checkpoint leaves either nothing or all.

import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

import type { ArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { canonicalJson } from "@scshafe/switchyard/contracts/digest";
import type { GraphDefinition, GraphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import {
  TurnLeaseLostError,
  type CacheTurnCompletionInput,
  type CacheTurnCompletionResult,
  type ClaimExternalUnitTurnInput,
  type ClaimUnitTurnsInput,
  type ClaimedUnitTurn,
  type ExternalUnitTurnClaimResult,
  type ExternalUnitTurnInspection,
  type HeartbeatTurnInput,
  type InspectExternalUnitTurnInput,
  type PrepareTurnAttemptInput,
  type RecordTurnFailureInput,
  type RecordTurnFailureResult,
  type SettleTurnInput,
  type SettleTurnResult,
  type TurnAttemptPreparation,
  type TurnOutboxEvents
} from "@scshafe/switchyard/execute/unit-runner";
import {
  GraphLoadDigestConflictError,
  type GraphStore
} from "@scshafe/switchyard/store/graph-store";
import {
  MemoryUnitStore,
  type MemoryUnitStoreStateSnapshot
} from "@scshafe/switchyard/store/memory-unit-store";
import {
  SETTLE_TRANSACTION_CHECKPOINTS,
  type AdmitUnitInput,
  type AdmitUnitResult,
  type GetArtifactInput,
  type JoinProgress,
  type ListQueuedUnitsInput,
  type ListUnitEvidenceInput,
  type QueuedUnit,
  type ReadJoinProgressInput,
  type ReadJourneyInput,
  type ReadUnitInput,
  type SettleTransactionCheckpoint,
  type SwitchyardUnit,
  type UnitDeadLetterRecord,
  type UnitJourneyRecord,
  type UnitOutboxEventRecord,
  type UnitStore
} from "@scshafe/switchyard/store/unit-store";

import { loadGraphOnClient } from "./graph-store.js";
import {
  isPgLeaseLost,
  isPgRetryableBeforeCommit,
  withClient,
  type PgClient,
  type PgPool
} from "./pg.js";
import { DEFAULT_SCHEMA, qualified, validateSchemaName } from "./schema.js";
import {
  decodePostgresUnitStateSnapshot,
  diffPostgresUnitState,
  encodePostgresUnitStateDelta,
  type EncodedPostgresUnitStateDelta
} from "./unit-state.js";

type UnitOperation =
  | "admit"
  | "read_unit"
  | "read_journey"
  | "read_join"
  | "read_artifact"
  | "list_queue"
  | "claim_worker"
  | "inspect_external"
  | "claim_external"
  | "heartbeat"
  | "prepare_attempt"
  | "cache_completion"
  | "record_failure"
  | "settle"
  | "list_outbox"
  | "list_dead_letters";

interface OperationScope {
  readonly operation: UnitOperation;
  readonly queueId?: string;
  readonly unitId?: string;
  readonly nodeId?: string;
  readonly principalId?: string;
  readonly leaseToken?: string;
  readonly artifactContractId?: string;
  readonly artifactDigest?: string;
}

export type SettlePhase = Exclude<SettleTransactionCheckpoint, "post_commit_reply">;

export interface PostgresUnitStoreCheckpointContext {
  /** Backend process id of the settle transaction (for crash testing). */
  readonly backendPid: number;
}

export interface PostgresUnitStoreOptions {
  readonly pool: PgPool;
  /** Schema created by migrate(). Default "switchyard". */
  readonly schema?: string;
  /** Engine clock. Default: the system clock. */
  readonly now?: () => Date;
  /** Queue, lease, outbox and dead-letter ids. Must return UUIDs. */
  readonly idFactory?: (kind: "queue" | "lease" | "outbox" | "dead-letter") => string;
  /**
   * Test hook called after each settle phase is written (pre-commit) and after
   * COMMIT ("post_commit_reply"). Throwing before commit rolls the settle back.
   */
  readonly settleCheckpoint?: (
    checkpoint: SettleTransactionCheckpoint,
    context: PostgresUnitStoreCheckpointContext
  ) => void | Promise<void>;
  /** Pre-commit retries on serialization/lock/timeout errors. Default 96. */
  readonly maxSerializationAttempts?: number;
}

const PRE_COMMIT_SETTLE_PHASES = SETTLE_TRANSACTION_CHECKPOINTS.filter(
  (checkpoint): checkpoint is SettlePhase => checkpoint !== "post_commit_reply"
);

const EMPTY_DELTA: EncodedPostgresUnitStateDelta = Object.freeze({
  unitGraphs: [],
  units: [],
  artifacts: [],
  queues: [],
  journey: [],
  joins: [],
  attempts: [],
  cachedCompletions: [],
  failures: [],
  settlements: [],
  outbox: [],
  deadLetters: [],
  leaseUpserts: [],
  leaseDeletes: [],
  fairnessUpserts: []
});

function emptyDelta(delta: EncodedPostgresUnitStateDelta): boolean {
  return Object.values(delta).every((value) => Array.isArray(value) && value.length === 0);
}

function phaseDelta(
  delta: EncodedPostgresUnitStateDelta,
  phase: SettlePhase
): EncodedPostgresUnitStateDelta {
  switch (phase) {
    case "journey_append":
      return { ...EMPTY_DELTA, journey: delta.journey, settlements: delta.settlements };
    case "artifact_retain":
      return { ...EMPTY_DELTA, artifacts: delta.artifacts };
    case "edge_evaluation":
      return EMPTY_DELTA;
    case "join_progress":
      return { ...EMPTY_DELTA, joins: delta.joins };
    case "successor_enqueue":
      return { ...EMPTY_DELTA, queues: delta.queues };
    case "outbox_append":
      return { ...EMPTY_DELTA, outbox: delta.outbox };
    case "lease_release":
      return { ...EMPTY_DELTA, leaseUpserts: delta.leaseUpserts, leaseDeletes: delta.leaseDeletes };
  }
}

function assertSettleOnlyDelta(delta: EncodedPostgresUnitStateDelta): void {
  const forbidden = [
    ["unitGraphs", delta.unitGraphs],
    ["units", delta.units],
    ["attempts", delta.attempts],
    ["cachedCompletions", delta.cachedCompletions],
    ["failures", delta.failures],
    ["deadLetters", delta.deadLetters],
    ["fairnessUpserts", delta.fairnessUpserts]
  ] as const;
  const changed = forbidden.filter(([, rows]) => rows.length > 0).map(([name]) => name);
  if (changed.length > 0) {
    throw new Error(`PostgresUnitStore settle produced forbidden state classes: ${changed.join(", ")}`);
  }
}

/** 20 ms growing to 1 s, plus up to 200 ms of jitter. */
function retryBackoffMs(attempt: number): number {
  return Math.min(1_000, 20 * attempt) + Math.floor(Math.random() * 200);
}

function operationInstant(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("PostgresUnitStore clock must return a valid Date");
  }
  return new Date(value.getTime());
}

function parseStateBundle(value: unknown): unknown {
  if (typeof value !== "string") {
    throw new Error("begin_unit_operation must return one text state bundle");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("begin_unit_operation returned malformed state JSON", { cause: error });
  }
}

/**
 * Read-only GraphStore over the operation's own transaction, with a
 * process-wide cache of immutable sealed graphs. It keeps admission from
 * needing a second pooled connection.
 */
class TransactionGraphReader implements GraphStore {
  readonly #client: PgClient;
  readonly #schema: string;
  readonly #cache: Map<string, GraphDefinition>;

  constructor(client: PgClient, schema: string, cache: Map<string, GraphDefinition>) {
    this.#client = client;
    this.#schema = schema;
    this.#cache = cache;
  }

  async publishGraph(): Promise<void> {
    throw new Error("PostgresUnitStore reads graphs only; publish with PostgresGraphStore");
  }

  async loadGraph(ref: GraphDefinitionRef): Promise<GraphDefinition | undefined> {
    const key = `${ref.id}\u0000${ref.version}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      if (cached.graphDigest !== ref.digest) {
        throw new GraphLoadDigestConflictError(ref.id, ref.version, cached.graphDigest, ref.digest);
      }
      return cached;
    }
    const graph = await loadGraphOnClient(this.#client, this.#schema, ref);
    if (graph !== undefined) this.#cache.set(key, graph);
    return graph;
  }
}

/** Durable switchyard UnitStore backed by PostgreSQL. */
export class PostgresUnitStore implements UnitStore {
  readonly schema: string;
  readonly #pool: PgPool;
  readonly #now: () => Date;
  readonly #idFactory: NonNullable<PostgresUnitStoreOptions["idFactory"]>;
  readonly #settleCheckpoint: PostgresUnitStoreOptions["settleCheckpoint"];
  readonly #maxAttempts: number;
  readonly #graphs = new Map<string, GraphDefinition>();
  readonly #routines: {
    readonly begin: string;
    readonly apply: string;
    readonly claimable: string;
  };

  constructor(options: PostgresUnitStoreOptions) {
    this.#pool = options.pool;
    this.schema = validateSchemaName(options.schema ?? DEFAULT_SCHEMA);
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#settleCheckpoint = options.settleCheckpoint;
    const attempts = options.maxSerializationAttempts ?? 96;
    if (!Number.isSafeInteger(attempts) || attempts < 1) {
      throw new Error("maxSerializationAttempts must be a positive integer");
    }
    this.#maxAttempts = attempts;
    this.#routines = Object.freeze({
      begin: qualified(this.schema, "begin_unit_operation"),
      apply: qualified(this.schema, "apply_unit_delta"),
      claimable: qualified(this.schema, "has_claimable_worker_turns")
    });
  }

  async #begin(
    client: PgClient,
    scope: OperationScope,
    at: string
  ): Promise<MemoryUnitStoreStateSnapshot> {
    const result = await client.query<{ state_bundle: string }>(`
      SELECT ${this.#routines.begin}(
        $1::text, $2::text, $3::text, $4::text, $5::text,
        $6::text, $7::text, $8::text, $9::timestamptz
      ) AS state_bundle
    `, [
      scope.operation,
      scope.queueId ?? null,
      scope.unitId ?? null,
      scope.nodeId ?? null,
      scope.principalId ?? null,
      scope.leaseToken ?? null,
      scope.artifactContractId ?? null,
      scope.artifactDigest ?? null,
      at
    ]);
    if (result.rows.length !== 1) {
      throw new Error(`begin_unit_operation must return one row (got ${result.rows.length})`);
    }
    return decodePostgresUnitStateSnapshot(parseStateBundle(result.rows[0]!.state_bundle));
  }

  async #apply(
    client: PgClient,
    scope: OperationScope,
    phase: SettlePhase | "atomic",
    at: string,
    delta: EncodedPostgresUnitStateDelta
  ): Promise<void> {
    await client.query(`
      SELECT ${this.#routines.apply}(
        $1::text, $2::text, $3::text, $4::text, $5::text,
        $6::text, $7::text, $8::text, $9::timestamptz
      )
    `, [
      scope.operation,
      scope.queueId ?? null,
      scope.unitId ?? null,
      scope.nodeId ?? null,
      scope.principalId ?? null,
      scope.leaseToken ?? null,
      phase,
      canonicalJson(delta),
      at
    ]);
  }

  async #run<T>(
    scope: OperationScope,
    operation: (store: MemoryUnitStore) => Promise<T>,
    options: { readonly settle?: boolean } = {}
  ): Promise<T> {
    const instant = operationInstant(this.#now);
    const at = instant.toISOString();
    let lastRetryable: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const client = await this.#pool.connect();
      let committed = false;
      let released = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        let backendPid = -1;
        if (options.settle === true && this.#settleCheckpoint !== undefined) {
          const pid = await client.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid");
          backendPid = Number(pid.rows[0]?.pid ?? -1);
        }
        const before = await this.#begin(client, scope, at);
        const store = new MemoryUnitStore({
          graphStore: new TransactionGraphReader(client, this.schema, this.#graphs),
          now: () => new Date(instant.getTime()),
          idFactory: this.#idFactory,
          initialState: before
        });
        const result = await operation(store);
        const delta = encodePostgresUnitStateDelta(
          diffPostgresUnitState(before, store.stateSnapshot())
        );

        if (options.settle === true) {
          assertSettleOnlyDelta(delta);
          for (const phase of PRE_COMMIT_SETTLE_PHASES) {
            await this.#apply(client, scope, phase, at, phaseDelta(delta, phase));
            await this.#settleCheckpoint?.(phase, { backendPid });
          }
        } else if (!emptyDelta(delta)) {
          await this.#apply(client, scope, "atomic", at, delta);
        }

        await client.query("COMMIT");
        committed = true;
        client.release();
        released = true;
        if (options.settle === true) {
          await this.#settleCheckpoint?.("post_commit_reply", { backendPid });
        }
        return result;
      } catch (error) {
        if (!committed) {
          const rolledBack = await client.query("ROLLBACK").then(() => true, () => false);
          if (!released) {
            // A connection that could not roll back is discarded, not reused.
            client.release(rolledBack ? undefined : true);
            released = true;
          }
        }
        if (!committed && isPgRetryableBeforeCommit(error) && attempt < this.#maxAttempts) {
          lastRetryable = error;
          await delay(retryBackoffMs(attempt));
          continue;
        }
        if (scope.queueId !== undefined && isPgLeaseLost(error)) {
          throw new TurnLeaseLostError(scope.queueId);
        }
        throw error;
      } finally {
        if (!released) client.release();
      }
    }
    throw new Error("PostgresUnitStore serialization retry budget exhausted", {
      cause: lastRetryable
    });
  }

  admitUnit(input: AdmitUnitInput): Promise<AdmitUnitResult> {
    return this.#run(
      { operation: "admit", unitId: input.unitId, principalId: input.principalId },
      (store) => store.admitUnit(input)
    );
  }

  readUnit(input: ReadUnitInput): Promise<SwitchyardUnit | undefined> {
    return this.#run(
      { operation: "read_unit", unitId: input.unitId },
      (store) => store.readUnit(input)
    );
  }

  readJourney(input: ReadJourneyInput): Promise<readonly UnitJourneyRecord[]> {
    return this.#run(
      { operation: "read_journey", unitId: input.unitId },
      (store) => store.readJourney(input)
    );
  }

  readJoinProgress(input: ReadJoinProgressInput): Promise<JoinProgress | undefined> {
    return this.#run(
      { operation: "read_join", unitId: input.unitId, nodeId: input.nodeId },
      (store) => store.readJoinProgress(input)
    );
  }

  listQueuedUnits(input: ListQueuedUnitsInput): Promise<readonly QueuedUnit[]> {
    return this.#run(
      { operation: "list_queue", nodeId: input.nodeId, principalId: input.principalId },
      (store) => store.listQueuedUnits(input)
    );
  }

  getArtifact(input: GetArtifactInput): Promise<ArtifactEnvelope | undefined> {
    return this.#run(
      {
        operation: "read_artifact",
        artifactContractId: input.artifact.contractId,
        artifactDigest: input.artifact.digest
      },
      (store) => store.getArtifact(input)
    );
  }

  async claimUnitTurns(input: ClaimUnitTurnsInput): Promise<readonly ClaimedUnitTurn[]> {
    if (!(await this.hasClaimableWorkerTurns(input.principalId, input.nodeId))) {
      return Object.freeze([]);
    }
    return this.#run(
      {
        operation: "claim_worker",
        principalId: input.principalId,
        ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId })
      },
      (store) => store.claimUnitTurns(input)
    );
  }

  /**
   * Lock-free, conservative pre-check: false only when no open worker-kind
   * turn exists for this principal (and node). Idle workers poll this instead
   * of entering the serialized claim transaction.
   */
  async hasClaimableWorkerTurns(principalId: string, nodeId?: string): Promise<boolean> {
    try {
      return await withClient(this.#pool, async (client) => {
        const result = await client.query<{ claimable: boolean }>(
          `SELECT ${this.#routines.claimable}($1::text, $2::text) AS claimable`,
          [principalId, nodeId ?? null]
        );
        return result.rows[0]?.claimable !== false;
      });
    } catch (error) {
      if (isPgRetryableBeforeCommit(error)) return true;
      throw error;
    }
  }

  inspectExternalUnitTurn(
    input: InspectExternalUnitTurnInput
  ): Promise<ExternalUnitTurnInspection | undefined> {
    return this.#run(
      {
        operation: "inspect_external",
        queueId: input.queueId,
        unitId: input.unitId,
        nodeId: input.nodeId,
        principalId: input.principalId
      },
      (store) => store.inspectExternalUnitTurn(input)
    );
  }

  claimExternalUnitTurn(
    input: ClaimExternalUnitTurnInput
  ): Promise<ExternalUnitTurnClaimResult | undefined> {
    return this.#run(
      {
        operation: "claim_external",
        queueId: input.queueId,
        unitId: input.unitId,
        nodeId: input.nodeId,
        principalId: input.principalId
      },
      (store) => store.claimExternalUnitTurn(input)
    );
  }

  heartbeatTurn(input: HeartbeatTurnInput): Promise<void> {
    return this.#run(
      { operation: "heartbeat", queueId: input.queueId, leaseToken: input.leaseToken },
      (store) => store.heartbeatTurn(input)
    );
  }

  prepareTurnAttempt(input: PrepareTurnAttemptInput): Promise<TurnAttemptPreparation> {
    return this.#run(
      {
        operation: "prepare_attempt",
        queueId: input.queueId,
        unitId: input.unitId,
        nodeId: input.nodeId,
        leaseToken: input.leaseToken
      },
      (store) => store.prepareTurnAttempt(input)
    );
  }

  cacheTurnCompletion(input: CacheTurnCompletionInput): Promise<CacheTurnCompletionResult> {
    return this.#run(
      {
        operation: "cache_completion",
        queueId: input.queueId,
        unitId: input.unitId,
        nodeId: input.nodeId,
        leaseToken: input.leaseToken
      },
      (store) => store.cacheTurnCompletion(input)
    );
  }

  recordTurnFailure(
    input: RecordTurnFailureInput,
    outbox?: TurnOutboxEvents
  ): Promise<RecordTurnFailureResult> {
    return this.#run(
      {
        operation: "record_failure",
        queueId: input.queueId,
        unitId: input.unitId,
        nodeId: input.nodeId,
        principalId: input.principalId,
        leaseToken: input.leaseToken
      },
      (store) => store.recordTurnFailure(input, outbox)
    );
  }

  settleTurn(input: SettleTurnInput, outbox?: TurnOutboxEvents): Promise<SettleTurnResult> {
    return this.#run(
      {
        operation: "settle",
        queueId: input.queueId,
        unitId: input.unitId,
        nodeId: input.nodeId,
        principalId: input.principalId,
        leaseToken: input.leaseToken
      },
      (store) => store.settleTurn(input, outbox),
      { settle: true }
    );
  }

  listOutboxEvents(input?: ListUnitEvidenceInput): Promise<readonly UnitOutboxEventRecord[]> {
    return this.#run(
      {
        operation: "list_outbox",
        ...(input?.unitId === undefined ? {} : { unitId: input.unitId })
      },
      (store) => store.listOutboxEvents(input)
    );
  }

  listDeadLetters(input?: ListUnitEvidenceInput): Promise<readonly UnitDeadLetterRecord[]> {
    return this.#run(
      {
        operation: "list_dead_letters",
        ...(input?.unitId === undefined ? {} : { unitId: input.unitId })
      },
      (store) => store.listDeadLetters(input)
    );
  }
}
