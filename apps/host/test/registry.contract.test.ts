// 適合性テスト：ホスト中枢のアプリ・レジストリ（登録/状態/利用集計/申告パース）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { listApps, registerApp, setAppStatus, recordUsage, usageByApp, parseAppsParam } from "../src/lib/registry.ts";

// D1 互換の最小 env（prepare→bind→run/all/first）を node:sqlite 上に。
function fakeEnv(sqlite: DatabaseSync) {
  const mk = (sql: string, bound: unknown[] = []) => ({
    bind: (...v: unknown[]) => mk(sql, v),
    run: async () => { sqlite.prepare(sql).run(...(bound as never[])); return { success: true }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...(bound as never[])) }),
    first: async () => sqlite.prepare(sql).get(...(bound as never[])) ?? null,
  });
  return { DB: { prepare: (sql: string) => mk(sql) } } as never;
}

const SCHEMA = `
CREATE TABLE registry_apps (id TEXT PRIMARY KEY, name TEXT, version TEXT, repo_url TEXT, publisher TEXT, category TEXT, permissions TEXT, description TEXT, definition TEXT, submitted_by TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER, updated_at INTEGER);
CREATE TABLE app_usage (license_id TEXT, app_id TEXT, version TEXT, last_seen INTEGER, PRIMARY KEY (license_id, app_id));
`;

test("registerApp は upsert・setAppStatus で承認", async () => {
  const db = new DatabaseSync(":memory:"); db.exec(SCHEMA);
  const env = fakeEnv(db);
  await registerApp(env, { id: "inventory", name: "在庫", version: "1.0.0", permissions: ["db:read"] });
  await registerApp(env, { id: "inventory", name: "在庫", version: "1.1.0" }); // 版更新（upsert）
  let apps = await listApps(env);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].version, "1.1.0");
  assert.equal(apps[0].status, "pending");
  await setAppStatus(env, "inventory", "approved");
  apps = await listApps(env);
  assert.equal(apps[0].status, "approved");
});

test("recordUsage→usageByApp：導入数・版分布を集計", async () => {
  const db = new DatabaseSync(":memory:"); db.exec(SCHEMA);
  const env = fakeEnv(db);
  await recordUsage(env, "licA", [{ id: "x", version: "1.0.0" }, { id: "y", version: "1.0.0" }]);
  await recordUsage(env, "licB", [{ id: "x", version: "2.0.0" }]);
  await recordUsage(env, "licA", [{ id: "x", version: "1.0.0" }]); // 同一license+appは上書き
  const u = await usageByApp(env);
  const x = u.find((r) => r.app_id === "x");
  assert.equal(x.installs, 2, "x は2ライセンスで導入");
  assert.equal([...x.versions.split(",")].sort().join(","), "1.0.0,2.0.0");
  assert.equal(u.find((r) => r.app_id === "y").installs, 1);
});

test("parseAppsParam：id:version をパースし不正idを除去", () => {
  assert.deepEqual(parseAppsParam("inventory:1.0.0, chat:1.2.3 ,bad id:9"), [
    { id: "inventory", version: "1.0.0" }, { id: "chat", version: "1.2.3" },
  ]);
  assert.deepEqual(parseAppsParam(null), []);
});
