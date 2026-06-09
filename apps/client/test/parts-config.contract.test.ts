// 適合性テスト（移植性アーキ §5/§13.5・Phase 5）：団体ごとの「有効パーツ集合」の選択。
import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/parts/index.ts"; // パーツ登録
import { partCatalog, enabledParts, toolsOf, enabledPartIds, setEnabledPartIds } from "../src/core/parts.ts";
import { detectProfile } from "../src/core/profiles.ts";
import { memKv } from "./node-sqlite-adapter.ts";

function ctxWithKv() {
  return { profile: "test", storage: { kv: memKv() } } as never;
}
const toolNames = (ids: string[] | null) => toolsOf(enabledParts(ids)).map((t) => t.name).sort();

test("環境Profile 検出（§6）：env からAI/ストレージ/鍵の構成を判定", () => {
  assert.deepEqual(detectProfile({} as never), { id: "A", label: "A: フルクラウド", ai: "cloud", storage: "kv", keyStore: "kv-autogen" });
  const c = detectProfile({ LOCAL_AI_BASE_URL: "http://localhost:11434", MASTER_KEY: "k", MEDIA_R2: {} } as never);
  assert.equal(c.id, "C");
  assert.equal(c.ai, "local");
  assert.equal(c.storage, "r2");
  assert.equal(c.keyStore, "secret");
});

test("カタログに組み込みパーツ（アプリ）が揃う", () => {
  const ids = partCatalog().map((p) => p.id).sort();
  assert.deepEqual(ids, ["accounting", "branding", "calendar", "chat", "gmail", "import", "invoices", "knowledge", "meet", "members", "memo", "reminders", "site"]);
});

test("未設定は全パーツ有効（既定）", async () => {
  const ctx = ctxWithKv();
  assert.equal(await enabledPartIds(ctx), null);
  assert.ok(toolNames(null).includes("search_members"));
  assert.ok(toolNames(null).includes("record_expense"));
});

test("有効パーツを限定すると、その道具だけになる", async () => {
  const ctx = ctxWithKv();
  const saved = await setEnabledPartIds(ctx, ["reminders", "accounting", "unknown-x"]); // 未知idは除去
  assert.deepEqual(saved.sort(), ["accounting", "reminders"]);
  const ids = await enabledPartIds(ctx);
  assert.deepEqual(ids!.sort(), ["accounting", "reminders"]);

  const names = toolNames(ids);
  assert.deepEqual(names, ["list_expenses", "list_reminders", "record_expense", "set_reminder"]);
  assert.ok(!names.includes("search_members"), "無効パーツ(members)の道具は出ない");
});
