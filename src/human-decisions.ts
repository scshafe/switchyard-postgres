// human-decisions.ts — record and review decisions at `human` nodes.
//
// A human decision is the settlement of a human node's turn through the
// engine's recordHumanNodeDecision: the engine claims the external turn under
// the node's sealed principal, checks the outcome against the node's closed
// vocabulary (and any declared output contract), settles it with the actor as
// evidence, and routes the unit on. This module adds what a review surface
// needs around that: a pending-turn listing that reads projections instead of
// hydrating the engine, and a decision ledger. Approval and review nodes that
// switchyard compiles from node settings are ordinary human nodes here.

import {
  validateArtifactEnvelope,
  type ArtifactEnvelope
} from "@scshafe/switchyard/contracts/artifact";
import { canonicalJson } from "@scshafe/switchyard/contracts/digest";
import type { GraphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import {
  recordHumanNodeDecision,
  type TurnOutboxEvents,
  type UnitTurnRunResult
} from "@scshafe/switchyard/execute/unit-runner";

import { withClient, type PgPool } from "./pg.js";
import { DEFAULT_SCHEMA, qualified, validateSchemaName } from "./schema.js";
import { PostgresUnitStore, type PostgresUnitStoreOptions } from "./unit-store.js";

export const MAX_HUMAN_DECISION_PAGE = 1_000;

/** One human turn waiting for a decision. */
export interface PendingHumanTurn {
  readonly queueId: string;
  readonly unitId: string;
  readonly graph: GraphDefinitionRef;
  readonly nodeId: string;
  readonly nodeRef: { readonly id: string; readonly version: number };
  /** The node's sealed principal; decisions are recorded under it. */
  readonly principalId: string;
  /** The node's closed outcome vocabulary, in lexical order. */
  readonly outcomes: readonly string[];
  /** Exactly what the reviewer is asked to decide on. */
  readonly inputArtifact: ArtifactEnvelope;
  readonly queuedAt: string;
  readonly enqueueSequence: number;
  /** Set while a decision is being recorded (an external lease is held). */
  readonly claimedBy?: string;
  readonly claimedAt?: string;
}

/** One recorded human decision (a settled human turn). */
export interface HumanDecisionRecord {
  readonly decisionSequence: number;
  readonly queueId: string;
  readonly unitId: string;
  readonly graph: GraphDefinitionRef;
  readonly nodeId: string;
  readonly principalId: string;
  readonly actorId: string;
  readonly outcome: string;
  readonly outputArtifact?: { readonly contractId: string; readonly digest: string };
  readonly startedAt: string;
  readonly settledAt: string;
  readonly settlementDigest: string;
}

export interface ListPendingHumanTurnsInput {
  readonly principalId?: string;
  readonly nodeId?: string;
  readonly graphId?: string;
  /** FIFO cursor: return turns queued after this enqueue sequence. */
  readonly afterEnqueueSequence?: number;
  /** 1..1000, default 100. */
  readonly limit?: number;
}

export interface ListHumanDecisionsInput {
  readonly unitId?: string;
  /** Cursor: return decisions recorded after this decision sequence. */
  readonly afterDecisionSequence?: number;
  /** 1..1000, default 100. */
  readonly limit?: number;
}

export interface RecordHumanDecisionInput {
  readonly queueId: string;
  /** Must be one of the node's outcomes. */
  readonly outcome: string;
  /** Who decided. Evidence only; it grants no authority. */
  readonly actorId: string;
  /** Required when the node declares an output contract for the outcome. */
  readonly outputArtifact?: ArtifactEnvelope;
  readonly outboxEvents?: TurnOutboxEvents;
}

export interface RecordedHumanDecision {
  readonly turn: PendingHumanTurn;
  readonly result: UnitTurnRunResult;
}

export class HumanTurnNotPendingError extends Error {
  readonly code = "human_turn_not_pending";
  readonly queueId: string;

  constructor(queueId: string) {
    super(`human turn ${queueId} is not pending (unknown, already decided, or not a human node)`);
    this.name = "HumanTurnNotPendingError";
    this.queueId = queueId;
  }
}

export interface PostgresHumanDecisionsOptions {
  readonly pool: PgPool;
  readonly schema?: string;
  /** Unit store used to settle decisions. Default: one built from pool/schema/now. */
  readonly unitStore?: PostgresUnitStore;
  readonly now?: () => Date;
}

interface PendingRow extends Record<string, unknown> {
  readonly queue_id: string;
  readonly unit_id: string;
  readonly graph_id: string;
  readonly graph_version: string | number;
  readonly graph_digest: string;
  readonly node_id: string;
  readonly node_ref_id: string;
  readonly node_ref_version: string | number;
  readonly principal_id: string;
  readonly outcomes: unknown;
  readonly input_envelope: string;
  readonly queued_at: Date;
  readonly enqueue_sequence: string | number;
  readonly claimed_by: string | null;
  readonly claimed_at: Date | null;
}

interface DecisionRow extends Record<string, unknown> {
  readonly decision_sequence: string | number;
  readonly queue_id: string;
  readonly unit_id: string;
  readonly graph_id: string;
  readonly graph_version: string | number;
  readonly graph_digest: string;
  readonly node_id: string;
  readonly principal_id: string;
  readonly actor_id: string | null;
  readonly outcome: string;
  readonly output_contract_id: string | null;
  readonly output_artifact_digest: string | null;
  readonly started_at: Date;
  readonly settled_at: Date;
  readonly settlement_digest: string;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a safe positive integer`);
  }
  return parsed;
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HUMAN_DECISION_PAGE) {
    throw new RangeError(`limit must be an integer 1..${MAX_HUMAN_DECISION_PAGE}`);
  }
  return limit;
}

function optionalCursor(value: number | undefined, label: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function iso(value: Date): string {
  return new Date(value).toISOString();
}

function pendingTurn(row: PendingRow): PendingHumanTurn {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.input_envelope) as unknown;
  } catch (error) {
    throw new Error(`pending human turn ${row.queue_id} has malformed input JSON`, { cause: error });
  }
  if (canonicalJson(parsed) !== row.input_envelope) {
    throw new Error(`pending human turn ${row.queue_id} input is not canonical JSON`);
  }
  const outcomes = row.outcomes;
  if (!Array.isArray(outcomes) || outcomes.some((outcome) => typeof outcome !== "string")) {
    throw new Error(`pending human turn ${row.queue_id} has a malformed outcome vocabulary`);
  }
  return Object.freeze({
    queueId: row.queue_id,
    unitId: row.unit_id,
    graph: Object.freeze({
      id: row.graph_id,
      version: positiveInteger(row.graph_version, "graph_version"),
      digest: row.graph_digest
    }),
    nodeId: row.node_id,
    nodeRef: Object.freeze({
      id: row.node_ref_id,
      version: positiveInteger(row.node_ref_version, "node_ref_version")
    }),
    principalId: row.principal_id,
    outcomes: Object.freeze([...(outcomes as string[])]),
    inputArtifact: validateArtifactEnvelope(parsed),
    queuedAt: iso(row.queued_at),
    enqueueSequence: positiveInteger(row.enqueue_sequence, "enqueue_sequence"),
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(row.claimed_at === null ? {} : { claimedAt: iso(row.claimed_at) })
  });
}

function decisionRecord(row: DecisionRow): HumanDecisionRecord {
  if (row.actor_id === null) {
    throw new Error(`human decision ${row.queue_id} has no actor evidence`);
  }
  return Object.freeze({
    decisionSequence: positiveInteger(row.decision_sequence, "decision_sequence"),
    queueId: row.queue_id,
    unitId: row.unit_id,
    graph: Object.freeze({
      id: row.graph_id,
      version: positiveInteger(row.graph_version, "graph_version"),
      digest: row.graph_digest
    }),
    nodeId: row.node_id,
    principalId: row.principal_id,
    actorId: row.actor_id,
    outcome: row.outcome,
    ...(row.output_contract_id === null || row.output_artifact_digest === null
      ? {}
      : {
          outputArtifact: Object.freeze({
            contractId: row.output_contract_id,
            digest: row.output_artifact_digest
          })
        }),
    startedAt: iso(row.started_at),
    settledAt: iso(row.settled_at),
    settlementDigest: row.settlement_digest
  });
}

const PENDING_COLUMNS = `
  queue_id::text AS queue_id, unit_id, graph_id, graph_version, graph_digest,
  node_id, node_ref_id, node_ref_version, principal_id, outcomes, input_envelope,
  queued_at, enqueue_sequence, claimed_by, claimed_at
`;

/** Human-decision recording and review over the switchyard schema. */
export class PostgresHumanDecisions {
  readonly schema: string;
  readonly unitStore: PostgresUnitStore;
  readonly #pool: PgPool;
  readonly #now: (() => Date) | undefined;

  constructor(options: PostgresHumanDecisionsOptions) {
    this.#pool = options.pool;
    this.schema = validateSchemaName(options.schema ?? DEFAULT_SCHEMA);
    this.#now = options.now;
    if (options.unitStore !== undefined && options.unitStore.schema !== this.schema) {
      throw new Error("PostgresHumanDecisions unitStore must use the same schema");
    }
    const storeOptions: PostgresUnitStoreOptions = {
      pool: options.pool,
      schema: this.schema,
      ...(options.now === undefined ? {} : { now: options.now })
    };
    this.unitStore = options.unitStore ?? new PostgresUnitStore(storeOptions);
  }

  /** Pending human turns in global FIFO order. */
  async listPending(input: ListPendingHumanTurnsInput = {}): Promise<readonly PendingHumanTurn[]> {
    const limit = pageLimit(input.limit);
    const after = optionalCursor(input.afterEnqueueSequence, "afterEnqueueSequence");
    const rows = await withClient(this.#pool, (client) => client.query<PendingRow>(`
      SELECT ${PENDING_COLUMNS}
      FROM ${qualified(this.schema, "list_pending_human_turns")}(
        $1::text, $2::text, $3::text, $4::bigint, $5::integer
      )
    `, [input.principalId ?? null, input.nodeId ?? null, input.graphId ?? null, after, limit]));
    return Object.freeze(rows.rows.map(pendingTurn));
  }

  /** One pending human turn, or undefined when it is not (or no longer) pending. */
  async inspect(queueId: string): Promise<PendingHumanTurn | undefined> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(queueId)) {
      return undefined;
    }
    const rows = await withClient(this.#pool, (client) => client.query<PendingRow>(`
      SELECT ${PENDING_COLUMNS}
      FROM ${qualified(this.schema, "inspect_pending_human_turn")}($1::uuid)
    `, [queueId]));
    if (rows.rows.length > 1) throw new Error("inspect_pending_human_turn returned duplicate rows");
    return rows.rows.length === 0 ? undefined : pendingTurn(rows.rows[0]!);
  }

  /**
   * Record a decision for one pending human turn and route the unit on.
   * The engine checks the outcome against the node's vocabulary and any
   * declared output contract. A turn that is no longer pending (decided,
   * failed, unknown, or not a human node) is refused with
   * HumanTurnNotPendingError; after an uncertain reply, listDecisions shows
   * whether the decision was recorded.
   */
  async record(input: RecordHumanDecisionInput): Promise<RecordedHumanDecision> {
    const turn = await this.inspect(input.queueId);
    if (turn === undefined) throw new HumanTurnNotPendingError(input.queueId);
    const result = await recordHumanNodeDecision({
      store: this.unitStore,
      principalId: turn.principalId,
      decision: {
        queueId: turn.queueId,
        unitId: turn.unitId,
        nodeId: turn.nodeId,
        outcome: input.outcome,
        actor: { actorId: input.actorId },
        ...(input.outputArtifact === undefined ? {} : { outputArtifact: input.outputArtifact })
      },
      ...(input.outboxEvents === undefined ? {} : { outboxEvents: input.outboxEvents }),
      ...(this.#now === undefined ? {} : { now: this.#now })
    });
    return Object.freeze({ turn, result });
  }

  /** Recorded decisions in the order they were recorded. */
  async listDecisions(input: ListHumanDecisionsInput = {}): Promise<readonly HumanDecisionRecord[]> {
    const limit = pageLimit(input.limit);
    const after = optionalCursor(input.afterDecisionSequence, "afterDecisionSequence");
    const rows = await withClient(this.#pool, (client) => client.query<DecisionRow>(`
      SELECT decision_sequence, queue_id::text AS queue_id, unit_id, graph_id,
        graph_version, graph_digest, node_id, principal_id, actor_id, outcome,
        output_contract_id, output_artifact_digest, started_at, settled_at,
        settlement_digest
      FROM ${qualified(this.schema, "list_human_decisions")}($1::text, $2::bigint, $3::integer)
    `, [input.unitId ?? null, after, limit]));
    return Object.freeze(rows.rows.map(decisionRecord));
  }
}
