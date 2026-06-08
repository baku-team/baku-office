// A2A（他団体エージェント連携）クライアント側：公開アクションの管理・ホスト中継への送信・接続操作。
// 認証はホストが署名・接続(active)を検証。inbound 側でホスト署名＋公開アクション許可を再検証する。
import { hostFetch, getToken } from "./client.ts";

// ホスト中継で相手団体の公開アクション（公開名）を呼ぶ（outbound・1:1）。
export async function callPartner(env: Env, to: string, action: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const token = await getToken(env);
  if (!token) return { ok: false, error: "ライセンス未取得" };
  try {
    const r = await hostFetch(env, "/api/a2a/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, to, action, args }) });
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

// グループ操作（ホストへ中継）。
export async function groupHost(env: Env, action: "create" | "join" | "list" | "leave", body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const token = await getToken(env);
  if (!token) return { error: "ライセンス未取得" };
  const r = await hostFetch(env, "/api/a2a/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ _action: action, token, ...body }) });
  return (await r.json().catch(() => ({ error: "応答不正" }))) as Record<string, unknown>;
}

// グループ中継（to 指定で個別、未指定で同報）。公開名 action を指定。
export async function groupRelayCall(env: Env, groupId: string, to: string | null, action: string, args: Record<string, unknown>): Promise<{ ok: boolean; results?: { member: string; ok: boolean; result?: unknown; error?: string }[]; error?: string }> {
  const token = await getToken(env);
  if (!token) return { ok: false, error: "ライセンス未取得" };
  try {
    const r = await hostFetch(env, "/api/a2a/broadcast", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, groupId, to: to ?? undefined, action, args }) });
    return (await r.json().catch(() => ({ ok: false, error: "応答不正" }))) as { ok: boolean; results?: { member: string; ok: boolean; result?: unknown; error?: string }[]; error?: string };
  } catch (e) {
    return { ok: false, error: "ホストへ到達できません：" + ((e as Error).message ?? "") };
  }
}
