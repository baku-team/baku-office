// Google Meet 連携パーツ（Pro以上・方式③：リアルタイム参加はせず会議後に処理）。
// Meet REST API（Conference Records）で会議記録とトランスクリプトを取得 → Claude で議事録要約・
// アクション抽出 → ナレッジ保存（knowledge）＋タスク化（reminders）＋ meet_records にキャッシュ（画面表示）。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";
import { googleFetch } from "../lib/google.ts";
import { getApiKey } from "../lib/client.ts";
import { nowSec } from "../lib/accounting.ts";
import { saveKnowledge } from "./knowledge.ts";
import { setReminder } from "./reminders.ts";

const MEET = "https://meet.googleapis.com/v2";
const NEED_CONNECT = "Google 連携が未設定です。連携設定（Meet画面）から連携してください。";

type ConfRecord = { name: string; startTime?: string; endTime?: string; space?: string };

async function listConferenceRecords(ctx: Ctx, a: { max?: number }): Promise<string> {
  const u = new URL(`${MEET}/conferenceRecords`);
  u.searchParams.set("pageSize", String(Math.min(a.max ?? 10, 25)));
  const r = await googleFetch(ctx.env, u.toString());
  if (!r) return NEED_CONNECT;
  if (!r.ok) return `会議記録の取得に失敗しました（${r.status}）。`;
  const d = (await r.json()) as { conferenceRecords?: ConfRecord[] };
  const recs = d.conferenceRecords ?? [];
  if (!recs.length) return "会議記録はありません（Meet の文字起こしが有効な会議のみ取得できます）。";
  return recs.map((c) => `・[${c.name}] ${(c.startTime ?? "").slice(0, 16).replace("T", " ")} 〜 ${(c.endTime ?? "").slice(11, 16)}`).join("\n");
}

// 会議記録のトランスクリプト本文を「話者: 発言」で連結（最大 maxChars 字）。
async function fetchTranscriptText(ctx: Ctx, recordId: string, maxChars = 18000): Promise<{ text: string; error?: string } | null> {
  const tr = await googleFetch(ctx.env, `${MEET}/${recordId}/transcripts`);
  if (!tr) return null;
  if (!tr.ok) return { text: "", error: `transcripts ${tr.status}` };
  const td = (await tr.json()) as { transcripts?: { name: string }[] };
  const first = td.transcripts?.[0];
  if (!first) return { text: "", error: "この会議に文字起こしがありません。" };
  let pageToken = "";
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const u = new URL(`${MEET}/${first.name}/entries`);
    u.searchParams.set("pageSize", "1000");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const er = await googleFetch(ctx.env, u.toString());
    if (!er || !er.ok) break;
    const ed = (await er.json()) as { transcriptEntries?: { participant?: string; text?: string }[]; nextPageToken?: string };
    for (const e of ed.transcriptEntries ?? []) {
      const line = `${(e.participant ?? "").split("/").pop() ?? "?"}: ${e.text ?? ""}`;
      parts.push(line); total += line.length;
    }
    if (total >= maxChars || !ed.nextPageToken) break;
    pageToken = ed.nextPageToken;
  }
  return { text: parts.join("\n").slice(0, maxChars) };
}

async function getTranscript(ctx: Ctx, a: { record_id: string }): Promise<string> {
  const t = await fetchTranscriptText(ctx, a.record_id);
  if (!t) return NEED_CONNECT;
  if (t.error) return t.error;
  return t.text || "トランスクリプトが空です。";
}

// Claude で要約＋アクション抽出（JSON）。media-ai.ts の呼び出しパターンに準拠（model 文字列も流用）。
async function summarizeWithClaude(env: Env, transcript: string): Promise<{ summary: string; actions: { content: string; due?: string }[] } | null> {
  const key = await getApiKey(env, "claude");
  if (!key) return null;
  const sys = "あなたは会議の議事録作成アシスタント。与えられたトランスクリプトから日本語で(1)議事録要約(2)アクションアイテムを抽出し、" +
    'JSONのみを出力：{"summary":"...","actions":[{"content":"担当と内容","due":"ISO8601日時(任意・無ければ省略)"}]}（前置き・コードフェンス無し）。';
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000, system: sys, messages: [{ role: "user", content: transcript }] }),
  });
  if (!r.ok) { console.log("[meet-claude]", r.status, (await r.text()).slice(0, 150)); return null; }
  const data = (await r.json()) as { content?: { text?: string }[] };
  const raw = (data.content?.map((c) => c.text ?? "").join("") ?? "").replace(/^```(?:json)?|```$/g, "").trim();
  try {
    const j = JSON.parse(raw) as { summary?: string; actions?: { content: string; due?: string }[] };
    return { summary: String(j.summary ?? ""), actions: Array.isArray(j.actions) ? j.actions : [] };
  } catch { return { summary: raw.slice(0, 4000), actions: [] }; }
}

async function summarizeMeeting(ctx: Ctx, owner: string, a: { record_id: string; title?: string }): Promise<string> {
  const t = await fetchTranscriptText(ctx, a.record_id);
  if (!t) return NEED_CONNECT;
  if (t.error) return t.error;
  if (!t.text) return "トランスクリプトが空のため要約できません。";
  const result = await summarizeWithClaude(ctx.env, t.text);
  if (!result) return "要約には Claude APIキーが必要です（連携設定で登録してください）。";
  const title = a.title || `会議 ${new Date(nowSec() * 1000).toISOString().slice(0, 10)}`;

  // ① ナレッジへ議事録を保存
  const actionsText = result.actions.map((x) => `- ${x.content}${x.due ? `（期限 ${x.due}）` : ""}`).join("\n");
  const body = `${result.summary}\n\n## アクションアイテム\n${actionsText || "（なし）"}`;
  await saveKnowledge(ctx, owner, { title: `[議事録] ${title}`, body });

  // ② 期限のあるアクションをリマインダ登録
  let reminded = 0;
  for (const x of result.actions) {
    if (!x.due) continue;
    const msg = await setReminder(ctx, owner, { content: `[${title}] ${x.content}`, remind_at: x.due });
    if (msg.startsWith("リマインダー設定")) reminded++;
  }

  // ③ meet_records にキャッシュ（画面一覧・二重要約防止）
  await ctx.db.prepare(
    `INSERT INTO meet_records (id,space_name,title,start_time,end_time,summary,actions,knowledge_saved,reminders_saved,owner,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,1,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, summary=excluded.summary, actions=excluded.actions, knowledge_saved=1, reminders_saved=excluded.reminders_saved, updated_at=excluded.updated_at`,
  ).bind(a.record_id, null, title, null, null, result.summary.slice(0, 8000), JSON.stringify(result.actions).slice(0, 8000), reminded > 0 ? 1 : 0, owner, nowSec(), nowSec()).run().catch(() => {});

  return `議事録を作成しました：「${title}」\nナレッジに保存・アクション${result.actions.length}件（うち${reminded}件をリマインダ登録）。`;
}

// cron自動巡回：未処理の会議記録を検知して自動で議事録化。重複は meet_records.knowledge_saved=1 で防止。
// 文字起こし未生成の会議は要約されず（次巡回で再試行）。試行は新しい順8件まで、成功 limit 件で打ち切り（無料枠配慮）。
export async function pollNewConferences(env: Env, ctx: Ctx, owner = "org", limit = 2): Promise<number> {
  const u = new URL(`${MEET}/conferenceRecords`);
  u.searchParams.set("pageSize", "25");
  const r = await googleFetch(env, u.toString());
  if (!r || !r.ok) return 0;
  const d = (await r.json()) as { conferenceRecords?: ConfRecord[] };
  const recs = d.conferenceRecords ?? [];
  let done = 0;
  for (const c of recs.slice(0, 8)) {
    if (done >= limit) break;
    const existing = await ctx.db.prepare("SELECT knowledge_saved FROM meet_records WHERE id=?").bind(c.name).first<{ knowledge_saved: number }>().catch(() => null);
    if (existing?.knowledge_saved === 1) continue; // 処理済みはスキップ
    const msg = await summarizeMeeting(ctx, owner, { record_id: c.name }).catch(() => "");
    if (msg.startsWith("議事録を作成しました")) done++;
  }
  return done;
}

export const meetPart: Part = {
  id: "meet",
  name: "Google Meet",
  version: "1.0.0",
  category: "庶務",
  description: "Google Meet の会議記録から議事録要約を作成し、ナレッジ保存・タスク化する（会議後処理）。",
  permissions: ["net", "db:read", "db:write", "ai"],
  minPlan: "pro",
  menu: [{ href: "/meet", label: "Meet議事録" }],
  agentTools: [
    {
      name: "list_conference_records",
      description: "Google Meet の会議記録を一覧（文字起こしが有効な会議）",
      parameters: { type: "object", properties: { max: { type: "number" } } },
      run: (ctx, _o, _b, a) => listConferenceRecords(ctx, { max: a.max as number }),
    },
    {
      name: "get_transcript",
      description: "会議のトランスクリプト本文を取得（record_id 指定）",
      parameters: { type: "object", properties: { record_id: { type: "string", description: "conferenceRecords/xxx 形式" } }, required: ["record_id"] },
      run: (ctx, _o, _b, a) => getTranscript(ctx, { record_id: String(a.record_id) }),
    },
    {
      name: "summarize_meeting",
      description: "会議のトランスクリプトを要約して議事録を作成。ナレッジ保存＋アクションをリマインダ登録",
      parameters: { type: "object", properties: { record_id: { type: "string", description: "conferenceRecords/xxx 形式" }, title: { type: "string" } }, required: ["record_id"] },
      run: (ctx, owner, _b, a) => summarizeMeeting(ctx, owner, { record_id: String(a.record_id), title: a.title as string }),
    },
  ],
};

export { listConferenceRecords, summarizeMeeting };
