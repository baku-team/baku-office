// 適合性テスト（移植性アーキ §2.3）：Gemini/Claude を ChatModel に一本化した際、
// wire 形式（リクエスト本体）と応答解釈が従来どおりであることを fetch モックで確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiModel } from "../src/core/models/gemini.ts";
import { claudeModel } from "../src/core/models/claude.ts";
import { runToolLoop, type Turn, type TokenUsage } from "../src/core/ai.ts";
import { estimateUsd } from "../src/lib/usage.ts";

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
  try { assert.deepEqual(await geminiModel("K").turn("S", HISTORY, DECLS), { text: "了解です", usage: { inputTokens: 0, outputTokens: 0 } }); } finally { m.restore(); }
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
  try { assert.deepEqual(await claudeModel("K").turn("S", HISTORY, DECLS), { text: "完了", usage: { inputTokens: 0, outputTokens: 0 } }); } finally { m.restore(); }
});

test("usage 捕捉（P0-2）：Gemini usageMetadata / Claude usage を token に変換", async () => {
  const mg = mockFetch([{ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 340 } }]);
  try {
    const r = await geminiModel("K").turn("S", HISTORY, DECLS);
    assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 340 });
  } finally { mg.restore(); }
  const mc = mockFetch([{ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 210 } }]);
  try {
    const r = await claudeModel("K").turn("S", HISTORY, DECLS);
    assert.deepEqual(r.usage, { inputTokens: 900, outputTokens: 210 });
  } finally { mc.restore(); }
});

test("runToolLoop：onUsage が全hopの token を受け取り合算できる（P0-2）", async () => {
  const m = mockFetch([
    { candidates: [{ content: { parts: [{ functionCall: { name: "set_reminder", args: { content: "会議" } } }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } },
    { candidates: [{ content: { parts: [{ text: "登録しました" }] } }], usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 30 } },
  ]);
  try {
    const acc: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    await runToolLoop(geminiModel("K"), "S", { text: "x" }, DECLS, async () => "ok", 4, [], (u) => { acc.inputTokens += u.inputTokens; acc.outputTokens += u.outputTokens; });
    assert.deepEqual(acc, { inputTokens: 250, outputTokens: 50 });
  } finally { m.restore(); }
});

test("estimateUsd（P0-2）：参考単価で推定USDを算出（gemini/claude・未登録は0）", () => {
  const env = {} as Env; // env未設定＝既定単価
  // gemini: 1M in×$0.30 + 1M out×$2.50 = $2.80
  assert.equal(Math.round(estimateUsd(env, "gemini", 1_000_000, 1_000_000) * 100) / 100, 2.8);
  // claude: 1M in×$3 + 1M out×$15 = $18
  assert.equal(estimateUsd(env, "claude", 1_000_000, 1_000_000), 18);
  assert.equal(estimateUsd(env, "local", 1_000_000, 1_000_000), 0);
});

test("estimateUsd：MODEL_PRICING(env)で単価を上書きできる", () => {
  const env = { MODEL_PRICING: JSON.stringify({ claude: { in: 1, out: 5 } }) } as unknown as Env;
  // 上書き後 claude: 1M in×$1 + 1M out×$5 = $6
  assert.equal(estimateUsd(env, "claude", 1_000_000, 1_000_000), 6);
  // 未指定の gemini は既定値のまま
  assert.equal(Math.round(estimateUsd(env, "gemini", 1_000_000, 1_000_000) * 100) / 100, 2.8);
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
