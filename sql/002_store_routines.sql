-- 002 — graph store and unit store routines.
--
-- The runtime role gets EXECUTE on these SECURITY DEFINER routines and no
-- relation privilege at all (grants are applied by migrate(), not here).
-- Every routine pins search_path to pg_catalog and names its objects with
-- the {{schema}} prefix.
--
-- The unit store works as in the switchyard N4 design: the adapter calls
-- begin_unit_operation to read one operation's normalized state (scoped to
-- the units it can touch), replays the operation in the engine's
-- MemoryUnitStore, and appends the resulting delta with apply_unit_delta,
-- all inside one SERIALIZABLE transaction holding the store-wide operation
-- lock. The engine owns the semantics; these routines own atomicity,
-- immutability, fencing and scope.

-- Graph publication ----------------------------------------------------------

-- Parse canonical JSON text into jsonb for projection only. jsonb rejects the
-- valid escape \u0000, so it is neutralized in the disposable copy; the
-- retained text stays byte-exact.
CREATE FUNCTION {{schema}}.projection_jsonb(p_text text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $projection_jsonb$
  SELECT pg_catalog.replace(
    p_text,
    pg_catalog.chr(92) || 'u0000',
    pg_catalog.chr(92) || pg_catalog.chr(92) || 'u0000'
  )::jsonb
$projection_jsonb$;

CREATE FUNCTION {{schema}}.publish_graph(
  p_graph_id text,
  p_graph_version bigint,
  p_graph_digest text,
  p_definition_json text,
  p_node_signatures jsonb
)
RETURNS TABLE (
  publication_status text,
  published_digest text,
  node_ref_id text,
  node_ref_version bigint,
  conflict_field text,
  first_graph_id text,
  first_graph_version bigint,
  first_graph_digest text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $publish_graph$
DECLARE
  existing_digest text;
  conflict record;
  definition jsonb;
BEGIN
  -- One publication lock makes graph identity and cross-graph node-signature
  -- checks a single atomic decision.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('{{schema}}:graph-publication', 0)
  );

  IF p_graph_id IS NULL OR p_graph_version IS NULL OR p_graph_digest IS NULL
     OR p_definition_json IS NULL OR p_node_signatures IS NULL THEN
    RAISE EXCEPTION 'publish_graph requires every argument' USING ERRCODE = '22023';
  END IF;
  BEGIN
    definition := {{schema}}.projection_jsonb(p_definition_json);
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'publish_graph definition is not JSON' USING ERRCODE = '22023';
  END;
  IF jsonb_typeof(definition) IS DISTINCT FROM 'object'
     OR definition ->> 'graphId' IS DISTINCT FROM p_graph_id
     OR (definition ->> 'version')::bigint IS DISTINCT FROM p_graph_version
     OR definition ->> 'graphDigest' IS DISTINCT FROM p_graph_digest
     OR jsonb_typeof(definition -> 'nodes') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'publish_graph definition identity is not sealed to its arguments'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_node_signatures) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_node_signatures) < 1
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_node_signatures) AS item(value)
       WHERE jsonb_typeof(item.value) <> 'object'
          OR jsonb_typeof(item.value -> 'refId') <> 'string'
          OR jsonb_typeof(item.value -> 'refVersion') <> 'number'
          OR jsonb_typeof(item.value -> 'kind') <> 'string'
          OR jsonb_typeof(item.value -> 'input') <> 'string'
          OR jsonb_typeof(item.value -> 'outcomes') <> 'array'
          OR (item.value ? 'outputs' AND jsonb_typeof(item.value -> 'outputs') <> 'object')
     ) THEN
    RAISE EXCEPTION 'publish_graph node signatures are malformed' USING ERRCODE = '22023';
  END IF;

  -- Signatures cover the unique ref set; every graph node must match its
  -- ref's signature and every signature must name a graph node.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(definition -> 'nodes') AS node(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_node_signatures) AS signature(value)
      WHERE signature.value ->> 'refId' = node.value #>> '{ref,id}'
        AND (signature.value ->> 'refVersion')::bigint = (node.value #>> '{ref,version}')::bigint
        AND signature.value ->> 'kind' = node.value ->> 'kind'
        AND signature.value ->> 'input' = node.value ->> 'input'
        AND signature.value -> 'outcomes' = (
          SELECT jsonb_agg(outcome.value ORDER BY (outcome.value #>> '{}') COLLATE "C")
          FROM jsonb_array_elements(node.value #> '{outcomes,outcomes}') AS outcome(value)
        )
        AND (signature.value -> 'outputs') IS NOT DISTINCT FROM (node.value -> 'outputs')
    )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_node_signatures) AS signature(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(definition -> 'nodes') AS node(value)
      WHERE signature.value ->> 'refId' = node.value #>> '{ref,id}'
        AND (signature.value ->> 'refVersion')::bigint = (node.value #>> '{ref,version}')::bigint
    )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_node_signatures) AS signature(value)
    GROUP BY signature.value ->> 'refId', (signature.value ->> 'refVersion')::bigint
    HAVING pg_catalog.count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'publish_graph node signatures do not exactly cover the sealed graph nodes'
      USING ERRCODE = '22023';
  END IF;

  SELECT graph.graph_digest::text INTO existing_digest
  FROM {{schema}}.graphs AS graph
  WHERE graph.graph_id = p_graph_id AND graph.graph_version = p_graph_version;
  IF FOUND AND existing_digest <> p_graph_digest THEN
    RETURN QUERY SELECT 'graph_conflict'::text, existing_digest,
      NULL::text, NULL::bigint, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  WITH requested AS (
    SELECT
      item.value ->> 'refId' AS ref_id,
      (item.value ->> 'refVersion')::bigint AS ref_version,
      item.value ->> 'kind' AS kind,
      item.value ->> 'input' AS input_contract,
      item.value -> 'outcomes' AS outcomes,
      item.value -> 'outputs' AS outputs
    FROM jsonb_array_elements(p_node_signatures) AS item(value)
  )
  SELECT
    requested.ref_id,
    requested.ref_version,
    CASE
      WHEN published.kind::text <> requested.kind THEN 'kind'
      WHEN published.input_contract::text <> requested.input_contract THEN 'input contract'
      WHEN published.outcomes <> requested.outcomes THEN 'outcome vocabulary'
      ELSE 'output contracts'
    END AS field,
    published.first_graph_id::text AS first_id,
    published.first_graph_version::bigint AS first_version,
    published.first_graph_digest::text AS first_digest
  INTO conflict
  FROM requested
  JOIN {{schema}}.node_definitions AS published
    ON published.node_ref_id = requested.ref_id
   AND published.node_ref_version = requested.ref_version
  WHERE published.kind::text <> requested.kind
     OR published.input_contract::text <> requested.input_contract
     OR published.outcomes <> requested.outcomes
     OR published.outputs IS DISTINCT FROM requested.outputs
  ORDER BY requested.ref_id COLLATE "C", requested.ref_version
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'node_conflict'::text, COALESCE(existing_digest, p_graph_digest),
      conflict.ref_id::text, conflict.ref_version::bigint, conflict.field::text,
      conflict.first_id, conflict.first_version, conflict.first_digest;
    RETURN;
  END IF;

  IF existing_digest IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed'::text, existing_digest,
      NULL::text, NULL::bigint, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  INSERT INTO {{schema}}.graphs (graph_id, graph_version, graph_digest, definition_json)
  VALUES (p_graph_id, p_graph_version, p_graph_digest, p_definition_json);

  INSERT INTO {{schema}}.node_definitions (
    node_ref_id, node_ref_version, kind, input_contract, outcomes, outputs,
    first_graph_id, first_graph_version, first_graph_digest
  )
  SELECT
    item.value ->> 'refId',
    (item.value ->> 'refVersion')::bigint,
    (item.value ->> 'kind')::{{schema}}.node_kind,
    item.value ->> 'input',
    item.value -> 'outcomes',
    item.value -> 'outputs',
    p_graph_id, p_graph_version, p_graph_digest
  FROM jsonb_array_elements(p_node_signatures) AS item(value)
  ON CONFLICT ON CONSTRAINT node_definitions_pkey DO NOTHING;

  INSERT INTO {{schema}}.graph_nodes (
    graph_id, graph_version, graph_digest, node_id, node_ref_id,
    node_ref_version, kind, input_contract, outcomes, principal_id,
    lease_ms, max_attempts, join_definition, node_definition
  )
  SELECT
    p_graph_id, p_graph_version, p_graph_digest,
    node.value ->> 'nodeId',
    node.value #>> '{ref,id}',
    (node.value #>> '{ref,version}')::bigint,
    (node.value ->> 'kind')::{{schema}}.node_kind,
    node.value ->> 'input',
    (
      SELECT jsonb_agg(outcome.value ORDER BY (outcome.value #>> '{}') COLLATE "C")
      FROM jsonb_array_elements(node.value #> '{outcomes,outcomes}') AS outcome(value)
    ),
    node.value #>> '{principal,id}',
    (node.value #>> '{turn,leaseMs}')::bigint,
    (node.value #>> '{turn,maxAttempts}')::integer,
    node.value -> 'join',
    node.value
  FROM jsonb_array_elements(definition -> 'nodes') AS node(value);

  RETURN QUERY SELECT 'published'::text, p_graph_digest,
    NULL::text, NULL::bigint, NULL::text, NULL::text, NULL::bigint, NULL::text;
END
$publish_graph$;

CREATE FUNCTION {{schema}}.load_graph(p_graph_id text, p_graph_version bigint)
RETURNS TABLE (graph_digest text, definition_json text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $load_graph$
  SELECT graph.graph_digest::text, graph.definition_json::text
  FROM {{schema}}.graphs AS graph
  WHERE graph.graph_id = p_graph_id AND graph.graph_version = p_graph_version
$load_graph$;

-- Unit operations -------------------------------------------------------------

-- Private: validate the operation envelope and take the store-wide
-- operation lock. Semantic authority (principal, kind, lease, coordinates)
-- is decided by the engine over the hydrated state; apply_unit_delta then
-- fences what may be written.
CREATE FUNCTION {{schema}}.start_unit_operation(
  p_operation text,
  p_queue_id text,
  p_lease_token text,
  p_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $start_unit_operation$
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN (
    'admit', 'read_unit', 'read_journey', 'read_join', 'read_artifact',
    'list_queue', 'claim_worker', 'inspect_external', 'claim_external',
    'heartbeat', 'prepare_attempt', 'cache_completion', 'record_failure',
    'settle', 'list_outbox', 'list_dead_letters'
  ) THEN
    RAISE EXCEPTION 'unknown switchyard unit operation %', p_operation
      USING ERRCODE = '22023';
  END IF;
  IF p_at IS NULL OR NOT pg_catalog.isfinite(p_at) THEN
    RAISE EXCEPTION 'unit operation timestamp must be finite' USING ERRCODE = '22023';
  END IF;
  IF p_queue_id IS NOT NULL AND p_queue_id !~
       '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'unit operation received an invalid queue identity'
      USING ERRCODE = '22023';
  END IF;
  IF p_lease_token IS NOT NULL AND p_lease_token !~
       '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'unit operation received an invalid lease identity'
      USING ERRCODE = '22023';
  END IF;
  -- Serializes every hydration/application decision in this schema. The
  -- adapter keeps begin and apply in one transaction, so the lock is
  -- re-entrant there and released at commit or rollback.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('{{schema}}:unit-operations', 0)
  );
END
$start_unit_operation$;

-- Open means neither settled nor terminally failed (MemoryUnitStore.isQueueOpen).
CREATE FUNCTION {{schema}}.queue_is_open(p_queue_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $queue_is_open$
  SELECT NOT EXISTS (
    SELECT 1 FROM {{schema}}.turn_settlements AS settlement
    WHERE settlement.queue_id = p_queue_id
  ) AND NOT EXISTS (
    SELECT 1 FROM {{schema}}.turn_failures AS failure
    WHERE failure.queue_id = p_queue_id AND failure.terminal
  )
$queue_is_open$;

CREATE FUNCTION {{schema}}.begin_unit_operation(
  p_operation text,
  p_queue_id text,
  p_unit_id text,
  p_node_id text,
  p_principal_id text,
  p_lease_token text,
  p_artifact_contract_id text,
  p_artifact_digest text,
  p_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $begin_unit_operation$
DECLARE
  scope_unit_ids text[] := ARRAY[]::text[];
  state_bundle text;
BEGIN
  PERFORM {{schema}}.start_unit_operation(p_operation, p_queue_id, p_lease_token, p_at);

  -- The hydration scope: exactly the units this operation can read or change.
  IF p_queue_id IS NOT NULL THEN
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT scoped.unit_id), ARRAY[]::text[])
      INTO scope_unit_ids
    FROM (
      SELECT queue.unit_id::text AS unit_id FROM {{schema}}.unit_queue AS queue
      WHERE queue.queue_id = p_queue_id::uuid
      UNION
      SELECT unit.unit_id::text FROM {{schema}}.units AS unit
      WHERE unit.unit_id = p_unit_id
    ) AS scoped;
  ELSIF p_unit_id IS NOT NULL AND p_operation <> 'read_artifact' THEN
    SELECT COALESCE(pg_catalog.array_agg(unit.unit_id::text), ARRAY[]::text[])
      INTO scope_unit_ids
    FROM {{schema}}.units AS unit WHERE unit.unit_id = p_unit_id;
  ELSIF p_operation = 'claim_worker' THEN
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT queue.unit_id::text), ARRAY[]::text[])
      INTO scope_unit_ids
    FROM {{schema}}.unit_queue AS queue
    JOIN {{schema}}.graph_nodes AS node
      ON node.graph_id = queue.graph_id
     AND node.graph_version = queue.graph_version
     AND node.graph_digest = queue.graph_digest
     AND node.node_id = queue.node_id
    WHERE node.principal_id = p_principal_id
      AND node.kind IN ('code', 'model', 'agent')
      AND (p_node_id IS NULL OR queue.node_id = p_node_id)
      AND {{schema}}.queue_is_open(queue.queue_id);
  ELSIF p_operation = 'list_queue' THEN
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT queue.unit_id::text), ARRAY[]::text[])
      INTO scope_unit_ids
    FROM {{schema}}.unit_queue AS queue
    JOIN {{schema}}.graph_nodes AS node
      ON node.graph_id = queue.graph_id
     AND node.graph_version = queue.graph_version
     AND node.graph_digest = queue.graph_digest
     AND node.node_id = queue.node_id
    WHERE queue.node_id = p_node_id
      AND node.principal_id = p_principal_id
      AND {{schema}}.queue_is_open(queue.queue_id);
  ELSIF p_operation = 'list_outbox' THEN
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT event.unit_id::text), ARRAY[]::text[])
      INTO scope_unit_ids FROM {{schema}}.outbox AS event;
  ELSIF p_operation = 'list_dead_letters' THEN
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT letter.unit_id::text), ARRAY[]::text[])
      INTO scope_unit_ids FROM {{schema}}.dead_letters AS letter;
  END IF;

  WITH latest_joins AS (
    SELECT DISTINCT ON (progress.unit_id, progress.node_id)
      progress.unit_id, progress.node_id, progress.progress
    FROM {{schema}}.join_progress AS progress
    WHERE progress.unit_id::text = ANY (scope_unit_ids)
    ORDER BY progress.unit_id, progress.node_id, progress.progress_revision DESC
  ), scoped_artifacts AS (
    SELECT artifact.contract_id, artifact.artifact_digest, artifact.envelope
    FROM {{schema}}.artifacts AS artifact
    WHERE EXISTS (
        SELECT 1 FROM {{schema}}.unit_artifacts AS link
        WHERE link.contract_id = artifact.contract_id
          AND link.artifact_digest = artifact.artifact_digest
          AND link.unit_id::text = ANY (scope_unit_ids)
      )
       OR (p_operation = 'read_artifact'
           AND artifact.contract_id = p_artifact_contract_id
           AND artifact.artifact_digest = p_artifact_digest)
  )
  SELECT pg_catalog.jsonb_build_object(
    'unitGraphs', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'unitId', unit.unit_id::text,
        'graphCanonicalJson', graph.definition_json::text
      ) ORDER BY unit.unit_id COLLATE "C")
      FROM {{schema}}.units AS unit
      JOIN {{schema}}.graphs AS graph
        ON graph.graph_id = unit.graph_id
       AND graph.graph_version = unit.graph_version
       AND graph.graph_digest = unit.graph_digest
      WHERE unit.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'units', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', unit.unit_definition::text
      ) ORDER BY unit.unit_id COLLATE "C")
      FROM {{schema}}.units AS unit
      WHERE unit.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'artifacts', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', artifact.envelope::text
      ) ORDER BY artifact.contract_id COLLATE "C", artifact.artifact_digest COLLATE "C")
      FROM scoped_artifacts AS artifact
    ), '[]'::jsonb),
    'queues', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', queue.queue_definition::text
      ) ORDER BY queue.enqueue_sequence)
      FROM {{schema}}.unit_queue AS queue
      WHERE queue.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'journey', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', journey.record::text
      ) ORDER BY journey.unit_id COLLATE "C", journey.sequence)
      FROM {{schema}}.unit_journey AS journey
      WHERE journey.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'joins', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', latest.progress::text
      ) ORDER BY latest.unit_id COLLATE "C", latest.node_id COLLATE "C")
      FROM latest_joins AS latest
    ), '[]'::jsonb),
    'attempts', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', attempt.attempt::text
      ) ORDER BY attempt.queue_id, attempt.attempt_number)
      FROM {{schema}}.turn_attempts AS attempt
      WHERE attempt.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'cachedCompletions', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', cache.completion::text
      ) ORDER BY cache.queue_id, cache.attempt_number)
      FROM {{schema}}.turn_completion_cache AS cache
      JOIN {{schema}}.turn_attempts AS attempt
        ON attempt.queue_id = cache.queue_id
       AND attempt.attempt_number = cache.attempt_number
      WHERE attempt.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'failures', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', failure.failure::text
      ) ORDER BY failure.queue_id, failure.attempt_number)
      FROM {{schema}}.turn_failures AS failure
      WHERE failure.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'settlements', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', settlement.settlement::text
      ) ORDER BY settlement.queue_id)
      FROM {{schema}}.turn_settlements AS settlement
      WHERE settlement.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'outbox', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', event.event_record::text
      ) ORDER BY event.outbox_sequence)
      FROM {{schema}}.outbox AS event
      WHERE event.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'deadLetters', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', letter.dead_letter::text
      ) ORDER BY letter.recorded_at, letter.dead_letter_id)
      FROM {{schema}}.dead_letters AS letter
      WHERE letter.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'leases', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'canonicalJson', lease.lease_definition::text
      ) ORDER BY lease.queue_id)
      FROM {{schema}}.unit_leases AS lease
      JOIN {{schema}}.unit_queue AS queue ON queue.queue_id = lease.queue_id
      WHERE queue.unit_id::text = ANY (scope_unit_ids)
    ), '[]'::jsonb),
    'fairnessCursor', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'nodeId', cursor.node_id::text,
        'nodeRefId', cursor.node_ref_id::text,
        'nodeRefVersion', cursor.node_ref_version::bigint,
        'graphId', cursor.last_graph_id::text,
        'graphVersion', cursor.last_graph_version::bigint,
        'graphDigest', cursor.last_graph_digest::text
      ) ORDER BY cursor.node_id COLLATE "C", cursor.node_ref_id COLLATE "C",
                 cursor.node_ref_version)
      FROM {{schema}}.fairness_cursors AS cursor
      WHERE EXISTS (
        SELECT 1
        FROM {{schema}}.units AS unit
        JOIN {{schema}}.graph_nodes AS node
          ON node.graph_id = unit.graph_id
         AND node.graph_version = unit.graph_version
         AND node.graph_digest = unit.graph_digest
        WHERE unit.unit_id::text = ANY (scope_unit_ids)
          AND node.node_id = cursor.node_id
          AND node.node_ref_id = cursor.node_ref_id
          AND node.node_ref_version = cursor.node_ref_version
          AND unit.graph_id = cursor.last_graph_id
          AND unit.graph_version = cursor.last_graph_version
          AND unit.graph_digest = cursor.last_graph_digest
      )
    ), '[]'::jsonb),
    'outboxDedupeKeys', COALESCE((
      SELECT pg_catalog.jsonb_agg(event.dedupe_key::text ORDER BY event.dedupe_key COLLATE "C")
      FROM {{schema}}.outbox AS event
      WHERE event.dedupe_key IS NOT NULL
    ), '[]'::jsonb),
    'nextEnqueueSequence', COALESCE((
      SELECT pg_catalog.max(queue.enqueue_sequence) + 1 FROM {{schema}}.unit_queue AS queue
    ), 1::bigint)
  )::text
  INTO state_bundle;
  RETURN state_bundle;
END
$begin_unit_operation$;

CREATE FUNCTION {{schema}}.apply_unit_delta(
  p_operation text,
  p_queue_id text,
  p_unit_id text,
  p_node_id text,
  p_principal_id text,
  p_lease_token text,
  p_phase text,
  p_delta_text text,
  p_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $apply_unit_delta$
DECLARE
  delta jsonb;
  allowed_keys text[];
  delta_key text;
  delta_value jsonb;
  scope_unit text;
  deleted_count bigint;
BEGIN
  PERFORM {{schema}}.start_unit_operation(p_operation, p_queue_id, p_lease_token, p_at);
  BEGIN
    delta := p_delta_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'unit delta transport must be JSON' USING ERRCODE = '22023';
  END;
  IF pg_catalog.jsonb_typeof(delta) IS DISTINCT FROM 'object'
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(delta)) <> 15
     OR NOT delta ?& ARRAY[
       'unitGraphs', 'units', 'artifacts', 'queues', 'journey', 'joins', 'attempts',
       'cachedCompletions', 'failures', 'settlements', 'outbox', 'deadLetters',
       'leaseUpserts', 'leaseDeletes', 'fairnessUpserts'
     ] THEN
    RAISE EXCEPTION 'unit delta must contain the closed 15-key transport'
      USING ERRCODE = '22023';
  END IF;
  FOR delta_key, delta_value IN SELECT key, value FROM pg_catalog.jsonb_each(delta)
  LOOP
    IF pg_catalog.jsonb_typeof(delta_value) <> 'array' THEN
      RAISE EXCEPTION 'unit delta.% must be an array', delta_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- Which state classes each operation (and each settle phase) may append.
  IF p_operation = 'settle' THEN
    allowed_keys := CASE p_phase
      WHEN 'journey_append' THEN ARRAY['journey', 'settlements']
      WHEN 'artifact_retain' THEN ARRAY['artifacts']
      WHEN 'edge_evaluation' THEN ARRAY[]::text[]
      WHEN 'join_progress' THEN ARRAY['joins']
      WHEN 'successor_enqueue' THEN ARRAY['queues']
      WHEN 'outbox_append' THEN ARRAY['outbox']
      WHEN 'lease_release' THEN ARRAY['leaseUpserts', 'leaseDeletes']
      ELSE NULL
    END;
    IF allowed_keys IS NULL THEN
      RAISE EXCEPTION 'settle rejects unknown phase %', p_phase USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_phase IS DISTINCT FROM 'atomic' THEN
      RAISE EXCEPTION '% requires the atomic phase', p_operation USING ERRCODE = '22023';
    END IF;
    allowed_keys := CASE p_operation
      WHEN 'admit' THEN ARRAY['unitGraphs', 'units', 'artifacts', 'queues', 'journey']
      WHEN 'claim_worker' THEN ARRAY['leaseUpserts', 'fairnessUpserts']
      WHEN 'claim_external' THEN ARRAY['leaseUpserts']
      WHEN 'heartbeat' THEN ARRAY['leaseUpserts']
      WHEN 'prepare_attempt' THEN ARRAY['attempts']
      WHEN 'cache_completion' THEN ARRAY['cachedCompletions']
      WHEN 'record_failure' THEN ARRAY[
        'artifacts', 'queues', 'journey', 'joins', 'failures', 'outbox',
        'deadLetters', 'leaseUpserts', 'leaseDeletes'
      ]
      ELSE ARRAY[]::text[]
    END;
  END IF;
  FOR delta_key, delta_value IN SELECT key, value FROM pg_catalog.jsonb_each(delta)
  LOOP
    IF pg_catalog.jsonb_array_length(delta_value) > 0
       AND NOT delta_key = ANY (allowed_keys) THEN
      RAISE EXCEPTION '%/% may not append delta class %', p_operation, p_phase, delta_key
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Unit-scoped rows must belong to the one unit the operation addresses.
  IF p_queue_id IS NOT NULL THEN
    SELECT queue.unit_id::text INTO scope_unit
    FROM {{schema}}.unit_queue AS queue WHERE queue.queue_id = p_queue_id::uuid;
  END IF;
  scope_unit := COALESCE(scope_unit, p_unit_id);
  IF scope_unit IS NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(delta) AS entry(key, value)
    WHERE entry.key NOT IN ('leaseUpserts', 'fairnessUpserts')
      AND pg_catalog.jsonb_array_length(entry.value) > 0
  ) THEN
    RAISE EXCEPTION '% appends unit evidence without a unit scope', p_operation
      USING ERRCODE = '42501';
  END IF;

  -- Graph bindings --------------------------------------------------------
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'unitGraphs') AS value(
      "unitId" text, "graphId" text, "graphVersion" bigint, "graphDigest" text,
      "graphCanonicalJson" text
    )
    LEFT JOIN {{schema}}.graphs AS graph
      ON graph.graph_id = value."graphId" AND graph.graph_version = value."graphVersion"
    WHERE value."unitId" IS DISTINCT FROM scope_unit
       OR graph.graph_id IS NULL
       OR graph.graph_digest::text IS DISTINCT FROM value."graphDigest"
       OR graph.definition_json::text IS DISTINCT FROM value."graphCanonicalJson"
  ) THEN
    RAISE EXCEPTION 'unit delta binds an unpublished or conflicting graph'
      USING ERRCODE = '23505';
  END IF;

  -- Outbox ----------------------------------------------------------------
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'outbox') AS value(
      "unitId" text, "queueId" text, "nodeId" text
    )
    WHERE value."unitId" IS DISTINCT FROM scope_unit
       OR value."nodeId" IS DISTINCT FROM p_node_id
       OR (value."queueId" IS NOT NULL AND value."queueId" IS DISTINCT FROM p_queue_id)
  ) THEN
    RAISE EXCEPTION 'outbox append is outside the addressed turn' USING ERRCODE = '42501';
  END IF;
  -- Identity order follows the delta's array order, which is the engine's.
  INSERT INTO {{schema}}.outbox (
    outbox_event_id, unit_id, queue_id, node_id, attempt_number, attempt_index,
    event_type, payload, dedupe_key, event_digest, recorded_at, event_record
  )
  SELECT (item.value ->> 'outboxEventId')::uuid, item.value ->> 'unitId',
    (item.value ->> 'queueId')::uuid, item.value ->> 'nodeId',
    (item.value ->> 'attemptNumber')::bigint, (item.value ->> 'attemptIndex')::bigint,
    item.value ->> 'eventType', item.value ->> 'payloadCanonicalJson',
    item.value ->> 'dedupeKey', item.value ->> 'eventDigest',
    (item.value ->> 'recordedAt')::timestamptz, item.value ->> 'canonicalJson'
  FROM pg_catalog.jsonb_array_elements(delta -> 'outbox')
    WITH ORDINALITY AS item(value, ordinality)
  ORDER BY item.ordinality
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'outbox') AS value(
      "canonicalJson" text, "outboxEventId" text
    )
    LEFT JOIN {{schema}}.outbox AS event
      ON event.outbox_event_id = value."outboxEventId"::uuid
    WHERE event.outbox_event_id IS NULL
       OR event.event_record::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'outbox identity or dedupe key conflicts with retained evidence'
      USING ERRCODE = '23505';
  END IF;

  -- Dead letters ----------------------------------------------------------
  INSERT INTO {{schema}}.dead_letters (
    dead_letter_id, unit_id, queue_id, node_id, attempt_number, attempt_index,
    error_code, failure_digest, principal_id, recorded_at, dead_letter
  )
  SELECT value."deadLetterId"::uuid, value."unitId", value."queueId"::uuid,
    value."nodeId", value."attemptNumber", value."attemptIndex", value."errorCode",
    value."failureDigest", value."principalId", value."recordedAt", value."canonicalJson"
  FROM pg_catalog.jsonb_to_recordset(delta -> 'deadLetters') AS value(
    "canonicalJson" text, "deadLetterId" text, "unitId" text, "queueId" text,
    "nodeId" text, "attemptNumber" bigint, "attemptIndex" bigint, "errorCode" text,
    "failureDigest" text, "principalId" text, "recordedAt" timestamptz
  )
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'deadLetters') AS value(
      "canonicalJson" text, "deadLetterId" text, "unitId" text, "queueId" text,
      "nodeId" text, "principalId" text
    )
    LEFT JOIN {{schema}}.dead_letters AS letter
      ON letter.dead_letter_id = value."deadLetterId"::uuid
    WHERE value."unitId" IS DISTINCT FROM scope_unit
       OR value."queueId" IS DISTINCT FROM p_queue_id
       OR value."nodeId" IS DISTINCT FROM p_node_id
       OR value."principalId" IS DISTINCT FROM p_principal_id
       OR letter.dead_letter_id IS NULL
       OR letter.dead_letter::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'dead-letter identity conflicts with retained evidence'
      USING ERRCODE = '23505';
  END IF;

  -- Leases (mutable, fenced) ------------------------------------------------
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'leaseUpserts') AS value(
      "queueId" text, "leaseToken" text, "mode" text, "principalId" text,
      "externalKind" text
    )
    LEFT JOIN {{schema}}.unit_queue AS queue ON queue.queue_id = value."queueId"::uuid
    LEFT JOIN {{schema}}.graph_nodes AS node
      ON node.graph_id = queue.graph_id
     AND node.graph_version = queue.graph_version
     AND node.graph_digest = queue.graph_digest
     AND node.node_id = queue.node_id
    WHERE node.node_id IS NULL
       OR node.principal_id::text IS DISTINCT FROM value."principalId"
       OR value."mode" NOT IN ('worker', 'external')
       OR (value."mode" = 'worker'
           AND (node.kind NOT IN ('code', 'model', 'agent') OR value."externalKind" IS NOT NULL))
       OR (value."mode" = 'external'
           AND (node.kind NOT IN ('human', 'callback')
                OR value."externalKind" IS DISTINCT FROM node.kind::text))
       OR (p_operation = 'claim_worker'
           AND (value."mode" <> 'worker'
                OR value."principalId" IS DISTINCT FROM p_principal_id
                OR (p_node_id IS NOT NULL AND queue.node_id <> p_node_id)))
       OR (p_operation = 'claim_external'
           AND (value."queueId" IS DISTINCT FROM p_queue_id
                OR value."mode" <> 'external'
                OR value."principalId" IS DISTINCT FROM p_principal_id))
       OR (p_operation IN ('heartbeat', 'record_failure', 'settle')
           AND (value."queueId" IS DISTINCT FROM p_queue_id
                OR value."leaseToken" IS DISTINCT FROM p_lease_token))
  ) THEN
    RAISE EXCEPTION 'lease delta exceeds the sealed queue authority' USING ERRCODE = '42501';
  END IF;
  -- A lease row is replaced only by its own holder or once it has expired.
  INSERT INTO {{schema}}.unit_leases (
    queue_id, lease_owner, lease_token, acquired_at, heartbeat_at, expires_at,
    mode, principal_id, external_kind, external_actor_id,
    external_completion_digest, external_outbox_digests, lease_definition
  )
  SELECT value."queueId"::uuid, value."leaseOwner", value."leaseToken"::uuid,
    value."acquiredAt", value."heartbeatAt", value."expiresAt",
    value."mode"::{{schema}}.lease_mode, value."principalId",
    value."externalKind"::{{schema}}.node_kind, value."externalActorId",
    value."externalCompletionDigest", value."externalOutboxDigests", value."canonicalJson"
  FROM pg_catalog.jsonb_to_recordset(delta -> 'leaseUpserts') AS value(
    "canonicalJson" text, "queueId" text, "leaseOwner" text, "leaseToken" text,
    "acquiredAt" timestamptz, "heartbeatAt" timestamptz, "expiresAt" timestamptz,
    "mode" text, "principalId" text, "externalKind" text, "externalActorId" text,
    "externalCompletionDigest" text, "externalOutboxDigests" jsonb
  )
  ON CONFLICT (queue_id) DO UPDATE SET
    lease_owner = EXCLUDED.lease_owner,
    lease_token = EXCLUDED.lease_token,
    acquired_at = EXCLUDED.acquired_at,
    heartbeat_at = EXCLUDED.heartbeat_at,
    expires_at = EXCLUDED.expires_at,
    mode = EXCLUDED.mode,
    principal_id = EXCLUDED.principal_id,
    external_kind = EXCLUDED.external_kind,
    external_actor_id = EXCLUDED.external_actor_id,
    external_completion_digest = EXCLUDED.external_completion_digest,
    external_outbox_digests = EXCLUDED.external_outbox_digests,
    lease_definition = EXCLUDED.lease_definition
  WHERE {{schema}}.unit_leases.lease_token = EXCLUDED.lease_token
     OR {{schema}}.unit_leases.expires_at <= p_at;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'leaseUpserts') AS value(
      "canonicalJson" text, "queueId" text
    )
    LEFT JOIN {{schema}}.unit_leases AS lease ON lease.queue_id = value."queueId"::uuid
    WHERE lease.queue_id IS NULL
       OR lease.lease_definition::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'lease upsert lost to another active lease'
      USING ERRCODE = 'P0002', DETAIL = 'turn_lease_lost';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(delta -> 'leaseDeletes') AS raw(value)
    WHERE pg_catalog.jsonb_typeof(raw.value) <> 'string'
       OR raw.value #>> '{}' IS DISTINCT FROM p_queue_id
  ) THEN
    RAISE EXCEPTION 'lease release is outside the addressed queue' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.jsonb_array_length(delta -> 'leaseDeletes') > 0 THEN
    DELETE FROM {{schema}}.unit_leases AS lease
    WHERE lease.queue_id = p_queue_id::uuid
      AND lease.lease_token = p_lease_token::uuid;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    IF deleted_count <> 1 THEN
      RAISE EXCEPTION 'turn lease is no longer held'
        USING ERRCODE = 'P0002', DETAIL = 'turn_lease_lost';
    END IF;
  END IF;

  -- Fairness cursors (mutable) --------------------------------------------
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'fairnessUpserts') AS value(
      "nodeId" text, "nodeRefId" text, "nodeRefVersion" bigint,
      "graphId" text, "graphVersion" bigint, "graphDigest" text
    )
    LEFT JOIN {{schema}}.graph_nodes AS node
      ON node.graph_id = value."graphId"
     AND node.graph_version = value."graphVersion"
     AND node.graph_digest = value."graphDigest"
     AND node.node_id = value."nodeId"
    WHERE node.node_id IS NULL
       OR node.node_ref_id::text IS DISTINCT FROM value."nodeRefId"
       OR node.node_ref_version::bigint IS DISTINCT FROM value."nodeRefVersion"
       OR node.principal_id::text IS DISTINCT FROM p_principal_id
       OR node.kind NOT IN ('code', 'model', 'agent')
       OR (p_node_id IS NOT NULL AND value."nodeId" <> p_node_id)
  ) THEN
    RAISE EXCEPTION 'fairness delta exceeds the claimed worker lane' USING ERRCODE = '42501';
  END IF;
  INSERT INTO {{schema}}.fairness_cursors (
    node_id, node_ref_id, node_ref_version, last_graph_id, last_graph_version,
    last_graph_digest, updated_at
  )
  SELECT value."nodeId", value."nodeRefId", value."nodeRefVersion",
    value."graphId", value."graphVersion", value."graphDigest", p_at
  FROM pg_catalog.jsonb_to_recordset(delta -> 'fairnessUpserts') AS value(
    "nodeId" text, "nodeRefId" text, "nodeRefVersion" bigint,
    "graphId" text, "graphVersion" bigint, "graphDigest" text
  )
  ON CONFLICT (node_id, node_ref_id, node_ref_version) DO UPDATE SET
    last_graph_id = EXCLUDED.last_graph_id,
    last_graph_version = EXCLUDED.last_graph_version,
    last_graph_digest = EXCLUDED.last_graph_digest,
    updated_at = EXCLUDED.updated_at;

  -- Queue occurrences ------------------------------------------------------
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'queues') AS value(
      "unitId" text, "graphId" text, "graphVersion" bigint, "graphDigest" text,
      "nodeId" text, "nodeRefId" text, "nodeRefVersion" bigint,
      "inputContractId" text
    )
    LEFT JOIN {{schema}}.graph_nodes AS node
      ON node.graph_id = value."graphId"
     AND node.graph_version = value."graphVersion"
     AND node.graph_digest = value."graphDigest"
     AND node.node_id = value."nodeId"
    WHERE value."unitId" IS DISTINCT FROM scope_unit
       OR node.node_id IS NULL
       OR node.node_ref_id::text IS DISTINCT FROM value."nodeRefId"
       OR node.node_ref_version::bigint IS DISTINCT FROM value."nodeRefVersion"
       OR node.input_contract::text IS DISTINCT FROM value."inputContractId"
  ) THEN
    RAISE EXCEPTION 'queue occurrence does not match its sealed graph node'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO {{schema}}.unit_queue (
    queue_id, unit_id, graph_id, graph_version, graph_digest, node_id,
    node_ref_id, node_ref_version, input_contract_id, input_artifact_digest,
    input_envelope, queued_at, enqueue_sequence, source_evidence_digest,
    source_journey_sequence, source_journey_record_digest, inbound_edge_ids,
    join_provenance, queue_definition
  )
  SELECT value."queueId"::uuid, value."unitId", value."graphId",
    value."graphVersion", value."graphDigest", value."nodeId", value."nodeRefId",
    value."nodeRefVersion", value."inputContractId", value."inputArtifactDigest",
    value."inputEnvelopeCanonicalJson", value."queuedAt", value."enqueueSequence",
    value."sourceEvidenceDigest", value."sourceJourneySequence",
    value."sourceJourneyRecordDigest", value."inboundEdgeIds",
    NULLIF(value."joinProvenance", 'null'::jsonb), value."canonicalJson"
  FROM pg_catalog.jsonb_to_recordset(delta -> 'queues') AS value(
    "canonicalJson" text, "queueId" text, "unitId" text, "graphId" text,
    "graphVersion" bigint, "graphDigest" text, "nodeId" text, "nodeRefId" text,
    "nodeRefVersion" bigint, "inputContractId" text, "inputArtifactDigest" text,
    "inputEnvelopeCanonicalJson" text, "queuedAt" timestamptz,
    "enqueueSequence" bigint, "sourceEvidenceDigest" text,
    "sourceJourneySequence" bigint, "sourceJourneyRecordDigest" text,
    "inboundEdgeIds" jsonb, "joinProvenance" jsonb
  )
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'queues') AS value(
      "canonicalJson" text, "queueId" text
    )
    LEFT JOIN {{schema}}.unit_queue AS queue ON queue.queue_id = value."queueId"::uuid
    WHERE queue.queue_id IS NULL
       OR queue.queue_definition::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'queue identity conflicts with retained routing evidence'
      USING ERRCODE = '23505';
  END IF;
  INSERT INTO {{schema}}.unit_artifacts (
    unit_id, contract_id, artifact_digest, linked_at, source_operation, source_queue_id
  )
  SELECT value."unitId", value."inputContractId", value."inputArtifactDigest",
    p_at, p_operation, value."queueId"::uuid
  FROM pg_catalog.jsonb_to_recordset(delta -> 'queues') AS value(
    "queueId" text, "unitId" text, "inputContractId" text, "inputArtifactDigest" text
  )
  ON CONFLICT DO NOTHING;

  -- Join progress (appended revisions) --------------------------------------
  INSERT INTO {{schema}}.join_progress (
    unit_id, node_id, progress_revision, status, selected_queue_id,
    synthetic_outcome_digest, progress_digest, progress, recorded_at
  )
  SELECT value."unitId", value."nodeId",
    COALESCE((
      SELECT pg_catalog.max(existing.progress_revision) + 1
      FROM {{schema}}.join_progress AS existing
      WHERE existing.unit_id = value."unitId" AND existing.node_id = value."nodeId"
    ), 1),
    value."status"::{{schema}}.join_status, value."selectedQueueId"::uuid,
    value."syntheticOutcomeDigest", value."progressDigest", value."canonicalJson", p_at
  FROM pg_catalog.jsonb_to_recordset(delta -> 'joins') AS value(
    "canonicalJson" text, "unitId" text, "nodeId" text, "status" text,
    "selectedQueueId" text, "syntheticOutcomeDigest" text, "progressDigest" text
  )
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'joins') AS value(
      "canonicalJson" text, "unitId" text, "nodeId" text, "progressDigest" text
    )
    LEFT JOIN {{schema}}.join_progress AS progress
      ON progress.unit_id = value."unitId"
     AND progress.node_id = value."nodeId"
     AND progress.progress_digest = value."progressDigest"
    WHERE value."unitId" IS DISTINCT FROM scope_unit
       OR progress.unit_id IS NULL
       OR progress.progress::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'join progress conflicts with retained evidence' USING ERRCODE = '23505';
  END IF;

  -- Attempts, completion cache, failures, settlements --------------------------
  INSERT INTO {{schema}}.turn_attempts (
    queue_id, unit_id, node_id, node_ref_id, node_ref_version, fingerprint,
    input_digest, execution_identity_digest, attempt_number, attempt_index,
    idempotency_key, reserved_at, attempt
  )
  SELECT value."queueId"::uuid, value."unitId", value."nodeId", value."nodeRefId",
    value."nodeRefVersion", value."fingerprint", value."inputDigest",
    value."executionIdentityDigest", value."attemptNumber", value."attemptIndex",
    value."idempotencyKey", p_at, value."canonicalJson"
  FROM pg_catalog.jsonb_to_recordset(delta -> 'attempts') AS value(
    "canonicalJson" text, "queueId" text, "unitId" text, "nodeId" text,
    "nodeRefId" text, "nodeRefVersion" bigint, "fingerprint" text,
    "inputDigest" text, "executionIdentityDigest" text, "attemptNumber" bigint,
    "attemptIndex" bigint, "idempotencyKey" text
  )
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'attempts') AS value(
      "canonicalJson" text, "queueId" text, "unitId" text, "nodeId" text,
      "attemptNumber" bigint
    )
    LEFT JOIN {{schema}}.turn_attempts AS attempt
      ON attempt.queue_id = value."queueId"::uuid
     AND attempt.attempt_number = value."attemptNumber"
    WHERE value."queueId" IS DISTINCT FROM p_queue_id
       OR value."unitId" IS DISTINCT FROM scope_unit
       OR value."nodeId" IS DISTINCT FROM p_node_id
       OR attempt.queue_id IS NULL
       OR attempt.attempt::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'attempt identity conflicts with retained evidence' USING ERRCODE = '23505';
  END IF;

  INSERT INTO {{schema}}.turn_completion_cache (
    queue_id, attempt_number, attempt_index, idempotency_key, completion_digest,
    completion, started_at, settled_at
  )
  SELECT value."queueId"::uuid, value."attemptNumber", value."attemptIndex",
    value."idempotencyKey", value."completionDigest", value."canonicalJson",
    value."startedAt", value."settledAt"
  FROM pg_catalog.jsonb_to_recordset(delta -> 'cachedCompletions') AS value(
    "canonicalJson" text, "queueId" text, "attemptNumber" bigint,
    "attemptIndex" bigint, "idempotencyKey" text, "completionDigest" text,
    "startedAt" timestamptz, "settledAt" timestamptz
  )
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'cachedCompletions') AS value(
      "canonicalJson" text, "queueId" text, "attemptNumber" bigint
    )
    LEFT JOIN {{schema}}.turn_completion_cache AS cache
      ON cache.queue_id = value."queueId"::uuid
     AND cache.attempt_number = value."attemptNumber"
    WHERE value."queueId" IS DISTINCT FROM p_queue_id
       OR cache.queue_id IS NULL
       OR cache.completion::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'completion cache conflicts with retained evidence' USING ERRCODE = '23505';
  END IF;

  INSERT INTO {{schema}}.turn_failures (
    queue_id, unit_id, node_id, attempt_number, attempt_index, idempotency_key,
    principal_id, started_at, failed_at, error_code, error_message, retryable,
    terminal, usage_receipts, failure_digest, committed_outbox_digests, failure
  )
  SELECT value."queueId"::uuid, value."unitId", value."nodeId",
    value."attemptNumber", value."attemptIndex", value."idempotencyKey",
    value."principalId", value."startedAt", value."failedAt", value."errorCode",
    value."errorMessage", value."retryable", value."terminal",
    value."usageCanonicalJson", value."failureDigest",
    value."committedOutboxDigests", value."canonicalJson"
  FROM pg_catalog.jsonb_to_recordset(delta -> 'failures') AS value(
    "canonicalJson" text, "queueId" text, "unitId" text, "nodeId" text,
    "attemptNumber" bigint, "attemptIndex" bigint, "idempotencyKey" text,
    "principalId" text, "startedAt" timestamptz, "failedAt" timestamptz,
    "errorCode" text, "errorMessage" text, "retryable" boolean, "terminal" boolean,
    "usageCanonicalJson" text, "failureDigest" text, "committedOutboxDigests" jsonb
  )
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'failures') AS value(
      "canonicalJson" text, "queueId" text, "unitId" text, "nodeId" text,
      "attemptNumber" bigint, "principalId" text
    )
    LEFT JOIN {{schema}}.turn_failures AS failure
      ON failure.queue_id = value."queueId"::uuid
     AND failure.attempt_number = value."attemptNumber"
    WHERE value."queueId" IS DISTINCT FROM p_queue_id
       OR value."unitId" IS DISTINCT FROM scope_unit
       OR value."nodeId" IS DISTINCT FROM p_node_id
       OR value."principalId" IS DISTINCT FROM p_principal_id
       OR failure.queue_id IS NULL
       OR failure.failure::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'failure identity conflicts with retained evidence' USING ERRCODE = '23505';
  END IF;

  INSERT INTO {{schema}}.turn_settlements (
    queue_id, unit_id, node_id, attempt_number, attempt_index, idempotency_key,
    principal_id, actor_id, outcome, output_contract_id, output_artifact_digest,
    started_at, settled_at, completion_digest, settlement_digest, completion,
    committed_outbox_digests, settlement
  )
  SELECT value."queueId"::uuid, value."unitId", value."nodeId",
    value."attemptNumber", value."attemptIndex", value."idempotencyKey",
    value."principalId", value."actorId", value."outcome",
    value."outputContractId", value."outputArtifactDigest", value."startedAt",
    value."settledAt", value."completionDigest", value."settlementDigest",
    value."completionCanonicalJson", value."committedOutboxDigests", value."canonicalJson"
  FROM pg_catalog.jsonb_to_recordset(delta -> 'settlements') AS value(
    "canonicalJson" text, "queueId" text, "unitId" text, "nodeId" text,
    "attemptNumber" bigint, "attemptIndex" bigint, "idempotencyKey" text,
    "principalId" text, "actorId" text, "outcome" text, "outputContractId" text,
    "outputArtifactDigest" text, "startedAt" timestamptz, "settledAt" timestamptz,
    "completionDigest" text, "settlementDigest" text,
    "completionCanonicalJson" text, "committedOutboxDigests" jsonb
  )
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'settlements') AS value(
      "canonicalJson" text, "queueId" text, "unitId" text, "nodeId" text,
      "principalId" text
    )
    LEFT JOIN {{schema}}.turn_settlements AS settlement
      ON settlement.queue_id = value."queueId"::uuid
    WHERE value."queueId" IS DISTINCT FROM p_queue_id
       OR value."unitId" IS DISTINCT FROM scope_unit
       OR value."nodeId" IS DISTINCT FROM p_node_id
       OR value."principalId" IS DISTINCT FROM p_principal_id
       OR settlement.queue_id IS NULL
       OR settlement.settlement::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'settlement identity conflicts with retained evidence'
      USING ERRCODE = '23505';
  END IF;

  -- Artifacts (shared by contract/digest, linked per unit) -------------------
  INSERT INTO {{schema}}.artifacts (
    contract_id, artifact_digest, declared_bytes, envelope, retained_at
  )
  SELECT value."contractId", value."artifactDigest", value."declaredBytes",
    value."canonicalJson", p_at
  FROM pg_catalog.jsonb_to_recordset(delta -> 'artifacts') AS value(
    "canonicalJson" text, "contractId" text, "artifactDigest" text, "declaredBytes" bigint
  )
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'artifacts') AS value(
      "canonicalJson" text, "contractId" text, "artifactDigest" text
    )
    LEFT JOIN {{schema}}.artifacts AS artifact
      ON artifact.contract_id = value."contractId"
     AND artifact.artifact_digest = value."artifactDigest"
    WHERE artifact.contract_id IS NULL
       OR artifact.envelope::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'artifact identity conflicts with retained evidence'
      USING ERRCODE = '23505';
  END IF;
  INSERT INTO {{schema}}.unit_artifacts (
    unit_id, contract_id, artifact_digest, linked_at, source_operation, source_queue_id
  )
  SELECT scope_unit, value."contractId", value."artifactDigest", p_at, p_operation,
    p_queue_id::uuid
  FROM pg_catalog.jsonb_to_recordset(delta -> 'artifacts') AS value(
    "contractId" text, "artifactDigest" text
  )
  ON CONFLICT DO NOTHING;

  -- Units and journey ---------------------------------------------------------
  INSERT INTO {{schema}}.units (
    unit_id, graph_id, graph_version, graph_digest, seed_contract_id,
    seed_artifact_digest, seed_declared_bytes, admitted_at, principal_id,
    admission_digest, unit_definition
  )
  SELECT value."unitId", value."graphId", value."graphVersion", value."graphDigest",
    value."seedContractId", value."seedArtifactDigest", value."seedDeclaredBytes",
    value."admittedAt", value."principalId", value."admissionDigest", value."canonicalJson"
  FROM pg_catalog.jsonb_to_recordset(delta -> 'units') AS value(
    "canonicalJson" text, "unitId" text, "graphId" text, "graphVersion" bigint,
    "graphDigest" text, "seedContractId" text, "seedArtifactDigest" text,
    "seedDeclaredBytes" bigint, "admittedAt" timestamptz, "principalId" text,
    "admissionDigest" text
  )
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'units') AS value(
      "canonicalJson" text, "unitId" text
    )
    LEFT JOIN {{schema}}.units AS unit ON unit.unit_id = value."unitId"
    WHERE value."unitId" IS DISTINCT FROM p_unit_id
       OR unit.unit_id IS NULL
       OR unit.unit_definition::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'unit identity conflicts with retained admission' USING ERRCODE = '23505';
  END IF;

  INSERT INTO {{schema}}.unit_journey (
    unit_id, sequence, kind, queue_id, node_id, recorded_at, record_digest, record
  )
  SELECT value."unitId", value."sequence", value."kind"::{{schema}}.journey_kind,
    value."queueId"::uuid, value."nodeId", value."recordedAt", value."recordDigest",
    value."canonicalJson"
  FROM pg_catalog.jsonb_to_recordset(delta -> 'journey') AS value(
    "canonicalJson" text, "unitId" text, "sequence" bigint, "kind" text,
    "queueId" text, "nodeId" text, "recordedAt" timestamptz, "recordDigest" text
  )
  ON CONFLICT DO NOTHING;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(delta -> 'journey') AS value(
      "canonicalJson" text, "unitId" text, "sequence" bigint
    )
    LEFT JOIN {{schema}}.unit_journey AS journey
      ON journey.unit_id = value."unitId" AND journey.sequence = value."sequence"
    WHERE value."unitId" IS DISTINCT FROM scope_unit
       OR journey.unit_id IS NULL
       OR journey.record::text IS DISTINCT FROM value."canonicalJson"
  ) THEN
    RAISE EXCEPTION 'journey record conflicts with retained evidence' USING ERRCODE = '23505';
  END IF;
END
$apply_unit_delta$;

-- Lock-free, advisory claim pre-check. A conservative TRUE (for example when
-- every open occurrence is leased) falls through to the full claim; only
-- FALSE, meaning no open worker-kind occurrence for this principal, lets an
-- idle worker skip the serialized hydrating claim transaction.
CREATE FUNCTION {{schema}}.has_claimable_worker_turns(
  p_principal_id text,
  p_node_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $has_claimable_worker_turns$
  SELECT EXISTS (
    SELECT 1
    FROM {{schema}}.unit_queue AS queue
    JOIN {{schema}}.graph_nodes AS node
      ON node.graph_id = queue.graph_id
     AND node.graph_version = queue.graph_version
     AND node.graph_digest = queue.graph_digest
     AND node.node_id = queue.node_id
    WHERE node.kind IN ('code', 'model', 'agent')
      AND node.principal_id = p_principal_id
      AND (p_node_id IS NULL OR queue.node_id = p_node_id)
      AND {{schema}}.queue_is_open(queue.queue_id)
  )
$has_claimable_worker_turns$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA {{schema}} FROM PUBLIC;
