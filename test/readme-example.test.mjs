// The README quick start (steps 3-5), run as written against a fresh schema.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { createGraphDefinition, graphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import { runNextUnitTurn } from "@scshafe/switchyard/execute/unit-runner";
import { assertSchemaCurrent, createPostgresStores } from "@scshafe/switchyard-postgres";

import { closeAdmin, openScenarioDatabase } from "./support/postgres.mjs";

after(closeAdmin);

test("README quick start: draft, human review, publish, inspect", async () => {
  const database = await openScenarioDatabase("readme");
  try {
    const pool = database.runtimePool;
    await assertSchemaCurrent({ pool: database.ownerPool });
    const { graphStore, unitStore, humanDecisions } = createPostgresStores({ pool });

    const turn = {
      idempotency: "per (unitId, nodeId, attemptNumber)",
      leaseMs: 30_000,
      maxAttempts: 3,
      retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
    };
    const graph = createGraphDefinition({
      graphId: "answers",
      version: 1,
      description: "Draft an answer, have a person review it, publish it.",
      entry: "draft",
      nodes: [
        { nodeId: "draft", ref: { id: "answers.draft", version: 1 }, kind: "code",
          input: "question.v1", outcomes: { version: 1, outcomes: ["drafted"] },
          principal: { id: "worker" }, turn },
        { nodeId: "review", ref: { id: "answers.review", version: 1 }, kind: "human",
          input: "question.v1", outcomes: { version: 1, outcomes: ["approved", "rejected"] },
          principal: { id: "reviewer" }, turn },
        { nodeId: "publish", ref: { id: "answers.publish", version: 1 }, kind: "code",
          input: "question.v1", outcomes: { version: 1, outcomes: ["published"] },
          principal: { id: "worker" }, turn }
      ],
      edges: [
        { edgeId: "draft-review", from: "draft", when: { outcome: "drafted" }, to: ["review"] },
        { edgeId: "review-publish", from: "review", when: { outcome: "approved" }, to: ["publish"] }
      ],
      terminals: [
        { nodeId: "review", outcome: "rejected" },
        { nodeId: "publish", outcome: "published" }
      ]
    });

    await graphStore.publishGraph(graph);
    await graphStore.publishGraph(graph);
    await unitStore.admitUnit({
      unitId: "question-42",
      graph: graphDefinitionRef(graph),
      seedArtifact: createArtifactEnvelope("question.v1", { text: "What is a switchyard?" }),
      admittedAt: new Date().toISOString(),
      principalId: "admitter"
    });
    const drafted = await runNextUnitTurn({
      store: unitStore,
      principalId: "worker",
      leaseOwner: "worker-1",
      ports: { code: { run: async () => ({ outcome: "drafted" }) } }
    });
    assert.equal(drafted.status, "succeeded");

    const [pending] = await humanDecisions.listPending({ principalId: "reviewer" });
    assert.deepEqual(pending.inputArtifact.payload, { text: "What is a switchyard?" });
    await humanDecisions.record({ queueId: pending.queueId, outcome: "approved", actorId: "alice" });
    const decisions = await humanDecisions.listDecisions({ unitId: "question-42" });
    assert.deepEqual(decisions.map((decision) => [decision.nodeId, decision.outcome, decision.actorId]), [
      ["review", "approved", "alice"]
    ]);

    const published = await runNextUnitTurn({
      store: unitStore,
      principalId: "worker",
      leaseOwner: "worker-1",
      ports: { code: { run: async () => ({ outcome: "published" }) } }
    });
    assert.equal(published.status, "succeeded");
    // Nothing is left for the worker; an idle poll skips the serialized claim.
    assert.equal(await unitStore.hasClaimableWorkerTurns("worker"), false);

    const watched = await database.readerPool.query(`
      SELECT node_id, status, outcome, actor_id, attempts::int AS attempts
      FROM switchyard.turns WHERE unit_id = 'question-42' ORDER BY enqueue_sequence
    `);
    assert.deepEqual(watched.rows, [
      { node_id: "draft", status: "settled", outcome: "drafted", actor_id: null, attempts: 1 },
      { node_id: "review", status: "settled", outcome: "approved", actor_id: "alice", attempts: 1 },
      { node_id: "publish", status: "settled", outcome: "published", actor_id: null, attempts: 1 }
    ]);
    assert.equal((await database.readerPool.query("SELECT * FROM switchyard.pending_human_turns")).rows.length, 0);
  } finally {
    await database.close();
  }
});
