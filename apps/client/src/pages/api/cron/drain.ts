import type { APIRoute } from "astro";
import { getApiKey } from "../../../lib/client.ts";
import { linePush } from "../../../lib/agent.ts";
import { dueReminders, markReminderDone } from "../../../lib/agent-tools.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 期限到来リマインダーを一括配信（外部スケジューラ＝cron-job.org 等から毎分叩く）。
// Astro単一Workerはネイティブcron非対応のため、INTERNAL_KEY 保護のHTTPエンドポイントで代替。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  if (!env.INTERNAL_KEY || request.headers.get("x-internal-key") !== env.INTERNAL_KEY) return json({ error: "forbidden" }, 403);
  const accessToken = await getApiKey(env, "line_token");
  if (!accessToken) return json({ ok: true, sent: 0, note: "LINE未設定" });
  let sent = 0;
  for (const r of await dueReminders(env)) {
    const userId = r.owner.startsWith("line:") ? r.owner.slice(5) : null;
    if (userId) {
      await linePush(accessToken, userId, `⏰ リマインド：${r.content}`);
      sent++;
    }
    await markReminderDone(env, r.id);
  }
  return json({ ok: true, sent });
};
