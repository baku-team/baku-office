// A2A（他団体エージェント連携）クライアント側：公開アクションの管理・ホスト中継への送信・接続操作。
// 認証はホストが署名・接続(active)を検証。inbound 側でホスト署名＋公開アクション許可を再検証する。
import type { Ctx } from "../core/ports.ts";
import { hostFetch, getToken } from "./client.ts";

const KV_EXPOSED = "a2a_exposed"; // この団体が相手に公開する "appId.action" の配列。

export async function getExposedActions(ctx: Ctx): Promise<string[]> {
  const raw = await ctx.storage.kv.get(KV_EXPOSED);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
export async function setExposedActions(ctx: Ctx, list: string[]): Promise<string[]> {
  const clean = [...new Set((list ?? []).map(String).filter((s) => /^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(s)))];
  await ctx.storage.kv.put(KV_EXPOSED, JSON.stringify(clean));
  return clean;
}

// ホスト中継で相手団体のアクションを呼ぶ（outbound）。
export async function callPartner(env: Env, to: string, appId: string, action: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const token = await getToken(env);
  if (!token) return { ok: false, error: "ライセンス未取得" };
  try {
    const r = await hostFetch(env, "/api/a2a/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, to, appId, action, args }) });
    return (await r.json().catch(() => ({ ok: false, error: "応答不正" }))) as { ok: boolean; result?: unknown; error?: string };
  } catch (e) {
    return { ok: false, error: "ホストへ到達できません：" + ((e as Error).message ?? "") };
  }
}

// 接続操作（ホストへ中継）。
export async function a2aHost(env: Env, action: "create" | "accept" | "list" | "revoke", body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const token = await getToken(env);
  if (!token) return { error: "ライセンス未取得" };
  const r = await hostFetch(env, "/api/a2a/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ _action: action, token, ...body }) });
  return (await r.json().catch(() => ({ error: "応答不正" }))) as Record<string, unknown>;
}

// ===== グループ（1:1とは別管理。公開アクションはグループ別 allowlist） =====
const gexposedKey = (groupId: string) => `a2a_gexposed:${groupId}`;
export async function getGroupExposed(ctx: Ctx, groupId: string): Promise<string[]> {
  const raw = await ctx.storage.kv.get(gexposedKey(groupId));
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
export async function setGroupExposed(ctx: Ctx, groupId: string, list: string[]): Promise<string[]> {
  const clean = [...new Set((list ?? []).map(String).filter((s) => /^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(s)))];
  await ctx.storage.kv.put(gexposedKey(groupId), JSON.stringify(clean));
  return clean;
}

// グループ操作（ホストへ中継）。
export async function groupHost(env: Env, action: "create" | "join" | "list" | "leave", body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const token = await getToken(env);
  if (!token) return { error: "ライセンス未取得" };
  const r = await hostFetch(env, "/api/a2a/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ _action: action, token, ...body }) });
  return (await r.json().catch(() => ({ error: "応答不正" }))) as Record<string, unknown>;
}

// グループ中継（to 指定で個別、未指定で同報）。
export async function groupRelayCall(env: Env, groupId: string, to: string | null, appId: string, action: string, args: Record<string, unknown>): Promise<{ ok: boolean; results?: { member: string; ok: boolean; result?: unknown; error?: string }[]; error?: string }> {
  const token = await getToken(env);
  if (!token) return { ok: false, error: "ライセンス未取得" };
  try {
    const r = await hostFetch(env, "/api/a2a/broadcast", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, groupId, to: to ?? undefined, appId, action, args }) });
    return (await r.json().catch(() => ({ ok: false, error: "応答不正" }))) as { ok: boolean; results?: { member: string; ok: boolean; result?: unknown; error?: string }[]; error?: string };
  } catch (e) {
    return { ok: false, error: "ホストへ到達できません：" + ((e as Error).message ?? "") };
  }
}
