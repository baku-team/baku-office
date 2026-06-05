// Proプランの会計・庶務エージェント（設計書§2/付録B）。
// Gemini function-calling のツールループで、新データモデル（personal_items/knowledge/reminders/users）を操作。
// APIキーは連携設定の暗号KVから復号して使用。
import { getApiKey } from "./client.ts";
import * as T from "./agent-tools.ts";
import { webSearch, makeDocument } from "./media-ai.ts";
import { listSkills, runSkill } from "./skills.ts";
import { listCapabilities, invokeCapability, capabilitySummary, videoStatusText } from "./capabilities.ts";

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
  const key = await getApiKey(env, "gemini");
  if (!key) return "AI機能が未設定です。管理画面の『連携設定』で Gemini APIキーを登録してください。";
  const hasClaude = !!(await getApiKey(env, "claude"));
  const enabledSkills = hasClaude ? await listSkills(env, true) : [];
  const caps = await listCapabilities(env, true);
  const capDecls = caps.map((c) => CAP_TOOLS[c.capability]).filter(Boolean);
  if (caps.some((c) => c.capability === "video_gen")) capDecls.push(VIDEO_STATUS_TOOL);
  const decls = [...TOOLS, ...GEMINI_TOOLS, ...(hasClaude ? CLAUDE_TOOLS : []), ...(enabledSkills.length ? [skillTool(enabledSkills.map((s) => s.name))] : []), ...capDecls];
  // 自己認識：有効な追加能力をシステム文脈へ（AI/エージェントが参照できるように）。
  const capInfo = await capabilitySummary(env);
  const sys = capInfo ? `${SYSTEM}\n${capInfo}` : SYSTEM;
  const firstParts: Part[] = [{ text: text || "（画像）" }];
  if (image) firstParts.push({ inlineData: { mimeType: image.mimeType, data: image.dataB64 } });
  const contents: Content[] = [{ role: "user", parts: firstParts }];

  for (let hop = 0; hop < 4; hop++) {
    const out = await gemini(key, contents, decls, sys);
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
