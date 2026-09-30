// switchyard 2.1.0's UnitStore conformance suite against PostgresUnitStore.

import { after } from "node:test";

import { registerUnitStoreConformanceTests } from "@scshafe/switchyard/store/unit-store-conformance";
import { PostgresGraphStore, PostgresUnitStore } from "@scshafe/switchyard-postgres";

import { readEvidence } from "./support/evidence.mjs";
import { closeAdmin, openScenarioDatabase } from "./support/postgres.mjs";

after(closeAdmin);

registerUnitStoreConformanceTests({
  backendName: "PostgresUnitStore",
  async createDriver(context) {
    const database = await openScenarioDatabase("unit");
    let epoch = Date.parse("2026-08-27T12:00:00.000Z");
    let armed;
    let hits = [];
    const unitStore = new PostgresUnitStore({
      pool: database.runtimePool,
      now: () => new Date(epoch),
      settleCheckpoint: (checkpoint) => {
        hits.push(checkpoint);
        if (checkpoint === armed) {
          throw new Error(`simulated process death at settle checkpoint ${checkpoint} (${context.scenario})`);
        }
      }
    });
    return {
      graphStore: new PostgresGraphStore({ pool: database.runtimePool }),
      unitStore,
      now: () => new Date(epoch),
      advanceClock(milliseconds) {
        epoch += milliseconds;
      },
      armSettleCrash(checkpoint) {
        armed = checkpoint;
        hits = [];
      },
      async recover() {
        armed = undefined;
      },
      checkpointHits() {
        return Object.freeze([...hits]);
      },
      evidence: () => readEvidence(database.readerPool),
      close: () => database.close()
    };
  }
});
