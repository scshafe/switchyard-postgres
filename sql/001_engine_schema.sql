-- 001 — switchyard engine schema.
--
-- Fresh, consolidated store for @scshafe/switchyard graphs and units. Every
-- occurrence of {{schema}} is replaced by the quoted, validated schema name
-- (default "switchyard") before this file runs; the migration runner wraps
-- the whole file in one transaction and records it in schema_migrations.
--
-- Arbitrary engine evidence (graph definitions, artifacts, journey records,
-- completions, outbox payloads) is retained as its exact canonical JSON TEXT.
-- PostgreSQL json/jsonb rejects the valid JSON escape \u0000, so jsonb is used
-- only for small engine-authored projections. Typed columns are the query and
-- constraint projection of that text; the adapter re-validates the text.

CREATE DOMAIN {{schema}}.identifier AS text COLLATE "C"
  CHECK (
    char_length(VALUE) BETWEEN 1 AND 160
    AND VALUE ~ '^[a-z0-9][a-z0-9._:-]*$'
  );

CREATE DOMAIN {{schema}}.evidence_text AS text COLLATE "C"
  CHECK (
    char_length(VALUE) BETWEEN 1 AND 512
    AND VALUE !~ '[[:cntrl:]]'
  );

CREATE DOMAIN {{schema}}.sha256_digest AS text COLLATE "C"
  CHECK (VALUE ~ '^[a-f0-9]{64}$');

CREATE DOMAIN {{schema}}.contract_id AS text COLLATE "C"
  CHECK (
    char_length(VALUE) BETWEEN 1 AND 160
    AND VALUE ~ '^[a-z0-9][a-z0-9._-]*[.]v[1-9][0-9]*$'
  );

CREATE DOMAIN {{schema}}.canonical_json_text AS text COLLATE "C"
  CHECK (octet_length(VALUE) BETWEEN 1 AND 134217728);

CREATE DOMAIN {{schema}}.safe_positive_integer AS bigint
  CHECK (VALUE BETWEEN 1 AND 9007199254740991);

CREATE TYPE {{schema}}.node_kind AS ENUM (
  'code', 'model', 'agent', 'human', 'callback'
);
CREATE TYPE {{schema}}.journey_kind AS ENUM (
  'unit_admitted', 'turn_settled', 'turn_failed', 'join_unsatisfiable'
);
CREATE TYPE {{schema}}.lease_mode AS ENUM ('worker', 'external');
CREATE TYPE {{schema}}.join_status AS ENUM (
  'pending', 'queued', 'unsatisfiable'
);

-- Graph registry ------------------------------------------------------------

CREATE TABLE {{schema}}.graphs (
  graph_id {{schema}}.identifier NOT NULL,
  graph_version {{schema}}.safe_positive_integer NOT NULL,
  graph_digest {{schema}}.sha256_digest NOT NULL,
  definition_json {{schema}}.canonical_json_text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT transaction_timestamp()
    CHECK (isfinite(published_at)),
  PRIMARY KEY (graph_id, graph_version),
  UNIQUE (graph_id, graph_version, graph_digest)
);

-- One row per node ref/version: the definition-bound meaning (kind, input
-- contract, outcome set, declared output contracts) first published for it.
CREATE TABLE {{schema}}.node_definitions (
  node_ref_id {{schema}}.identifier NOT NULL,
  node_ref_version {{schema}}.safe_positive_integer NOT NULL,
  kind {{schema}}.node_kind NOT NULL,
  input_contract {{schema}}.contract_id NOT NULL,
  outcomes jsonb NOT NULL CHECK (jsonb_typeof(outcomes) = 'array'),
  outputs jsonb CHECK (outputs IS NULL OR jsonb_typeof(outputs) = 'object'),
  first_graph_id {{schema}}.identifier NOT NULL,
  first_graph_version {{schema}}.safe_positive_integer NOT NULL,
  first_graph_digest {{schema}}.sha256_digest NOT NULL,
  PRIMARY KEY (node_ref_id, node_ref_version),
  FOREIGN KEY (first_graph_id, first_graph_version, first_graph_digest)
    REFERENCES {{schema}}.graphs (graph_id, graph_version, graph_digest)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE {{schema}}.graph_nodes (
  graph_id {{schema}}.identifier NOT NULL,
  graph_version {{schema}}.safe_positive_integer NOT NULL,
  graph_digest {{schema}}.sha256_digest NOT NULL,
  node_id {{schema}}.identifier NOT NULL,
  node_ref_id {{schema}}.identifier NOT NULL,
  node_ref_version {{schema}}.safe_positive_integer NOT NULL,
  kind {{schema}}.node_kind NOT NULL,
  input_contract {{schema}}.contract_id NOT NULL,
  outcomes jsonb NOT NULL CHECK (jsonb_typeof(outcomes) = 'array'),
  principal_id {{schema}}.evidence_text NOT NULL,
  lease_ms bigint NOT NULL CHECK (lease_ms > 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  join_definition jsonb
    CHECK (join_definition IS NULL OR jsonb_typeof(join_definition) = 'object'),
  node_definition jsonb NOT NULL CHECK (jsonb_typeof(node_definition) = 'object'),
  PRIMARY KEY (graph_id, graph_version, node_id),
  UNIQUE (graph_id, graph_version, graph_digest, node_id),
  FOREIGN KEY (graph_id, graph_version, graph_digest)
    REFERENCES {{schema}}.graphs (graph_id, graph_version, graph_digest)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (node_ref_id, node_ref_version)
    REFERENCES {{schema}}.node_definitions (node_ref_id, node_ref_version)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX graph_nodes_principal_kind
  ON {{schema}}.graph_nodes (principal_id, kind, node_id);

-- Units and their evidence ----------------------------------------------------

CREATE TABLE {{schema}}.artifacts (
  contract_id {{schema}}.contract_id NOT NULL,
  artifact_digest {{schema}}.sha256_digest NOT NULL,
  declared_bytes {{schema}}.safe_positive_integer,
  envelope {{schema}}.canonical_json_text NOT NULL,
  retained_at timestamptz NOT NULL CHECK (isfinite(retained_at)),
  PRIMARY KEY (contract_id, artifact_digest)
);

CREATE TABLE {{schema}}.units (
  unit_id {{schema}}.evidence_text PRIMARY KEY,
  graph_id {{schema}}.identifier NOT NULL,
  graph_version {{schema}}.safe_positive_integer NOT NULL,
  graph_digest {{schema}}.sha256_digest NOT NULL,
  seed_contract_id {{schema}}.contract_id NOT NULL,
  seed_artifact_digest {{schema}}.sha256_digest NOT NULL,
  seed_declared_bytes {{schema}}.safe_positive_integer,
  admitted_at timestamptz NOT NULL CHECK (isfinite(admitted_at)),
  principal_id {{schema}}.evidence_text NOT NULL,
  admission_digest {{schema}}.sha256_digest NOT NULL UNIQUE,
  unit_definition {{schema}}.canonical_json_text NOT NULL,
  FOREIGN KEY (graph_id, graph_version, graph_digest)
    REFERENCES {{schema}}.graphs (graph_id, graph_version, graph_digest)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (seed_contract_id, seed_artifact_digest)
    REFERENCES {{schema}}.artifacts (contract_id, artifact_digest)
    DEFERRABLE INITIALLY DEFERRED
);

-- Which retained artifacts a unit may read back. Artifacts are shared by
-- contract/digest; this link scopes hydration to one unit's evidence.
CREATE TABLE {{schema}}.unit_artifacts (
  unit_id {{schema}}.evidence_text NOT NULL
    REFERENCES {{schema}}.units (unit_id) DEFERRABLE INITIALLY DEFERRED,
  contract_id {{schema}}.contract_id NOT NULL,
  artifact_digest {{schema}}.sha256_digest NOT NULL,
  linked_at timestamptz NOT NULL CHECK (isfinite(linked_at)),
  source_operation text COLLATE "C" NOT NULL,
  source_queue_id uuid,
  PRIMARY KEY (unit_id, contract_id, artifact_digest),
  FOREIGN KEY (contract_id, artifact_digest)
    REFERENCES {{schema}}.artifacts (contract_id, artifact_digest)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX unit_artifacts_artifact
  ON {{schema}}.unit_artifacts (contract_id, artifact_digest, unit_id);

CREATE TABLE {{schema}}.unit_journey (
  unit_id {{schema}}.evidence_text NOT NULL
    REFERENCES {{schema}}.units (unit_id) DEFERRABLE INITIALLY DEFERRED,
  sequence {{schema}}.safe_positive_integer NOT NULL,
  kind {{schema}}.journey_kind NOT NULL,
  queue_id uuid,
  node_id {{schema}}.identifier NOT NULL,
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  record_digest {{schema}}.sha256_digest NOT NULL UNIQUE,
  record {{schema}}.canonical_json_text NOT NULL,
  PRIMARY KEY (unit_id, sequence),
  UNIQUE (unit_id, sequence, record_digest),
  CHECK ((kind = 'join_unsatisfiable') = (queue_id IS NULL))
);

-- Queue occurrences are immutable once appended. Each names the journey
-- record whose routing created it; open/leased/settled is derived from the
-- lease, settlement and failure tables.
CREATE TABLE {{schema}}.unit_queue (
  queue_id uuid PRIMARY KEY,
  unit_id {{schema}}.evidence_text NOT NULL
    REFERENCES {{schema}}.units (unit_id) DEFERRABLE INITIALLY DEFERRED,
  graph_id {{schema}}.identifier NOT NULL,
  graph_version {{schema}}.safe_positive_integer NOT NULL,
  graph_digest {{schema}}.sha256_digest NOT NULL,
  node_id {{schema}}.identifier NOT NULL,
  node_ref_id {{schema}}.identifier NOT NULL,
  node_ref_version {{schema}}.safe_positive_integer NOT NULL,
  input_contract_id {{schema}}.contract_id NOT NULL,
  input_artifact_digest {{schema}}.sha256_digest NOT NULL,
  input_envelope {{schema}}.canonical_json_text NOT NULL,
  queued_at timestamptz NOT NULL CHECK (isfinite(queued_at)),
  enqueue_sequence {{schema}}.safe_positive_integer NOT NULL UNIQUE,
  source_evidence_digest {{schema}}.sha256_digest NOT NULL,
  source_journey_sequence {{schema}}.safe_positive_integer NOT NULL,
  source_journey_record_digest {{schema}}.sha256_digest NOT NULL,
  inbound_edge_ids jsonb NOT NULL CHECK (jsonb_typeof(inbound_edge_ids) = 'array'),
  join_provenance jsonb
    CHECK (join_provenance IS NULL OR jsonb_typeof(join_provenance) = 'object'),
  queue_definition {{schema}}.canonical_json_text NOT NULL,
  FOREIGN KEY (graph_id, graph_version, graph_digest, node_id)
    REFERENCES {{schema}}.graph_nodes (graph_id, graph_version, graph_digest, node_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (input_contract_id, input_artifact_digest)
    REFERENCES {{schema}}.artifacts (contract_id, artifact_digest)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (unit_id, source_journey_sequence, source_journey_record_digest)
    REFERENCES {{schema}}.unit_journey (unit_id, sequence, record_digest)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX unit_queue_unit_order
  ON {{schema}}.unit_queue (unit_id, enqueue_sequence);
CREATE INDEX unit_queue_node_fifo
  ON {{schema}}.unit_queue (node_id, enqueue_sequence);

ALTER TABLE {{schema}}.unit_journey
  ADD FOREIGN KEY (queue_id) REFERENCES {{schema}}.unit_queue (queue_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Mutable coordination state: one fenced lease per queue occurrence.
CREATE TABLE {{schema}}.unit_leases (
  queue_id uuid PRIMARY KEY
    REFERENCES {{schema}}.unit_queue (queue_id) DEFERRABLE INITIALLY DEFERRED,
  lease_owner {{schema}}.evidence_text NOT NULL,
  lease_token uuid NOT NULL UNIQUE,
  acquired_at timestamptz NOT NULL CHECK (isfinite(acquired_at)),
  heartbeat_at timestamptz NOT NULL CHECK (isfinite(heartbeat_at)),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  mode {{schema}}.lease_mode NOT NULL,
  principal_id {{schema}}.evidence_text NOT NULL,
  external_kind {{schema}}.node_kind,
  external_actor_id {{schema}}.evidence_text,
  external_completion_digest {{schema}}.sha256_digest,
  external_outbox_digests jsonb,
  lease_definition {{schema}}.canonical_json_text NOT NULL,
  CHECK (heartbeat_at >= acquired_at),
  CHECK (expires_at > heartbeat_at),
  CHECK (
    (
      mode = 'worker'
      AND external_kind IS NULL
      AND external_actor_id IS NULL
      AND external_completion_digest IS NULL
      AND external_outbox_digests IS NULL
    )
    OR (
      mode = 'external'
      AND external_kind IN ('human', 'callback')
      AND external_actor_id IS NOT NULL
      AND external_completion_digest IS NOT NULL
      AND jsonb_typeof(external_outbox_digests) = 'array'
    )
  )
);
CREATE INDEX unit_leases_expiry ON {{schema}}.unit_leases (expires_at, queue_id);

CREATE TABLE {{schema}}.turn_attempts (
  queue_id uuid NOT NULL
    REFERENCES {{schema}}.unit_queue (queue_id) DEFERRABLE INITIALLY DEFERRED,
  unit_id {{schema}}.evidence_text NOT NULL
    REFERENCES {{schema}}.units (unit_id) DEFERRABLE INITIALLY DEFERRED,
  node_id {{schema}}.identifier NOT NULL,
  node_ref_id {{schema}}.identifier NOT NULL,
  node_ref_version {{schema}}.safe_positive_integer NOT NULL,
  fingerprint {{schema}}.sha256_digest NOT NULL,
  input_digest {{schema}}.sha256_digest NOT NULL,
  execution_identity_digest {{schema}}.sha256_digest,
  attempt_number {{schema}}.safe_positive_integer NOT NULL,
  attempt_index {{schema}}.safe_positive_integer NOT NULL,
  idempotency_key {{schema}}.sha256_digest NOT NULL UNIQUE,
  reserved_at timestamptz NOT NULL CHECK (isfinite(reserved_at)),
  attempt {{schema}}.canonical_json_text NOT NULL,
  PRIMARY KEY (queue_id, attempt_number),
  UNIQUE (queue_id, attempt_index)
);
CREATE INDEX turn_attempts_unit ON {{schema}}.turn_attempts (unit_id);

CREATE TABLE {{schema}}.turn_completion_cache (
  queue_id uuid NOT NULL,
  attempt_number {{schema}}.safe_positive_integer NOT NULL,
  attempt_index {{schema}}.safe_positive_integer NOT NULL,
  idempotency_key {{schema}}.sha256_digest NOT NULL,
  completion_digest {{schema}}.sha256_digest NOT NULL,
  completion {{schema}}.canonical_json_text NOT NULL,
  started_at timestamptz NOT NULL CHECK (isfinite(started_at)),
  settled_at timestamptz NOT NULL CHECK (isfinite(settled_at)),
  PRIMARY KEY (queue_id, attempt_number),
  FOREIGN KEY (queue_id, attempt_number)
    REFERENCES {{schema}}.turn_attempts (queue_id, attempt_number)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (settled_at >= started_at)
);

CREATE TABLE {{schema}}.turn_failures (
  queue_id uuid NOT NULL,
  unit_id {{schema}}.evidence_text NOT NULL,
  node_id {{schema}}.identifier NOT NULL,
  attempt_number {{schema}}.safe_positive_integer NOT NULL,
  attempt_index {{schema}}.safe_positive_integer NOT NULL,
  idempotency_key {{schema}}.sha256_digest NOT NULL,
  principal_id {{schema}}.evidence_text NOT NULL,
  started_at timestamptz NOT NULL CHECK (isfinite(started_at)),
  failed_at timestamptz NOT NULL CHECK (isfinite(failed_at)),
  error_code {{schema}}.identifier NOT NULL,
  error_message text COLLATE "C" NOT NULL
    CHECK (char_length(error_message) BETWEEN 1 AND 2000),
  retryable boolean NOT NULL,
  terminal boolean NOT NULL,
  usage_receipts {{schema}}.canonical_json_text NOT NULL,
  failure_digest {{schema}}.sha256_digest NOT NULL UNIQUE,
  committed_outbox_digests jsonb NOT NULL
    CHECK (jsonb_typeof(committed_outbox_digests) = 'array'),
  failure {{schema}}.canonical_json_text NOT NULL,
  PRIMARY KEY (queue_id, attempt_number),
  FOREIGN KEY (queue_id, attempt_number)
    REFERENCES {{schema}}.turn_attempts (queue_id, attempt_number)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (failed_at >= started_at)
);
CREATE UNIQUE INDEX turn_failures_one_terminal_per_queue
  ON {{schema}}.turn_failures (queue_id) WHERE terminal;
CREATE INDEX turn_failures_unit ON {{schema}}.turn_failures (unit_id);

CREATE TABLE {{schema}}.turn_settlements (
  settlement_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  queue_id uuid PRIMARY KEY,
  unit_id {{schema}}.evidence_text NOT NULL,
  node_id {{schema}}.identifier NOT NULL,
  attempt_number {{schema}}.safe_positive_integer NOT NULL,
  attempt_index {{schema}}.safe_positive_integer NOT NULL,
  idempotency_key {{schema}}.sha256_digest NOT NULL,
  principal_id {{schema}}.evidence_text NOT NULL,
  actor_id {{schema}}.evidence_text,
  outcome {{schema}}.identifier NOT NULL,
  output_contract_id {{schema}}.contract_id,
  output_artifact_digest {{schema}}.sha256_digest,
  started_at timestamptz NOT NULL CHECK (isfinite(started_at)),
  settled_at timestamptz NOT NULL CHECK (isfinite(settled_at)),
  completion_digest {{schema}}.sha256_digest NOT NULL,
  settlement_digest {{schema}}.sha256_digest NOT NULL UNIQUE,
  completion {{schema}}.canonical_json_text NOT NULL,
  committed_outbox_digests jsonb NOT NULL
    CHECK (jsonb_typeof(committed_outbox_digests) = 'array'),
  settlement {{schema}}.canonical_json_text NOT NULL,
  FOREIGN KEY (queue_id, attempt_number)
    REFERENCES {{schema}}.turn_attempts (queue_id, attempt_number)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (settled_at >= started_at),
  CHECK ((output_contract_id IS NULL) = (output_artifact_digest IS NULL))
);
CREATE INDEX turn_settlements_unit ON {{schema}}.turn_settlements (unit_id);

-- Join progress is appended as revisions; the highest revision is current.
CREATE TABLE {{schema}}.join_progress (
  unit_id {{schema}}.evidence_text NOT NULL
    REFERENCES {{schema}}.units (unit_id) DEFERRABLE INITIALLY DEFERRED,
  node_id {{schema}}.identifier NOT NULL,
  progress_revision {{schema}}.safe_positive_integer NOT NULL,
  status {{schema}}.join_status NOT NULL,
  selected_queue_id uuid
    REFERENCES {{schema}}.unit_queue (queue_id) DEFERRABLE INITIALLY DEFERRED,
  synthetic_outcome_digest {{schema}}.sha256_digest,
  progress_digest {{schema}}.sha256_digest NOT NULL UNIQUE,
  progress {{schema}}.canonical_json_text NOT NULL,
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  PRIMARY KEY (unit_id, node_id, progress_revision),
  CHECK (
    (status = 'pending' AND selected_queue_id IS NULL AND synthetic_outcome_digest IS NULL)
    OR (status = 'queued' AND selected_queue_id IS NOT NULL AND synthetic_outcome_digest IS NULL)
    OR (status = 'unsatisfiable' AND selected_queue_id IS NULL AND synthetic_outcome_digest IS NOT NULL)
  )
);

-- Mutable coordination state: per shared node, the graph lane served last.
CREATE TABLE {{schema}}.fairness_cursors (
  node_id {{schema}}.identifier NOT NULL,
  node_ref_id {{schema}}.identifier NOT NULL,
  node_ref_version {{schema}}.safe_positive_integer NOT NULL,
  last_graph_id {{schema}}.identifier NOT NULL,
  last_graph_version {{schema}}.safe_positive_integer NOT NULL,
  last_graph_digest {{schema}}.sha256_digest NOT NULL,
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
  PRIMARY KEY (node_id, node_ref_id, node_ref_version),
  FOREIGN KEY (last_graph_id, last_graph_version, last_graph_digest)
    REFERENCES {{schema}}.graphs (graph_id, graph_version, graph_digest)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE {{schema}}.outbox (
  outbox_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  outbox_event_id uuid PRIMARY KEY,
  unit_id {{schema}}.evidence_text NOT NULL
    REFERENCES {{schema}}.units (unit_id) DEFERRABLE INITIALLY DEFERRED,
  queue_id uuid
    REFERENCES {{schema}}.unit_queue (queue_id) DEFERRABLE INITIALLY DEFERRED,
  node_id {{schema}}.identifier NOT NULL,
  attempt_number {{schema}}.safe_positive_integer,
  attempt_index {{schema}}.safe_positive_integer,
  event_type {{schema}}.evidence_text NOT NULL,
  payload {{schema}}.canonical_json_text NOT NULL,
  dedupe_key {{schema}}.evidence_text,
  event_digest {{schema}}.sha256_digest NOT NULL,
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  event_record {{schema}}.canonical_json_text NOT NULL
);
CREATE UNIQUE INDEX outbox_dedupe_key
  ON {{schema}}.outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX outbox_unit_order ON {{schema}}.outbox (unit_id, outbox_sequence);

CREATE TABLE {{schema}}.dead_letters (
  dead_letter_id uuid PRIMARY KEY,
  unit_id {{schema}}.evidence_text NOT NULL
    REFERENCES {{schema}}.units (unit_id) DEFERRABLE INITIALLY DEFERRED,
  queue_id uuid NOT NULL,
  node_id {{schema}}.identifier NOT NULL,
  attempt_number {{schema}}.safe_positive_integer NOT NULL,
  attempt_index {{schema}}.safe_positive_integer NOT NULL,
  error_code {{schema}}.identifier NOT NULL,
  failure_digest {{schema}}.sha256_digest NOT NULL UNIQUE,
  principal_id {{schema}}.evidence_text NOT NULL,
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  dead_letter {{schema}}.canonical_json_text NOT NULL,
  FOREIGN KEY (queue_id, attempt_number)
    REFERENCES {{schema}}.turn_failures (queue_id, attempt_number)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX dead_letters_unit ON {{schema}}.dead_letters (unit_id);

-- Append-only evidence ------------------------------------------------------
-- Evidence rows cannot be updated, deleted or truncated, even by the owner.
-- Only unit_leases and fairness_cursors are mutable coordination state.

CREATE FUNCTION {{schema}}.reject_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $reject_evidence_mutation$
BEGIN
  RAISE EXCEPTION 'switchyard evidence is append-only: %.%',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$reject_evidence_mutation$;

DO $append_only$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'graphs', 'node_definitions', 'graph_nodes', 'artifacts', 'units',
    'unit_artifacts', 'unit_journey', 'unit_queue', 'turn_attempts',
    'turn_completion_cache', 'turn_failures', 'turn_settlements',
    'join_progress', 'outbox', 'dead_letters'
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER reject_evidence_row_mutation BEFORE UPDATE OR DELETE ON %s.%I FOR EACH ROW EXECUTE FUNCTION %s.reject_evidence_mutation()',
      '{{schema}}', relation_name, '{{schema}}'
    );
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER reject_evidence_truncate BEFORE TRUNCATE ON %s.%I FOR EACH STATEMENT EXECUTE FUNCTION %s.reject_evidence_mutation()',
      '{{schema}}', relation_name, '{{schema}}'
    );
  END LOOP;
END
$append_only$;

REVOKE ALL ON ALL TABLES IN SCHEMA {{schema}} FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA {{schema}} FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA {{schema}} FROM PUBLIC;
