# Changelog

All notable changes to `@scshafe/switchyard-postgres` are recorded here.
Versions follow [SemVer](https://semver.org/). A release is the annotated tag
`v<x.y.z>` on a commit on `main` whose `package.json` version is `<x.y.z>`;
published versions are never deleted, replaced or reused.

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
