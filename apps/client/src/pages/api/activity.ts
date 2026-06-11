import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const trunc = (s: unknown) => { const t = String(s ?? ""); return t.length > 28 ? t.slice(0, 28) + "…" : t; };

// バックグラウンド稼働中のAI/エージェントジョブ一覧（全ページ共通のマスコット表示用）。
// 単一テナント前提。prompt 等の本文は自分のジョブのみ表示し、他者ジョブは種別のみ（プライバシー）。
export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses) return json({ active: 0, tasks: [] });
  const tasks: { kind: string; status: string; label: string; mine: boolean }[] = [];
  try {
    const a = (await env.DB.prepare("SELECT owner,prompt,status FROM agent_jobs WHERE status IN ('pending','running') ORDER BY created_at DESC LIMIT 8").all<{ owner: string; prompt: string; status: string }>()).results;
    for (const j of a) { const mine = j.owner === ses.uid; tasks.push({ kind: "agent", status: j.status, label: mine ? trunc(j.prompt) : "AIエージェント", mine }); }
  } catch { /* 未マイグレ */ }
  try {
    const s = (await env.DB.prepare("SELECT owner,name,status FROM summary_jobs WHERE status='pending' ORDER BY created_at DESC LIMIT 8").all<{ owner: string; name: string | null; status: string }>()).results;
    for (const j of s) tasks.push({ kind: "summary", status: "running", label: j.name ? `要約: ${trunc(j.name)}` : "ファイル要約", mine: j.owner === ses.uid });
  } catch { /* noop */ }
  try {
    const v = (await env.DB.prepare("SELECT owner,status FROM video_jobs WHERE status='pending' ORDER BY created_at DESC LIMIT 8").all<{ owner: string; status: string }>()).results;
    for (const j of v) tasks.push({ kind: "video", status: "running", label: "動画生成", mine: j.owner === ses.uid });
  } catch { /* noop */ }
  return json({ active: tasks.length, tasks });
};
