// 公開ディレクトリ：掲載・検索（コサイン）・信頼スコア・通報自動blockの契約テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { publishEntry, searchEntries, recomputeTrust, reportEntry, getEntry, setCertified } from "../src/lib/directory.ts";

const SCHEMA = `
CREATE TABLE public_directory (license_id TEXT PRIMARY KEY, org_name TEXT NOT NULL, profile TEXT NOT NULL DEFAULT '{}', embedding TEXT, verification TEXT NOT NULL DEFAULT '{}', trust_score REAL NOT NULL DEFAULT 0, listed INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, certified INTEGER NOT NULL DEFAULT 0, certified_at INTEGER, certified_note TEXT);
CREATE TABLE directory_reports (id TEXT PRIMARY KEY, target_license TEXT NOT NULL, reporter_license TEXT, reason TEXT, detail TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
CREATE TABLE licenses (license_id TEXT PRIMARY KEY, plan TEXT, entitlement TEXT, status TEXT, deploy_url TEXT, last_seen INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE a2a_audit (id TEXT PRIMARY KEY, conn_id TEXT, from_license TEXT, to_license TEXT, action TEXT, status TEXT, kind TEXT DEFAULT 'conn', created_at INTEGER NOT NULL);
`;

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const env = {
    DB: {
      prepare: (sql: string) => {
        const mk = (bound: unknown[] = []) => ({
          bind: (...v: unknown[]) => mk(v),
          run: async () => { db.prepare(sql).run(...(bound as never[])); return { success: true }; },
          all: async () => ({ results: db.prepare(sql).all(...(bound as never[])) }),
          first: async () => db.prepare(sql).get(...(bound as never[])) ?? null,
        });
        return mk();
      },
    },
  } as never as Env;
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO licenses VALUES ('LIC-A','plus','plus','active',NULL,?,?)").run(now, now - 200 * 86400);
  db.prepare("INSERT INTO licenses VALUES ('LIC-B','free','free','active',NULL,?,?)").run(now, now - 1 * 86400);
  return { db, env };
}

test("掲載→埋め込みコサインで検索ヒット（近いベクトルが上位）", async () => {
  const { env } = setup();
  await publishEntry(env, "LIC-A", { orgName: "花屋アオキ", profile: { summary: "生花店", tags: ["花", "ギフト"], public_actions: [{ name: "profile", label: "会社情報" }] }, embedding: [1, 0, 0], verification: { exists: true, score: 0.8 }, listed: true });
  await publishEntry(env, "LIC-B", { orgName: "鉄工所ビー", profile: { summary: "金属加工", tags: ["金属"] }, embedding: [0, 1, 0], verification: {}, listed: true });
  const res = await searchEntries(env, { queryEmbedding: [0.9, 0.1, 0] });
  assert.equal(res[0].license_id, "LIC-A");
  assert.equal(res[0].verified, true);
  assert.ok(res[0].public_actions.some((a) => a.name === "profile"));
});

test("キーワード検索（org_name/summary/tags 部分一致）", async () => {
  const { env } = setup();
  await publishEntry(env, "LIC-A", { orgName: "花屋アオキ", profile: { summary: "生花店", tags: ["花"] }, embedding: null, listed: true } as never);
  const res = await searchEntries(env, { query: "生花" });
  assert.equal(res.length, 1);
  assert.equal(res[0].license_id, "LIC-A");
});

test("非掲載・blocked は検索に出ない", async () => {
  const { env } = setup();
  await publishEntry(env, "LIC-A", { orgName: "A", profile: {}, embedding: null, verification: {}, listed: false });
  const res = await searchEntries(env, { query: "A" });
  assert.equal(res.length, 0);
});

test("信頼スコア：plus＋運用歴ありは free＋新規より高い", async () => {
  const { env } = setup();
  const a = await recomputeTrust(env, "LIC-A");
  const b = await recomputeTrust(env, "LIC-B");
  assert.ok(a > b);
  assert.ok(a > 0 && a <= 1);
});

test("公式認証：付与で certified=1・trustブースト・certifiedOnly検索に反映", async () => {
  const { env } = setup();
  await publishEntry(env, "LIC-A", { orgName: "公認花屋", profile: { summary: "生花店", tags: ["花"] }, embedding: [1, 0, 0], verification: {}, listed: true });
  const before = await recomputeTrust(env, "LIC-A");
  await setCertified(env, "LIC-A", true, "2026-06面談");
  const e = await getEntry(env, "LIC-A");
  assert.equal(e?.certified, 1);
  const after = await recomputeTrust(env, "LIC-A");
  assert.ok(after > before, "認証で信頼スコアが上がる");
  const certOnly = await searchEntries(env, { query: "花", certifiedOnly: true });
  assert.equal(certOnly.length, 1);
  assert.equal(certOnly[0].certified, true);
  await setCertified(env, "LIC-A", false);
  assert.equal((await searchEntries(env, { query: "花", certifiedOnly: true })).length, 0);
});

test("通報が閾値(3)に達すると自動 block", async () => {
  const { env } = setup();
  await publishEntry(env, "LIC-A", { orgName: "A", profile: {}, embedding: null, verification: {}, listed: true });
  await reportEntry(env, "LIC-A", "LIC-B", "spam");
  await reportEntry(env, "LIC-A", "LIC-B", "spam");
  const r3 = await reportEntry(env, "LIC-A", "LIC-B", "spam");
  assert.equal(r3.blocked, true);
  assert.equal((await getEntry(env, "LIC-A"))?.blocked, 1);
});
