// A real crash: the settle transaction's backend is terminated by the server
// mid-settle (pre-commit) or right after COMMIT. PostgreSQL must leave either
// no trace or the whole settle, and the engine's recovery must converge on
// exactly one settlement without re-running the node body.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { createGraphDefinition, graphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import {
  runClaimedUnitTurn,
  TurnSettlementUncertainError
} from "@scshafe/switchyard/execute/unit-runner";
import { PostgresGraphStore, PostgresUnitStore } from "@scshafe/switchyard-postgres";

import { readEvidence } from "./support/evidence.mjs";
import { closeAdmin, openScenarioDatabase } from "./support/postgres.mjs";

after(closeAdmin);

const TURN = {
  idempotency: "per (unitId, nodeId, attemptNumber)",
  leaseMs: 1_000,
  maxAttempts: 3,
  retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
};

const graph = createGraphDefinition({
  graphId: "crash.linear",
  version: 1,
  description: "Two code nodes; the first one's settle is crashed.",
  entry: "first",
  nodes: ["first", "second"].map((nodeId) => ({
    nodeId,
    ref: { id: `crash.${nodeId}`, version: 1 },
    kind: "code",
    input: "crash-input.v1",
    outcomes: { version: 1, outcomes: ["done"] },
    principal: { id: "worker" },
    turn: TURN
  })),
  edges: [{ edgeId: "first-second", from: "first", when: { outcome: "done" }, to: ["second"] }],
  terminals: [{ nodeId: "second", outcome: "done" }]
});

for (const checkpoint of ["successor_enqueue", "post_commit_reply"]) {
  test(`terminating the backend at ${checkpoint} is exactly-once`, async () => {
    const database = await openScenarioDatabase("crash");
    let epoch = Date.parse("2026-09-29T08:00:00.000Z");
    const now = () => new Date(epoch);
    let armed = checkpoint;
    let terminated = false;
    const unitStore = new PostgresUnitStore({
      pool: database.runtimePool,
      now,
      settleCheckpoint: async (hit, { backendPid }) => {
        if (hit !== armed) return;
        armed = undefined;
        const result = await database.ownerPool.query(
          "SELECT pg_terminate_backend($1) AS terminated", [backendPid]
        );
        terminated = result.rows[0].terminated === true || hit === "post_commit_reply";
        if (hit === "post_commit_reply") {
          throw new Error("simulated reply loss after COMMIT");
        }
      }
    });
    try {
      await new PostgresGraphStore({ pool: database.runtimePool }).publishGraph(graph);
      await unitStore.admitUnit({
        unitId: `unit-${checkpoint}`,
        graph: graphDefinitionRef(graph),
        seedArtifact: createArtifactEnvelope("crash-input.v1", { n: 1 }),
        admittedAt: now().toISOString(),
        principalId: "admitter"
      });
      const [claim] = await unitStore.claimUnitTurns({
        principalId: "worker", leaseOwner: "crash-worker", batch: 1, nodeId: "first"
      });
      let bodyCalls = 0;
      const ports = {
        code: {
          run: async () => {
            bodyCalls += 1;
            return { outcome: "done", outputArtifact: createArtifactEnvelope("crash-input.v1", { n: 2 }) };
          }
        }
      };
      await assert.rejects(
        runClaimedUnitTurn({ store: unitStore, claim, principalId: "worker", ports, now }),
        (error) => error instanceof TurnSettlementUncertainError
      );
      assert.equal(terminated, true);

      const crashed = await readEvidence(database.readerPool);
      const committed = checkpoint === "post_commit_reply";
      assert.equal(crashed.settlements.length, committed ? 1 : 0);
      assert.equal(crashed.queues.filter((queue) => queue.nodeId === "second").length, committed ? 1 : 0);
      assert.equal(crashed.cachedCompletions.length, 1, "the completion was cached before settling");

      // Recovery: the lease expires, the turn is reclaimed, and the cached
      // completion settles it without calling the body again.
      epoch += TURN.leaseMs + 1;
      if (!committed) {
        const [reclaimed] = await unitStore.claimUnitTurns({
          principalId: "worker", leaseOwner: "crash-worker-2", batch: 1, nodeId: "first"
        });
        const replay = await runClaimedUnitTurn({ store: unitStore, claim: reclaimed, principalId: "worker", ports, now });
        assert.equal(replay.status, "succeeded");
        assert.equal(replay.reused, true);
      } else {
        assert.deepEqual(
          await unitStore.claimUnitTurns({ principalId: "worker", leaseOwner: "late", batch: 1, nodeId: "first" }),
          []
        );
      }
      const final = await readEvidence(database.readerPool);
      assert.equal(bodyCalls, 1);
      assert.equal(final.settlements.length, 1);
      assert.equal(final.queues.filter((queue) => queue.nodeId === "second").length, 1);
      assert.equal(final.leases.length, 0);
    } finally {
      await database.close();
    }
  });
}
