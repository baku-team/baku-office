// 適合性テスト：アプリ開発の事前4確認（環境/権限/安全/コスト）。fail があれば実装ブロック。
import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../src/lib/preflight.ts";
import { memKv } from "./node-sqlite-adapter.ts";

// preflight は ctx.env（getApiKey/usage/storage は env.LICENSE 等）を使う。最小 env を用意。
function ctxWith(env: Record<string, unknown> = {}) {
  // getApiKey は env.LICENSE.get("apikey:*")、usage/storage は env.LICENSE/env.DB を見る。KV を memKv で代用。
  const kv = memKv();
  return { env: { LICENSE: { get: kv.get, put: kv.put, list: async () => ({ keys: [] }) }, DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }) }) }, ...env }, storage: { kv } } as never;
}
const find = (r: { checks: { key: string; status: string }[] }, k: string) => r.checks.find((c) => c.key === k);

test("権限OK・AI不要なら全てok（実装可）", async () => {
  const r = await preflight(ctxWith(), { name: "メモ拡張", permissions: ["db:read", "db:write"], definition: { insert: "personal_items" } });
  // db:write は privileged→warn だが fail ではない＝実装可。
  assert.equal(r.ok, true);
  assert.equal(find(r, "permission").status, "warn");
  assert.equal(find(r, "safety").status, "ok");
});

test("未知権限は権限確認 fail＝ブロック", async () => {
  const r = await preflight(ctxWith(), { name: "x", permissions: ["db:read", "system:root"] });
  assert.equal(find(r, "permission").status, "fail");
  assert.equal(r.ok, false);
});

test("破壊的SQL痕跡は安全確認 fail＝ブロック", async () => {
  const r = await preflight(ctxWith(), { name: "y", permissions: ["db:write"], definition: { sql: "DELETE FROM personal_items" } });
  assert.equal(find(r, "safety").status, "fail");
  assert.equal(r.ok, false);
});

test("AI必要だがキー未設定なら環境確認 fail＝ブロック", async () => {
  const r = await preflight(ctxWith(), { name: "z", permissions: ["ai"] });
  assert.equal(find(r, "env").status, "fail");
  assert.equal(r.ok, false);
});
