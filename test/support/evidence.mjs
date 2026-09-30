// Read the conformance evidence view straight from the tables, as the
// reader role, re-validating every canonical JSON text on the way out.

import assert from "node:assert/strict";

import { canonicalJson } from "@scshafe/switchyard/contracts/digest";

// The engine's evidence snapshots are deep-frozen; so is this view.
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseRows(rows, label) {
  return Object.freeze(rows.map((row, index) => {
    const value = JSON.parse(row.canonical_json);
    assert.equal(canonicalJson(value), row.canonical_json, `${label}[${index}] must be canonical JSON`);
    return deepFreeze(value);
  }));
}

export async function readEvidence(pool, schema = "switchyard") {
  const s = `"${schema}"`;
  const query = async (text, label) => parseRows((await pool.query(text)).rows, label);
  const [artifacts, queues, journey, joins, outbox, deadLetters] = await Promise.all([
    query(`SELECT envelope AS canonical_json FROM ${s}.artifacts
           ORDER BY contract_id COLLATE "C", artifact_digest COLLATE "C"`, "artifacts"),
    query(`SELECT queue_definition AS canonical_json FROM ${s}.unit_queue
           ORDER BY enqueue_sequence`, "queues"),
    query(`SELECT record AS canonical_json FROM ${s}.unit_journey
           ORDER BY unit_id COLLATE "C", sequence`, "journey"),
    query(`SELECT latest.progress AS canonical_json FROM (
             SELECT DISTINCT ON (unit_id, node_id) unit_id, node_id, progress
             FROM ${s}.join_progress
             ORDER BY unit_id, node_id, progress_revision DESC
           ) AS latest ORDER BY latest.unit_id COLLATE "C", latest.node_id COLLATE "C"`, "joins"),
    query(`SELECT event_record AS canonical_json FROM ${s}.outbox
           ORDER BY outbox_sequence`, "outbox"),
    query(`SELECT dead_letter AS canonical_json FROM ${s}.dead_letters
           ORDER BY recorded_at, dead_letter_id`, "deadLetters")
  ]);
  const cachedCompletions = (await pool.query(`
    SELECT queue_id::text AS queue_id, completion_digest FROM ${s}.turn_completion_cache
    ORDER BY queue_id, attempt_number
  `)).rows.map((row) => Object.freeze({ queueId: row.queue_id, completionDigest: row.completion_digest }));
  const settlements = (await pool.query(`
    SELECT queue_id::text AS queue_id, settlement_digest FROM ${s}.turn_settlements
    ORDER BY settlement_sequence
  `)).rows.map((row) => Object.freeze({ queueId: row.queue_id, settlementDigest: row.settlement_digest }));
  const leases = (await pool.query(`
    SELECT queue_id::text AS queue_id, lease_token::text AS lease_token FROM ${s}.unit_leases
    ORDER BY queue_id
  `)).rows.map((row) => Object.freeze({
    queueId: row.queue_id,
    lease: Object.freeze({ leaseToken: row.lease_token })
  }));
  return Object.freeze({
    artifacts,
    queues,
    journey,
    joins,
    cachedCompletions: Object.freeze(cachedCompletions),
    settlements: Object.freeze(settlements),
    outbox,
    deadLetters,
    leases: Object.freeze(leases)
  });
}
