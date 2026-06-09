// 適合性テスト（P0-4）：対外/破壊系ツールの人間承認ゲートの判定とプレビュー。
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApproval, previewFor, A2A_OUTWARD } from "../src/lib/approvals.ts";
import type { AgentTool } from "../src/core/parts.ts";

const tool = (name: string, unattended?: boolean): AgentTool =>
  ({ name, description: "", parameters: {}, unattended, run: async () => "" });

test("needsApproval：unattended:false の業務道具は承認必須", () => {
  const tools = [tool("send_message", false), tool("search_members"), tool("update_event", false)];
  assert.equal(needsApproval("send_message", tools), true);
  assert.equal(needsApproval("update_event", tools), true);
  assert.equal(needsApproval("search_members", tools), false, "閲覧系は承認不要");
});

test("needsApproval：A2A 対外ツールは名前一致で承認必須", () => {
  assert.equal(needsApproval("call_partner", []), true);
  assert.equal(needsApproval("broadcast_group", []), true);
  assert.equal(needsApproval("call_group_member", []), true);
  assert.deepEqual([...A2A_OUTWARD].sort(), ["broadcast_group", "call_group_member", "call_partner"]);
});

test("needsApproval：未知ツールは承認不要（既定で通す）", () => {
  assert.equal(needsApproval("unknown_tool", []), false);
});

test("previewFor：主要ツールは人間可読のプレビューを生成", () => {
  assert.match(previewFor("send_message", { to: "a@x.jp", subject: "件名", body: "b" }), /メール送信.*a@x\.jp.*件名/);
  assert.match(previewFor("delete_event", { event_id: "ev1" }), /予定の削除.*ev1/);
  assert.match(previewFor("call_partner", { partner: "L1", action: "act" }), /A2A.*L1.*act/);
  // 未知ツールは引数JSONを要約
  assert.match(previewFor("foo", { x: 1 }), /foo.*\{"x":1\}/);
});
