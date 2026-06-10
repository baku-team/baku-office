// 適合性テスト（P0-1 IDOR是正）：ファイルの一覧/削除が ctx＋created_by＋role でスコープされる。
// listFilesForSession / softDeleteFileForSession は env.DB のみ使用（暗号化/KV非依存）なので直接検証できる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlStore } from "./node-sqlite-adapter.ts";
import { listFilesForSession, softDeleteFileForSession } from "../src/lib/storage.ts";
import type { Session } from "../src/lib/auth.ts";

// 0002 + 0025 相当の最小 files スキーマ。
const SCHEMA = `
CREATE TABLE files (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT, ref TEXT NOT NULL,
  created_by TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER, enc INTEGER DEFAULT 0, expires_at INTEGER, ctx TEXT);
`;

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const env = { DB: nodeSqlStore(sqlite) } as unknown as Env;
  const ins = (id: string, by: string, ctx: string | null) =>
    sqlite.prepare("INSERT INTO files (id,name,size,mime,ref,created_by,created_at,ctx) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, id + ".pdf", 1, "application/pdf", "kv:f/" + id, by, 1, ctx);
  // org共有2件 / 個人u1の私的1件 / 個人u2の私的1件 / legacy(ctx=NULL)1件。
  ins("orgA", "admin1", "org");
  ins("orgB", "staff1", "org");
  ins("p1", "line:u1", "personal");
  ins("p2", "line:u2", "personal");
  ins("legacy", "old", null);
  return { env };
}

const ses = (p: Partial<Session>): Session => ({ uid: "x", role: "other", ctx: "org", exp: 9e9, ...p });

test("org文脈の非admin：org共有(ctx=org/NULL)は見えるが他人の personal は見えない", async () => {
  const { env } = setup();
  const ids = (await listFilesForSession(env, ses({ uid: "staff1", role: "clerical", ctx: "org" }))).map((f) => f.id).sort();
  assert.deepEqual(ids, ["legacy", "orgA", "orgB"]);
});

test("personal文脈：自分の created_by だけが見える（他人のorgも他人のpersonalも不可視）", async () => {
  const { env } = setup();
  const ids = (await listFilesForSession(env, ses({ uid: "line:u1", role: "member", ctx: "personal" }))).map((f) => f.id).sort();
  assert.deepEqual(ids, ["p1"]);
});

test("admin：全件見える", async () => {
  const { env } = setup();
  const ids = (await listFilesForSession(env, ses({ uid: "admin1", role: "admin", ctx: "org" }))).map((f) => f.id).sort();
  assert.deepEqual(ids, ["legacy", "orgA", "orgB", "p1", "p2"]);
});

test("削除：スコープ外IDは false（未変更）＝IDOR削除を拒否", async () => {
  const { env } = setup();
  // personal u1 が他人(u2)のファイルを削除しようとしても拒否。
  assert.equal(await softDeleteFileForSession(env, "p2", ses({ uid: "line:u1", role: "member", ctx: "personal" })), false);
  // 自分のは削除できる。
  assert.equal(await softDeleteFileForSession(env, "p1", ses({ uid: "line:u1", role: "member", ctx: "personal" })), true);
  // 2回目は既に deleted＝false。
  assert.equal(await softDeleteFileForSession(env, "p1", ses({ uid: "line:u1", role: "member", ctx: "personal" })), false);
});

test("削除：org非adminは他人の personal を削除できない／org共有は削除できる", async () => {
  const { env } = setup();
  const staff = ses({ uid: "staff1", role: "clerical", ctx: "org" });
  assert.equal(await softDeleteFileForSession(env, "p1", staff), false);   // 他人のpersonal不可
  assert.equal(await softDeleteFileForSession(env, "orgA", staff), true);  // org共有は可
});

test("削除：adminは任意ファイルを削除できる", async () => {
  const { env } = setup();
  assert.equal(await softDeleteFileForSession(env, "p2", ses({ uid: "admin1", role: "admin", ctx: "org" })), true);
});
