// マルチエージェントの長時間ジョブ（バックグラウンド実行）。enqueue→drain で順次処理し、結果をチャットセッションへ追記。
import type { Ctx } from "../core/ports.ts";
import type { Role } from "@baku-office/shared";
import { randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";
import { runAgent } from "./agent.ts";
import { appendMessage } from "./chat-sessions.ts";

export async function enqueueAgentJob(ctx: Ctx, a: { owner: string; sessionId?: string; prompt: string; role?: Role; baseUrl?: string }): Promise<string> {
  const id = randomId();
  const now = nowSec();
  await ctx.db.prepare("INSERT INTO agent_jobs (id,owner,session_id,prompt,role,status,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?)")
    .bind(id, a.owner, a.sessionId ?? null, a.prompt, a.role ?? "member", now, now).run();
  return id;
}

// pending を取り出して実行（drain から呼ぶ）。最大 limit 件。処理件数を返す。
export async function processAgentJobs(ctx: Ctx, baseUrl = "", limit = 2): Promise<number> {
  const { results } = await ctx.db.prepare("SELECT id,owner,session_id,prompt,role FROM agent_jobs WHERE status='pending' ORDER BY created_at LIMIT ?").bind(limit)
    .all<{ id: string; owner: string; session_id: string | null; prompt: string; role: string }>();
  let done = 0;
  for (const j of results) {
    await ctx.db.prepare("UPDATE agent_jobs SET status='running', updated_at=? WHERE id=?").bind(nowSec(), j.id).run();
    try {
      const reply = await runAgent(ctx, j.owner, j.prompt, undefined, baseUrl, (j.role as Role) ?? "member");
      await ctx.db.prepare("UPDATE agent_jobs SET status='done', result=?, updated_at=? WHERE id=?").bind(reply, nowSec(), j.id).run();
      if (j.session_id) await appendMessage(ctx, j.session_id, "assistant", reply).catch(() => {});
      done++;
    } catch (e) {
      await ctx.db.prepare("UPDATE agent_jobs SET status='error', result=?, updated_at=? WHERE id=?").bind(String((e as Error).message ?? e), nowSec(), j.id).run();
    }
  }
  return done;
}
