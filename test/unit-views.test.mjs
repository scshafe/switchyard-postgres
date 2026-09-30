// unit_status, unit_positions and unit_outputs, read as the reader login.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { ExecutionFailureError } from "@scshafe/switchyard/execute/failure";
import { createGraphDefinition, graphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import { runNextUnitTurn } from "@scshafe/switchyard/execute/unit-runner";
import { createPostgresStores } from "@scshafe/switchyard-postgres";

import { closeAdmin, openScenarioDatabase } from "./support/postgres.mjs";

after(closeAdmin);

const TURN = {
  idempotency: "per (unitId, nodeId, attemptNumber)",
  leaseMs: 30_000,
  maxAttempts: 1,
  retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
};

// write (code, emits draft.v1 on drafted) -> check (human); write may give up.
function viewsGraph() {
  return createGraphDefinition({
    graphId: "views.graph",
    version: 1,
    description: "Write a draft and have a person check it.",
    entry: "write",
    nodes: [
      {
        nodeId: "write",
        ref: { id: "views.write", version: 1 },
        kind: "code",
        input: "question.v1",
        outcomes: { version: 1, outcomes: ["drafted", "gave_up"] },
        outputs: { drafted: "draft.v1" },
        principal: { id: "worker" },
        turn: TURN
      },
      {
        nodeId: "check",
        ref: { id: "views.check", version: 1 },
        kind: "human",
        input: "draft.v1",
        outcomes: { version: 1, outcomes: ["ship", "hold"] },
        principal: { id: "checker" },
        turn: TURN
      }
    ],
    edges: [{ edgeId: "write-check", from: "write", when: { outcome: "drafted" }, to: ["check"] }],
    terminals: [
      { nodeId: "write", outcome: "gave_up" },
      { nodeId: "check", outcome: "ship" },
      { nodeId: "check", outcome: "hold" }
    ]
  });
}

// A payload with a NUL (canonical escape \u0000) and a literal backslash-u0000.
const DRAFT = { text: "a\u0000b", literal: "\\u0000", n: 1 };

test("unit views show status, final outcome, queue positions and outputs to the reader", async () => {
  const database = await openScenarioDatabase("views");
  try {
    const graph = viewsGraph();
    const { graphStore, unitStore, humanDecisions } = createPostgresStores({ pool: database.runtimePool });
    await graphStore.publishGraph(graph);
    const seeds = new Map();
    const admit = async (unitId) => {
      const seed = createArtifactEnvelope("question.v1", { unitId });
      seeds.set(unitId, seed);
      await unitStore.admitUnit({
        unitId,
        graph: graphDefinitionRef(graph),
        seedArtifact: seed,
        admittedAt: new Date().toISOString(),
        principalId: "admitter"
      });
    };
    const draft = createArtifactEnvelope("draft.v1", DRAFT);
    const runWrite = (body) => runNextUnitTurn({
      store: unitStore,
      principalId: "worker",
      leaseOwner: "views-worker",
      ports: { code: { run: body } }
    });

    await admit("u-human");
    assert.equal((await runWrite(async () => ({ outcome: "drafted", outputArtifact: draft }))).status, "succeeded");
    await admit("u-done");
    await runWrite(async () => ({ outcome: "drafted", outputArtifact: draft }));
    await humanDecisions.recordAnswer({ unitId: "u-done", nodeId: "check", answer: "ship", actorId: "carol" });
    await admit("u-failed");
    const failed = await runWrite(async () => {
      throw new ExecutionFailureError("views.broken", false);
    });
    assert.notEqual(failed.status, "succeeded");
    await admit("u-gave-up");
    await runWrite(async () => ({ outcome: "gave_up" }));
    await admit("u-open-1");
    await admit("u-open-2");

    const reader = database.readerPool;
    const status = await reader.query(`
      SELECT unit_id, status, open_turns::int, open_human_turns::int, settled_turns::int,
        dead_turns::int, final_node_id, final_outcome, final_actor_id, final_contract_id,
        final_artifact_digest, finished_at IS NOT NULL AS finished,
        admitted_by, graph_id, last_activity_at IS NOT NULL AS active_at
      FROM switchyard.unit_status ORDER BY admitted_at, unit_id
    `);
    const byUnit = Object.fromEntries(status.rows.map((row) => [row.unit_id, row]));
    const common = { admitted_by: "admitter", graph_id: "views.graph", active_at: true };
    assert.deepEqual(byUnit["u-human"], {
      ...common, unit_id: "u-human", status: "awaiting_human", open_turns: 1, open_human_turns: 1,
      settled_turns: 1, dead_turns: 0, final_node_id: null, final_outcome: null, final_actor_id: null,
      final_contract_id: null, final_artifact_digest: null, finished: false
    });
    assert.deepEqual(byUnit["u-done"], {
      ...common, unit_id: "u-done", status: "completed", open_turns: 0, open_human_turns: 0,
      settled_turns: 2, dead_turns: 0, final_node_id: "check", final_outcome: "ship", final_actor_id: "carol",
      // The person returned no artifact, so the draft carried on is the result.
      final_contract_id: "draft.v1", final_artifact_digest: draft.digest, finished: true
    });
    assert.deepEqual(byUnit["u-failed"], {
      ...common, unit_id: "u-failed", status: "failed", open_turns: 0, open_human_turns: 0,
      settled_turns: 0, dead_turns: 1, final_node_id: null, final_outcome: null, final_actor_id: null,
      final_contract_id: null, final_artifact_digest: null, finished: false
    });
    assert.deepEqual(byUnit["u-gave-up"], {
      ...common, unit_id: "u-gave-up", status: "completed", open_turns: 0, open_human_turns: 0,
      settled_turns: 1, dead_turns: 0, final_node_id: "write", final_outcome: "gave_up", final_actor_id: null,
      final_contract_id: "question.v1", final_artifact_digest: seeds.get("u-gave-up").digest, finished: true
    });
    for (const unitId of ["u-open-1", "u-open-2"]) {
      assert.equal(byUnit[unitId].status, "active");
      assert.equal(byUnit[unitId].open_turns, 1);
    }

    const positions = await reader.query(`
      SELECT unit_id, node_id, node_kind::text AS node_kind, principal_id, state,
        queue_position::int, attempts::int, failed_attempts::int, last_error_code, claimed_by
      FROM switchyard.unit_positions ORDER BY enqueue_sequence
    `);
    assert.deepEqual(positions.rows, [
      { unit_id: "u-human", node_id: "check", node_kind: "human", principal_id: "checker", state: "queued",
        queue_position: 1, attempts: 0, failed_attempts: 0, last_error_code: null, claimed_by: null },
      { unit_id: "u-open-1", node_id: "write", node_kind: "code", principal_id: "worker", state: "queued",
        queue_position: 1, attempts: 0, failed_attempts: 0, last_error_code: null, claimed_by: null },
      { unit_id: "u-open-2", node_id: "write", node_kind: "code", principal_id: "worker", state: "queued",
        queue_position: 2, attempts: 0, failed_attempts: 0, last_error_code: null, claimed_by: null }
    ]);
    // Filtering by unit keeps the lane-wide position.
    const one = await reader.query(
      "SELECT queue_position::int FROM switchyard.unit_positions WHERE unit_id = 'u-open-2'"
    );
    assert.deepEqual(one.rows, [{ queue_position: 2 }]);

    const outputs = await reader.query(`
      SELECT unit_id, node_id, outcome, contract_id, artifact_digest, envelope, payload
      FROM switchyard.unit_outputs ORDER BY settlement_sequence
    `);
    assert.deepEqual(outputs.rows.map((row) => [row.unit_id, row.node_id, row.outcome, row.contract_id, row.artifact_digest]), [
      ["u-human", "write", "drafted", "draft.v1", draft.digest],
      ["u-done", "write", "drafted", "draft.v1", draft.digest]
    ]);
    // The envelope is the exact canonical text; the jsonb payload projection
    // spells the NUL as the six characters \u0000 and keeps the rest intact.
    assert.deepEqual(JSON.parse(outputs.rows[0].envelope).payload, DRAFT);
    assert.deepEqual(outputs.rows[0].payload, { text: "a\\u0000b", literal: "\\u0000", n: 1 });

    // The runtime role reads none of the views.
    for (const view of ["unit_status", "unit_positions", "unit_outputs"]) {
      await assert.rejects(
        database.runtimePool.query(`SELECT * FROM switchyard.${view}`),
        (error) => error.code === "42501",
        view
      );
    }
  } finally {
    await database.close();
  }
});

test("a claimed human turn shows as leased with its claimant", async () => {
  const database = await openScenarioDatabase("views");
  try {
    const graph = viewsGraph();
    const { graphStore, unitStore, humanDecisions } = createPostgresStores({ pool: database.runtimePool });
    await graphStore.publishGraph(graph);
    await unitStore.admitUnit({
      unitId: "u-claimed",
      graph: graphDefinitionRef(graph),
      seedArtifact: createArtifactEnvelope("question.v1", { unitId: "u-claimed" }),
      admittedAt: new Date().toISOString(),
      principalId: "admitter"
    });
    await runNextUnitTurn({
      store: unitStore,
      principalId: "worker",
      leaseOwner: "views-worker",
      ports: { code: { run: async () => ({ outcome: "drafted", outputArtifact: createArtifactEnvelope("draft.v1", { n: 2 }) }) } }
    });
    const [pending] = await humanDecisions.listPending({ unitId: "u-claimed" });
    const claim = await unitStore.claimExternalUnitTurn({
      principalId: "checker",
      kind: "human",
      queueId: pending.queueId,
      unitId: pending.unitId,
      nodeId: pending.nodeId,
      actorId: "dave",
      completionDigest: "b".repeat(64),
      outboxEventDigests: []
    });
    assert.equal(claim.disposition, "claimed");
    const positions = await database.readerPool.query(
      "SELECT node_id, state, lease_mode::text AS lease_mode, claimed_by FROM switchyard.unit_positions"
    );
    assert.deepEqual(positions.rows, [{ node_id: "check", state: "leased", lease_mode: "external", claimed_by: "dave" }]);
    const status = await database.readerPool.query("SELECT status FROM switchyard.unit_status");
    assert.deepEqual(status.rows, [{ status: "awaiting_human" }]);
  } finally {
    await database.close();
  }
});
