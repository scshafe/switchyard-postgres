// switchyard 2.1.0's GraphStore conformance suite against PostgresGraphStore.

import { after } from "node:test";

import { registerGraphStoreConformanceTests } from "@scshafe/switchyard/store/graph-store-conformance";
import { PostgresGraphStore } from "@scshafe/switchyard-postgres";

import { closeAdmin, openScenarioDatabase } from "./support/postgres.mjs";

after(closeAdmin);

registerGraphStoreConformanceTests({
  backendName: "PostgresGraphStore",
  async createDriver() {
    const database = await openScenarioDatabase("graph");
    return {
      graphStore: new PostgresGraphStore({ pool: database.runtimePool }),
      close: () => database.close()
    };
  }
});
