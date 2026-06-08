import type { APIRoute } from "astro";
import { getApiKey } from "../../../lib/client.ts";
import { linePush } from "../../../lib/agent.ts";
import { dueReminders, markReminderDone } from "../../../parts/reminders.ts";
import { processSummaryJobs } from "../../../lib/media-ai.ts";
import { pollVideoJobs } from "../../../lib/capabilities.ts";
import { processAgentJobs } from "../../../lib/agent-jobs.ts";
import { guardHeavy } from "../../../lib/diag.ts";
import { getDriveBackup, backupToDrive } from "../../../lib/drive.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 期限到来リマインダーを一括配信（外部スケジューラ＝cron-job.org 等から毎分叩く）。
// Astro単一Workerはネイティブcron非対応のため、INTERNAL_KEY 保護のHTTPエンドポイントで代替。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  if (!env.INTERNAL_KEY || request.headers.get("x-internal-key") !== env.INTERNAL_KEY) return json({ error: "forbidden" }, 403);
  // 要約ジョブのステップ処理（Geminiキーがある時のみ進む）。CF制限時は診断記録。
  const g = await guardHeavy(env, "summary jobs", () => processSummaryJobs(env));
  const summarized = g.ok ? g.value : 0;

  // マルチエージェントの長時間ジョブ（Pro・バックグラウンド実行）。CF制限時は診断記録。
  const aj = await guardHeavy(env, "agent jobs", () => processAgentJobs(locals.ctx, new URL(request.url).origin));
  const agentJobs = aj.ok ? aj.value : 0;

  const accessToken = await getApiKey(env, "line_token");
  // 動画ジョブのポーリング（完成→DL保存＋LINE通知）。
  const vr = await guardHeavy(env, "video jobs", () => pollVideoJobs(env, accessToken ?? undefined));
  const video = vr.ok ? vr.value : { done: 0, pending: 0 };
  let sent = 0;
  if (accessToken) {
    for (const r of await dueReminders(locals.ctx)) {
      const userId = r.owner.startsWith("line:") ? r.owner.slice(5) : null;
      if (userId) { await linePush(accessToken, userId, `⏰ リマインド：${r.content}`); sent++; }
      await markReminderDone(locals.ctx, r.id);
    }
  }
  // 任意：Google ドライブへの定期バックアップ（有効時のみ）。
  let driveBackup: { uploaded: number; error?: string } = { uploaded: 0 };
  if ((await getDriveBackup(env)).enabled) {
    const dr = await guardHeavy(env, "drive backup", () => backupToDrive(env, 5));
    if (dr.ok) driveBackup = dr.value;
  }

  return json({ ok: true, sent, summarized, video, agentJobs, driveBackup });
};
