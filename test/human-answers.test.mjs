// Answer-level recording: a person's answer at ordinary, approval and review
// nodes, mapped to the stored outcome by the engine's own helper.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { withApprovalReviewPorts } from "@scshafe/switchyard/execute/approval-review";
import { createGraphDefinition, graphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import { runNextUnitTurn } from "@scshafe/switchyard/execute/unit-runner";
import {
  HumanTurnNotPendingError,
  InvalidHumanAnswerError,
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

// An ordinary human node whose outcomes are declared out of lexical order.
function questionGraph() {
  return createGraphDefinition({
    graphId: "answers.question",
    version: 1,
    description: "A person answers a yes/no question.",
    entry: "ask",
    nodes: [{
      nodeId: "ask",
      ref: { id: "answers.question.ask", version: 1 },
      kind: "human",
      input: "question.v1",
      outcomes: { version: 1, outcomes: ["yes", "no"] },
      principal: { id: "console" },
      turn: TURN
    }],
    edges: [],
    terminals: [{ nodeId: "ask", outcome: "yes" }, { nodeId: "ask", outcome: "no" }]
  });
}

// draft needs a person's approval before it runs and a person's review after.
function reviewedGraph() {
  return createGraphDefinition({
    graphId: "answers.reviewed",
    version: 1,
    description: "Draft an answer after approval; a reviewer accepts it or sends it back once.",
    entry: "draft",
    nodes: [
      {
        nodeId: "draft",
        ref: { id: "answers.reviewed.draft", version: 1 },
        kind: "code",
        input: "question.v1",
        outcomes: { version: 1, outcomes: ["drafted"] },
        outputs: { drafted: "answer.v1" },
        principal: { id: "worker" },
        turn: TURN,
        approval: { by: { kind: "human", principal: { id: "approver" } }, onDeny: "terminal" },
        review: { by: { kind: "human", principal: { id: "reviewer" } }, onReject: "terminal", maxRounds: 2 }
      },
      {
        nodeId: "publish",
        ref: { id: "answers.reviewed.publish", version: 1 },
        kind: "code",
        input: "answer.v1",
        outcomes: { version: 1, outcomes: ["published"] },
        principal: { id: "worker" },
        turn: TURN
      }
    ],
    edges: [{ edgeId: "draft-publish", from: "draft", when: { outcome: "drafted" }, to: ["publish"] }],
    terminals: [{ nodeId: "publish", outcome: "published" }]
  });
}

async function setup(graph) {
  const database = await openScenarioDatabase("answer");
  const stores = createPostgresStores({ pool: database.runtimePool });
  await stores.graphStore.publishGraph(graph);
  const admit = (unitId) => stores.unitStore.admitUnit({
    unitId,
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope("question.v1", { text: `question of ${unitId}` }),
    admittedAt: new Date().toISOString(),
    principalId: "admitter"
  });
  let drafts = 0;
  const ports = withApprovalReviewPorts({
    code: {
      async run(_input, context) {
        if (context.nodeId === "publish") return { outcome: "published" };
        drafts += 1;
        return {
          outcome: "drafted",
          outputArtifact: createArtifactEnvelope("answer.v1", { text: `draft ${drafts} (${context.nodeId})` })
        };
      }
    }
  }, { graphs: [graph] });
  const runWorker = () => runNextUnitTurn({
    store: stores.unitStore,
    principalId: "worker",
    leaseOwner: "answers-worker",
    ports
  });
  return { database, stores, decisions: stores.humanDecisions, admit, runWorker, close: () => database.close() };
}

test("an ordinary human node lists its outcomes in declared order and records answers as given", async () => {
  const ctx = await setup(questionGraph());
  try {
    await ctx.admit("q-1");
    const [pending] = await ctx.decisions.listPending({ principalId: "console" });
    assert.deepEqual(pending.outcomes, ["yes", "no"]);
    assert.deepEqual(pending.answers, ["yes", "no"]);
    assert.deepEqual(pending.notesAnswers, []);
    assert.equal(pending.role, undefined);
    assert.deepEqual(await ctx.decisions.inspect(pending.queueId), pending);

    await assert.rejects(
      ctx.decisions.recordAnswer({ unitId: "q-1", nodeId: "ask", answer: "maybe", actorId: "alice" }),
      (error) => error instanceof InvalidHumanAnswerError
        && error.code === "human_answer_invalid"
        && /valid answers: yes, no\)$/.test(error.message)
        && error.answer === "maybe"
        && error.validAnswers.join() === "yes,no"
    );
    await assert.rejects(
      ctx.decisions.recordAnswer({ unitId: "q-1", nodeId: "ask", answer: "no", notes: "why", actorId: "alice" }),
      /this node records no notes \(node ask of unit q-1; valid answers: yes, no\)/
    );
    await assert.rejects(
      ctx.decisions.recordAnswer({ unitId: "q-1", nodeId: "ask", answer: "no", actorId: "alice", principalId: "someone-else" }),
      /decided under principal console, not someone-else/
    );
    assert.deepEqual(await ctx.decisions.listDecisions(), []);

    const recorded = await ctx.decisions.recordAnswer({ unitId: "q-1", nodeId: "ask", answer: "no", actorId: "alice", principalId: "console" });
    assert.equal(recorded.answer, "no");
    assert.equal(recorded.outcome, "no");
    assert.equal(recorded.result.status, "succeeded");
    assert.equal(recorded.turn.queueId, pending.queueId);
    assert.deepEqual((await ctx.decisions.listDecisions()).map((decision) => [decision.outcome, decision.actorId]), [["no", "alice"]]);

    await assert.rejects(
      ctx.decisions.recordAnswer({ unitId: "q-1", nodeId: "ask", answer: "yes", actorId: "bob" }),
      (error) => error instanceof HumanTurnNotPendingError && error.unitId === "q-1" && error.nodeId === "ask"
    );
    await assert.rejects(
      ctx.decisions.recordAnswer({ queueId: pending.queueId, answer: "yes", actorId: "bob" }),
      (error) => error instanceof HumanTurnNotPendingError && error.queueId === pending.queueId
    );
    await assert.rejects(
      ctx.decisions.recordAnswer({ queueId: pending.queueId, unitId: "q-1", nodeId: "ask", answer: "yes", actorId: "bob" }),
      TypeError
    );
    await assert.rejects(ctx.decisions.recordAnswer({ unitId: "q-1", answer: "yes", actorId: "bob" }), TypeError);
  } finally {
    await ctx.close();
  }
});

test("approval and review answers are mapped to the synthesized nodes' outcomes", async () => {
  const graph = reviewedGraph();
  const ctx = await setup(graph);
  try {
    await ctx.admit("r-1");

    // Approval before the node runs: approved / denied.
    const [approval] = await ctx.decisions.listPending({ unitId: "r-1" });
    assert.equal(approval.nodeId, "draft::approval");
    assert.equal(approval.principalId, "approver");
    assert.equal(approval.role, "approval");
    assert.deepEqual(approval.answers, ["approved", "denied"]);
    assert.deepEqual(approval.outcomes, ["approved", "denied"]);
    await assert.rejects(
      ctx.decisions.recordAnswer({ unitId: "r-1", nodeId: "draft::approval", answer: "accepted", actorId: "ann" }),
      /"accepted" is not an answer here \(node draft::approval of unit r-1; valid answers: approved, denied\)/
    );
    const approved = await ctx.decisions.recordAnswer({ unitId: "r-1", nodeId: "draft::approval", answer: "approved", actorId: "ann" });
    assert.equal(approved.outcome, "approved");
    assert.equal((await ctx.runWorker()).status, "succeeded");

    // Review after it ran: accepted / rejected, stored as accepted:<o> / rework / rejected.
    const [review] = await ctx.decisions.listPending({ principalId: "reviewer" });
    assert.equal(review.nodeId, "draft::review");
    assert.equal(review.role, "review");
    assert.deepEqual(review.answers, ["accepted", "rejected"]);
    assert.deepEqual(review.notesAnswers, ["rejected"]);
    assert.deepEqual(review.outcomes, ["accepted:drafted", "rework", "rejected"]);
    assert.equal(review.inputArtifact.contractId, "switchyard.review-request.v1");
    assert.equal(review.inputArtifact.payload.round, 1);
    await assert.rejects(
      ctx.decisions.recordAnswer({ queueId: review.queueId, answer: "accepted", notes: "fine", actorId: "rae" }),
      /notes go only with "rejected" \(node draft::review of unit r-1; valid answers: accepted, rejected\)/
    );
    await assert.rejects(
      ctx.decisions.recordAnswer({ queueId: review.queueId, answer: "rework", actorId: "rae" }),
      (error) => error instanceof InvalidHumanAnswerError && error.validAnswers.join() === "accepted,rejected"
    );
    const rejected = await ctx.decisions.recordAnswer({
      queueId: review.queueId,
      answer: "rejected",
      notes: "Cite a source.",
      actorId: "rae",
      principalId: "reviewer"
    });
    assert.equal(rejected.answer, "rejected");
    assert.equal(rejected.outcome, "rework");

    // The rework twin runs with the notes, then round 2 is reviewed.
    assert.equal((await ctx.runWorker()).status, "succeeded");
    const [second] = await ctx.decisions.listPending({ unitId: "r-1", nodeId: "draft::review" });
    assert.equal(second.inputArtifact.payload.round, 2);
    assert.equal(second.inputArtifact.payload.history[0].feedback.payload.notes, "Cite a source.");
    const accepted = await ctx.decisions.recordAnswer({ unitId: "r-1", nodeId: "draft::review", answer: "accepted", actorId: "rae" });
    assert.equal(accepted.outcome, "accepted:drafted");
    assert.equal((await ctx.runWorker()).status, "succeeded");

    const decisions = await ctx.decisions.listDecisions({ unitId: "r-1" });
    assert.deepEqual(decisions.map((decision) => [decision.nodeId, decision.outcome, decision.actorId]), [
      ["draft::approval", "approved", "ann"],
      ["draft::review", "rework", "rae"],
      ["draft::review", "accepted:drafted", "rae"]
    ]);
    const status = await ctx.database.readerPool.query(
      "SELECT status, final_node_id, final_outcome FROM switchyard.unit_status WHERE unit_id = 'r-1'"
    );
    assert.deepEqual(status.rows, [{ status: "completed", final_node_id: "publish", final_outcome: "published" }]);

    // A denial ends the unit at the approval node's terminal.
    await ctx.admit("r-2");
    const denied = await ctx.decisions.recordAnswer({ unitId: "r-2", nodeId: "draft::approval", answer: "denied", actorId: "ann" });
    assert.equal(denied.outcome, "denied");
    const deniedStatus = await ctx.database.readerPool.query(
      "SELECT status, final_node_id, final_outcome, final_actor_id FROM switchyard.unit_status WHERE unit_id = 'r-2'"
    );
    assert.deepEqual(deniedStatus.rows, [
      { status: "completed", final_node_id: "draft::approval", final_outcome: "denied", final_actor_id: "ann" }
    ]);

    // The low-level record still takes stored outcomes.
    await ctx.admit("r-3");
    const [approval3] = await ctx.decisions.listPending({ unitId: "r-3" });
    await ctx.decisions.record({ queueId: approval3.queueId, outcome: "approved", actorId: "ann" });
    assert.equal((await ctx.runWorker()).status, "succeeded");
    const [review3] = await ctx.decisions.listPending({ unitId: "r-3" });
    await assert.rejects(ctx.decisions.record({ queueId: review3.queueId, outcome: "accepted", actorId: "rae" }));
    assert.deepEqual(await ctx.decisions.listPending({ unitId: "r-3" }), [review3]);
  } finally {
    await ctx.close();
  }
});
