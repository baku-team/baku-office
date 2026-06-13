// 招待なし公開A2A：public スコープ解決の allowPublic 制御・受付箱・ブロックの契約テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlStore, memKv } from "./node-sqlite-adapter.ts";
import { resolveAction } from "../src/lib/a2a-actions.ts";
import { addInquiry, listInquiries, addBlock, isBlocked, removeBlock } from "../src/lib/reception.ts";

const SCHEMA = `
CREATE TABLE a2a_actions (id TEXT PRIMARY KEY, name TEXT, kind TEXT, spec TEXT, scope TEXT, target TEXT, enabled INTEGER, created_at INTEGER);
CREATE TABLE a2a_inquiries (id TEXT PRIMARY KEY, from_license TEXT NOT NULL, from_name TEXT, action TEXT, args TEXT, message TEXT, trust TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE a2a_blocks (from_license TEXT PRIMARY KEY, reason TEXT, created_at INTEGER NOT NULL);
`;

function ctxOf() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return { ctx: { db: nodeSqlStore(db), storage: { kv: memKv() } } as never, db };
}

test("public スコープは allowPublic=true のときだけ解決される", async () => {
  const { ctx, db } = ctxOf();
  db.prepare("INSERT INTO a2a_actions VALUES ('a1','reception','decl','{\"type\":\"profile\"}','public','',1,0)").run();
  assert.equal(await resolveAction(ctx, "reception", { allowPublic: false }), null);
  const r = await resolveAction(ctx, "reception", { allowPublic: true });
  assert.equal(r?.scope, "public");
});

test("conn/common スコープは公開経路の有無に関わらず従来通り", async () => {
  const { ctx, db } = ctxOf();
  db.prepare("INSERT INTO a2a_actions VALUES ('a2','share','decl','{}','common','',1,0)").run();
  db.prepare("INSERT INTO a2a_actions VALUES ('a3','priv','decl','{}','conn','LIC-X',1,0)").run();
  assert.equal((await resolveAction(ctx, "share", { allowPublic: false }))?.scope, "common");
  assert.equal((await resolveAction(ctx, "priv", { from: "LIC-X" }))?.scope, "conn");
  assert.equal(await resolveAction(ctx, "priv", { from: "LIC-Y" }), null);
});

test("受付箱：問い合わせを積み pending で一覧化", async () => {
  const { ctx } = ctxOf();
  await addInquiry(ctx, { fromLicense: "LIC-B", fromName: "ビー社", action: "inquiry", message: "見積もりが欲しい", trust: { hostTrust: 0.6 } });
  const list = await listInquiries(ctx, "pending");
  assert.equal(list.length, 1);
  assert.equal(list[0].from_name, "ビー社");
  assert.equal(list[0].message, "見積もりが欲しい");
});

test("ブロック：登録で isBlocked=true、解除で false", async () => {
  const { ctx } = ctxOf();
  assert.equal(await isBlocked(ctx, "LIC-Z"), false);
  await addBlock(ctx, "LIC-Z", "spam");
  assert.equal(await isBlocked(ctx, "LIC-Z"), true);
  await removeBlock(ctx, "LIC-Z");
  assert.equal(await isBlocked(ctx, "LIC-Z"), false);
});
