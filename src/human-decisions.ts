// human-decisions.ts — record and review decisions at `human` nodes.
//
// A human decision is the settlement of a human node's turn through the
// engine's recordHumanNodeDecision: the engine claims the external turn under
// the node's sealed principal, checks the outcome against the node's closed
// vocabulary (and any declared output contract), settles it with the actor as
// evidence, and routes the unit on. This module adds what a review surface
// needs around that: a pending-turn listing that reads projections instead of
// hydrating the engine, and a decision ledger. Approval and review nodes that
// switchyard compiles from node settings are ordinary human nodes to the
// store; recordAnswer() takes a person's answer (approved / denied,
// accepted / rejected, or an ordinary node's outcome) and maps it to the
// stored outcome with the engine's own approvalReviewHumanDecision.

import {
  validateArtifactEnvelope,
  type ArtifactEnvelope
} from "@scshafe/switchyard/contracts/artifact";
import { canonicalJson } from "@scshafe/switchyard/contracts/digest";
import {
  approvalReviewHumanDecision,
  reviewNotes
} from "@scshafe/switchyard/execute/approval-review";
import { ENGINE_JOIN_UNSATISFIABLE_OUTCOME } from "@scshafe/switchyard/execute/ports";
import {
  APPROVAL_OUTCOMES,
  REVIEWER_OUTCOMES,
  REVIEW_REJECTED_OUTCOME,
  approvalReviewRole,
  type ApprovalReviewRoleKind
} from "@scshafe/switchyard/graph/approval-review";
import type { GraphDefinition, GraphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import {
  recordHumanNodeDecision,
  type TurnOutboxEvents,
  type UnitTurnRunResult
} from "@scshafe/switchyard/execute/unit-runner";

import { loadGraphOnClient } from "./graph-store.js";
import { withClient, type PgClient, type PgPool } from "./pg.js";
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
  /**
   * The node's closed outcome vocabulary as stored, in the node's declared
   * order: what `record` takes. For a review node these are the composed
   * outcomes (`accepted:<outcome>`, `rework`, `rejected`).
   */
  readonly outcomes: readonly string[];
  /**
   * What a person answers here, in order: what `recordAnswer` takes.
   * `approved` / `denied` at an approval node, `accepted` / `rejected` at a
   * review node, otherwise the node's outcomes (without the engine-reserved
   * `join_unsatisfiable`).
   */
  readonly answers: readonly string[];
  /** Answers that may carry `notes` (`rejected` at a review node; else none). */
  readonly notesAnswers: readonly string[];
  /**
   * The part the node plays in an approval/review expansion
   * (switchyard's `approvalReviewRole`); absent for an ordinary human node.
   */
  readonly role?: ApprovalReviewRoleKind;
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
  readonly unitId?: string;
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

/**
 * A person's answer at a pending human turn. Name the turn by `queueId`, or
 * by `unitId` and `nodeId` when exactly one turn of that unit waits there.
 */
export interface RecordHumanAnswerInput {
  readonly queueId?: string;
  readonly unitId?: string;
  readonly nodeId?: string;
  /** One of the turn's `answers` (see listPending). */
  readonly answer: string;
  /**
   * Reviewer feedback, only with an answer in the turn's `notesAnswers`
   * (`rejected` at a review node); recorded as switchyard's `reviewNotes`.
   */
  readonly notes?: string;
  /** Who answered. Evidence only; it grants no authority. */
  readonly actorId: string;
  /**
   * Optional guard: refuse unless the turn's sealed principal is this one
   * (e.g. the principal a review surface serves).
   */
  readonly principalId?: string;
  /**
   * For an ordinary human node (or a person running a reviewed node) whose
   * outcome declares an output contract. Not taken together with `notes`.
   */
  readonly outputArtifact?: ArtifactEnvelope;
  readonly outboxEvents?: TurnOutboxEvents;
}

export interface RecordedHumanAnswer extends RecordedHumanDecision {
  /** The answer as given. */
  readonly answer: string;
  /** The outcome recorded for it (e.g. `accepted:drafted`, `rework`). */
  readonly outcome: string;
}

export interface HumanTurnSelector {
  readonly queueId?: string;
  readonly unitId?: string;
  readonly nodeId?: string;
}

function describeSelector(selector: HumanTurnSelector): string {
  return selector.queueId !== undefined
    ? `human turn ${selector.queueId}`
    : `a human turn of unit ${JSON.stringify(selector.unitId)} at node ${JSON.stringify(selector.nodeId)}`;
}

export class HumanTurnNotPendingError extends Error {
  readonly code = "human_turn_not_pending";
  /** The queue id asked for; empty when the turn was named by unit and node. */
  readonly queueId: string;
  readonly unitId?: string;
  readonly nodeId?: string;

  constructor(selector: string | HumanTurnSelector) {
    const named = typeof selector === "string" ? { queueId: selector } : selector;
    super(`${describeSelector(named)} is not pending (unknown, already decided, or not a human node)`);
    this.name = "HumanTurnNotPendingError";
    this.queueId = named.queueId ?? "";
    if (named.unitId !== undefined) this.unitId = named.unitId;
    if (named.nodeId !== undefined) this.nodeId = named.nodeId;
  }
}

/** An answer that is not one of the turn's answers, or notes it cannot carry. */
export class InvalidHumanAnswerError extends Error {
  readonly code = "human_answer_invalid";
  readonly queueId: string;
  readonly nodeId: string;
  readonly answer: string;
  /** The answers this turn takes, in order. */
  readonly validAnswers: readonly string[];

  constructor(turn: PendingHumanTurn, answer: string, reason: string) {
    super(`${reason} (node ${turn.nodeId} of unit ${turn.unitId}; valid answers: ${turn.answers.join(", ")})`);
    this.name = "InvalidHumanAnswerError";
    this.queueId = turn.queueId;
    this.nodeId = turn.nodeId;
    this.answer = answer;
    this.validAnswers = turn.answers;
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

interface AnswerShape {
  readonly outcomes: readonly string[];
  readonly answers: readonly string[];
  readonly notesAnswers: readonly string[];
  readonly role?: ApprovalReviewRoleKind;
}

/** Declared outcomes and the person-facing answers of one sealed node. */
function answerShape(graph: GraphDefinition, nodeId: string): AnswerShape {
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) {
    throw new Error(`graph ${graph.graphId}@${graph.version} has no node ${nodeId}`);
  }
  const outcomes = Object.freeze([...node.outcomes.outcomes]);
  const role = approvalReviewRole(graph, nodeId)?.role;
  const answers = role === "review"
    ? [...REVIEWER_OUTCOMES]
    : role === "approval"
      ? [...APPROVAL_OUTCOMES]
      : outcomes.filter((outcome) => outcome !== ENGINE_JOIN_UNSATISFIABLE_OUTCOME);
  return Object.freeze({
    outcomes,
    answers: Object.freeze(answers),
    notesAnswers: Object.freeze(role === "review" ? [REVIEW_REJECTED_OUTCOME] : []),
    ...(role === undefined ? {} : { role })
  });
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

function pendingTurn(row: PendingRow, graph: GraphDefinition): PendingHumanTurn {
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
  const shape = answerShape(graph, row.node_id);
  if (!sameMembers(shape.outcomes, outcomes as string[])) {
    throw new Error(`pending human turn ${row.queue_id} outcome vocabulary differs from its sealed node`);
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
    outcomes: shape.outcomes,
    answers: shape.answers,
    notesAnswers: shape.notesAnswers,
    ...(shape.role === undefined ? {} : { role: shape.role }),
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Sealed graphs are immutable; keep this many decoded per instance. */
const GRAPH_CACHE_SIZE = 64;

/** Human-decision recording and review over the switchyard schema. */
export class PostgresHumanDecisions {
  readonly schema: string;
  readonly unitStore: PostgresUnitStore;
  readonly #pool: PgPool;
  readonly #now: (() => Date) | undefined;
  readonly #graphs = new Map<string, GraphDefinition>();

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
    return withClient(this.#pool, async (client) => {
      const rows = await client.query<PendingRow>(`
        SELECT ${PENDING_COLUMNS}
        FROM ${qualified(this.schema, "find_pending_human_turns")}(
          $1::text, $2::text, $3::text, $4::text, $5::bigint, $6::integer
        )
      `, [
        input.unitId ?? null,
        input.principalId ?? null,
        input.nodeId ?? null,
        input.graphId ?? null,
        after,
        limit
      ]);
      return this.#pendingTurns(client, rows.rows);
    });
  }

  /** One pending human turn, or undefined when it is not (or no longer) pending. */
  async inspect(queueId: string): Promise<PendingHumanTurn | undefined> {
    if (!UUID_PATTERN.test(queueId)) return undefined;
    return withClient(this.#pool, async (client) => {
      const rows = await client.query<PendingRow>(`
        SELECT ${PENDING_COLUMNS}
        FROM ${qualified(this.schema, "inspect_pending_human_turn")}($1::uuid)
      `, [queueId]);
      if (rows.rows.length > 1) throw new Error("inspect_pending_human_turn returned duplicate rows");
      const [turn] = await this.#pendingTurns(client, rows.rows);
      return turn;
    });
  }

  async #graph(client: PgClient, ref: GraphDefinitionRef): Promise<GraphDefinition> {
    const cached = this.#graphs.get(ref.digest);
    if (cached !== undefined) return cached;
    const graph = await loadGraphOnClient(client, this.schema, ref);
    if (graph === undefined) {
      throw new Error(`graph ${ref.id}@${ref.version} of a pending human turn is not published`);
    }
    if (this.#graphs.size >= GRAPH_CACHE_SIZE) {
      this.#graphs.delete(this.#graphs.keys().next().value!);
    }
    this.#graphs.set(ref.digest, graph);
    return graph;
  }

  async #pendingTurns(client: PgClient, rows: readonly PendingRow[]): Promise<readonly PendingHumanTurn[]> {
    const turns: PendingHumanTurn[] = [];
    for (const row of rows) {
      const graph = await this.#graph(client, {
        id: row.graph_id,
        version: positiveInteger(row.graph_version, "graph_version"),
        digest: row.graph_digest
      });
      turns.push(pendingTurn(row, graph));
    }
    return Object.freeze(turns);
  }

  /** The one pending turn a selector names, or HumanTurnNotPendingError. */
  async #selectPending(selector: HumanTurnSelector): Promise<PendingHumanTurn> {
    if (selector.queueId !== undefined) {
      if (selector.unitId !== undefined || selector.nodeId !== undefined) {
        throw new TypeError("name a human turn by queueId, or by unitId and nodeId, not both");
      }
      const turn = await this.inspect(selector.queueId);
      if (turn === undefined) throw new HumanTurnNotPendingError(selector.queueId);
      return turn;
    }
    if (typeof selector.unitId !== "string" || typeof selector.nodeId !== "string") {
      throw new TypeError("name a human turn by queueId, or by unitId and nodeId");
    }
    const turns = await this.listPending({ unitId: selector.unitId, nodeId: selector.nodeId, limit: 2 });
    if (turns.length === 0) {
      throw new HumanTurnNotPendingError({ unitId: selector.unitId, nodeId: selector.nodeId });
    }
    if (turns.length > 1) {
      throw new Error(
        `unit ${selector.unitId} has more than one pending turn at node ${selector.nodeId}; name one by queueId (listPending({ unitId, nodeId }))`
      );
    }
    return turns[0]!;
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

  /**
   * Record a person's answer and route the unit on. The answer is what the
   * person chose (one of the turn's `answers`): at an approval node
   * `approved` / `denied`, at a review node `accepted` / `rejected` (a
   * rejection may carry `notes`), at any other human node one of its
   * outcomes. Answers at approval, review and reviewed nodes are mapped to
   * the stored outcome by switchyard's approvalReviewHumanDecision (e.g.
   * `accepted` becomes `accepted:<outcome>`, a rejection before the last
   * round becomes `rework`); ordinary nodes' answers pass through. An
   * invalid answer is refused with InvalidHumanAnswerError, which lists the
   * valid ones; nothing is recorded.
   */
  async recordAnswer(input: RecordHumanAnswerInput): Promise<RecordedHumanAnswer> {
    const turn = await this.#selectPending(input);
    if (input.principalId !== undefined && input.principalId !== turn.principalId) {
      throw new Error(
        `human turn ${turn.queueId} is decided under principal ${turn.principalId}, not ${input.principalId}`
      );
    }
    const answer = input.answer;
    if (typeof answer !== "string" || !turn.answers.includes(answer)) {
      throw new InvalidHumanAnswerError(turn, String(answer), `${JSON.stringify(answer)} is not an answer here`);
    }
    let outputArtifact = input.outputArtifact;
    if (input.notes !== undefined) {
      if (!turn.notesAnswers.includes(answer)) {
        throw new InvalidHumanAnswerError(
          turn,
          answer,
          turn.notesAnswers.length === 0
            ? "this node records no notes"
            : `notes go only with ${turn.notesAnswers.map((notesAnswer) => JSON.stringify(notesAnswer)).join(" or ")}`
        );
      }
      if (outputArtifact !== undefined) {
        throw new InvalidHumanAnswerError(turn, answer, "pass notes or an outputArtifact, not both");
      }
      outputArtifact = reviewNotes(input.notes);
    }
    const graph = await withClient(this.#pool, (client) => this.#graph(client, turn.graph));
    const decision = approvalReviewHumanDecision(graph, {
      queued: {
        queueId: turn.queueId,
        unitId: turn.unitId,
        nodeId: turn.nodeId,
        inputArtifact: turn.inputArtifact
      },
      outcome: answer,
      ...(outputArtifact === undefined ? {} : { outputArtifact }),
      actor: { actorId: input.actorId }
    });
    const result = await recordHumanNodeDecision({
      store: this.unitStore,
      principalId: turn.principalId,
      decision,
      ...(input.outboxEvents === undefined ? {} : { outboxEvents: input.outboxEvents }),
      ...(this.#now === undefined ? {} : { now: this.#now })
    });
    return Object.freeze({ turn, result, answer, outcome: decision.outcome });
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
