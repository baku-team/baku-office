// 適合性テスト（移植性アーキ §9）：各パーツが「CF(D1) 以外のアダプタでも同一コードで動く」ことの実証。
// 同じ Part 道具・同じデータ関数を、Node+SQLite の SqlStore 実装に差し替えて実行する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { encryptField, generateMasterKey } from "@baku-office/shared";
import { nodeSqlStore, memKv } from "./node-sqlite-adapter.ts";
import { masterKeyCtx } from "../src/lib/client.ts";
import { remindersPart, setReminder, dueReminders, markReminderDone } from "../src/parts/reminders.ts";
import { recordExpense, listExpenses } from "../src/parts/accounting.ts";
import { saveMemo } from "../src/parts/memo.ts";
import { saveKnowledge, searchKnowledge } from "../src/parts/knowledge.ts";
import { searchMembers } from "../src/parts/members.ts";

const SCHEMA = `
CREATE TABLE reminders (id TEXT PRIMARY KEY, owner TEXT, content TEXT, remind_at INTEGER, done INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE personal_items (id TEXT PRIMARY KEY, owner_user_id TEXT, type TEXT, title TEXT, body TEXT, amount INTEGER, date TEXT, share_scope TEXT, review_status TEXT, reviewed_by TEXT, reviewed_at INTEGER, reject_reason TEXT, created_at INTEGER);
CREATE TABLE knowledge (id TEXT PRIMARY KEY, title TEXT, body TEXT, file_ref TEXT, tags TEXT, created_by TEXT, created_at INTEGER, deleted_at INTEGER);
CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, role TEXT, status TEXT, created_at INTEGER);
`;

function setup(env: Record<string, unknown> = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const db = nodeSqlStore(sqlite);
  return { sqlite, db, ctx: { profile: "node", db, env } };
}

test("reminders パーツが Node+SQLite で動く（道具経路）", async () => {
  const { ctx } = setup();
  const setTool = remindersPart.agentTools.find((t) => t.name === "set_reminder");
  const listTool = remindersPart.agentTools.find((t) => t.name === "list_reminders");
  assert.match(await setTool.run(ctx, "line:u1", "", { content: "理事会", remind_at: "2999-01-01T10:00" }), /リマインダー設定/);
  assert.match(await listTool.run(ctx, "line:u1", "", {}), /理事会/);
  assert.match(await listTool.run(ctx, "line:other", "", {}), /ありません/);
});

test("reminders の drain 経路（due → markDone）も Node+SQLite で成立", async () => {
  const { ctx } = setup();
  await setReminder(ctx, "line:u2", { content: "期限切れ", remind_at: "2000-01-01T00:00" });
  await setReminder(ctx, "line:u2", { content: "未来", remind_at: "2999-01-01T00:00" });
  const due = await dueReminders(ctx);
  assert.equal(due.length, 1);
  assert.equal(due[0].content, "期限切れ");
  await markReminderDone(ctx, due[0].id);
  assert.equal((await dueReminders(ctx)).length, 0);
});

test("accounting パーツが Node+SQLite で動く", async () => {
  const { ctx } = setup();
  assert.match(await recordExpense(ctx, "line:u1", { amount: 1200, title: "文具" }), /領収書を記録/);
  const list = await listExpenses(ctx, "line:u1");
  assert.match(list, /文具/);
  assert.match(list, /1,200/);
  assert.match(await listExpenses(ctx, "line:none"), /ありません/);
});

test("memo / knowledge パーツが Node+SQLite で動く", async () => {
  const { ctx } = setup();
  assert.match(await saveMemo(ctx, "line:u1", { title: "買い物", body: "封筒" }), /メモを保存/);
  assert.match(await saveKnowledge(ctx, "line:u1", { title: "会則", body: "会費は月500円" }), /ナレッジを保存/);
  assert.match(await searchKnowledge(ctx, { query: "会費" }), /会則/);
  assert.match(await searchKnowledge(ctx, { query: "存在しない" }), /見つかりません/);
});

test("members パーツが Node+SQLite で動く（暗号化名簿の復号も含む）", async () => {
  const key = generateMasterKey();
  const { sqlite, ctx } = setup({ MASTER_KEY: key }); // 鍵は Worker Secret 相当を env で供給
  const enc = await encryptField(key, "山田太郎", "member-pii");
  sqlite.prepare("INSERT INTO users (id,display_name,role,status,created_at) VALUES (?,?,?,?,?)").run("m1", enc, "admin", "active", 0);
  const out = await searchMembers(ctx, { query: "山田" });
  assert.match(out, /山田太郎/);
  assert.match(out, /admin/);
  assert.match(await searchMembers(ctx, { query: "佐藤" }), /いません/);
});

test("members：鍵保管Port(ctx.storage.kv)経由で鍵を解決し復号できる（§14-3）", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, role TEXT, status TEXT, created_at INTEGER)");
  const ctx = { profile: "node", db: nodeSqlStore(sqlite), storage: { kv: memKv() }, env: {} } as never;
  const mk = await masterKeyCtx(ctx); // secret 無し → kv に自動生成
  const enc = await encryptField(mk, "鈴木花子", "member-pii");
  sqlite.prepare("INSERT INTO users (id,display_name,role,status,created_at) VALUES (?,?,?,?,?)").run("m2", enc, "clerical", "active", 0);
  assert.match(await searchMembers(ctx, { query: "鈴木" }), /鈴木花子/);
  // 同じ kv から同じ鍵が再解決される（再生成しない）。
  assert.equal(await masterKeyCtx(ctx), mk);
});
