# Changelog

All notable changes to `@scshafe/switchyard-postgres` are recorded here.
Versions follow [SemVer](https://semver.org/). A release is the annotated tag
`v<x.y.z>` on a commit on `main` whose `package.json` version is `<x.y.z>`;
published versions are never deleted, replaced or reused.

## 0.1.0 — unreleased

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
