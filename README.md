# @scshafe/switchyard-postgres

PostgreSQL stores for [`@scshafe/switchyard`](https://github.com/scshafe/switchyard):
a `GraphStore`, a `UnitStore`, and human-decision recording for `human` nodes, over
one versioned schema you can inspect with plain SQL.

- **Same semantics as the engine.** Every unit operation replays switchyard's own
  `MemoryUnitStore` over the unit's rows inside one SERIALIZABLE transaction and appends
  the resulting delta, so routing, joins (including 2.1.0 join envelopes), retries,
  leases and fairness behave exactly as the engine specifies. switchyard 2.1.0's
  unit-store and graph-store conformance suites run against this package on every CI run.
- **Append-only evidence.** Units, journeys, queue occurrences, attempts, settlements,
  failures, outbox events and dead letters can't be updated or deleted, even by the owner.
  Only leases and fairness cursors change.
- **Least privilege.** The runtime role can execute the store routines and nothing
  else. A separate reader role can `SELECT` every table and view.

Requires Node 22.22+ or 24.18+, PostgreSQL (tested on 18), and
`@scshafe/switchyard` `^2.1.0` as a peer dependency.

## Install

The package is on GitHub Packages. Map the scope in your project's `.npmrc`:

```ini
@scshafe:registry=https://npm.pkg.github.com
```

Put a token with `read:packages` in your user-level npmrc (in `$HOME`, as the
`_authToken` for `npm.pkg.github.com`), never in the project. Then:

```sh
pnpm add @scshafe/switchyard@2.2.0 @scshafe/switchyard-postgres@0.1.1
```

`pg` comes in as a dependency.

## Quick start

### 1. Start PostgreSQL

```sh
docker run -d --name switchyard-db -p 127.0.0.1:5432:5432 \
  -e POSTGRES_PASSWORD=devpassword postgres:18
```

### 2. Create the schema

```sh
export SWITCHYARD_DATABASE_URL=postgres://postgres:devpassword@127.0.0.1:5432/postgres
pnpm exec switchyard-postgres migrate
# {"schema":"switchyard","applied":[1,2,3],"currentVersion":3,"roles":{"runtime":"switchyard_runtime","reader":"switchyard_reader"}}
```

`migrate` is idempotent, so you can run it on every deploy. It creates the schema, applies
any pending migrations, and grants the two NOLOGIN roles. To connect your app with the
runtime role and nothing more, give a login role membership:

```sql
CREATE ROLE my_app LOGIN PASSWORD '…' IN ROLE switchyard_runtime;
CREATE ROLE my_dashboard LOGIN PASSWORD '…' IN ROLE switchyard_reader;
```

The CLI also runs `status`. Its options are `--schema`, `--runtime-role`, `--reader-role`,
`--no-roles` (for owner-only use), `--no-create-roles` and `--target <version>`. It
reads the connection from `--url`, `$SWITCHYARD_DATABASE_URL` or `$DATABASE_URL`. From
code, call `await migrate({ connectionString, schema: "switchyard" })` or pass a `pool`.

### 3. Wire the stores into switchyard

```ts
import pg from "pg";
import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { createGraphDefinition, graphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import { runNextUnitTurn } from "@scshafe/switchyard/execute/unit-runner";
import { assertSchemaCurrent, createPostgresStores } from "@scshafe/switchyard-postgres";

const pool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
pool.on("error", (error) => console.error("idle PostgreSQL client failed", error));
await assertSchemaCurrent({ pool });

const { graphStore, unitStore, humanDecisions } = createPostgresStores({ pool });

const turn = {
  idempotency: "per (unitId, nodeId, attemptNumber)",
  leaseMs: 30_000,
  maxAttempts: 3,
  retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
} as const;
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

await graphStore.publishGraph(graph); // replaying an identical graph is a no-op
await unitStore.admitUnit({
  unitId: "question-42",
  graph: graphDefinitionRef(graph),
  seedArtifact: createArtifactEnvelope("question.v1", { text: "What is a switchyard?" }),
  admittedAt: new Date().toISOString(),
  principalId: "admitter"
});

// A worker loop: claim and run the next code/model/agent turn for a principal.
await runNextUnitTurn({
  store: unitStore,
  principalId: "worker",
  leaseOwner: "worker-1",
  ports: { code: { run: async () => ({ outcome: "drafted" }) } }
});
```

### 4. Record a human decision

```ts
const [pending] = await humanDecisions.listPending({ principalId: "reviewer" });
// pending.inputArtifact is what the reviewer decides on; pending.outcomes are the choices.
await humanDecisions.record({ queueId: pending.queueId, outcome: "approved", actorId: "alice" });
const decisions = await humanDecisions.listDecisions({ unitId: "question-42" });
```

`record` settles the human turn through switchyard's `recordHumanNodeDecision`, under the
node's sealed principal. The engine checks the outcome against the node's vocabulary, and
if the node declares an output contract for that outcome, the decision has to carry it as
`outputArtifact`. The actor is kept as evidence and never grants authority. Approval and
review steps that switchyard compiles from node settings become ordinary `human` nodes,
so this recording covers them as well.

### 5. Watch a unit move

As any member of `switchyard_reader`:

```sql
SELECT node_id, status, outcome, actor_id, attempts, queued_at, settled_at
FROM switchyard.turns WHERE unit_id = 'question-42' ORDER BY enqueue_sequence;

SELECT * FROM switchyard.pending_human_turns ORDER BY enqueue_sequence;
SELECT * FROM switchyard.human_decisions ORDER BY decision_sequence;
```

## Schema

The schema name defaults to `switchyard`. You can pass any other with `schema` or
`--schema`, and several schemas can live in one database. The roles are
`<schema>_runtime` and `<schema>_reader` unless you name them yourself.

| Object | What it holds |
| --- | --- |
| `graphs`, `graph_nodes`, `node_definitions` | Sealed graph definitions (exact canonical JSON), one row per node, and the first-published meaning of each node ref/version (kind, input contract, outcome set, declared output contracts) |
| `units`, `artifacts`, `unit_artifacts` | Admissions, artifacts shared by contract and digest, and which artifacts each unit may read |
| `unit_queue`, `unit_journey` | Immutable queue occurrences (each tied to the journey record that routed it) and the per-unit journey |
| `turn_attempts`, `turn_completion_cache`, `turn_failures`, `turn_settlements` | Attempt reservations, cached completions, failures, and settlements (with `outcome`, `actor_id` and output artifact columns) |
| `join_progress` | Join progress revisions; the highest revision is current |
| `outbox`, `dead_letters` | Transactional outbox events and dead letters |
| `unit_leases`, `fairness_cursors` | The only mutable state: fenced leases and claim fairness |
| `turns`, `pending_human_turns`, `human_decisions` (views) | Status per queue occurrence, open human turns, and recorded decisions |
| `schema_migrations` | Applied versions and their SHA-256 checksums |

JSON evidence is stored as exact canonical text rather than `jsonb`, because `jsonb` can't
hold the valid escape `\u0000`. Typed columns project the fields you'd query on.

## Operating notes

- **Ownership.** Run `migrate` as the role that should own the schema, and in production
  make that a dedicated non-superuser. The store routines are `SECURITY DEFINER` and run
  as that owner. Only the owner can apply later migrations.
- **Pools.** Attach `pool.on("error", …)`. pg emits it when an idle client's connection
  dies. While a client is checked out, this package handles the error itself.
- **Throughput.** Unit operations take one schema-wide advisory lock, so decisions are
  serialized. Each operation also reads its units' full evidence plus every outbox dedupe
  key. That fits the small-to-moderate volumes switchyard targets. Claims first run a
  lock-free check, so idle workers never take the lock.
- **Retries.** Serialization, deadlock, lock and statement-timeout errors are retried
  before commit, up to `maxSerializationAttempts` (default 96, with backoff).
- **Versioning.** Applied migrations are immutable, so a schema change is always a new
  numbered file. `assertSchemaCurrent` fails fast when the database and the library
  disagree.

## API

| Export | Purpose |
| --- | --- |
| `migrate(options)`, `migrationStatus(options)`, `assertSchemaCurrent(options)` | Schema lifecycle; `options` take `pool` or `connectionString`, plus `schema` |
| `PostgresGraphStore({ pool, schema? })` | switchyard `GraphStore` |
| `PostgresUnitStore({ pool, schema?, now?, idFactory?, maxSerializationAttempts? })` | switchyard `UnitStore` (also a worker/external turn store); `hasClaimableWorkerTurns(principalId, nodeId?)` |
| `PostgresHumanDecisions({ pool, schema?, unitStore?, now? })` | `listPending`, `inspect`, `record`, `listDecisions` |
| `createPostgresStores({ pool, schema?, ... })` | All three stores over one pool and schema |
| `MIGRATIONS`, `LATEST_MIGRATION_VERSION`, `loadMigrations()` | The pinned migration manifest |

## Development

```sh
pnpm install
pnpm run build
pnpm test        # starts postgres:18.6 (pinned digest) in Docker, runs every test, removes it
```

If you set `SWITCHYARD_POSTGRES_TEST_URL` to a superuser URL, the tests use that server
and don't start Docker (CI uses a service container this way). Each scenario runs in its
own database, copied from a migrated template. The stores connect through a login that's
only a member of `switchyard_runtime`, so the suites also check the grants.
`pnpm run verify` runs the build, the tests and the package checks (payload manifest,
byte-reproducible pack, pack-and-install smoke, secret and path scan).

**The engine comes from GitHub Packages.** `@scshafe/switchyard` is a dev dependency
pinned exactly (and a peer dependency `^2.1.0` for consumers), installed from
npm.pkg.github.com like any `@scshafe` package: locally with a `read:packages` token in your user-level
`.npmrc`, in CI with the job token, which needs the `@scshafe/switchyard` package to
grant this repository read access ("Manage Actions access").

## Releasing

Releases follow the SCSHAFE library standard (LIB-06/07). Bump `package.json`, add a
`## x.y.z — date` section to `CHANGELOG.md`, run `pnpm run release:manifest`, and commit.
Once CI is green on `main`, push an annotated tag `vx.y.z`. `publish.yml` checks the tag
against `main` and the version, runs `verify`, publishes to GitHub Packages, installs the
published version back, compares its integrity, and creates the GitHub Release with the
digests.

## License

MIT
