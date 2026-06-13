import { kvPut } from "./kv.ts";
// Google連携の自動巡回（cron/drain から呼ぶ）。未処理の受信メールを検知し、エージェントジョブに積む。
// エージェント主体：cron は「未処理メールの検知＋ジョブ投入」だけ行い、分類・登録は runAgent が既存道具で実行。
// コスト/無料枠対策：1巡回の件数上限＋KVの既処理マーカー（message_id）で重複処理を防ぐ。
import type { Ctx } from "../core/ports.ts";
import { googleFetch } from "./google.ts";
import { enqueueAgentJob } from "./agent-jobs.ts";

const SEEN_KEY = "google_gmail_seen"; // 直近処理した message_id（重複防止・最大200件）

async function getSeen(env: Env): Promise<string[]> {
  try { const r = await env.LICENSE.get(SEEN_KEY); const v = r ? JSON.parse(r) : []; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

// 未読の受信メールから未処理分を最大 limit 件、エージェントジョブへ。processAgentJobs が後段で実行。
export async function pollUnprocessedEmails(env: Env, ctx: Ctx, limit = 3): Promise<number> {
  const u = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  u.searchParams.set("q", "is:unread newer_than:2d");
  u.searchParams.set("maxResults", "15");
  const r = await googleFetch(env, u.toString());
  if (!r || !r.ok) return 0;
  const d = (await r.json()) as { messages?: { id: string }[] };
  const ids = (d.messages ?? []).map((m) => m.id);
  if (!ids.length) return 0;
  const seen = new Set(await getSeen(env));
  const fresh = ids.filter((id) => !seen.has(id)).slice(0, limit);
  if (!fresh.length) return 0;
  for (const id of fresh) {
    await enqueueAgentJob(ctx, {
      owner: "org",
      role: "member",
      prompt:
        `受信メール（message_id=${id}）を get_message で確認し、内容に応じて対応する：` +
        `(1) 請求書/領収書なら get_attachment で添付を保存し、その file_id を register_invoice に渡して登録。` +
        `(2) 打合せ/予定の連絡なら create_event でカレンダー登録（オンライン会議が必要そうなら with_meet=true）。` +
        `(3) いずれでもなければ何もしない（返信不要）。` +
        `【厳守】メール送信・予定削除・既存データの削除など対外的/破壊的な操作は行わない。`,
    }).catch(() => {});
    seen.add(id);
  }
  await kvPut(env, SEEN_KEY, JSON.stringify([...seen].slice(-200))).catch(() => {});
  return fresh.length;
}
