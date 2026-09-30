// unit-state.ts — normalized state transport between PostgreSQL and the
// engine's MemoryUnitStore (ported from inbox-pipeline's N4 adapter).
//
// begin_unit_operation returns one operation's scoped rows as canonical JSON
// text; decodePostgresUnitStateSnapshot turns them into a MemoryUnitStore
// snapshot. After the engine applies the operation, diffPostgresUnitState
// computes the only writes a durable store may make (append-only evidence,
// join revisions, lease/fairness replacement) and encodePostgresUnitStateDelta
// ships them to apply_unit_delta with typed projections alongside the text.

import { canonicalJson, digest } from "@scshafe/switchyard/contracts/digest";
import {
  MEMORY_UNIT_STORE_STATE_SNAPSHOT_SCHEMA_VERSION,
  type MemoryUnitStoreStateSnapshot
} from "@scshafe/switchyard/store/memory-unit-store";

type StateItem<
  Key extends keyof MemoryUnitStoreStateSnapshot
> = MemoryUnitStoreStateSnapshot[Key] extends readonly (infer Item)[]
  ? Item
  : never;

export interface PostgresUnitStateDelta {
  readonly unitGraphs: readonly StateItem<"unitGraphs">[];
  readonly units: readonly StateItem<"units">[];
  readonly artifacts: readonly StateItem<"artifacts">[];
  readonly queues: readonly StateItem<"queues">[];
  readonly journey: readonly StateItem<"journey">[];
  readonly joins: readonly StateItem<"joins">[];
  readonly attempts: readonly StateItem<"attempts">[];
  readonly cachedCompletions: readonly StateItem<"cachedCompletions">[];
  readonly failures: readonly StateItem<"failures">[];
  readonly settlements: readonly StateItem<"settlements">[];
  readonly outbox: readonly StateItem<"outbox">[];
  readonly deadLetters: readonly StateItem<"deadLetters">[];
  readonly leaseUpserts: readonly StateItem<"leases">[];
  readonly leaseDeletes: readonly string[];
  readonly fairnessUpserts: readonly StateItem<"fairnessCursor">[];
}

export interface EncodedPostgresUnitStateDelta {
  readonly unitGraphs: readonly EncodedUnitGraph[];
  readonly units: readonly EncodedUnit[];
  readonly artifacts: readonly EncodedArtifact[];
  readonly queues: readonly EncodedQueue[];
  readonly journey: readonly EncodedJourney[];
  readonly joins: readonly EncodedJoinProgress[];
  readonly attempts: readonly EncodedAttempt[];
  readonly cachedCompletions: readonly EncodedCachedCompletion[];
  readonly failures: readonly EncodedFailure[];
  readonly settlements: readonly EncodedSettlement[];
  readonly outbox: readonly EncodedOutboxEvent[];
  readonly deadLetters: readonly EncodedDeadLetter[];
  readonly leaseUpserts: readonly EncodedLease[];
  readonly leaseDeletes: readonly string[];
  readonly fairnessUpserts: readonly EncodedFairnessCursor[];
}

export interface EncodedPostgresUnitStateSnapshot {
  readonly unitGraphs: readonly EncodedSnapshotUnitGraph[];
  readonly units: readonly CanonicalRecord[];
  readonly artifacts: readonly CanonicalRecord[];
  readonly queues: readonly CanonicalRecord[];
  readonly journey: readonly CanonicalRecord[];
  readonly joins: readonly CanonicalRecord[];
  readonly attempts: readonly CanonicalRecord[];
  readonly cachedCompletions: readonly CanonicalRecord[];
  readonly failures: readonly CanonicalRecord[];
  readonly settlements: readonly CanonicalRecord[];
  readonly outbox: readonly CanonicalRecord[];
  readonly deadLetters: readonly CanonicalRecord[];
  readonly leases: readonly CanonicalRecord[];
  readonly fairnessCursor: readonly EncodedFairnessCursor[];
  readonly outboxDedupeKeys: readonly string[];
  readonly nextEnqueueSequence: number;
}

export interface CanonicalRecord {
  readonly canonicalJson: string;
}

export interface EncodedUnitGraph extends CanonicalRecord {
  readonly unitId: string;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly graphDigest: string;
  readonly graphCanonicalJson: string;
}

export interface EncodedSnapshotUnitGraph {
  readonly unitId: string;
  readonly graphCanonicalJson: string;
}

export interface EncodedUnit extends CanonicalRecord {
  readonly unitId: string;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly graphDigest: string;
  readonly seedContractId: string;
  readonly seedArtifactDigest: string;
  readonly seedDeclaredBytes: number | null;
  readonly admittedAt: string;
  readonly principalId: string;
  readonly admissionDigest: string;
}

export interface EncodedArtifact extends CanonicalRecord {
  readonly contractId: string;
  readonly artifactDigest: string;
  readonly declaredBytes: number | null;
}

export interface EncodedQueue extends CanonicalRecord {
  readonly queueId: string;
  readonly unitId: string;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly graphDigest: string;
  readonly nodeId: string;
  readonly nodeRefId: string;
  readonly nodeRefVersion: number;
  readonly inputContractId: string;
  readonly inputArtifactDigest: string;
  readonly inputEnvelopeCanonicalJson: string;
  readonly queuedAt: string;
  readonly enqueueSequence: number;
  readonly sourceEvidenceDigest: string;
  readonly sourceJourneySequence: number;
  readonly sourceJourneyRecordDigest: string;
  readonly inboundEdgeIds: readonly string[];
  readonly joinProvenance: unknown | null;
}

export interface EncodedJourney extends CanonicalRecord {
  readonly unitId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly queueId: string | null;
  readonly nodeId: string;
  readonly recordedAt: string;
  readonly recordDigest: string;
}

export interface EncodedJoinProgress extends CanonicalRecord {
  readonly unitId: string;
  readonly nodeId: string;
  readonly status: string;
  readonly selectedQueueId: string | null;
  readonly syntheticOutcomeDigest: string | null;
  readonly progressDigest: string;
}

export interface EncodedAttempt extends CanonicalRecord {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly nodeRefId: string;
  readonly nodeRefVersion: number;
  readonly fingerprint: string;
  readonly inputDigest: string;
  readonly executionIdentityDigest: string | null;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
}

export interface EncodedCachedCompletion extends CanonicalRecord {
  readonly queueId: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
  readonly completionDigest: string;
  readonly startedAt: string;
  readonly settledAt: string;
}

export interface EncodedFailure extends CanonicalRecord {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly startedAt: string;
  readonly failedAt: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
  readonly terminal: boolean;
  readonly usageCanonicalJson: string;
  readonly failureDigest: string;
  readonly committedOutboxDigests: readonly string[];
}

export interface EncodedSettlement extends CanonicalRecord {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly actorId: string | null;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly outcome: string;
  readonly outputContractId: string | null;
  readonly outputArtifactDigest: string | null;
  readonly completionDigest: string;
  readonly settlementDigest: string;
  readonly completionCanonicalJson: string;
  readonly committedOutboxDigests: readonly string[];
}

export interface EncodedOutboxEvent extends CanonicalRecord {
  readonly outboxEventId: string;
  readonly unitId: string;
  readonly queueId: string | null;
  readonly nodeId: string;
  readonly attemptNumber: number | null;
  readonly attemptIndex: number | null;
  readonly eventType: string;
  readonly payloadCanonicalJson: string;
  readonly dedupeKey: string | null;
  readonly eventDigest: string;
  readonly recordedAt: string;
}

export interface EncodedDeadLetter extends CanonicalRecord {
  readonly deadLetterId: string;
  readonly unitId: string;
  readonly queueId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly errorCode: string;
  readonly failureDigest: string;
  readonly principalId: string;
  readonly recordedAt: string;
}

export interface EncodedLease extends CanonicalRecord {
  readonly queueId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly mode: string;
  readonly principalId: string;
  readonly externalKind: string | null;
  readonly externalActorId: string | null;
  readonly externalCompletionDigest: string | null;
  readonly externalOutboxDigests: readonly string[] | null;
}

export interface EncodedFairnessCursor {
  readonly nodeId: string;
  readonly nodeRefId: string;
  readonly nodeRefVersion: number;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly graphDigest: string;
}

function immutableAdditions<T>(
  before: readonly T[],
  after: readonly T[],
  identity: (value: T) => string,
  label: string
): readonly T[] {
  const prior = new Map(before.map((value) => [identity(value), value]));
  const retained = new Set<string>();
  const additions: T[] = [];
  for (const value of after) {
    const key = identity(value);
    if (retained.has(key)) {
      throw new Error(`PostgresUnitStore ${label} contains duplicate identity ${key}`);
    }
    retained.add(key);
    const existing = prior.get(key);
    if (existing === undefined) {
      additions.push(value);
      continue;
    }
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error(`PostgresUnitStore ${label} rewrote immutable identity ${key}`);
    }
  }
  for (const key of prior.keys()) {
    if (!retained.has(key)) {
      throw new Error(`PostgresUnitStore ${label} removed immutable identity ${key}`);
    }
  }
  return Object.freeze(additions);
}

function projectionChanges<T>(
  before: readonly T[],
  after: readonly T[],
  identity: (value: T) => string,
  label: string
): readonly T[] {
  const prior = new Map(before.map((value) => [identity(value), value]));
  const retained = new Set<string>();
  const changes: T[] = [];
  for (const value of after) {
    const key = identity(value);
    if (retained.has(key)) {
      throw new Error(`PostgresUnitStore ${label} contains duplicate identity ${key}`);
    }
    retained.add(key);
    const existing = prior.get(key);
    if (existing === undefined || canonicalJson(existing) !== canonicalJson(value)) {
      changes.push(value);
    }
  }
  for (const key of prior.keys()) {
    if (!retained.has(key)) {
      throw new Error(`PostgresUnitStore ${label} removed retained projection ${key}`);
    }
  }
  return Object.freeze(changes);
}

function mutableChanges<T>(
  before: readonly T[],
  after: readonly T[],
  identity: (value: T) => string,
  label: string
): { readonly upserts: readonly T[]; readonly deletes: readonly string[] } {
  const prior = new Map(before.map((value) => [identity(value), value]));
  const retained = new Set<string>();
  const upserts: T[] = [];
  for (const value of after) {
    const key = identity(value);
    if (retained.has(key)) {
      throw new Error(`PostgresUnitStore ${label} contains duplicate identity ${key}`);
    }
    retained.add(key);
    const existing = prior.get(key);
    if (existing === undefined || canonicalJson(existing) !== canonicalJson(value)) {
      upserts.push(value);
    }
  }
  return Object.freeze({
    upserts: Object.freeze(upserts),
    deletes: Object.freeze([...prior.keys()].filter((key) => !retained.has(key)))
  });
}

/**
 * Compute the only writes a normalized durable store may make after one
 * MemoryUnitStore transition. Evidence can append, joins can add a revision,
 * and only leases/fairness are replaceable coordination projections.
 */
export function diffPostgresUnitState(
  before: MemoryUnitStoreStateSnapshot,
  after: MemoryUnitStoreStateSnapshot
): PostgresUnitStateDelta {
  if (before.schemaVersion !== after.schemaVersion) {
    throw new Error("PostgresUnitStore state snapshot schema changed during one operation");
  }
  if (after.nextEnqueueSequence < before.nextEnqueueSequence) {
    throw new Error("PostgresUnitStore next enqueue sequence moved backwards");
  }

  const leases = mutableChanges(
    before.leases,
    after.leases,
    (entry) => entry.queueId,
    "leases"
  );
  const fairness = mutableChanges(
    before.fairnessCursor,
    after.fairnessCursor,
    (entry) => entry.sharedNodeKey,
    "fairness cursors"
  );
  if (fairness.deletes.length > 0) {
    throw new Error("PostgresUnitStore removed a fairness cursor");
  }

  return Object.freeze({
    unitGraphs: immutableAdditions(
      before.unitGraphs,
      after.unitGraphs,
      (entry) => entry.unitId,
      "unit graphs"
    ),
    units: immutableAdditions(before.units, after.units, (unit) => unit.unitId, "units"),
    artifacts: immutableAdditions(
      before.artifacts,
      after.artifacts,
      (artifact) => `${artifact.contractId}\u0000${artifact.digest}`,
      "artifacts"
    ),
    queues: immutableAdditions(before.queues, after.queues, (queue) => queue.queueId, "queues"),
    journey: immutableAdditions(
      before.journey,
      after.journey,
      (record) => `${record.unitId}\u0000${record.sequence}`,
      "journey"
    ),
    joins: projectionChanges(
      before.joins,
      after.joins,
      (join) => `${join.unitId}\u0000${join.nodeId}`,
      "join progress"
    ),
    attempts: immutableAdditions(
      before.attempts,
      after.attempts,
      (attempt) => `${attempt.queueId}\u0000${attempt.attemptNumber}`,
      "attempts"
    ),
    cachedCompletions: immutableAdditions(
      before.cachedCompletions,
      after.cachedCompletions,
      (completion) => `${completion.queueId}\u0000${completion.attemptNumber}`,
      "completion cache"
    ),
    failures: immutableAdditions(
      before.failures,
      after.failures,
      (failure) => `${failure.queueId}\u0000${failure.attemptNumber}`,
      "failures"
    ),
    settlements: immutableAdditions(
      before.settlements,
      after.settlements,
      (settlement) => settlement.queueId,
      "settlements"
    ),
    outbox: immutableAdditions(
      before.outbox,
      after.outbox,
      (event) => event.outboxEventId,
      "outbox"
    ),
    deadLetters: immutableAdditions(
      before.deadLetters,
      after.deadLetters,
      (record) => record.deadLetterId,
      "dead letters"
    ),
    leaseUpserts: leases.upserts,
    leaseDeletes: leases.deletes,
    fairnessUpserts: fairness.upserts
  });
}

function splitCursorKey(value: string, label: string): readonly [string, string, number] {
  const parts = value.split("\u0000");
  const version = Number(parts[2]);
  if (
    parts.length !== 3
    || parts[0]?.length === 0
    || parts[1]?.length === 0
    || !Number.isSafeInteger(version)
    || version < 1
  ) {
    throw new Error(`PostgresUnitStore ${label} is not a three-part engine key`);
  }
  return [parts[0]!, parts[1]!, version];
}

function encodeFairnessCursor(
  value: StateItem<"fairnessCursor">
): EncodedFairnessCursor {
  const [nodeId, nodeRefId, nodeRefVersion] = splitCursorKey(
    value.sharedNodeKey,
    "shared node key"
  );
  const [graphId, graphVersionText, graphDigest] = value.lastGraphLaneKey.split("\u0000");
  const graphVersion = Number(graphVersionText);
  if (
    graphId === undefined
    || graphId.length === 0
    || graphDigest === undefined
    || !/^[a-f0-9]{64}$/.test(graphDigest)
    || !Number.isSafeInteger(graphVersion)
    || graphVersion < 1
  ) {
    throw new Error("PostgresUnitStore graph lane key is not a sealed three-part engine key");
  }
  return Object.freeze({
    nodeId,
    nodeRefId,
    nodeRefVersion,
    graphId,
    graphVersion,
    graphDigest
  });
}

/**
 * Encode arbitrary evidence as canonical JSON *strings*. PostgreSQL jsonb
 * cannot represent a JSON string containing U+0000, while TEXT can retain its
 * canonical `\\u0000` escape exactly; the outer transport object only carries
 * those canonical strings plus bounded engine-authored metadata.
 */
export function encodePostgresUnitStateDelta(
  delta: PostgresUnitStateDelta
): EncodedPostgresUnitStateDelta {
  const unitsById = new Map(delta.units.map((unit) => [unit.unitId, unit]));
  const sourceJourneys = new Map<string, StateItem<"journey">>();
  for (const record of delta.journey) {
    const sourceDigest = record.kind === "unit_admitted"
      ? unitsById.get(record.unitId)?.admissionDigest
      : record.kind === "turn_settled"
        ? record.settlementDigest
        : record.kind === "turn_failed"
          ? record.failureDigest
          : record.syntheticOutcomeDigest;
    if (sourceDigest !== undefined) sourceJourneys.set(sourceDigest, record);
  }
  return Object.freeze({
    unitGraphs: Object.freeze(delta.unitGraphs.map((entry) => Object.freeze({
      canonicalJson: canonicalJson(entry),
      unitId: entry.unitId,
      graphId: entry.graph.graphId,
      graphVersion: entry.graph.version,
      graphDigest: entry.graph.graphDigest,
      graphCanonicalJson: canonicalJson(entry.graph)
    }))),
    units: Object.freeze(delta.units.map((unit) => Object.freeze({
      canonicalJson: canonicalJson(unit),
      unitId: unit.unitId,
      graphId: unit.graph.id,
      graphVersion: unit.graph.version,
      graphDigest: unit.graph.digest,
      seedContractId: unit.seedArtifact.contractId,
      seedArtifactDigest: unit.seedArtifact.digest,
      seedDeclaredBytes: unit.seedArtifact.bytes ?? null,
      admittedAt: unit.admittedAt,
      principalId: unit.principalId,
      admissionDigest: unit.admissionDigest
    }))),
    artifacts: Object.freeze(delta.artifacts.map((artifact) => Object.freeze({
      canonicalJson: canonicalJson(artifact),
      contractId: artifact.contractId,
      artifactDigest: artifact.digest,
      declaredBytes: artifact.bytes ?? null
    }))),
    queues: Object.freeze(delta.queues.map((queue) => {
      const source = sourceJourneys.get(queue.sourceEvidenceDigest);
      if (source === undefined || source.unitId !== queue.unitId) {
        throw new Error(
          `PostgresUnitStore queue ${queue.queueId} has no same-operation source journey`
        );
      }
      return Object.freeze({
        canonicalJson: canonicalJson(queue),
        queueId: queue.queueId,
        unitId: queue.unitId,
        graphId: queue.graph.id,
        graphVersion: queue.graph.version,
        graphDigest: queue.graph.digest,
        nodeId: queue.nodeId,
        nodeRefId: queue.nodeRef.id,
        nodeRefVersion: queue.nodeRef.version,
        inputContractId: queue.inputArtifact.contractId,
        inputArtifactDigest: queue.inputArtifact.digest,
        inputEnvelopeCanonicalJson: canonicalJson(queue.inputArtifact),
        queuedAt: queue.queuedAt,
        enqueueSequence: queue.enqueueSequence,
        sourceEvidenceDigest: queue.sourceEvidenceDigest,
        sourceJourneySequence: source.sequence,
        sourceJourneyRecordDigest: source.recordDigest,
        inboundEdgeIds: queue.inboundEdgeIds,
        joinProvenance: queue.join ?? null
      });
    })),
    journey: Object.freeze(delta.journey.map((record) => Object.freeze({
      canonicalJson: canonicalJson(record),
      unitId: record.unitId,
      sequence: record.sequence,
      kind: record.kind,
      queueId: record.kind === "join_unsatisfiable"
        ? null
        : record.kind === "unit_admitted"
          ? record.entryQueueId
          : record.queueId,
      nodeId: record.kind === "unit_admitted" ? record.entryNodeId : record.nodeId,
      recordedAt: record.recordedAt,
      recordDigest: record.recordDigest
    }))),
    joins: Object.freeze(delta.joins.map((progress) => Object.freeze({
      canonicalJson: canonicalJson(progress),
      unitId: progress.unitId,
      nodeId: progress.nodeId,
      status: progress.status,
      selectedQueueId: progress.queueId ?? null,
      syntheticOutcomeDigest: progress.syntheticOutcomeDigest ?? null,
      progressDigest: digest(progress)
    }))),
    attempts: Object.freeze(delta.attempts.map((attempt) => Object.freeze({
      canonicalJson: canonicalJson(attempt),
      queueId: attempt.queueId,
      unitId: attempt.unitId,
      nodeId: attempt.nodeId,
      nodeRefId: attempt.nodeRef.id,
      nodeRefVersion: attempt.nodeRef.version,
      fingerprint: attempt.fingerprint,
      inputDigest: attempt.inputDigest,
      executionIdentityDigest: attempt.executionIdentityDigest ?? null,
      attemptNumber: attempt.attemptNumber,
      attemptIndex: attempt.attemptIndex,
      idempotencyKey: attempt.idempotencyKey
    }))),
    cachedCompletions: Object.freeze(delta.cachedCompletions.map((completion) =>
      Object.freeze({
        canonicalJson: canonicalJson(completion),
        queueId: completion.queueId,
        attemptNumber: completion.attemptNumber,
        attemptIndex: completion.attemptIndex,
        idempotencyKey: completion.idempotencyKey,
        completionDigest: completion.completionDigest,
        startedAt: completion.startedAt,
        settledAt: completion.settledAt
      })
    )),
    failures: Object.freeze(delta.failures.map((failure) => Object.freeze({
      canonicalJson: canonicalJson(failure),
      queueId: failure.queueId,
      unitId: failure.unitId,
      nodeId: failure.nodeId,
      attemptNumber: failure.attemptNumber,
      attemptIndex: failure.attemptIndex,
      idempotencyKey: failure.idempotencyKey,
      principalId: failure.principalId,
      startedAt: failure.startedAt,
      failedAt: failure.failedAt,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
      retryable: failure.retryable,
      terminal: failure.terminal,
      usageCanonicalJson: canonicalJson(failure.usage),
      failureDigest: failure.failureDigest,
      committedOutboxDigests: failure.committedOutboxEventDigests
    }))),
    settlements: Object.freeze(delta.settlements.map((settlement) => Object.freeze({
      canonicalJson: canonicalJson(settlement),
      queueId: settlement.queueId,
      unitId: settlement.unitId,
      nodeId: settlement.nodeId,
      attemptNumber: settlement.attemptNumber,
      attemptIndex: settlement.attemptIndex,
      idempotencyKey: settlement.idempotencyKey,
      principalId: settlement.principalId,
      actorId: settlement.actorId ?? null,
      startedAt: settlement.startedAt,
      settledAt: settlement.settledAt,
      outcome: settlement.completion.outcome,
      outputContractId: settlement.completion.outputArtifact?.contractId ?? null,
      outputArtifactDigest: settlement.completion.outputArtifact?.digest ?? null,
      completionDigest: settlement.completionDigest,
      settlementDigest: settlement.settlementDigest,
      completionCanonicalJson: canonicalJson(settlement.completion),
      committedOutboxDigests: settlement.committedOutboxEventDigests
    }))),
    outbox: Object.freeze(delta.outbox.map((event) => Object.freeze({
      canonicalJson: canonicalJson(event),
      outboxEventId: event.outboxEventId,
      unitId: event.unitId,
      queueId: event.queueId ?? null,
      nodeId: event.nodeId,
      attemptNumber: event.attemptNumber ?? null,
      attemptIndex: event.attemptIndex ?? null,
      eventType: event.eventType,
      payloadCanonicalJson: canonicalJson(event.payload),
      dedupeKey: event.dedupeKey ?? null,
      eventDigest: event.eventDigest,
      recordedAt: event.recordedAt
    }))),
    deadLetters: Object.freeze(delta.deadLetters.map((record) => Object.freeze({
      canonicalJson: canonicalJson(record),
      deadLetterId: record.deadLetterId,
      unitId: record.unitId,
      queueId: record.queueId,
      nodeId: record.nodeId,
      attemptNumber: record.attemptNumber,
      attemptIndex: record.attemptIndex,
      errorCode: record.errorCode,
      failureDigest: record.failureDigest,
      principalId: record.principalId,
      recordedAt: record.recordedAt
    }))),
    leaseUpserts: Object.freeze(delta.leaseUpserts.map((entry) => Object.freeze({
      canonicalJson: canonicalJson(entry),
      queueId: entry.queueId,
      leaseOwner: entry.lease.leaseOwner,
      leaseToken: entry.lease.leaseToken,
      acquiredAt: entry.lease.acquiredAt,
      heartbeatAt: entry.lease.heartbeatAt,
      expiresAt: entry.lease.expiresAt,
      mode: entry.lease.mode,
      principalId: entry.lease.principalId,
      externalKind: entry.lease.external?.kind ?? null,
      externalActorId: entry.lease.external?.actorId ?? null,
      externalCompletionDigest: entry.lease.external?.completionDigest ?? null,
      externalOutboxDigests: entry.lease.external?.outboxEventDigests ?? null
    }))),
    leaseDeletes: Object.freeze([...delta.leaseDeletes]),
    fairnessUpserts: Object.freeze(delta.fairnessUpserts.map(encodeFairnessCursor))
  });
}

const SNAPSHOT_CANONICAL_ARRAY_KEYS = [
  "units",
  "artifacts",
  "queues",
  "journey",
  "joins",
  "attempts",
  "cachedCompletions",
  "failures",
  "settlements",
  "outbox",
  "deadLetters",
  "leases"
] as const;

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly ${wanted.join(", ")}`);
  }
}

function denseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error(`${label} must be dense`);
  }
  return value;
}

function decodeCanonicalRecords(value: unknown, label: string): readonly unknown[] {
  return Object.freeze(denseArray(value, label).map((entry, index) => {
    const row = plainRecord(entry, `${label}[${index}]`);
    exactKeys(row, ["canonicalJson"], `${label}[${index}]`);
    const text = row.canonicalJson;
    if (typeof text !== "string") {
      throw new Error(`${label}[${index}].canonicalJson must be text`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`${label}[${index}].canonicalJson is not JSON`, { cause: error });
    }
    if (canonicalJson(decoded) !== text) {
      throw new Error(`${label}[${index}].canonicalJson is not canonical`);
    }
    return decoded;
  }));
}

function decodeUnitGraphRows(
  value: unknown
): MemoryUnitStoreStateSnapshot["unitGraphs"] {
  return Object.freeze(denseArray(value, "PostgresUnitStore state.unitGraphs")
    .map((entry, index) => {
      const label = `PostgresUnitStore state.unitGraphs[${index}]`;
      const row = plainRecord(entry, label);
      exactKeys(row, ["unitId", "graphCanonicalJson"], label);
      if (typeof row.unitId !== "string" || row.unitId.length === 0) {
        throw new Error(`${label}.unitId must be non-empty text`);
      }
      if (typeof row.graphCanonicalJson !== "string") {
        throw new Error(`${label}.graphCanonicalJson must be text`);
      }
      let graph: unknown;
      try {
        graph = JSON.parse(row.graphCanonicalJson) as unknown;
      } catch (error) {
        throw new Error(`${label}.graphCanonicalJson is not JSON`, { cause: error });
      }
      if (canonicalJson(graph) !== row.graphCanonicalJson) {
        throw new Error(`${label}.graphCanonicalJson is not canonical`);
      }
      return Object.freeze({ unitId: row.unitId, graph });
    })) as MemoryUnitStoreStateSnapshot["unitGraphs"];
}

function decodeStringRows(value: unknown, label: string): readonly string[] {
  return Object.freeze(denseArray(value, label).map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${label}[${index}] must be non-empty text`);
    }
    return entry;
  }));
}

function decodeFairnessRows(value: unknown): MemoryUnitStoreStateSnapshot["fairnessCursor"] {
  return Object.freeze(denseArray(value, "PostgresUnitStore state.fairnessCursor")
    .map((entry, index) => {
      const label = `PostgresUnitStore state.fairnessCursor[${index}]`;
      const row = plainRecord(entry, label);
      exactKeys(row, [
        "nodeId",
        "nodeRefId",
        "nodeRefVersion",
        "graphId",
        "graphVersion",
        "graphDigest"
      ], label);
      const strings = ["nodeId", "nodeRefId", "graphId", "graphDigest"] as const;
      for (const key of strings) {
        if (typeof row[key] !== "string" || row[key].length === 0) {
          throw new Error(`${label}.${key} must be non-empty text`);
        }
      }
      const nodeRefVersion = row.nodeRefVersion;
      const graphVersion = row.graphVersion;
      if (!Number.isSafeInteger(nodeRefVersion) || (nodeRefVersion as number) < 1) {
        throw new Error(`${label}.nodeRefVersion must be a safe positive integer`);
      }
      if (!Number.isSafeInteger(graphVersion) || (graphVersion as number) < 1) {
        throw new Error(`${label}.graphVersion must be a safe positive integer`);
      }
      if (!/^[a-f0-9]{64}$/.test(row.graphDigest as string)) {
        throw new Error(`${label}.graphDigest must be bare lowercase SHA-256 hex`);
      }
      return Object.freeze({
        sharedNodeKey: `${row.nodeId as string}\u0000${row.nodeRefId as string}\u0000${nodeRefVersion as number}`,
        lastGraphLaneKey: `${row.graphId as string}\u0000${graphVersion as number}\u0000${row.graphDigest as string}`
      });
    }));
}

/** Decode the text-preserving normalized row bundle returned by PostgreSQL. */
export function decodePostgresUnitStateSnapshot(
  value: unknown
): MemoryUnitStoreStateSnapshot {
  const raw = plainRecord(value, "PostgresUnitStore state");
  exactKeys(raw, [
    ...SNAPSHOT_CANONICAL_ARRAY_KEYS,
    "unitGraphs",
    "fairnessCursor",
    "outboxDedupeKeys",
    "nextEnqueueSequence"
  ], "PostgresUnitStore state");
  const decoded = Object.fromEntries(SNAPSHOT_CANONICAL_ARRAY_KEYS
    .map((key) => [
      key,
      decodeCanonicalRecords(raw[key], `PostgresUnitStore state.${key}`)
    ])) as Record<string, readonly unknown[]>;
  const nextEnqueueSequence = raw.nextEnqueueSequence;
  if (!Number.isSafeInteger(nextEnqueueSequence) || (nextEnqueueSequence as number) < 1) {
    throw new Error("PostgresUnitStore state.nextEnqueueSequence must be a safe positive integer");
  }
  const outbox = decoded.outbox ?? [];
  return Object.freeze({
    schemaVersion: MEMORY_UNIT_STORE_STATE_SNAPSHOT_SCHEMA_VERSION,
    unitGraphs: decodeUnitGraphRows(raw.unitGraphs),
    units: decoded.units as MemoryUnitStoreStateSnapshot["units"],
    artifacts: decoded.artifacts as MemoryUnitStoreStateSnapshot["artifacts"],
    queues: decoded.queues as MemoryUnitStoreStateSnapshot["queues"],
    journey: decoded.journey as MemoryUnitStoreStateSnapshot["journey"],
    joins: decoded.joins as MemoryUnitStoreStateSnapshot["joins"],
    attempts: decoded.attempts as MemoryUnitStoreStateSnapshot["attempts"],
    cachedCompletions:
      decoded.cachedCompletions as MemoryUnitStoreStateSnapshot["cachedCompletions"],
    failures: decoded.failures as MemoryUnitStoreStateSnapshot["failures"],
    settlements: decoded.settlements as MemoryUnitStoreStateSnapshot["settlements"],
    outbox: outbox as MemoryUnitStoreStateSnapshot["outbox"],
    outboxDedupeKeys: decodeStringRows(
      raw.outboxDedupeKeys,
      "PostgresUnitStore state.outboxDedupeKeys"
    ),
    deadLetters: decoded.deadLetters as MemoryUnitStoreStateSnapshot["deadLetters"],
    leases: decoded.leases as MemoryUnitStoreStateSnapshot["leases"],
    fairnessCursor: decodeFairnessRows(raw.fairnessCursor),
    nextEnqueueSequence: nextEnqueueSequence as number
  });
}
