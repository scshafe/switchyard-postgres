-- 003 — human-decision recording and inspection views.
--
-- A human decision is an ordinary settlement of a `human` node turn (the
-- engine's recordHumanNodeDecision), so it is already retained, exactly and
-- append-only, in turn_settlements and the unit journey. This migration adds
-- the read side: a pending-turn projection that never hydrates the engine,
-- a decision ledger, and plain views for operators who inspect units in SQL.

-- Every queue occurrence with its derived status.
CREATE VIEW {{schema}}.turns AS
SELECT
  queue.queue_id,
  queue.unit_id,
  queue.graph_id,
  queue.graph_version,
  queue.graph_digest,
  queue.node_id,
  node.kind AS node_kind,
  node.principal_id,
  queue.enqueue_sequence,
  queue.queued_at,
  queue.input_contract_id,
  queue.input_artifact_digest,
  CASE
    WHEN settlement.queue_id IS NOT NULL THEN 'settled'
    WHEN terminal.queue_id IS NOT NULL THEN 'failed'
    WHEN lease.queue_id IS NOT NULL THEN 'leased'
    ELSE 'queued'
  END AS status,
  (
    SELECT pg_catalog.count(*)
    FROM {{schema}}.turn_attempts AS attempt
    WHERE attempt.queue_id = queue.queue_id
  ) AS attempts,
  settlement.outcome,
  settlement.actor_id,
  settlement.settled_at,
  terminal.error_code,
  terminal.failed_at,
  lease.mode AS lease_mode,
  lease.lease_owner,
  lease.expires_at AS lease_expires_at
FROM {{schema}}.unit_queue AS queue
JOIN {{schema}}.graph_nodes AS node
  ON node.graph_id = queue.graph_id
 AND node.graph_version = queue.graph_version
 AND node.graph_digest = queue.graph_digest
 AND node.node_id = queue.node_id
LEFT JOIN {{schema}}.turn_settlements AS settlement
  ON settlement.queue_id = queue.queue_id
LEFT JOIN {{schema}}.turn_failures AS terminal
  ON terminal.queue_id = queue.queue_id AND terminal.terminal
LEFT JOIN {{schema}}.unit_leases AS lease
  ON lease.queue_id = queue.queue_id;

-- Human turns still waiting for a decision (queued, or claimed by a decision
-- that has not settled yet).
CREATE VIEW {{schema}}.pending_human_turns AS
SELECT
  queue.queue_id,
  queue.unit_id,
  queue.graph_id,
  queue.graph_version,
  queue.graph_digest,
  queue.node_id,
  queue.node_ref_id,
  queue.node_ref_version,
  node.principal_id,
  node.outcomes,
  queue.input_contract_id,
  queue.input_artifact_digest,
  queue.input_envelope,
  queue.queued_at,
  queue.enqueue_sequence,
  lease.external_actor_id AS claimed_by,
  lease.acquired_at AS claimed_at
FROM {{schema}}.unit_queue AS queue
JOIN {{schema}}.graph_nodes AS node
  ON node.graph_id = queue.graph_id
 AND node.graph_version = queue.graph_version
 AND node.graph_digest = queue.graph_digest
 AND node.node_id = queue.node_id
LEFT JOIN {{schema}}.unit_leases AS lease
  ON lease.queue_id = queue.queue_id
WHERE node.kind = 'human'
  AND NOT EXISTS (
    SELECT 1 FROM {{schema}}.turn_settlements AS settlement
    WHERE settlement.queue_id = queue.queue_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM {{schema}}.turn_failures AS failure
    WHERE failure.queue_id = queue.queue_id AND failure.terminal
  );

-- Every recorded human decision, in the order it was recorded.
CREATE VIEW {{schema}}.human_decisions AS
SELECT
  settlement.settlement_sequence AS decision_sequence,
  settlement.queue_id,
  settlement.unit_id,
  queue.graph_id,
  queue.graph_version,
  queue.graph_digest,
  settlement.node_id,
  settlement.principal_id,
  settlement.actor_id,
  settlement.outcome,
  settlement.output_contract_id,
  settlement.output_artifact_digest,
  settlement.started_at,
  settlement.settled_at,
  settlement.settlement_digest
FROM {{schema}}.turn_settlements AS settlement
JOIN {{schema}}.unit_queue AS queue ON queue.queue_id = settlement.queue_id
JOIN {{schema}}.graph_nodes AS node
  ON node.graph_id = queue.graph_id
 AND node.graph_version = queue.graph_version
 AND node.graph_digest = queue.graph_digest
 AND node.node_id = queue.node_id
WHERE node.kind = 'human';

-- Runtime-callable projections (the runtime role has no SELECT on the views).

CREATE FUNCTION {{schema}}.list_pending_human_turns(
  p_principal_id text,
  p_node_id text,
  p_graph_id text,
  p_after_enqueue_sequence bigint,
  p_limit integer
)
RETURNS TABLE (
  queue_id uuid,
  unit_id text,
  graph_id text,
  graph_version bigint,
  graph_digest text,
  node_id text,
  node_ref_id text,
  node_ref_version bigint,
  principal_id text,
  outcomes jsonb,
  input_envelope text,
  queued_at timestamptz,
  enqueue_sequence bigint,
  claimed_by text,
  claimed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $list_pending_human_turns$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'list_pending_human_turns limit must be 1..1000' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT pending.queue_id, pending.unit_id::text, pending.graph_id::text,
    pending.graph_version::bigint, pending.graph_digest::text, pending.node_id::text,
    pending.node_ref_id::text, pending.node_ref_version::bigint,
    pending.principal_id::text, pending.outcomes, pending.input_envelope::text,
    pending.queued_at, pending.enqueue_sequence::bigint,
    pending.claimed_by::text, pending.claimed_at
  FROM {{schema}}.pending_human_turns AS pending
  WHERE (p_principal_id IS NULL OR pending.principal_id = p_principal_id)
    AND (p_node_id IS NULL OR pending.node_id = p_node_id)
    AND (p_graph_id IS NULL OR pending.graph_id = p_graph_id)
    AND (p_after_enqueue_sequence IS NULL OR pending.enqueue_sequence > p_after_enqueue_sequence)
  ORDER BY pending.enqueue_sequence
  LIMIT p_limit;
END
$list_pending_human_turns$;

CREATE FUNCTION {{schema}}.inspect_pending_human_turn(p_queue_id uuid)
RETURNS TABLE (
  queue_id uuid,
  unit_id text,
  graph_id text,
  graph_version bigint,
  graph_digest text,
  node_id text,
  node_ref_id text,
  node_ref_version bigint,
  principal_id text,
  outcomes jsonb,
  input_envelope text,
  queued_at timestamptz,
  enqueue_sequence bigint,
  claimed_by text,
  claimed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $inspect_pending_human_turn$
  SELECT pending.queue_id, pending.unit_id::text, pending.graph_id::text,
    pending.graph_version::bigint, pending.graph_digest::text, pending.node_id::text,
    pending.node_ref_id::text, pending.node_ref_version::bigint,
    pending.principal_id::text, pending.outcomes, pending.input_envelope::text,
    pending.queued_at, pending.enqueue_sequence::bigint,
    pending.claimed_by::text, pending.claimed_at
  FROM {{schema}}.pending_human_turns AS pending
  WHERE pending.queue_id = p_queue_id
$inspect_pending_human_turn$;

CREATE FUNCTION {{schema}}.list_human_decisions(
  p_unit_id text,
  p_after_decision_sequence bigint,
  p_limit integer
)
RETURNS TABLE (
  decision_sequence bigint,
  queue_id uuid,
  unit_id text,
  graph_id text,
  graph_version bigint,
  graph_digest text,
  node_id text,
  principal_id text,
  actor_id text,
  outcome text,
  output_contract_id text,
  output_artifact_digest text,
  started_at timestamptz,
  settled_at timestamptz,
  settlement_digest text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $list_human_decisions$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'list_human_decisions limit must be 1..1000' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT decision.decision_sequence, decision.queue_id, decision.unit_id::text,
    decision.graph_id::text, decision.graph_version::bigint,
    decision.graph_digest::text, decision.node_id::text,
    decision.principal_id::text, decision.actor_id::text, decision.outcome::text,
    decision.output_contract_id::text, decision.output_artifact_digest::text,
    decision.started_at, decision.settled_at, decision.settlement_digest::text
  FROM {{schema}}.human_decisions AS decision
  WHERE (p_unit_id IS NULL OR decision.unit_id = p_unit_id)
    AND (p_after_decision_sequence IS NULL
         OR decision.decision_sequence > p_after_decision_sequence)
  ORDER BY decision.decision_sequence
  LIMIT p_limit;
END
$list_human_decisions$;

REVOKE ALL ON ALL TABLES IN SCHEMA {{schema}} FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA {{schema}} FROM PUBLIC;
