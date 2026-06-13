import type { APIRoute } from "astro";
import { getApiKey } from "../../../lib/client.ts";
import { linePush } from "../../../lib/agent.ts";
import { dueReminders, markReminderDone } from "../../../parts/reminders.ts";
import { processSummaryJobs } from "../../../lib/media-ai.ts";
import { pollVideoJobs } from "../../../lib/capabilities.ts";
import { processAgentJobs } from "../../../lib/agent-jobs.ts";
import { guardHeavy } from "../../../lib/diag.ts";
import { getDriveBackup, backupToDrive, driveConnected, uploadBufferToDrive } from "../../../lib/drive.ts";
import { getBackupSchedule, backupAlert, buildBackup, backupFileName, recordBackupDone } from "../../../lib/backup.ts";
import { flushReports } from "../../../lib/reports.ts";
import { addNotification, pushWebhook } from "../../../lib/notifications.ts";
import { getNotifyWebhook } from "../../../lib/settings.ts";
import { purgeFiles } from "../../../lib/storage.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 期限到来リマインダー等の定期処理を一括実行（INTERNAL_KEY 保護のHTTPエンドポイント）。
// Astro単一Workerはネイティブcron非対応のため、当社運用は apps/scheduler（Cron Triggers）が
// Service Binding 経由で起動。配布クライアント（別アカウント）は外部スケジューラ等で起動する。
export const POST: APIRoute = async ({ request, locals }) => {
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
  // 期限到来リマインダーの配信。LINE 紐付けは push、org 等は アプリ内通知＋任意 Webhook。
  let sent = 0, notified = 0;
  const notifyWebhook = await getNotifyWebhook(env);
  for (const r of await dueReminders(locals.ctx)) {
    const userId = r.owner.startsWith("line:") ? r.owner.slice(5) : null;
    if (userId) {
      if (!accessToken) continue; // LINEトークン未設定なら done にせず次回へ回す
      await linePush(accessToken, userId, `⏰ リマインド：${r.content}`); sent++;
    } else {
      // org 等 LINE 未紐付けスコープ：アプリ内通知＋（設定時）Webhook プッシュ
      await addNotification(locals.ctx, { owner: r.owner, kind: "reminder", body: `⏰ ${r.content}`, link: "/invoices" });
      if (notifyWebhook) await pushWebhook(notifyWebhook, `⏰ リマインド：${r.content}`).catch(() => {});
      notified++;
    }
    await markReminderDone(locals.ctx, r.id);
  }
  // 任意：Google ドライブへの定期バックアップ（有効時のみ）。
  let driveBackup: { uploaded: number; error?: string } = { uploaded: 0 };
  if ((await getDriveBackup(env)).enabled) {
    const dr = await guardHeavy(env, "drive backup", () => backupToDrive(env, 5));
    if (dr.ok) driveBackup = dr.value;
  }

  // 全データの定期バックアップ（有効＋Drive連携＋前回から7日超過時のみ・P0-5）。重い処理のため未実施が続いた時だけ実行。
  let fullBackup: { uploaded: boolean; error?: string } = { uploaded: false };
  const sched = await getBackupSchedule(env);
  if (sched.enabled && (await driveConnected(env)) && (await backupAlert(env)).alert) {
    const bk = await guardHeavy(env, "full backup", async () => {
      const { json: body, tables, files } = await buildBackup(env, { decrypt: sched.mode === "decrypted" });
      const up = await uploadBufferToDrive(env, backupFileName(sched.mode === "decrypted"), "application/json", new TextEncoder().encode(body).buffer);
      if (!up.ok) throw new Error(up.error ?? "upload failed");
      await recordBackupDone(env, "drive", sched.mode, tables, files);
      return true;
    });
    fullBackup = bk.ok ? { uploaded: true } : { uploaded: false, error: bk.error };
  }

  // 未送信の報告（自動エラー・要望）をホストへ集積（自己修復ログ）。
  const fr = await guardHeavy(env, "flush reports", () => flushReports(env));
  const reportsSent = fr.ok ? fr.value : 0;

  // 保持期限切れ・ソフトデリート猶予超過ファイルの物理削除（P0-5）。
  const pf = await guardHeavy(env, "purge files", () => purgeFiles(env));
  const purged = pf.ok ? pf.value : { expired: 0, purged: 0 };

  return json({ ok: true, sent, notified, summarized, video, agentJobs, driveBackup, fullBackup, reportsSent, purged });
};
