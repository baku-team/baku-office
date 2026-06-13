// 適合性テスト（IDOR 横展開）：AIチャットのセッション/履歴が owner スコープで分離され、
// 他人の session_id を知っても読み取り・削除ができないことを env.DB 直結で検証する。
// files-idor.contract.test.ts と同方式（ctx.db のみ使用＝暗号化/KV 非依存で直接呼べる）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlStore } from "./node-sqlite-adapter.ts";
import { createSession, appendMessage, listSessions, ownedSession, deleteSession, getMessages } from "../src/lib/chat-sessions.ts";
import type { Ctx } from "../src/core/ports.ts";

// 0015 相当の最小スキーマ。
const SCHEMA = `
CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const db = nodeSqlStore(sqlite);
  const ctx = { profile: "node", db, env: {} } as unknown as Ctx;
  return { ctx };
}

test("listSessions：owner ごとに自分のセッションのみ（他人のは混ざらない）", async () => {
  const { ctx } = setup();
  await createSession(ctx, "line:u1");
  await createSession(ctx, "line:u1");
  await createSession(ctx, "line:u2");
  assert.equal((await listSessions(ctx, "line:u1")).length, 2);
  assert.equal((await listSessions(ctx, "line:u2")).length, 1);
  assert.equal((await listSessions(ctx, "line:other")).length, 0);
});

test("ownedSession：他人の session_id は null＝IDOR 読み取り拒否", async () => {
  const { ctx } = setup();
  const id = await createSession(ctx, "line:u1");
  assert.equal(await ownedSession(ctx, "line:u2", id), null); // 他人は取得不可
  assert.ok(await ownedSession(ctx, "line:u1", id));          // 本人は取得可
  assert.equal(await ownedSession(ctx, "line:u1", "no-such-id"), null); // 不在
});

test("deleteSession：他人の session は削除されない（履歴も残る）／本人は削除＋履歴も消える", async () => {
  const { ctx } = setup();
  const id = await createSession(ctx, "line:u1");
  await appendMessage(ctx, id, "user", "秘密");
  // 他人(u2)が他人のセッション削除を試みても消えない（IDOR 削除拒否）。
  await deleteSession(ctx, "line:u2", id);
  assert.ok(await ownedSession(ctx, "line:u1", id), "他人の削除でセッションが消えてはいけない");
  assert.equal((await getMessages(ctx, id)).length, 1, "他人の削除でメッセージも消えてはいけない");
  // 本人なら削除でき、履歴（chat_messages）も連動削除される。
  await deleteSession(ctx, "line:u1", id);
  assert.equal(await ownedSession(ctx, "line:u1", id), null);
  assert.equal((await getMessages(ctx, id)).length, 0);
});

test("getMessages は owner を検証しない＝API ルートは ownedSession で必ず事前ガードする契約", async () => {
  const { ctx } = setup();
  const id = await createSession(ctx, "line:u1");
  await appendMessage(ctx, id, "user", "本文");
  // session_id を知るだけで中身が取れてしまう（getMessages 単体に owner 検査は無い）。
  // よって履歴取得 API は ownedSession を先に必須化することで IDOR を防ぐ（経路全体の防御）。
  assert.equal((await getMessages(ctx, id)).length, 1);
  assert.equal(await ownedSession(ctx, "line:u2", id), null, "事前ガードが他人を弾くこと");
});
