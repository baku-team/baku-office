// AIメディア機能（設計書 付録B）。各機能は対応APIキーが連携設定にある時のみ実行（無ければ案内）。
//   Gemini：要約(Files API)／音声文字起こし／web検索grounding。 Claude：資料生成(make_document)。
import { randomId } from "@baku-office/shared";
import { getApiKey } from "./client.ts";
import { getFile, saveFile } from "./storage.ts";
import { nowSec } from "./accounting.ts";

const GEMINI = "gemini-2.5-flash";

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
async function geminiGenerate(key: string, parts: unknown[], tools?: unknown[]): Promise<string> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }], ...(tools ? { tools } : {}), generationConfig: { maxOutputTokens: 1200 } }),
  });
  if (!r.ok) { console.log("[gemini-gen]", r.status, (await r.text()).slice(0, 150)); return ""; }
  const d = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return d.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim() ?? "";
}

// 音声文字起こし＋議事録化（Gemini）。短尺はinline、長尺はFiles API。
export async function transcribeAudio(env: Env, buf: ArrayBuffer, mime: string): Promise<string | null> {
  const key = await getApiKey(env, "gemini");
  if (!key) return null;
  const prompt = "この音声を日本語で文字起こしし、会議なら話者を区別して要点・決定事項を議事録形式でまとめてください。";
  if (buf.byteLength <= 18 * 1024 * 1024) {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return geminiGenerate(key, [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }]);
  }
  const uri = await geminiUpload(key, buf, mime);
  if (!uri) return null;
  return geminiGenerate(key, [{ text: prompt }, { file_data: { mime_type: mime, file_uri: uri } }]);
}

// web検索（Gemini google search grounding）。
export async function webSearch(env: Env, query: string): Promise<string | null> {
  const key = await getApiKey(env, "gemini");
  if (!key) return null;
  const text = await geminiGenerate(key, [{ text: query }], [{ googleSearch: {} }]);
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
    const uri = await geminiUpload(key, f.buf, f.mime);
    const summary = uri ? await geminiGenerate(key, [{ text: "この資料の要点・数値・結論を漏れなく日本語で要約してください。" }, { file_data: { mime_type: f.mime, file_uri: uri } }]) : "";
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
  const type = ["md", "csv", "txt"].includes(a.type) ? a.type : "md";
  const sys = `あなたは資料作成アシスタント。指示に従い ${type} 形式の本文だけを出力（前置き・コードフェンス無し）。`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 4000, system: sys, messages: [{ role: "user", content: `タイトル:${a.title}\n要件:${a.content}` }] }),
  });
  if (!r.ok) { console.log("[claude-doc]", r.status, (await r.text()).slice(0, 150)); return "資料生成に失敗しました。"; }
  const data = (await r.json()) as { content?: { text?: string }[] };
  const body = data.content?.map((c) => c.text ?? "").join("") ?? "";
  const mime = type === "csv" ? "text/csv" : type === "txt" ? "text/plain" : "text/markdown";
  const file = new File([new TextEncoder().encode(body)], `${a.title}.${type}`, { type: mime });
  const saved = await saveFile(env, file, owner);
  return `資料を作成しました：${a.title}.${type}\nダウンロード：${baseUrl}/files/${saved.id}`;
}
