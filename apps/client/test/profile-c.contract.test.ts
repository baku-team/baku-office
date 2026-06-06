// 適合性テスト（移植性アーキ §9・Phase 4）：Profile C（オフライン）成立の実証。
// 1) ローカルLLM相当の ChatModel（スタブ）で、モデル非依存ループ→パーツ道具→ctx.db が成立する。
// 2) ローカル認証（PBKDF2）と会員/ロール解決が ctx.db（SQLite）で動く。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runToolLoop, type ChatModel } from "../src/core/ai.ts";
import { findAgentTool } from "../src/core/parts.ts";
import "../src/parts/index.ts"; // パーツ登録
import { listReminders } from "../src/parts/reminders.ts";
import { localIdentity } from "../src/core/identity.ts";
import { pbkdf2Hash } from "../src/lib/users.ts";
import { nodeSqlStore } from "./node-sqlite-adapter.ts";

const SCHEMA = `
CREATE TABLE reminders (id TEXT PRIMARY KEY, owner TEXT, content TEXT, remind_at INTEGER, done INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, role TEXT, status TEXT, created_at INTEGER);
CREATE TABLE identities (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, external_id TEXT, password_hash TEXT, created_at INTEGER);
`;

function profileC() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const db = nodeSqlStore(sqlite);
  const ctx = { profile: "c", db, env: {} } as Record<string, unknown>;
  ctx.identity = localIdentity(ctx as never);
  return { sqlite, ctx: ctx as never };
}

test("ローカルLLM相当(スタブ)で agent ツールループが成立し、道具→ctx.db に書き込む", async () => {
  const { ctx } = profileC();
  // ローカルLLM の代役：1ターン目に set_reminder を呼び、2ターン目にテキスト確定。
  let n = 0;
  const stub: ChatModel = {
    name: "stub-local",
    async turn() {
      n++;
      if (n === 1) return { toolCalls: [{ id: "c1", name: "set_reminder", args: { content: "理事会", remind_at: "2999-01-01T10:00" } }] };
      return { text: "リマインダーを登録しました。" };
    },
  };
  const exec = (name: string, args: Record<string, unknown>) => findAgentTool(name).run(ctx, "line:u1", "", args);

  const out = await runToolLoop(stub, "system", { text: "明日の理事会をリマインドして" }, [], exec);
  assert.match(out, /登録しました/);
  assert.match(await listReminders(ctx, "line:u1"), /理事会/, "道具経由で ctx.db に保存された");
});

test("ローカル認証(PBKDF2)と会員/ロール解決が ctx.db で動く", async () => {
  const { sqlite, ctx } = profileC();
  const hash = await pbkdf2Hash("pw-12345");
  sqlite.prepare("INSERT INTO users (id,display_name,role,status,created_at) VALUES (?,?,?,?,?)").run("u1", null, "accounting", "active", 0);
  sqlite.prepare("INSERT INTO identities (id,user_id,type,external_id,password_hash,created_at) VALUES (?,?,?,?,?,?)").run("i1", "u1", "local", "alice", hash, 0);
  sqlite.prepare("INSERT INTO identities (id,user_id,type,external_id,password_hash,created_at) VALUES (?,?,?,?,?,?)").run("i2", "u1", "line", "U999", null, 0);

  const ok = await ctx.identity.authenticate("alice", "pw-12345");
  assert.equal(ok?.role, "accounting");
  assert.equal(await ctx.identity.authenticate("alice", "wrong"), null, "誤パスワードは拒否");

  assert.equal(await ctx.identity.roleOf("line", "U999"), "accounting");
  assert.equal(await ctx.identity.memberOf("line", "unknown"), null);
});
