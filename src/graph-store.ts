// graph-store.ts — PostgreSQL implementation of switchyard's GraphStore.

import { canonicalJson } from "@scshafe/switchyard/contracts/digest";
import { compileGraph } from "@scshafe/switchyard/graph/compile";
import {
  graphDefinitionRef,
  validateGraphDefinition,
  type GraphDefinition,
  type GraphDefinitionRef
} from "@scshafe/switchyard/graph/definition";
import {
  GraphLoadDigestConflictError,
  GraphPublicationConflictError,
  GraphPublicationValidationError,
  NodeDefinitionPublicationConflictError,
  nodeDefinitionSignature,
  validateGraphDefinitionRef,
  type GraphStore,
  type NodeDefinitionConflictField
} from "@scshafe/switchyard/store/graph-store";

import { inTransaction, withClient, type PgClient, type PgPool } from "./pg.js";
import { DEFAULT_SCHEMA, qualified, validateSchemaName } from "./schema.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;

type PublicationStatus = "published" | "replayed" | "graph_conflict" | "node_conflict";

interface PublishGraphRow extends Record<string, unknown> {
  readonly publication_status: string;
  readonly published_digest: string | null;
  readonly node_ref_id: string | null;
  readonly node_ref_version: string | number | null;
  readonly conflict_field: string | null;
  readonly first_graph_id: string | null;
  readonly first_graph_version: string | number | null;
  readonly first_graph_digest: string | null;
}

interface LoadGraphRow extends Record<string, unknown> {
  readonly graph_digest: string;
  readonly definition_json: string;
}

interface PublishedNodeSignature {
  readonly refId: string;
  readonly refVersion: number;
  readonly kind: string;
  readonly input: string;
  readonly outcomes: readonly string[];
  readonly outputs?: Readonly<Record<string, string>>;
}

export interface PostgresGraphStoreOptions {
  readonly pool: PgPool;
  /** Schema created by migrate(). Default "switchyard". */
  readonly schema?: string;
}

function trustedErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "graph compilation failed";
}

function safePositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a safe positive integer`);
  }
  return parsed;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new Error(`${label} must be bare lowercase SHA-256 hex`);
  }
  return value;
}

function presentString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function publicationStatus(value: unknown): PublicationStatus {
  if (
    value !== "published"
    && value !== "replayed"
    && value !== "graph_conflict"
    && value !== "node_conflict"
  ) {
    throw new Error(`publish_graph returned unknown status ${JSON.stringify(value)}`);
  }
  return value;
}

function conflictField(value: unknown): NodeDefinitionConflictField {
  if (
    value !== "kind"
    && value !== "input contract"
    && value !== "outcome vocabulary"
    && value !== "output contracts"
  ) {
    throw new Error(`publish_graph returned invalid node conflict field ${JSON.stringify(value)}`);
  }
  return value;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One normalized signature per node ref/version, in ref order. */
function graphNodeSignatures(graph: GraphDefinition): readonly PublishedNodeSignature[] {
  const byRef = new Map<string, PublishedNodeSignature>();
  for (const node of graph.nodes) {
    const signature = nodeDefinitionSignature(node);
    byRef.set(`${node.ref.id}\u0000${node.ref.version}`, {
      refId: node.ref.id,
      refVersion: node.ref.version,
      kind: signature.kind,
      input: signature.input,
      outcomes: signature.outcomes,
      ...(signature.outputs === undefined ? {} : { outputs: signature.outputs })
    });
  }
  return [...byRef.values()].sort((left, right) => {
    const byId = lexicalCompare(left.refId, right.refId);
    return byId === 0 ? left.refVersion - right.refVersion : byId;
  });
}

function mapPublicationResult(row: PublishGraphRow, requested: GraphDefinitionRef): void {
  const status = publicationStatus(row.publication_status);
  if (status === "published" || status === "replayed") {
    const publishedDigest = sha256(row.published_digest, "publish_graph published_digest");
    if (publishedDigest !== requested.digest) {
      throw new Error(
        `publish_graph ${status} digest mismatch: expected ${requested.digest}, received ${publishedDigest}`
      );
    }
    return;
  }
  if (status === "graph_conflict") {
    throw new GraphPublicationConflictError(
      requested.id,
      requested.version,
      sha256(row.published_digest, "publish_graph published_digest"),
      requested.digest
    );
  }
  const publishedBy = validateGraphDefinitionRef(
    {
      id: presentString(row.first_graph_id, "publish_graph first_graph_id"),
      version: safePositiveInteger(row.first_graph_version, "publish_graph first_graph_version"),
      digest: sha256(row.first_graph_digest, "publish_graph first_graph_digest")
    },
    "publish_graph first-publisher graph ref"
  );
  throw new NodeDefinitionPublicationConflictError({
    nodeRefId: presentString(row.node_ref_id, "publish_graph node_ref_id"),
    nodeRefVersion: safePositiveInteger(row.node_ref_version, "publish_graph node_ref_version"),
    field: conflictField(row.conflict_field),
    publishedBy,
    requestedBy: requested
  });
}

/**
 * Load and fully re-validate one sealed graph over an existing connection.
 * Shared by the graph store and the unit store's in-transaction reader.
 */
export async function loadGraphOnClient(
  client: PgClient,
  schema: string,
  refRaw: GraphDefinitionRef
): Promise<GraphDefinition | undefined> {
  const ref = validateGraphDefinitionRef(refRaw, "loadGraph graph ref");
  const result = await client.query<LoadGraphRow>(
    `SELECT graph_digest, definition_json FROM ${qualified(schema, "load_graph")}($1::text, $2::bigint)`,
    [ref.id, ref.version]
  );
  if (result.rows.length === 0) return undefined;
  if (result.rows.length !== 1) {
    throw new Error(`load_graph must return zero or one row (got ${result.rows.length})`);
  }
  const row = result.rows[0]!;
  const storedDigest = sha256(row.graph_digest, "load_graph graph_digest");
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.definition_json) as unknown;
  } catch (error) {
    throw new GraphPublicationValidationError(
      ref.id, ref.version, "stored canonical definition is not JSON", error
    );
  }
  let graph: GraphDefinition;
  try {
    graph = validateGraphDefinition(decoded);
    compileGraph(graph);
  } catch (error) {
    throw new GraphPublicationValidationError(ref.id, ref.version, trustedErrorMessage(error), error);
  }
  if (graph.graphId !== ref.id || graph.version !== ref.version || graph.graphDigest !== storedDigest) {
    const error = new Error(
      `stored graph identity ${graph.graphId}@${graph.version} (${graph.graphDigest}) does not match row ${ref.id}@${ref.version} (${storedDigest})`
    );
    throw new GraphPublicationValidationError(ref.id, ref.version, error.message, error);
  }
  if (canonicalJson(graph) !== row.definition_json) {
    const error = new Error("stored graph definition is not canonical JSON");
    throw new GraphPublicationValidationError(ref.id, ref.version, error.message, error);
  }
  if (storedDigest !== ref.digest) {
    throw new GraphLoadDigestConflictError(ref.id, ref.version, storedDigest, ref.digest);
  }
  return graph;
}

/** Immutable, digest-sealed graph registry in PostgreSQL. */
export class PostgresGraphStore implements GraphStore {
  readonly schema: string;
  readonly #pool: PgPool;

  constructor(options: PostgresGraphStoreOptions) {
    this.#pool = options.pool;
    this.schema = validateSchemaName(options.schema ?? DEFAULT_SCHEMA);
  }

  async publishGraph(graphRaw: GraphDefinition): Promise<void> {
    const graph = validateGraphDefinition(graphRaw);
    try {
      compileGraph(graph);
    } catch (error) {
      throw new GraphPublicationValidationError(
        graph.graphId, graph.version, trustedErrorMessage(error), error
      );
    }
    const requested = graphDefinitionRef(graph);
    const definitionText = canonicalJson(graph);
    const signaturesText = canonicalJson(graphNodeSignatures(graph));

    await inTransaction(this.#pool, async (client) => {
      const result = await client.query<PublishGraphRow>(`
        SELECT publication_status, published_digest, node_ref_id, node_ref_version,
          conflict_field, first_graph_id, first_graph_version, first_graph_digest
        FROM ${qualified(this.schema, "publish_graph")}($1::text, $2::bigint, $3::text, $4::text, $5::jsonb)
      `, [graph.graphId, graph.version, graph.graphDigest, definitionText, signaturesText]);
      if (result.rows.length !== 1) {
        throw new Error(`publish_graph must return exactly one row (got ${result.rows.length})`);
      }
      mapPublicationResult(result.rows[0]!, requested);
    });
  }

  async loadGraph(ref: GraphDefinitionRef): Promise<GraphDefinition | undefined> {
    return withClient(this.#pool, (client) => loadGraphOnClient(client, this.schema, ref));
  }
}
