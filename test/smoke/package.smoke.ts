// Packed-install TypeScript smoke: typechecked in the consumer against the
// shipped .d.ts files and the peer's (scripts/check-pack-install.mjs): the
// stores satisfy switchyard's store interfaces.
import {
  createPostgresStores,
  migrate,
  PostgresGraphStore,
  PostgresHumanDecisions,
  PostgresUnitStore,
  type MigrateResult,
  type PendingHumanTurn,
  type PgPool
} from "@scshafe/switchyard-postgres";
import type { GraphStore } from "@scshafe/switchyard/store/graph-store";
import type { UnitStore } from "@scshafe/switchyard/store/unit-store";
import type { ExternalTurnRunnerStore } from "@scshafe/switchyard/execute/unit-runner";

declare const pool: PgPool;
const stores = createPostgresStores({ pool, now: () => new Date() });
const graphStore: GraphStore = stores.graphStore;
const unitStore: UnitStore = stores.unitStore;
const external: ExternalTurnRunnerStore = new PostgresUnitStore({ pool });
const decisions: PostgresHumanDecisions = stores.humanDecisions;
const direct: GraphStore = new PostgresGraphStore({ pool, schema: "custom" });
const result: Promise<MigrateResult> = migrate({ pool, roles: false });
const pending: Promise<readonly PendingHumanTurn[]> = decisions.listPending({ limit: 10 });
// @ts-expect-error a pool is required
new PostgresUnitStore({ schema: "switchyard" });
// @ts-expect-error decisions need an outcome and an actor
void decisions.record({ queueId: "q" });
void graphStore; void unitStore; void external; void direct; void result; void pending;
