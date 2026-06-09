import type { APIRoute } from "astro";
import { syncOpenReports } from "../../../lib/reports.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 自己修復ログの定期巡回（INTERNAL_KEY 保護・スケジューラWorkerが叩く）。
// 未集積のエラー報告を GitHub Issue へ自動集積（→ Claude が巡回・修復）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  if (!env.INTERNAL_KEY || request.headers.get("x-internal-key") !== env.INTERNAL_KEY) return json({ error: "forbidden" }, 403);
  const limit = Number(new URL(request.url).searchParams.get("limit") || 20);
  const r = await syncOpenReports(env, Math.min(Math.max(1, limit), 50)).catch((e) => ({ synced: 0, failed: 0, error: (e as Error).message }));
  return json({ ok: true, ...r });
};
