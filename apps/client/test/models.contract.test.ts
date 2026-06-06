// 適合性テスト（移植性アーキ §2.3）：Gemini/Claude を ChatModel に一本化した際、
// wire 形式（リクエスト本体）と応答解釈が従来どおりであることを fetch モックで確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiModel } from "../src/core/models/gemini.ts";
import { claudeModel } from "../src/core/models/claude.ts";
import { runToolLoop, type Turn } from "../src/core/ai.ts";

type Captured = { url: string; init: { headers?: Record<string, string>; body?: string } };
function mockFetch(responses: unknown[]) {
  const calls: Captured[] = [];
  let i = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: Captured["init"]) => {
    calls.push({ url: String(url), init });
    const data = responses[Math.min(i++, responses.length - 1)];
    return { ok: true, json: async () => data, text: async () => "" };
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const DECLS = [{ name: "set_reminder", description: "予定", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } }];
const HISTORY: Turn[] = [{ role: "user", text: "あした会議" }];

test("geminiModel：リクエスト wire 形式と functionCall 解釈", async () => {
  const m = mockFetch([{ candidates: [{ content: { parts: [{ functionCall: { name: "set_reminder", args: { content: "会議" } } }] } }] }]);
  try {
    const res = await geminiModel("KEY123").turn("SYS", HISTORY, DECLS);
    assert.deepEqual(res.toolCalls, [{ id: "g0_set_reminder", name: "set_reminder", args: { content: "会議" } }]);
    const c = m.calls[0];
    assert.ok(c.url.includes("generativelanguage.googleapis.com") && c.url.includes("KEY123"));
    const body = JSON.parse(c.init.body!);
    assert.equal(body.systemInstruction.parts[0].text, "SYS");
    assert.equal(body.tools[0].functionDeclarations.length, 1);
    assert.equal(body.generationConfig.temperature, 0.3);
    assert.equal(body.generationConfig.maxOutputTokens, 800);
    assert.equal(body.contents[0].role, "user");
  } finally { m.restore(); }
});

test("geminiModel：text 応答", async () => {
  const m = mockFetch([{ candidates: [{ content: { parts: [{ text: "了解です" }] } }] }]);
  try { assert.deepEqual(await geminiModel("K").turn("S", HISTORY, DECLS), { text: "了解です" }); } finally { m.restore(); }
});

test("claudeModel：リクエスト wire 形式と tool_use 解釈", async () => {
  const m = mockFetch([{ content: [{ type: "tool_use", id: "t1", name: "set_reminder", input: { content: "会議" } }], stop_reason: "tool_use" }]);
  try {
    const res = await claudeModel("SK").turn("SYS", HISTORY, DECLS);
    assert.deepEqual(res.toolCalls, [{ id: "t1", name: "set_reminder", args: { content: "会議" } }]);
    const c = m.calls[0];
    assert.ok(c.url.includes("api.anthropic.com"));
    assert.equal(c.init.headers!["x-api-key"], "SK");
    assert.equal(c.init.headers!["anthropic-version"], "2023-06-01");
    const body = JSON.parse(c.init.body!);
    assert.equal(body.model, "claude-sonnet-4-6");
    assert.equal(body.max_tokens, 1500);
    assert.equal(body.tools[0].input_schema.type, "object");
  } finally { m.restore(); }
});

test("claudeModel：text 応答（stop_reason!=tool_use は確定）", async () => {
  const m = mockFetch([{ content: [{ type: "text", text: "完了" }], stop_reason: "end_turn" }]);
  try { assert.deepEqual(await claudeModel("K").turn("S", HISTORY, DECLS), { text: "完了" }); } finally { m.restore(); }
});

test("runToolLoop×geminiModel：道具→次ターンで確定（一本化された経路）", async () => {
  const m = mockFetch([
    { candidates: [{ content: { parts: [{ functionCall: { name: "set_reminder", args: { content: "会議" } } }] } }] },
    { candidates: [{ content: { parts: [{ text: "登録しました" }] } }] },
  ]);
  try {
    let called = "";
    const out = await runToolLoop(geminiModel("K"), "S", { text: "あした会議" }, DECLS, async (n, a) => { called = `${n}:${(a as { content: string }).content}`; return "ok"; });
    assert.equal(out, "登録しました");
    assert.equal(called, "set_reminder:会議");
    assert.equal(m.calls.length, 2);
  } finally { m.restore(); }
});
