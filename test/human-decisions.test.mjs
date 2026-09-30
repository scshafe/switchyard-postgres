// Human-decision recording: pending listing, decisions, routing, ledger.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { createGraphDefinition, graphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import { runNextUnitTurn } from "@scshafe/switchyard/execute/unit-runner";
import {
  HumanTurnNotPendingError,
  PostgresHumanDecisions,
  createPostgresStores
} from "@scshafe/switchyard-postgres";

import { closeAdmin, openScenarioDatabase } from "./support/postgres.mjs";

after(closeAdmin);

const TURN = {
  idempotency: "per (unitId, nodeId, attemptNumber)",
  leaseMs: 30_000,
  maxAttempts: 2,
  retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
};

function node(nodeId, kind, outcomes, extra = {}) {
  return {
    nodeId,
    ref: { id: `review-graph.${nodeId}`, version: 1 },
    kind,
    input: extra.input ?? "draft.v1",
    outcomes: { version: 1, outcomes },
    principal: { id: kind === "human" ? "reviewer" : "worker" },
    turn: TURN,
    ...(extra.outputs === undefined ? {} : { outputs: extra.outputs })
  };
}

// write (code) -> review (human) -> publish (code); rejected ends the unit.
function reviewGraph(graphId = "review-graph", reviewOutputs) {
  return createGraphDefinition({
    graphId,
    version: 1,
    description: "A drafted answer is reviewed by a person before it is published.",
    entry: "write",
    nodes: [
      node("write", "code", ["drafted"]),
      node("review", "human", ["approved", "rejected"], reviewOutputs === undefined ? {} : { outputs: reviewOutputs }),
      node("publish", "code", ["published"], reviewOutputs === undefined ? {} : { input: "review-note.v1" })
    ],
    edges: [
      { edgeId: "write-review", from: "write", when: { outcome: "drafted" }, to: ["review"] },
      { edgeId: "review-publish", from: "review", when: { outcome: "approved" }, to: ["publish"] }
    ],
    terminals: [
      { nodeId: "review", outcome: "rejected" },
      { nodeId: "publish", outcome: "published" }
    ]
  });
}

async function setup(graph = reviewGraph()) {
  const database = await openScenarioDatabase("human");
  let epoch = Date.parse("2026-09-29T12:00:00.000Z");
  const now = () => new Date(epoch);
  const stores = createPostgresStores({ pool: database.runtimePool, now });
  await stores.graphStore.publishGraph(graph);
  const admit = (unitId, draft) => stores.unitStore.admitUnit({
    unitId,
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope("draft.v1", { draft }),
    admittedAt: now().toISOString(),
    principalId: "admitter"
  });
  const runWorker = (nodeId, outcome) => runNextUnitTurn({
    store: stores.unitStore,
    principalId: "worker",
    leaseOwner: "test-worker",
    nodeId,
    ports: { code: { run: async () => ({ outcome }) } },
    now
  });
  return {
    database,
    stores,
    decisions: stores.humanDecisions,
    admit,
    runWorker,
    tick(ms) {
      epoch += ms;
    },
    close: () => database.close()
  };
}

test("a pending human turn is listed, decided, routed and recorded", async () => {
  const ctx = await setup();
  try {
    assert.deepEqual(await ctx.decisions.listPending(), []);
    await ctx.admit("unit-1", "first answer");
    assert.equal((await ctx.runWorker("write", "drafted")).status, "succeeded");

    const [pending, ...rest] = await ctx.decisions.listPending();
    assert.equal(rest.length, 0);
    assert.equal(pending.unitId, "unit-1");
    assert.equal(pending.nodeId, "review");
    assert.equal(pending.principalId, "reviewer");
    assert.deepEqual(pending.outcomes, ["approved", "rejected"]);
    assert.deepEqual(pending.inputArtifact.payload, { draft: "first answer" });
    assert.equal(pending.graph.id, "review-graph");
    assert.equal(pending.claimedBy, undefined);
    assert.deepEqual(await ctx.decisions.inspect(pending.queueId), pending);

    ctx.tick(5_000);
    const recorded = await ctx.decisions.record({
      queueId: pending.queueId,
      outcome: "approved",
      actorId: "alice@example.test"
    });
    assert.equal(recorded.result.status, "succeeded");
    assert.equal(recorded.result.completion.outcome, "approved");
    assert.equal(recorded.turn.queueId, pending.queueId);

    assert.deepEqual(await ctx.decisions.listPending(), []);
    assert.equal(await ctx.decisions.inspect(pending.queueId), undefined);
    const [decision] = await ctx.decisions.listDecisions({ unitId: "unit-1" });
    assert.equal(decision.queueId, pending.queueId);
    assert.equal(decision.actorId, "alice@example.test");
    assert.equal(decision.outcome, "approved");
    assert.equal(decision.principalId, "reviewer");
    assert.equal(decision.settledAt, "2026-09-29T12:00:05.000Z");
    assert.equal(decision.outputArtifact, undefined);

    // The approval routed the unit to publish.
    const queued = await ctx.stores.unitStore.listQueuedUnits({ principalId: "worker", nodeId: "publish" });
    assert.deepEqual(queued.map((turn) => turn.unitId), ["unit-1"]);
    const journey = await ctx.stores.unitStore.readJourney({ unitId: "unit-1" });
    const settled = journey.find((record) => record.kind === "turn_settled" && record.nodeId === "review");
    assert.equal(settled.actorId, "alice@example.test");

    // Operators see the same thing through the reader role's views.
    const view = await ctx.database.readerPool.query(`
      SELECT node_id, status, outcome, actor_id FROM switchyard.turns
      WHERE unit_id = 'unit-1' ORDER BY enqueue_sequence
    `);
    assert.deepEqual(view.rows, [
      { node_id: "write", status: "settled", outcome: "drafted", actor_id: null },
      { node_id: "review", status: "settled", outcome: "approved", actor_id: "alice@example.test" },
      { node_id: "publish", status: "queued", outcome: null, actor_id: null }
    ]);
    const ledger = await ctx.database.readerPool.query(
      "SELECT unit_id, node_id, actor_id, outcome FROM switchyard.human_decisions"
    );
    assert.deepEqual(ledger.rows, [
      { unit_id: "unit-1", node_id: "review", actor_id: "alice@example.test", outcome: "approved" }
    ]);
  } finally {
    await ctx.close();
  }
});

test("a rejected decision ends the unit at the review terminal", async () => {
  const ctx = await setup();
  try {
    await ctx.admit("unit-rejected", "weak answer");
    await ctx.runWorker("write", "drafted");
    const [pending] = await ctx.decisions.listPending();
    await ctx.decisions.record({ queueId: pending.queueId, outcome: "rejected", actorId: "bob" });
    assert.deepEqual(
      await ctx.stores.unitStore.listQueuedUnits({ principalId: "worker", nodeId: "publish" }),
      []
    );
    const [decision] = await ctx.decisions.listDecisions();
    assert.equal(decision.outcome, "rejected");
    assert.equal(decision.actorId, "bob");
  } finally {
    await ctx.close();
  }
});

test("an outcome outside the node's vocabulary is refused and the turn stays pending", async () => {
  const ctx = await setup();
  try {
    await ctx.admit("unit-bad-outcome", "answer");
    await ctx.runWorker("write", "drafted");
    const [pending] = await ctx.decisions.listPending();
    await assert.rejects(
      ctx.decisions.record({ queueId: pending.queueId, outcome: "maybe", actorId: "carol" }),
      /maybe/
    );
    const [still] = await ctx.decisions.listPending();
    assert.equal(still.queueId, pending.queueId);
    assert.deepEqual(await ctx.decisions.listDecisions(), []);
  } finally {
    await ctx.close();
  }
});

test("deciding a turn twice, or a turn that is not a pending human turn, is refused", async () => {
  const ctx = await setup();
  try {
    await ctx.admit("unit-twice", "answer");
    await ctx.runWorker("write", "drafted");
    const [pending] = await ctx.decisions.listPending();
    await ctx.decisions.record({ queueId: pending.queueId, outcome: "approved", actorId: "dana" });
    await assert.rejects(
      ctx.decisions.record({ queueId: pending.queueId, outcome: "rejected", actorId: "erin" }),
      HumanTurnNotPendingError
    );
    await assert.rejects(
      ctx.decisions.record({ queueId: "00000000-0000-4000-8000-000000000000", outcome: "approved", actorId: "erin" }),
      HumanTurnNotPendingError
    );
    // The publish turn is a code turn, never a pending human turn.
    const [publishTurn] = await ctx.stores.unitStore.listQueuedUnits({ principalId: "worker", nodeId: "publish" });
    assert.equal(await ctx.decisions.inspect(publishTurn.queueId), undefined);
    assert.equal(await ctx.decisions.inspect("not-a-uuid"), undefined);
    assert.equal((await ctx.decisions.listDecisions()).length, 1);
  } finally {
    await ctx.close();
  }
});

test("pending turns page in FIFO order and filter by principal, node and graph", async () => {
  const ctx = await setup();
  try {
    for (const unitId of ["u-a", "u-b", "u-c"]) {
      await ctx.admit(unitId, unitId);
      await ctx.runWorker("write", "drafted");
    }
    const all = await ctx.decisions.listPending();
    assert.deepEqual(all.map((turn) => turn.unitId), ["u-a", "u-b", "u-c"]);
    const firstPage = await ctx.decisions.listPending({ limit: 2 });
    assert.deepEqual(firstPage.map((turn) => turn.unitId), ["u-a", "u-b"]);
    const secondPage = await ctx.decisions.listPending({
      limit: 2,
      afterEnqueueSequence: firstPage[1].enqueueSequence
    });
    assert.deepEqual(secondPage.map((turn) => turn.unitId), ["u-c"]);
    assert.equal((await ctx.decisions.listPending({ principalId: "reviewer", nodeId: "review", graphId: "review-graph" })).length, 3);
    assert.deepEqual(await ctx.decisions.listPending({ principalId: "someone-else" }), []);
    assert.deepEqual(await ctx.decisions.listPending({ nodeId: "write" }), []);
    await assert.rejects(ctx.decisions.listPending({ limit: 0 }), RangeError);
    await assert.rejects(ctx.decisions.listPending({ limit: 1001 }), RangeError);

    await ctx.decisions.record({ queueId: all[1].queueId, outcome: "approved", actorId: "frank" });
    await ctx.decisions.record({ queueId: all[0].queueId, outcome: "rejected", actorId: "grace" });
    const decisions = await ctx.decisions.listDecisions();
    assert.deepEqual(decisions.map((decision) => decision.unitId), ["u-b", "u-a"]);
    const later = await ctx.decisions.listDecisions({ afterDecisionSequence: decisions[0].decisionSequence });
    assert.deepEqual(later.map((decision) => decision.unitId), ["u-a"]);
    assert.deepEqual((await ctx.decisions.listPending()).map((turn) => turn.unitId), ["u-c"]);
  } finally {
    await ctx.close();
  }
});

test("a declared output contract requires the decision to carry that artifact", async () => {
  const graph = reviewGraph("review-graph-with-note", { approved: "review-note.v1" });
  const ctx = await setup(graph);
  try {
    await ctx.admit("unit-note", "answer");
    await ctx.runWorker("write", "drafted");
    const [pending] = await ctx.decisions.listPending();
    await assert.rejects(
      ctx.decisions.record({ queueId: pending.queueId, outcome: "approved", actorId: "heidi" })
    );
    const note = createArtifactEnvelope("review-note.v1", { note: "ship it", reviewer: "heidi" });
    const recorded = await ctx.decisions.record({
      queueId: pending.queueId,
      outcome: "approved",
      actorId: "heidi",
      outputArtifact: note
    });
    assert.equal(recorded.result.status, "succeeded");
    const [decision] = await ctx.decisions.listDecisions();
    assert.deepEqual(decision.outputArtifact, { contractId: "review-note.v1", digest: note.digest });
    const [publishTurn] = await ctx.stores.unitStore.listQueuedUnits({ principalId: "worker", nodeId: "publish" });
    assert.deepEqual(publishTurn.inputArtifact.payload, { note: "ship it", reviewer: "heidi" });
  } finally {
    await ctx.close();
  }
});

test("a decision in progress shows who claimed it, and the recorder checks its schema", async () => {
  const ctx = await setup();
  try {
    await ctx.admit("unit-claimed", "answer");
    await ctx.runWorker("write", "drafted");
    const [pending] = await ctx.decisions.listPending();
    // Claim without settling: the external lease is visible as claimedBy.
    const claim = await ctx.stores.unitStore.claimExternalUnitTurn({
      principalId: "reviewer",
      kind: "human",
      queueId: pending.queueId,
      unitId: pending.unitId,
      nodeId: pending.nodeId,
      actorId: "ivan",
      completionDigest: "a".repeat(64),
      outboxEventDigests: []
    });
    assert.equal(claim.disposition, "claimed");
    const [claimed] = await ctx.decisions.listPending();
    assert.equal(claimed.claimedBy, "ivan");
    assert.equal(typeof claimed.claimedAt, "string");
    assert.throws(
      () => new PostgresHumanDecisions({ pool: ctx.database.runtimePool, schema: "other", unitStore: ctx.stores.unitStore }),
      /same schema/
    );
  } finally {
    await ctx.close();
  }
});
