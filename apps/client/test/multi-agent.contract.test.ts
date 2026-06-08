// 適合性テスト：マルチエージェントのロール別道具絞り込み（Pro機能の中核ロジック）。
import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/parts/index.ts"; // パーツ登録
import { enabledParts } from "../src/core/parts.ts";
import { toolsForRole, normalizeRole, ROLES } from "../src/lib/multi-agent.ts";

const names = (role: Parameters<typeof toolsForRole>[0]) => toolsForRole(role, enabledParts(null)).map((t) => t.name).sort();

test("normalizeRole：未知ロールは general に丸める", () => {
  assert.equal(normalizeRole("accounting"), "accounting");
  assert.equal(normalizeRole("不明"), "general");
});

test("会計ロールは会計カテゴリの道具だけを見せる", () => {
  const acc = names("accounting");
  assert.ok(acc.includes("record_expense"));
  assert.ok(acc.includes("list_expenses"));
  assert.ok(!acc.includes("search_members")); // 庶務の道具は出ない
});

test("庶務ロールは庶務カテゴリの道具を見せ、会計の道具は出さない", () => {
  const cle = names("clerical");
  assert.ok(cle.includes("search_members"));
  assert.ok(!cle.includes("record_expense"));
});

test("general/planner はカテゴリ無指定＝全有効パーツの道具", () => {
  assert.equal(ROLES.general.categories, undefined);
  const all = names("general");
  assert.ok(all.includes("record_expense") && all.includes("search_members"));
});
