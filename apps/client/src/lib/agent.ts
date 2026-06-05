// Proプランの会計・庶務エージェント（設計書§2/付録B）。
// Gemini function-calling のツールループで、新データモデル（personal_items/knowledge/reminders/users）を操作。
// APIキーは連携設定の暗号KVから復号して使用。
import { getApiKey } from "./client.ts";
import * as T from "./agent-tools.ts";
import { webSearch, makeDocument } from "./media-ai.ts";
import { listSkills, runSkill } from "./skills.ts";
import { listCapabilities, invokeCapability, capabilitySummary, videoStatusText } from "./capabilities.ts";
import { getAiEngine, getCustomPrompt } from "./settings.ts";
import { recordUsage, overBudget } from "./usage.ts";

const SYSTEM =
  "あなたは団体の会計・庶務を補助するLINEアシスタント『baku-office』です。日本語で簡潔に。" +
  "支出/領収書は record_expense、メモは save_memo、リマインダーは set_reminder（日時はISO 例2026-06-20T10:00）、" +
  "ナレッジ保存は save_knowledge、検索は search_knowledge、メンバー照会は search_members、領収書一覧は list_expenses、予定確認は list_reminders。" +
  "最新情報が要る質問は web_search、資料作成依頼は make_document（type=md/csv/txt）を使う。" +
  "ツールが不要な質問・雑談は通常のテキストで短く答える。";

// Gemini 関数宣言（OpenAPI風スキーマ）。
const TOOLS = [
  { name: "record_expense", description: "支出/領収書を記録", parameters: { type: "object", properties: { amount: { type: "number" }, title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } }, required: ["amount", "title"] } },
  { name: "save_memo", description: "メモを保存", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] } },
  { name: "set_reminder", description: "指定日時にLINEへ通知", parameters: { type: "object", properties: { content: { type: "string" }, remind_at: { type: "string", description: "ISO日時" } }, required: ["content", "remind_at"] } },
  { name: "list_reminders", description: "未配信リマインダー一覧", parameters: { type: "object", properties: {} } },
  { name: "list_expenses", description: "記録した領収書一覧", parameters: { type: "object", properties: {} } },
  { name: "save_knowledge", description: "組織ナレッジを保存", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"] } },
  { name: "search_knowledge", description: "組織ナレッジを検索", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "search_members", description: "メンバー（名簿）を検索", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
// API依存ツール（キーがある時だけ宣言＝モデルに見せる）。
const GEMINI_TOOLS = [
  { name: "web_search", description: "最新情報をWeb検索（Google grounding）", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
const CLAUDE_TOOLS = [
  { name: "make_document", description: "資料を生成（type=md/csv/txt）してDLリンクを返す", parameters: { type: "object", properties: { type: { type: "string" }, title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] } },
];
// 高度なオプション：有効化済みのユーザー追加スキル（要Claudeキー）。
function skillTool(names: string[]) {
  return { name: "run_skill", description: `登録済みの業務スキルを実行（利用可能: ${names.join(", ")}）`, parameters: { type: "object", properties: { name: { type: "string" }, input: { type: "string" } }, required: ["name", "input"] } };
}
// 任意API能力（設定済みのものだけツール提示）。
const CAP_TOOLS: Record<string, unknown> = {
  image_gen: { name: "generate_image", description: "画像を生成してDLリンクを返す", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
  tts: { name: "synthesize_speech", description: "テキストを音声合成してDLリンクを返す", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  video_gen: { name: "generate_video", description: "動画を生成（非同期）", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
};
const VIDEO_STATUS_TOOL = { name: "video_status", description: "依頼した動画生成の状況を確認（完成ならDLリンク）", parameters: { type: "object", properties: {} } };

type Part = { text?: string; functionCall?: { name: string; args: Record<string, unknown> }; functionResponse?: { name: string; response: unknown }; inlineData?: { mimeType: string; data: string } };
type Content = { role: string; parts: Part[] };

async function gemini(key: string, contents: Content[], decls: unknown[], sys: string): Promise<Content | null> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, tools: [{ functionDeclarations: decls }], generationConfig: { temperature: 0.3, maxOutputTokens: 800 } }),
  });
  if (!r.ok) { console.log("[gemini]", r.status, (await r.text()).slice(0, 200)); return null; }
  const data = (await r.json()) as { candidates?: { content?: Content }[] };
  return data.candidates?.[0]?.content ?? null;
}

// Claude（Anthropic Messages API）でのツールループ。Gemini宣言を Claude の tools 形式に変換して使う。
type Decl = { name: string; description: string; parameters: unknown };
type CContent = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
async function claudeAgent(key: string, sys: string, decls: Decl[], userText: string, exec: (name: string, args: Record<string, unknown>) => Promise<string>): Promise<string> {
  const tools = decls.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
  const messages: { role: string; content: unknown }[] = [{ role: "user", content: userText }];
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1500, system: sys, tools, messages }),
    });
    if (!r.ok) { console.log("[claude-agent]", r.status, (await r.text()).slice(0, 200)); return "（Claudeの応答に失敗しました）"; }
    const data = (await r.json()) as { content?: CContent[]; stop_reason?: string };
    const content = data.content ?? [];
    const toolUses = content.filter((c) => c.type === "tool_use");
    if (!toolUses.length || data.stop_reason !== "tool_use") {
      return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim() || "（応答が空でした）";
    }
    messages.push({ role: "assistant", content });
    const results = [];
    for (const tu of toolUses) results.push({ type: "tool_result", tool_use_id: tu.id, content: await exec(tu.name!, tu.input ?? {}) });
    messages.push({ role: "user", content: results });
  }
  return "処理が長くなりました。もう一度お試しください。";
}

async function execTool(env: Env, owner: string, baseUrl: string, name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "record_expense": return T.recordExpense(env, owner, { amount: Number(args.amount), title: String(args.title), date: args.date ? String(args.date) : undefined });
    case "save_memo": return T.saveMemo(env, owner, { title: String(args.title), body: args.body ? String(args.body) : undefined });
    case "set_reminder": return T.setReminder(env, owner, { content: String(args.content), remind_at: String(args.remind_at) });
    case "list_reminders": return T.listReminders(env, owner);
    case "list_expenses": return T.listExpenses(env, owner);
    case "save_knowledge": return T.saveKnowledge(env, owner, { title: String(args.title), body: String(args.body) });
    case "search_knowledge": return T.searchKnowledge(env, { query: String(args.query) });
    case "search_members": return T.searchMembers(env, { query: String(args.query ?? "") });
    case "web_search": return (await webSearch(env, String(args.query))) ?? "web検索は未設定です。";
    case "make_document": return makeDocument(env, owner, baseUrl, { type: String(args.type ?? "md"), title: String(args.title), content: String(args.content) });
    case "run_skill": return runSkill(env, owner, baseUrl, String(args.name), String(args.input ?? ""));
    case "generate_image": return invokeCapability(env, owner, baseUrl, "image_gen", String(args.prompt));
    case "synthesize_speech": return invokeCapability(env, owner, baseUrl, "tts", String(args.text));
    case "generate_video": return invokeCapability(env, owner, baseUrl, "video_gen", String(args.prompt));
    case "video_status": return videoStatusText(env, owner, baseUrl);
    default: return "未知のツール";
  }
}

// テキスト発話 → ツールループ。最大4ホップで関数呼び出しを解決して最終テキストを返す。
// owner はデータスコープ識別子（LINE は `line:<userId>`、Web は session.uid）。呼び出し側で付与する。
// API依存ツール（web_search=Gemini／make_document=Claude）は対応キーがある時だけモデルに提示。
export async function runAgent(env: Env, owner: string, text: string, image?: { mimeType: string; dataB64: string }, baseUrl = ""): Promise<string> {
  const geminiKey = await getApiKey(env, "gemini");
  const claudeKey = await getApiKey(env, "claude");
  if (!geminiKey && !claudeKey) return "AI機能が未設定です。管理画面の『連携設定』または『高度なオプション』で Gemini か Claude のAPIキーを登録してください。";
  const hasClaude = !!claudeKey;
  const engine = await getAiEngine(env);
  const enabledSkills = hasClaude ? await listSkills(env, true) : [];
  const caps = await listCapabilities(env, true);
  const capDecls = caps.map((c) => CAP_TOOLS[c.capability]).filter(Boolean);
  if (caps.some((c) => c.capability === "video_gen")) capDecls.push(VIDEO_STATUS_TOOL);
  const decls = [...TOOLS, ...GEMINI_TOOLS, ...(hasClaude ? CLAUDE_TOOLS : []), ...(enabledSkills.length ? [skillTool(enabledSkills.map((s) => s.name))] : []), ...capDecls];
  // 自己認識：有効な追加能力＋団体のカスタム指示（口調・人格・回答形式）をシステム文脈へ。安全制約は不変。
  const capInfo = await capabilitySummary(env);
  const custom = await getCustomPrompt(env);
  const sys = [SYSTEM, capInfo, custom && `団体の追加指示（口調・人格・回答形式など。安全制約は変更しない）:\n${custom}`].filter(Boolean).join("\n");

  // エンジン選択：Claude（BYOK）を選択／Geminiが無い場合は Claude で実行（画像はGeminiパスのみ対応）。
  const useClaude = !!claudeKey && (engine === "claude" || !geminiKey) && !image;
  if (useClaude) {
    const b = await overBudget(env, "claude");
    if (b === "pause") return "Claudeの今月の利用上限に達しました（高度なオプション → API使用量 で変更できます）。";
    if (b !== "switch_free") {
      // ok：Claudeで実行。
      await recordUsage(env, "claude");
      return claudeAgent(claudeKey!, sys, decls as Decl[], text || "（依頼）", (n, a) => execTool(env, owner, baseUrl, n, a));
    }
    // switch_free：Geminiが使えればフォールバック、無ければ停止。
    if (!geminiKey) return "Claudeの上限に達しました（Gemini未設定のため停止）。高度なオプションで上限を変更してください。";
  }
  if (!geminiKey) return "選択中のエンジンが未設定です。『連携設定』で Gemini APIキーを登録するか、高度なオプションでエンジンを Claude に切り替えてください。";
  const gb = await overBudget(env, "gemini");
  if (gb !== "ok") return "Geminiの今月の利用上限に達しました（高度なオプション → API使用量 で変更できます）。";
  await recordUsage(env, "gemini");

  const firstParts: Part[] = [{ text: text || "（画像）" }];
  if (image) firstParts.push({ inlineData: { mimeType: image.mimeType, data: image.dataB64 } });
  const contents: Content[] = [{ role: "user", parts: firstParts }];

  for (let hop = 0; hop < 4; hop++) {
    const out = await gemini(geminiKey, contents, decls, sys);
    if (!out) return "（AIの応答に失敗しました）";
    const calls = out.parts.filter((p) => p.functionCall);
    if (!calls.length) return out.parts.map((p) => p.text ?? "").join("").trim() || "（応答が空でした）";
    contents.push(out);
    const respParts: Part[] = [];
    for (const c of calls) {
      const result = await execTool(env, owner, baseUrl, c.functionCall!.name, c.functionCall!.args ?? {});
      respParts.push({ functionResponse: { name: c.functionCall!.name, response: { result } } });
    }
    contents.push({ role: "user", parts: respParts });
  }
  return "処理が長くなりました。もう一度お試しください。";
}

// LINE署名検証（HMAC-SHA256）。
export async function verifyLineSignature(secret: string, body: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac))) === signature;
}

// LINE 返信／プッシュ。
export async function lineReply(accessToken: string, replyToken: string, text: string): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
}
export async function linePush(accessToken: string, to: string, text: string): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
}

// LINE画像メッセージの本体を取得（OCR用）。
export async function fetchLineImage(accessToken: string, messageId: string): Promise<{ mimeType: string; dataB64: string } | null> {
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return null;
  const buf = await r.arrayBuffer();
  const mimeType = r.headers.get("content-type") ?? "image/jpeg";
  const dataB64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { mimeType, dataB64 };
}
