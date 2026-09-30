# Changelog

All notable changes to `@scshafe/switchyard-postgres` are recorded here.
Versions follow [SemVer](https://semver.org/). A release is the annotated tag
`v<x.y.z>` on a commit on `main` whose `package.json` version is `<x.y.z>`;
published versions are never deleted, replaced or reused.

## 0.2.0 — 2026-09-30

Found by a first-run guide author and a fresh-eyes tester on switchyard
2.2.0 + 0.1.1. Migration 004 is new; run `switchyard-postgres migrate`
before deploying 0.2.0 (`assertSchemaCurrent` refuses a version-3 schema).

- **Fixed: `assertSchemaCurrent` as the runtime role.** It read
  `schema_migrations`, on which the runtime role (EXECUTE on routines, no
  relation privilege) has no privilege, so the README quick start failed
  with `permission denied for table schema_migrations`. Migration 004 adds
  `schema_migration_status()`, a SECURITY DEFINER routine returning only
  the applied-migration ledger; the runtime role gets EXECUTE on it and
  still holds no relation privilege. `migrationStatus` /
  `assertSchemaCurrent` read the ledger as the connected role may, and a
  runtime role on a pre-004 schema is told to run `migrate`.
- **Added: `humanDecisions.recordAnswer`.** Takes what a person answered
  (`approved` / `denied` at an approval node, `accepted` / `rejected`, with
  optional `notes`, at a review node, or an ordinary human node's outcome),
  names the turn by `queueId` or by `unitId` + `nodeId`, and maps the answer
  to the stored outcome (`accepted:<outcome>`, `rework`, `rejected`) with
  switchyard's `approvalReviewHumanDecision`. Invalid answers throw
  `InvalidHumanAnswerError`, which lists the valid ones. Optional
  `principalId` guard. `record` is unchanged.
- **Changed: `listPending` order and fields.** A turn's `outcomes` follow
  the node's declared order instead of lexical order. New fields: `answers`
  (the person-facing choices), `notesAnswers` and `role` (the node's part in
  an approval/review expansion). `listPending` also filters by `unitId`.
- **Added: views `unit_status`, `unit_positions`, `unit_outputs`** (reader
  role): a unit's overall status (`awaiting_human`, `active`, `completed`,
  `failed`), final terminal outcome and the artifact it carries; its open
  queue occurrences with FIFO position; and every artifact its turns
  produced, with a `jsonb` payload projection.
- **Added: `createPostgresStores({ connectionString })`**, with
  `maxConnections`, `onPoolError`, and `close()`; the result also exposes
  `pool`. `pg` stays a regular dependency (the package opens connections
  itself; the stores take any `pg.Pool`-shaped object), documented in the
  README.
- **Peer range: `@scshafe/switchyard` `^2.2.0`** (was `^2.1.0`).
  `recordAnswer` and the `answers` / `role` fields use
  `approvalReviewHumanDecision`, `approvalReviewRole` and `reviewNotes`,
  which switchyard exports from 2.2.0.
- README: the quick start needs no `pg` import, records the review with
  `recordAnswer` and reads the new views; its test now runs the README's
  own code blocks and SQL instead of a copy.

## 0.1.1 — 2026-09-30

No change to the library code, SQL or public API; 0.1.0's release job
stopped before creating its GitHub Release, so 0.1.1 is the first release
with one.

- Release: the install-back job now installs `@scshafe/switchyard` (the
  exact version from `devDependencies`) next to the published package, as a
  user does. Relying on pnpm's auto-installed peer left the engine
  unimportable from the consumer, and 0.1.0's smoke failed with
  `ERR_MODULE_NOT_FOUND`. The pack-install smoke now requires the consumer to
  depend on the engine directly. The integrity comparison still covers only
  `@scshafe/switchyard-postgres`.
- Tests: fixed an intermittent failure of "schema names are validated and a
  custom schema coexists with the default" under file concurrency.
  `pg.Pool#end()` resolves before its backends exit, so the scenario's
  `DROP DATABASE … WITH (FORCE)` could still terminate one of them. That
  test's extra pool had no `'error'` listener, so the resulting FATAL 57P01
  was thrown as an uncaught exception. The pool now comes from the test
  helper that attaches one. Every test connection also sets an
  `application_name` naming its file and pool.

## 0.1.0 — 2026-09-30

Published to GitHub Packages; the release job failed before the GitHub
Release (see 0.1.1).


First release: the generic PostgreSQL stores for `@scshafe/switchyard`
`^2.1.0`, extracted from inbox-pipeline's `node-graph-v2` adapter onto a fresh
schema.

- `PostgresGraphStore` and `PostgresUnitStore` implement switchyard's
  `GraphStore` and `UnitStore` (including 2.1.0 declared output contracts,
  join envelopes and declared failure recovery) and pass switchyard's
  graph-store and unit-store conformance suites (2.2.0) on PostgreSQL 18.
  Approval and review nodes (switchyard 2.2.0) are ordinary nodes to the
  store; human approvers and reviewers are recorded like any `human` node.
- `PostgresHumanDecisions` records decisions at `human` nodes through the
  engine's `recordHumanNodeDecision`, lists pending human turns without
  hydrating the engine, and keeps a decision ledger.
- Schema migrations 001–003 (engine schema, store routines, human-decision
  projections and inspection views), a configurable schema name (default
  `switchyard`), `migrate()` / `migrationStatus()` / `assertSchemaCurrent()`
  and the `switchyard-postgres migrate|status` CLI.
- Least-privilege roles `<schema>_runtime` (execute the store routines only)
  and `<schema>_reader` (read tables and views); append-only evidence.
