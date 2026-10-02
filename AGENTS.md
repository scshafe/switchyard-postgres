# @scshafe/switchyard-postgres Agent Contract

A managed library under the SCSHAFE library standard (`scshafe-library` v1).
It is published to GitHub Packages and deploys nothing. Read `README.md` and
the header comments of `src/unit-store.ts` and `sql/002_store_routines.sql`
before meaningful changes.

## Invariants

- The engine owns the semantics. `PostgresUnitStore` replays switchyard's
  `MemoryUnitStore` over one operation's scoped rows and appends the diff;
  never re-implement routing, joins, retries, leases or fairness in SQL or in
  this package. A behaviour question is answered by switchyard's conformance
  suites, which must pass unmodified (`test/*-conformance.test.mjs`).
- Migrations in `sql/` are immutable once released: a schema change is a new
  numbered file, pinned in `src/migrations.ts` (`node scripts/pin-migrations.mjs`
  only for a file that has never been released). Templates use `{{schema}}`;
  every object is schema-qualified and every routine pins
  `search_path = pg_catalog`.
- Evidence tables are append-only (triggers); only `unit_leases` and
  `fairness_cursors` are mutable. The runtime role gets EXECUTE on the routines
  listed in `RUNTIME_ROUTINES` and no relation privilege; the reader role gets
  SELECT only. New routines must be added to that list deliberately.
- No application-specific tables or routines (email, jobs, model capacity,
  console projections of particular contracts). Those belong to the consumer.
- Runtime dependencies: `pg` only; `@scshafe/switchyard` is a peer. Public
  types never reference `pg` types (see `src/pg.ts`).
- `lib/` is build output and is never committed. Build it with
  `pnpm run build`.
- Toolchain is pnpm, pinned by `packageManager` (`pnpm@10.34.5`), with
  `pnpm-lock.yaml` committed and `strictDepBuilds: true`. Do not add
  `package-lock.json`.
- `.npmrc` holds only `@scshafe:registry=https://npm.pkg.github.com`. Never
  commit a credential, `_authToken` line or token to any file.
- The payload is the `files` whitelist in `package.json`; the release manifest
  `release/scshafe-switchyard-postgres-<version>.payload.sha256` pins every
  packed file's sha256. A payload change (including `package.json`,
  `README.md`, `CHANGELOG.md` or `sql/`) needs
  `pnpm run build && pnpm run release:manifest` in the same commit.
- `@scshafe/switchyard` comes from GitHub Packages (dev dependency pinned
  exactly, peer `^2.2.0`). Never vendor it or add a pnpm override:
  `publish.yml` refuses to release while either exists.
- The release kit (`scripts/check-*.mjs`, `clean.mjs`, `release-identity.mjs`,
  `smoke-peers.mjs`, `write-release-manifest.mjs`, `ci.yml`, `publish.yml`) is
  scshafe-dev's master, verbatim. `pin-migrations.mjs` and `test-postgres.mjs`
  are this repository's own. Repository inputs live in
  `scripts/release.config.mjs`; the packed-install smokes are `test/smoke/`.
  One known local difference: `ci.yml` and `publish.yml` add the Postgres
  service the tests need (drift lessons CI15, PB27). Do not edit the kit
  here; change `release.config.mjs`, or change the master and re-sync
  (`dev check --diff`).

## Verification

```sh
pnpm install --frozen-lockfile
pnpm run verify             # build, tests on PostgreSQL 18, payload, release bytes, packed install
pnpm run test:fresh-clone   # clean committed HEAD only: clone, install, build, verify
```

Tests need PostgreSQL: `pnpm test` starts a pinned `postgres:18.6` container
with Docker and removes it afterwards, or uses the superuser URL in
`SWITCHYARD_POSTGRES_TEST_URL` (CI's service container). CI
(`.github/workflows/ci.yml`) runs `verify` on the Node matrix in `engines` on
GitHub-hosted runners. Libraries never use a self-hosted runner.

## Releasing

- SemVer; `package.json` `version` is the authority. A release commit bumps
  the version, adds `## <x.y.z> — <date>` to `CHANGELOG.md` and regenerates
  the release manifest.
- After `ci.yml` is green on `main`, the owning agent pushes the annotated tag
  `v<x.y.z>` on that `main` commit. `.github/workflows/publish.yml` is the only
  publisher: it refuses tags not on `main` or not equal to the version,
  verifies, publishes, installs the published version back, compares
  integrity, and creates the GitHub Release with the digests.
- Never run `pnpm publish` by hand, never reuse, move or delete a tag or a
  published version. A bad release is superseded by a higher patch version
  with a changelog note.
- No prereleases in v1; co-development with consumers uses `pnpm link`, which
  must never be committed in a consumer.
