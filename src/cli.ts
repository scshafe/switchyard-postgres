#!/usr/bin/env node
// switchyard-postgres — migrate or inspect the switchyard schema.

import { parseArgs } from "node:util";

import { migrate, migrationStatus } from "./migrations.js";
import { DEFAULT_SCHEMA } from "./schema.js";

const USAGE = `usage: switchyard-postgres <migrate|status> [options]

  migrate   create or upgrade the schema (idempotent) and apply role grants
  status    print applied and pending migrations

options:
  --url <postgres-url>     connection string (default: $SWITCHYARD_DATABASE_URL, then $DATABASE_URL)
  --schema <name>          schema name (default: ${DEFAULT_SCHEMA})
  --runtime-role <name>    runtime role (default: <schema>_runtime)
  --reader-role <name>     read-only role (default: <schema>_reader)
  --no-roles               skip role creation and grants (owner-only use)
  --no-create-roles        grant to existing roles, never create them
  --target <version>       stop after this migration version
  -h, --help               show this help

Output is one JSON object on stdout.`;

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      url: { type: "string" },
      schema: { type: "string" },
      "runtime-role": { type: "string" },
      "reader-role": { type: "string" },
      "no-roles": { type: "boolean" },
      "no-create-roles": { type: "boolean" },
      target: { type: "string" },
      help: { type: "boolean", short: "h" }
    }
  });
  const command = positionals[0];
  if (values.help === true || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined && values.help !== true ? 2 : 0;
  }
  if (positionals.length > 1 || (command !== "migrate" && command !== "status")) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const connectionString = values.url
    ?? process.env.SWITCHYARD_DATABASE_URL
    ?? process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    process.stderr.write("switchyard-postgres: no --url, SWITCHYARD_DATABASE_URL or DATABASE_URL\n");
    return 2;
  }
  const schema = values.schema ?? DEFAULT_SCHEMA;

  if (command === "status") {
    const status = await migrationStatus({ connectionString, schema });
    process.stdout.write(`${JSON.stringify({
      schema: status.schema,
      currentVersion: status.currentVersion,
      applied: status.applied,
      pending: status.pending.map(({ version, name }) => ({ version, name }))
    })}\n`);
    return 0;
  }

  let targetVersion: number | undefined;
  if (values.target !== undefined) {
    targetVersion = Number(values.target);
    if (!Number.isSafeInteger(targetVersion)) {
      process.stderr.write("switchyard-postgres: --target must be an integer\n");
      return 2;
    }
  }
  const result = await migrate({
    connectionString,
    schema,
    roles: values["no-roles"] === true
      ? false
      : {
          ...(values["runtime-role"] === undefined ? {} : { runtime: values["runtime-role"] }),
          ...(values["reader-role"] === undefined ? {} : { reader: values["reader-role"] })
        },
    createRoles: values["no-create-roles"] !== true,
    ...(targetVersion === undefined ? {} : { targetVersion })
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`switchyard-postgres: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
);
