import type { APIRoute } from "astro";
import { syncOpenReports } from "../../../lib/reports.ts";
import { recomputeAllTrust } from "../../../lib/directory.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 自己修復ログの定期巡回（INTERNAL_KEY 保護・スケジューラWorkerが叩く）。
// 未集積のエラー報告を GitHub Issue へ自動集積（→ Claude が巡回・修復）＋公開ディレクトリの信頼スコア再計算（相乗り）。
export const POST: APIRoute = async ({ request, locals }) => {
  if (!env.INTERNAL_KEY || request.headers.get("x-internal-key") !== env.INTERNAL_KEY) return json({ error: "forbidden" }, 403);
  const limit = Number(new URL(request.url).searchParams.get("limit") || 20);
  const r = await syncOpenReports(env, Math.min(Math.max(1, limit), 50)).catch((e) => ({ synced: 0, failed: 0, error: (e as Error).message }));
  const trustRecomputed = await recomputeAllTrust(env, 50).catch(() => 0);
  return json({ ok: true, ...r, trustRecomputed });
};
