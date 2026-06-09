// エージェントの破壊的/対外操作の人間承認ゲート（第三者レビュー P0-4）。
// 対外/破壊系ツール（gmail送信・予定改変/削除・A2A連携など）は、実行前に preview を出して
// pending で保留し、人間が承認したときだけ実行する。既定 on（org が信頼運用する場合のみ admin が off に可）。
import { randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";
import { audit } from "./storage.ts";
import type { AgentTool } from "../core/parts.ts";

// A2A（他団体連携）の対外ツール。AgentTool ではなく agent.ts 側で捌くため、名前で判定する。
export const A2A_OUTWARD = new Set(["call_partner", "broadcast_group", "call_group_member"]);

// 承認が必要か。対外/破壊系（part tool は unattended:false、A2A は名前一致）。
export function needsApproval(name: string, activeTools: AgentTool[]): boolean {
  if (A2A_OUTWARD.has(name)) return true;
  const t = activeTools.find((x) => x.name === name);
  return t?.unattended === false;
}

// 承認モード（既定 on）。安全側の既定。org が信頼運用する場合のみ admin が off にできる。
export async function getApprovalMode(env: Env): Promise<boolean> {
  return (await env.LICENSE.get("agent_approval")) !== "off";
}
export async function setApprovalMode(env: Env, on: boolean): Promise<boolean> {
  await env.LICENSE.put("agent_approval", on ? "on" : "off");
  return on;
}

// 人間向けの操作プレビュー（何が起きるかを明示）。
export function previewFor(tool: string, args: Record<string, unknown>): string {
  const s = (k: string) => (args[k] == null ? "" : String(args[k]));
  switch (tool) {
    case "send_message": return `メール送信：宛先「${s("to")}」／件名「${s("subject")}」`;
    case "update_event": return `予定の変更：「${s("title") || s("event_id")}」`;
    case "delete_event": return `予定の削除：event_id「${s("event_id")}」`;
    case "call_partner": return `他団体連携（A2A）：partner=${s("partner")} / action=${s("action")}`;
    case "broadcast_group": return `グループ同報（A2A）：group=${s("group")} / action=${s("action")}`;
    case "call_group_member": return `グループ内連携（A2A）：group=${s("group")} / partner=${s("partner")} / action=${s("action")}`;
    default: {
      const j = JSON.stringify(args ?? {});
      return `${tool}（${j.length > 200 ? j.slice(0, 200) + "…" : j}）`;
    }
  }
}

export type Approval = { id: string; owner: string; tool: string; args: string; preview: string; status: string; result: string | null; created_at: number; decided_at: number | null; decided_by: string | null };

// 承認を起案（pending で保存）。返り値は承認ID。
export async function createApproval(env: Env, owner: string, tool: string, args: Record<string, unknown>, preview: string): Promise<string> {
  const id = randomId();
  await env.DB.prepare("INSERT INTO agent_approvals (id,owner,tool,args,preview,status,created_at) VALUES (?,?,?,?,?, 'pending', ?)")
    .bind(id, owner, tool, JSON.stringify(args ?? {}), preview, nowSec()).run();
  await audit(env, owner, "agent_approval_request", `${tool}:${id}`);
  return id;
}
export async function listApprovals(env: Env, status = "pending", limit = 100): Promise<Approval[]> {
  return (await env.DB.prepare("SELECT * FROM agent_approvals WHERE status=? ORDER BY created_at DESC LIMIT ?").bind(status, limit).all<Approval>()).results;
}
export async function getApproval(env: Env, id: string): Promise<Approval | null> {
  return (await env.DB.prepare("SELECT * FROM agent_approvals WHERE id=?").bind(id).first<Approval>()) ?? null;
}

// 承認判定。approve=false は却下。approve=true は exec（実ツール実行）を呼び結果を保存。
export async function decideApproval(
  env: Env,
  id: string,
  approve: boolean,
  by: string,
  exec: (tool: string, args: Record<string, unknown>) => Promise<string>,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const a = await getApproval(env, id);
  if (!a) return { ok: false, error: "承認が見つかりません" };
  if (a.status !== "pending") return { ok: false, error: "すでに処理済みです" };
  if (!approve) {
    await env.DB.prepare("UPDATE agent_approvals SET status='rejected', decided_at=?, decided_by=? WHERE id=?").bind(nowSec(), by, id).run();
    await audit(env, by, "agent_approval_reject", `${a.tool}:${id}`);
    return { ok: true };
  }
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(a.args) as Record<string, unknown>; } catch { /* {} */ }
  const result = await exec(a.tool, parsed);
  await env.DB.prepare("UPDATE agent_approvals SET status='approved', result=?, decided_at=?, decided_by=? WHERE id=?").bind(result.slice(0, 4000), nowSec(), by, id).run();
  await audit(env, by, "agent_approval_approve", `${a.tool}:${id}`);
  return { ok: true, result };
}
