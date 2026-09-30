// schema.ts — schema and role naming shared by migrations and stores.

/** The schema used when a caller names none. */
export const DEFAULT_SCHEMA = "switchyard" as const;

/**
 * Lower-case SQL identifier, short enough that `<schema>_runtime` and
 * `<schema>_reader` stay within PostgreSQL's 63-byte identifier limit. It is
 * interpolated into SQL (always double-quoted), so the grammar is closed.
 */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,47}$/;
const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export class SwitchyardPostgresConfigError extends Error {
  readonly code = "switchyard_postgres_config";

  constructor(message: string) {
    super(message);
    this.name = "SwitchyardPostgresConfigError";
  }
}

/** Validate a schema name; returns it unchanged. */
export function validateSchemaName(value: unknown = DEFAULT_SCHEMA): string {
  if (typeof value !== "string" || !SCHEMA_NAME_PATTERN.test(value) || value.startsWith("pg_")) {
    throw new SwitchyardPostgresConfigError(
      `schema must match ${SCHEMA_NAME_PATTERN} and not start with pg_ (got ${JSON.stringify(value)})`
    );
  }
  return value;
}

/** Validate a role name; returns it unchanged. */
export function validateRoleName(value: unknown, label: string): string {
  if (typeof value !== "string" || !ROLE_NAME_PATTERN.test(value) || value.startsWith("pg_")) {
    throw new SwitchyardPostgresConfigError(
      `${label} must match ${ROLE_NAME_PATTERN} and not start with pg_ (got ${JSON.stringify(value)})`
    );
  }
  return value;
}

/** Double-quoted identifier. Only ever called on validated names. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

/** Schema-qualified, quoted routine or relation name. */
export function qualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

/** Least-privilege NOLOGIN roles granted by migrate(). */
export interface SwitchyardRoleNames {
  /** EXECUTE on the store routines only; no relation privilege. */
  readonly runtime: string;
  /** SELECT on every table and view, for inspection. */
  readonly reader: string;
}

export function defaultRoleNames(schema: string): SwitchyardRoleNames {
  const validated = validateSchemaName(schema);
  return Object.freeze({
    runtime: `${validated}_runtime`,
    reader: `${validated}_reader`
  });
}

/** Render one migration template for a validated schema. */
export function renderMigrationSql(template: string, schema: string): string {
  const validated = validateSchemaName(schema);
  return template.replaceAll("{{schema}}", quoteIdentifier(validated));
}
