// The README quick start (steps 3-5), run as written against a fresh schema.
//
// The TypeScript blocks of steps 3 and 4 are taken from README.md verbatim
// (only `as const` is dropped, the one piece of TypeScript syntax in them),
// written next to this file so the package imports resolve, and imported as
// the runtime login named by APP_DATABASE_URL. The SQL of step 5 then runs
// statement by statement as the reader login.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { after, test } from "node:test";

import { SwitchyardPostgresConfigError, createPostgresStores } from "@scshafe/switchyard-postgres";

import {
  RUNTIME_LOGIN,
  closeAdmin,
  loginUrl,
  openScenarioDatabase,
  withApplicationName
} from "./support/postgres.mjs";

after(closeAdmin);

const README = new URL("../README.md", import.meta.url);

function section(markdown, heading) {
  const start = markdown.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `README has no "${heading}"`);
  const rest = markdown.slice(start + heading.length + 2);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

function firstBlock(text, language) {
  const match = new RegExp("```" + language + "\\n([\\s\\S]*?)```").exec(text);
  assert.ok(match, `no ${language} block`);
  return match[1];
}

async function quickStart() {
  const markdown = await readFile(README, "utf8");
  const step3 = firstBlock(section(markdown, "### 3. Wire the stores into switchyard"), "ts");
  const step4 = firstBlock(section(markdown, "### 4. Record a person's answer"), "ts");
  const step5 = firstBlock(section(markdown, "### 5. Watch a unit move"), "sql");
  const program = `${step3}\n${step4}`.replaceAll(" as const", "");
  assert.doesNotMatch(program, /\bimport pg\b/, "the quick start needs no direct pg import");
  const statements = step5.split(";").map((statement) => statement.trim()).filter(Boolean);
  return { program, statements };
}

test("README quick start: draft, a person's answer, publish, inspect through the views", async () => {
  const database = await openScenarioDatabase("readme");
  const { program, statements } = await quickStart();
  const file = new URL(`./.readme-quickstart-${process.pid}-${randomBytes(4).toString("hex")}.mjs`, import.meta.url);
  try {
    process.env.APP_DATABASE_URL = withApplicationName(loginUrl(database.name, RUNTIME_LOGIN), "readme-app");
    await writeFile(file, program);
    await import(file.href);

    const results = [];
    for (const statement of statements) {
      results.push((await database.readerPool.query(statement)).rows);
    }
    const [status, positions, outputs, turns, pending, decisions] = results;
    assert.equal(results.length, 6);
    assert.deepEqual(status, [
      { status: "completed", final_node_id: "publish", final_outcome: "published", final_contract_id: "answer.v1" }
    ]);
    assert.deepEqual(positions, []);
    assert.deepEqual(outputs, [
      { node_id: "draft", outcome: "drafted", contract_id: "answer.v1", payload: { text: "A graph of stations and tracks." } }
    ]);
    assert.deepEqual(turns.map((row) => ({ ...row, attempts: Number(row.attempts) })), [
      { node_id: "draft", status: "settled", outcome: "drafted", actor_id: null, attempts: 1 },
      { node_id: "review", status: "settled", outcome: "approved", actor_id: "alice", attempts: 1 },
      { node_id: "publish", status: "settled", outcome: "published", actor_id: null, attempts: 1 }
    ]);
    assert.deepEqual(pending, []);
    assert.deepEqual(decisions.map((row) => [row.unit_id, row.node_id, row.outcome, row.actor_id]), [
      ["question-42", "review", "approved", "alice"]
    ]);
  } finally {
    delete process.env.APP_DATABASE_URL;
    await rm(file, { force: true });
    await database.close();
  }
});

test("createPostgresStores takes a pool or a connectionString, and closes only its own pool", async () => {
  assert.throws(() => createPostgresStores({}), SwitchyardPostgresConfigError);
  assert.throws(() => createPostgresStores({ connectionString: " " }), SwitchyardPostgresConfigError);
  assert.throws(
    () => createPostgresStores({ connectionString: "postgres://unused", maxConnections: 0 }),
    /maxConnections/
  );
  const database = await openScenarioDatabase("readme");
  try {
    assert.throws(
      () => createPostgresStores({ pool: database.runtimePool, connectionString: "postgres://unused" }),
      /not both/
    );
    assert.throws(
      () => createPostgresStores({ pool: database.runtimePool, maxConnections: 2 }),
      /only with a connectionString/
    );
    const borrowed = createPostgresStores({ pool: database.runtimePool });
    assert.equal(borrowed.pool, database.runtimePool);
    await borrowed.close();
    assert.equal((await database.runtimePool.query("SELECT 1 AS one")).rows[0].one, 1);

    const errors = [];
    const owned = createPostgresStores({
      connectionString: withApplicationName(loginUrl(database.name, RUNTIME_LOGIN), "owned"),
      maxConnections: 2,
      onPoolError: (error) => errors.push(error)
    });
    assert.deepEqual(await owned.humanDecisions.listPending(), []);
    assert.equal(await owned.unitStore.hasClaimableWorkerTurns("worker"), false);
    await Promise.all([owned.close(), owned.close()]);
    await assert.rejects(owned.humanDecisions.listPending(), /Cannot use a pool after calling end/);
    assert.deepEqual(errors, []);
  } finally {
    await database.close();
  }
});
