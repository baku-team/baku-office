// AIメディア機能（設計書 付録B）。各機能は対応APIキーが連携設定にある時のみ実行（無ければ案内）。
//   Gemini：要約(Files API)／音声文字起こし／web検索grounding。 Claude：資料生成(make_document)。
import { randomId } from "@baku-office/shared";
import { getApiKey } from "./client.ts";
import { getFile, saveFile } from "./storage.ts";
import { nowSec } from "./accounting.ts";
import { recordUsage, recordTokens, overBudget } from "./usage.ts";
import { geminiModelId, claudeModelId } from "../core/models/config.ts";

// --- Gemini Files API（resumable・大容量対応） ---
async function geminiUpload(key: string, buf: ArrayBuffer, mime: string): Promise<string | null> {
  const start = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(buf.byteLength), "X-Goog-Upload-Header-Content-Type": mime, "content-type": "application/json" },
    body: JSON.stringify({ file: { display_name: "doc" } }),
  });
  const url = start.headers.get("x-goog-upload-url");
  if (!start.ok || !url) return null;
  const up = await fetch(url, { method: "POST", headers: { "Content-Length": String(buf.byteLength), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: buf });
  if (!up.ok) return null;
  return ((await up.json()) as { file?: { uri?: string } }).file?.uri ?? null;
}
async function geminiGenerate(env: Env, key: string, parts: unknown[], tools?: unknown[]): Promise<string> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModelId(env))}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }], ...(tools ? { tools } : {}), generationConfig: { maxOutputTokens: 1200 } }),
  });
  if (!r.ok) { console.log("[gemini-gen]", r.status, (await r.text()).slice(0, 150)); return ""; }
  const d = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  await recordTokens(env, "gemini", { inputTokens: d.usageMetadata?.promptTokenCount ?? 0, outputTokens: d.usageMetadata?.candidatesTokenCount ?? 0 });
  return d.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim() ?? "";
}

// 音声文字起こし＋議事録化（Gemini）。短尺はinline、長尺はFiles API。
export async function transcribeAudio(env: Env, buf: ArrayBuffer, mime: string): Promise<string | null> {
  const key = await getApiKey(env, "gemini");
  if (!key) return null;
  await recordUsage(env, "gemini");
  const prompt = "この音声を日本語で文字起こしし、会議なら話者を区別して要点・決定事項を議事録形式でまとめてください。";
  if (buf.byteLength <= 18 * 1024 * 1024) {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return geminiGenerate(env, key, [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }]);
  }
  const uri = await geminiUpload(key, buf, mime);
  if (!uri) return null;
  return geminiGenerate(env, key, [{ text: prompt }, { file_data: { mime_type: mime, file_uri: uri } }]);
}

// web検索（Gemini google search grounding）。
export async function webSearch(env: Env, query: string): Promise<string | null> {
  const key = await getApiKey(env, "gemini");
  if (!key) return null;
  // Web検索の従量上限（P3）。usage_limits.web_search.monthlyCap（回数）で hard cap。
  if ((await overBudget(env, "web_search")) === "pause") return "（Web検索の今月の利用上限に達しました。設定 → API使用量 で変更できます）";
  await recordUsage(env, "web_search");
  const text = await geminiGenerate(env, key, [{ text: query }], [{ googleSearch: {} }]);
  return text || "（検索結果が得られませんでした）";
}

// --- 大ファイル要約ジョブ（Files API＋drainステップ） ---
export async function enqueueSummary(env: Env, owner: string, fileId: string, name: string): Promise<void> {
  await env.DB.prepare("INSERT INTO summary_jobs (id,owner,name,file_id,status,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?)")
    .bind(randomId(), owner, name, fileId, nowSec(), nowSec()).run();
}
// 保留ジョブを1件処理（drainから呼ぶ）。Geminiキーが無ければ何もしない（pendingのまま）。
export async function processSummaryJobs(env: Env, limit = 3): Promise<number> {
  const key = await getApiKey(env, "gemini");
  if (!key) return 0;
  const { results } = await env.DB.prepare("SELECT id,owner,name,file_id FROM summary_jobs WHERE status='pending' ORDER BY created_at LIMIT ?").bind(limit).all<{ id: string; owner: string; name: string; file_id: string }>();
  let done = 0;
  for (const job of results) {
    const f = await getFile(env, job.file_id);
    if (!f) { await env.DB.prepare("UPDATE summary_jobs SET status='error',updated_at=? WHERE id=?").bind(nowSec(), job.id).run(); continue; }
    await recordUsage(env, "gemini");
    const uri = await geminiUpload(key, f.buf, f.mime);
    const summary = uri ? await geminiGenerate(env, key, [{ text: "この資料の要点・数値・結論を漏れなく日本語で要約してください。" }, { file_data: { mime_type: f.mime, file_uri: uri } }]) : "";
    if (!summary) { await env.DB.prepare("UPDATE summary_jobs SET status='error',updated_at=? WHERE id=?").bind(nowSec(), job.id).run(); continue; }
    await env.DB.prepare("UPDATE summary_jobs SET status='done',result=?,updated_at=? WHERE id=?").bind(summary.slice(0, 100000), nowSec(), job.id).run();
    await env.DB.prepare("INSERT INTO knowledge (id,title,body,file_ref,tags,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(randomId(), `[資料要約] ${job.name}`, summary.slice(0, 100000), job.file_id, "資料要約", job.owner, nowSec()).run();
    done++;
  }
  return done;
}

// --- make_document（Claude）。md/csv/txt をClaudeで生成しファイル保存→DLリンク。
//     pptx/docx/pdf/xlsx の本格生成は Agent Skills 接続が必要（次段）。 ---
export async function makeDocument(env: Env, owner: string, baseUrl: string, a: { type: string; title: string; content: string }): Promise<string> {
  const key = await getApiKey(env, "claude");
  if (!key) return "資料生成には Claude APIキーが必要です（連携設定で登録してください）。";
  await recordUsage(env, "claude");
  const type = ["md", "csv", "txt"].includes(a.type) ? a.type : "md";
  const sys = `あなたは資料作成アシスタント。指示に従い ${type} 形式の本文だけを出力（前置き・コードフェンス無し）。`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: claudeModelId(env), max_tokens: 4000, system: sys, messages: [{ role: "user", content: `タイトル:${a.title}\n要件:${a.content}` }] }),
  });
  if (!r.ok) { console.log("[claude-doc]", r.status, (await r.text()).slice(0, 150)); return "資料生成に失敗しました。"; }
  const data = (await r.json()) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  await recordTokens(env, "claude", { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 });
  const body = data.content?.map((c) => c.text ?? "").join("") ?? "";
  const mime = type === "csv" ? "text/csv" : type === "txt" ? "text/plain" : "text/markdown";
  const file = new File([new TextEncoder().encode(body)], `${a.title}.${type}`, { type: mime });
  const saved = await saveFile(env, file, owner);
  return `資料を作成しました：${a.title}.${type}\nダウンロード：${baseUrl}/files/${saved.id}`;
}

// --- 請求書/領収書の抽出（Claude マルチモーダル）。画像/PDFから請求元・金額・期日を読み取りJSONで返す。 ---
function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  const chunk = 0x8000; // スタック溢れ回避のため分割（大きめのPDF対策）
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
export type InvoiceExtract = { vendor?: string; amount?: number; issued_date?: string; due_date?: string };
export async function extractInvoiceData(env: Env, file: { buf: ArrayBuffer; mime: string; name: string }): Promise<InvoiceExtract> {
  const key = await getApiKey(env, "claude");
  if (!key) return {};
  const isPdf = file.mime === "application/pdf" || /\.pdf$/i.test(file.name);
  const data = bufToB64(file.buf);
  const imgMime = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime) ? file.mime : "image/jpeg";
  const block = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: imgMime, data } };
  const prompt = "この請求書/領収書から請求元・金額・発行日・支払期日を読み取り、JSONのみ出力（前置き・コードフェンス無し）：" +
    '{"vendor":"請求元名 or null","amount":金額の数値(円・整数。不明ならnull),"issued_date":"YYYY-MM-DD or null","due_date":"YYYY-MM-DD or null"}';
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: claudeModelId(env), max_tokens: 500, messages: [{ role: "user", content: [block, { type: "text", text: prompt }] }] }),
  });
  await recordUsage(env, "claude");
  if (!r.ok) { console.log("[invoice-extract]", r.status, (await r.text()).slice(0, 150)); return {}; }
  const d = (await r.json()) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  await recordTokens(env, "claude", { inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 });
  const raw = (d.content?.map((c) => c.text ?? "").join("") ?? "").replace(/^```(?:json)?|```$/g, "").trim();
  try {
    const j = JSON.parse(raw) as InvoiceExtract;
    return { vendor: j.vendor ?? undefined, amount: typeof j.amount === "number" ? j.amount : undefined, issued_date: j.issued_date ?? undefined, due_date: j.due_date ?? undefined };
  } catch { return {}; }
}

// 経費の勘定科目をAIが推定（候補から1つ選ぶ）。freeeに合わせた科目選択を補助。手動上書き前提。
// Claudeキー無し or 失敗時は null（UI側で手動選択にフォールバック）。
export async function suggestAccountItem(
  env: Env,
  input: { vendor?: string; description?: string; amount?: number },
  candidates: { code: string; name: string }[],
): Promise<{ code: string; reason: string } | null> {
  const key = await getApiKey(env, "claude");
  if (!key || candidates.length === 0) return null;
  const list = candidates.map((c) => `${c.code}:${c.name}`).join(" / ");
  const prompt =
    `次の支出に最も適切な勘定科目を、候補から1つだけ選んでJSONのみ出力（前置き・コードフェンス無し）。\n` +
    `候補: ${list}\n支払先: ${input.vendor ?? "(不明)"}\n内容: ${input.description ?? "(不明)"}\n金額: ${input.amount ?? "(不明)"}\n` +
    `出力形式: {"code":"候補のcode","reason":"30字以内の理由"}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: claudeModelId(env), max_tokens: 120, messages: [{ role: "user", content: prompt }] }),
    });
    await recordUsage(env, "claude");
    if (!r.ok) { console.log("[suggest-account]", r.status); return null; }
    const d = (await r.json()) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    await recordTokens(env, "claude", { inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 });
    const raw = (d.content?.map((c) => c.text ?? "").join("") ?? "").replace(/^```(?:json)?|```$/g, "").trim();
    const j = JSON.parse(raw) as { code?: string; reason?: string };
    const hit = candidates.find((c) => c.code === j.code);
    return hit ? { code: hit.code, reason: String(j.reason ?? "") } : null;
  } catch { return null; }
}

// 公開ディレクトリ用の団体紹介文＋検索タグをAIが生成（Gemini優先・無ければClaude）。キー無は null。
export async function generateOrgProfile(env: Env, info: { orgName: string; hints?: string }): Promise<{ summary: string; tags: string[] } | null> {
  const prompt =
    `次の団体の「公開ディレクトリ用の紹介文」と「検索タグ」を作って。紹介文は80〜120字で事業内容が一目で分かるように。タグは5個・日本語の短い語。JSONのみ出力（前置き・コードフェンス無し）：\n` +
    `{"summary":"...","tags":["...","..."]}\n団体名: ${info.orgName}\n補足: ${info.hints ?? "(なし)"}`;
  const gkey = await getApiKey(env, "gemini");
  try {
    let raw = "";
    if (gkey) {
      await recordUsage(env, "gemini");
      raw = await geminiGenerate(env, gkey, [{ text: prompt }]);
    } else {
      const ckey = await getApiKey(env, "claude");
      if (!ckey) return null;
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "x-api-key": ckey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: claudeModelId(env), max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
      });
      await recordUsage(env, "claude");
      if (!r.ok) return null;
      const d = (await r.json()) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      await recordTokens(env, "claude", { inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 });
      raw = d.content?.map((c) => c.text ?? "").join("") ?? "";
    }
    const j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as { summary?: string; tags?: string[] };
    return { summary: String(j.summary ?? ""), tags: Array.isArray(j.tags) ? j.tags.map(String).slice(0, 8) : [] };
  } catch { return null; }
}

// レジ締めの差異（想定額−実査額）の原因をAIが推定。直近取引と差額から日本語1〜2文。キー無は null。
export async function estimateDiscrepancy(
  env: Env,
  difference: number,
  recent: { date: string; kind: string; amount: number; description: string | null }[],
): Promise<string | null> {
  const key = await getApiKey(env, "claude");
  if (!key) return null;
  const lines = recent.slice(0, 30).map((t) => `${t.date} ${t.kind} ${t.amount} ${t.description ?? ""}`).join("\n");
  const prompt =
    `現金レジ締めで差異が出た。差異額（想定−実査）= ${difference} 円（プラスは現金が想定より不足、マイナスは過剰）。\n` +
    `直近の取引:\n${lines}\n\n考えられる原因を、会計初心者にも分かる日本語で1〜2文・具体的に推定して。前置き不要。`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: claudeModelId(env), max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
    });
    await recordUsage(env, "claude");
    if (!r.ok) { console.log("[closure-estimate]", r.status); return null; }
    const d = (await r.json()) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    await recordTokens(env, "claude", { inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 });
    const txt = (d.content?.map((c) => c.text ?? "").join("") ?? "").trim();
    return txt || null;
  } catch { return null; }
}

// 会議トランスクリプトの議事録要約＋アクション抽出（Claude）。Meet パーツから ctx.ai 経由で呼ぶ（env非露出）。
export async function summarizeTranscript(env: Env, transcript: string): Promise<{ summary: string; actions: { content: string; due?: string }[] } | null> {
  const key = await getApiKey(env, "claude");
  if (!key) return null;
  const sys = "あなたは会議の議事録作成アシスタント。与えられたトランスクリプトから日本語で(1)議事録要約(2)アクションアイテムを抽出し、" +
    'JSONのみを出力：{"summary":"...","actions":[{"content":"担当と内容","due":"ISO8601日時(任意・無ければ省略)"}]}（前置き・コードフェンス無し）。';
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: claudeModelId(env), max_tokens: 2000, system: sys, messages: [{ role: "user", content: transcript }] }),
  });
  await recordUsage(env, "claude").catch(() => {});
  if (!r.ok) { console.log("[meet-claude]", r.status, (await r.text()).slice(0, 150)); return null; }
  const data = (await r.json()) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  await recordTokens(env, "claude", { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 }).catch(() => {});
  const raw = (data.content?.map((c) => c.text ?? "").join("") ?? "").replace(/^```(?:json)?|```$/g, "").trim();
  try {
    const j = JSON.parse(raw) as { summary?: string; actions?: { content: string; due?: string }[] };
    return { summary: String(j.summary ?? ""), actions: Array.isArray(j.actions) ? j.actions : [] };
  } catch { return { summary: raw.slice(0, 4000), actions: [] }; }
}
