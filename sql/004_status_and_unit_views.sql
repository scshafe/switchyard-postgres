-- 004 — schema status for the runtime role, unit-level views, and a
-- pending-turn lookup by unit.
--
-- Released migrations never change, so everything 0.2.0 adds to the schema
-- is here. Grants stay with migrate(): the runtime role gets EXECUTE on the
-- two routines below (and still no relation privilege); the reader role gets
-- SELECT on the new views like on every other relation.

-- Schema status ---------------------------------------------------------------

-- assertSchemaCurrent() must work for the role the application connects as.
-- The runtime role has no relation privilege at all, so rather than granting
-- it SELECT on schema_migrations (the first relation privilege it would
-- hold), this routine hands it exactly the applied-migration ledger: version,
-- name, checksum and time. That is the same information the library already
-- carries in its own manifest, so it discloses nothing about units. The
-- table itself is created by migrate() before migration 1 runs.
CREATE FUNCTION {{schema}}.schema_migration_status()
RETURNS TABLE (
  version integer,
  name text,
  checksum text,
  applied_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $schema_migration_status$
  SELECT migration.version, migration.name, migration.checksum, migration.applied_at
  FROM {{schema}}.schema_migrations AS migration
  ORDER BY migration.version
$schema_migration_status$;

-- Pending human turns, optionally of one unit ---------------------------------

-- The 003 routine filters by principal, node and graph; answering "the review
-- of unit X" needs the unit too. Same columns and FIFO order as 003's.
CREATE FUNCTION {{schema}}.find_pending_human_turns(
  p_unit_id text,
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
AS $find_pending_human_turns$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'find_pending_human_turns limit must be 1..1000' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT pending.queue_id, pending.unit_id::text, pending.graph_id::text,
    pending.graph_version::bigint, pending.graph_digest::text, pending.node_id::text,
    pending.node_ref_id::text, pending.node_ref_version::bigint,
    pending.principal_id::text, pending.outcomes, pending.input_envelope::text,
    pending.queued_at, pending.enqueue_sequence::bigint,
    pending.claimed_by::text, pending.claimed_at
  FROM {{schema}}.pending_human_turns AS pending
  WHERE (p_unit_id IS NULL OR pending.unit_id = p_unit_id)
    AND (p_principal_id IS NULL OR pending.principal_id = p_principal_id)
    AND (p_node_id IS NULL OR pending.node_id = p_node_id)
    AND (p_graph_id IS NULL OR pending.graph_id = p_graph_id)
    AND (p_after_enqueue_sequence IS NULL OR pending.enqueue_sequence > p_after_enqueue_sequence)
  ORDER BY pending.enqueue_sequence
  LIMIT p_limit;
END
$find_pending_human_turns$;

-- Unit views --------------------------------------------------------------------
--
-- Plain views over the evidence, for the reader role and operators. They call
-- only pg_catalog functions: a view's function calls are checked against the
-- querying role, and the reader holds SELECT and nothing else.
--
-- A queue occurrence is open until it has a settlement or a terminal
-- failure (the engine's unit-path projection uses the same rule). Canonical
-- JSON text is parsed for projection only; the regexp neutralizes the valid
-- escape \u0000, which jsonb rejects, without touching an escaped backslash.

-- Where each unit is now: its open queue occurrences.
CREATE VIEW {{schema}}.unit_positions AS
SELECT
  queue.unit_id,
  queue.queue_id,
  queue.graph_id,
  queue.graph_version,
  queue.graph_digest,
  queue.node_id,
  node.kind AS node_kind,
  node.principal_id,
  CASE WHEN lease.queue_id IS NULL THEN 'queued' ELSE 'leased' END AS state,
  -- 1-based FIFO rank among the open occurrences of this node in this graph
  -- lane (leased ones included). Workers claim FIFO within a node and
  -- round-robin across graph lanes; people pick human turns in any order.
  pg_catalog.row_number() OVER (
    PARTITION BY queue.graph_id, queue.graph_version, queue.graph_digest, queue.node_id
    ORDER BY queue.enqueue_sequence
  ) AS queue_position,
  (
    SELECT pg_catalog.count(*)
    FROM {{schema}}.turn_attempts AS attempt
    WHERE attempt.queue_id = queue.queue_id
  ) AS attempts,
  (
    SELECT pg_catalog.count(*)
    FROM {{schema}}.turn_failures AS failure
    WHERE failure.queue_id = queue.queue_id
  ) AS failed_attempts,
  (
    SELECT failure.error_code
    FROM {{schema}}.turn_failures AS failure
    WHERE failure.queue_id = queue.queue_id
    ORDER BY failure.attempt_index DESC
    LIMIT 1
  ) AS last_error_code,
  queue.queued_at,
  queue.enqueue_sequence,
  lease.mode AS lease_mode,
  lease.lease_owner,
  lease.external_actor_id AS claimed_by,
  lease.expires_at AS lease_expires_at
FROM {{schema}}.unit_queue AS queue
JOIN {{schema}}.graph_nodes AS node
  ON node.graph_id = queue.graph_id
 AND node.graph_version = queue.graph_version
 AND node.graph_digest = queue.graph_digest
 AND node.node_id = queue.node_id
LEFT JOIN {{schema}}.unit_leases AS lease
  ON lease.queue_id = queue.queue_id
WHERE NOT EXISTS (
    SELECT 1 FROM {{schema}}.turn_settlements AS settlement
    WHERE settlement.queue_id = queue.queue_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM {{schema}}.turn_failures AS failure
    WHERE failure.queue_id = queue.queue_id AND failure.terminal
  );

-- One row per unit: overall status and, once nothing is open, the terminal
-- outcome it ended on.
--
-- status: 'awaiting_human' (every open turn is at a human node), 'active'
-- (other open turns), 'failed' (nothing open and at least one turn failed
-- terminally), 'completed' (nothing open, no terminal failure).
-- final_*: the last settlement (or join_unsatisfiable) in journey order whose
-- node and outcome the graph declares terminal; NULL while the unit is open
-- or when no terminal was reached. final_contract_id/final_artifact_digest
-- name the artifact that outcome carries: the node's output artifact, or its
-- input when it returned none (NULL for join_unsatisfiable).
CREATE VIEW {{schema}}.unit_status AS
SELECT
  unit.unit_id,
  unit.graph_id,
  unit.graph_version,
  unit.graph_digest,
  unit.admitted_at,
  unit.principal_id AS admitted_by,
  CASE
    WHEN counts.open_turns > 0 AND counts.open_turns = counts.open_human_turns THEN 'awaiting_human'
    WHEN counts.open_turns > 0 THEN 'active'
    WHEN counts.dead_turns > 0 THEN 'failed'
    ELSE 'completed'
  END AS status,
  counts.open_turns,
  counts.open_human_turns,
  counts.settled_turns,
  counts.dead_turns,
  final.node_id AS final_node_id,
  final.outcome AS final_outcome,
  final.actor_id AS final_actor_id,
  final.contract_id AS final_contract_id,
  final.artifact_digest AS final_artifact_digest,
  final.recorded_at AS finished_at,
  activity.last_activity_at
FROM {{schema}}.units AS unit
CROSS JOIN LATERAL (
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE settlement.queue_id IS NULL AND failure.queue_id IS NULL
    ) AS open_turns,
    pg_catalog.count(*) FILTER (
      WHERE settlement.queue_id IS NULL AND failure.queue_id IS NULL AND node.kind = 'human'
    ) AS open_human_turns,
    pg_catalog.count(settlement.queue_id) AS settled_turns,
    pg_catalog.count(failure.queue_id) AS dead_turns
  FROM {{schema}}.unit_queue AS queue
  JOIN {{schema}}.graph_nodes AS node
    ON node.graph_id = queue.graph_id
   AND node.graph_version = queue.graph_version
   AND node.graph_digest = queue.graph_digest
   AND node.node_id = queue.node_id
  LEFT JOIN {{schema}}.turn_settlements AS settlement
    ON settlement.queue_id = queue.queue_id
  LEFT JOIN {{schema}}.turn_failures AS failure
    ON failure.queue_id = queue.queue_id AND failure.terminal
  WHERE queue.unit_id = unit.unit_id
) AS counts
-- Parsed only for a unit with nothing open (a one-time filter per unit).
LEFT JOIN LATERAL (
  SELECT (
    pg_catalog.regexp_replace(
      graph.definition_json,
      '(?<!\\)((?:\\\\)*)\\u0000',
      '\1\\\\u0000',
      'g'
    )::jsonb
  ) -> 'terminals' AS terminals
  FROM {{schema}}.graphs AS graph
  WHERE counts.open_turns = 0
    AND graph.graph_id = unit.graph_id
    AND graph.graph_version = unit.graph_version
    AND graph.graph_digest = unit.graph_digest
) AS graph_terminals ON true
LEFT JOIN LATERAL (
  SELECT
    event.node_id,
    event.outcome,
    event.actor_id,
    event.contract_id,
    event.artifact_digest,
    event.recorded_at
  FROM (
    SELECT
      journey.sequence,
      journey.node_id::text AS node_id,
      COALESCE(settlement.outcome::text, 'join_unsatisfiable') AS outcome,
      settlement.actor_id::text AS actor_id,
      COALESCE(settlement.output_contract_id, queue.input_contract_id)::text AS contract_id,
      COALESCE(settlement.output_artifact_digest, queue.input_artifact_digest)::text AS artifact_digest,
      journey.recorded_at
    FROM {{schema}}.unit_journey AS journey
    LEFT JOIN {{schema}}.turn_settlements AS settlement
      ON journey.kind = 'turn_settled' AND settlement.queue_id = journey.queue_id
    LEFT JOIN {{schema}}.unit_queue AS queue
      ON journey.kind = 'turn_settled' AND queue.queue_id = journey.queue_id
    WHERE journey.unit_id = unit.unit_id
      AND journey.kind IN ('turn_settled', 'join_unsatisfiable')
  ) AS event
  WHERE graph_terminals.terminals @> pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('nodeId', event.node_id, 'outcome', event.outcome)
  )
  ORDER BY event.sequence DESC
  LIMIT 1
) AS final ON true
CROSS JOIN LATERAL (
  SELECT pg_catalog.max(journey.recorded_at) AS last_activity_at
  FROM {{schema}}.unit_journey AS journey
  WHERE journey.unit_id = unit.unit_id
) AS activity;

-- Every artifact a unit's turns produced (settlements that returned an output
-- artifact), in settlement order, with the exact envelope and a jsonb
-- projection of its payload. A turn that carried its input forward produced
-- nothing and has no row here; unit_status.final_* covers that case.
CREATE VIEW {{schema}}.unit_outputs AS
SELECT
  settlement.unit_id,
  settlement.settlement_sequence,
  settlement.queue_id,
  settlement.node_id,
  settlement.outcome,
  settlement.principal_id,
  settlement.actor_id,
  settlement.settled_at,
  settlement.output_contract_id AS contract_id,
  settlement.output_artifact_digest AS artifact_digest,
  artifact.declared_bytes,
  artifact.envelope,
  (
    pg_catalog.regexp_replace(
      artifact.envelope,
      '(?<!\\)((?:\\\\)*)\\u0000',
      '\1\\\\u0000',
      'g'
    )::jsonb
  ) -> 'payload' AS payload
FROM {{schema}}.turn_settlements AS settlement
JOIN {{schema}}.artifacts AS artifact
  ON artifact.contract_id = settlement.output_contract_id
 AND artifact.artifact_digest = settlement.output_artifact_digest;

REVOKE ALL ON ALL TABLES IN SCHEMA {{schema}} FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA {{schema}} FROM PUBLIC;
