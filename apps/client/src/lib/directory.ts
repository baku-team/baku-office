// 公開ディレクトリ（クライアント側）：自団体プロフィールの公開・検索・実在検証・埋め込み生成。
// 公開は host の /api/directory/* へ中継。埋め込みは Workers AI（env.AI bge-m3）で生成（無ければ null＝キーワード検索）。
import type { Ctx } from "../core/ports.ts";
import { hostFetch, getToken } from "./client.ts";
import { webSearch } from "./media-ai.ts";
import { getOrgProfile, setOrgProfile, listPublicActions } from "./a2a-actions.ts";
import { brandName, getTheme } from "../core/theme.ts";

export type OrgPublicProfile = { summary?: string; tags?: string[]; contact?: string; website?: string; listed?: boolean };

// 公開プロフィールの読み書き（既存 KV org_profile を共用）。
export async function getPublicProfile(ctx: Ctx): Promise<OrgPublicProfile> {
  const p = await getOrgProfile(ctx);
  return { summary: p.summary as string, tags: (p.tags as string[]) ?? [], contact: p.contact as string, website: p.website as string, listed: p.listed === true };
}
export async function setPublicProfile(ctx: Ctx, patch: OrgPublicProfile): Promise<OrgPublicProfile> {
  const cur = await getOrgProfile(ctx);
  const next = { ...cur, ...patch };
  await setOrgProfile(ctx, next);
  return next as OrgPublicProfile;
}

// 団体名（テーマのブランド名）。ディレクトリ掲載名に使う。
export async function orgDisplayName(ctx: Ctx): Promise<string> {
  return brandName(await getTheme(ctx));
}

// Workers AI で埋め込み生成（多言語 bge-m3）。env.AI 無し/失敗は null。
export async function buildEmbedding(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI || !text.trim()) return null;
  try {
    const r = (await env.AI.run("@cf/baai/bge-m3", { text: text.slice(0, 2000) })) as { data?: number[][] };
    const v = r?.data?.[0];
    if (!Array.isArray(v) || !v.length) return null;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; // 正規化（コサイン＝内積）
    return v.map((x) => x / norm);
  } catch { return null; }
}

// 公開時のWeb実在検証：団体名/サイトをWeb検索し、実在性・整合・評判を判定（Gemini web_search）。
export type Verification = { exists: boolean; siteMatch: boolean; reputation: "good" | "mixed" | "unknown"; score: number; summary: string; checked_at: number };
export async function verifyOrgExistence(env: Env, info: { orgName: string; website?: string }): Promise<Verification> {
  const now = Math.floor(Date.now() / 1000);
  const q = `${info.orgName} ${info.website ?? ""} 公式 事業内容 評判 口コミ`.trim();
  const text = await webSearch(env, `次の団体の実在性・事業実態・評判を簡潔に。問題（詐欺/苦情/反社の噂など）があれば明記：${q}`).catch(() => null);
  if (!text) return { exists: false, siteMatch: false, reputation: "unknown", score: 0, summary: "AI(Web検索)未設定のため未検証", checked_at: now };
  const low = text.toLowerCase();
  const bad = /詐欺|被害|苦情|反社|逮捕|行政処分|scam|fraud|complaint/.test(text);
  const exists = !/見つかりません|該当なし|情報が得られ|not found|no result/.test(low) && text.length > 30;
  const reputation: Verification["reputation"] = bad ? "mixed" : exists ? "good" : "unknown";
  const score = (exists ? 0.5 : 0) + (info.website ? 0.2 : 0) + (reputation === "good" ? 0.3 : 0);
  return { exists, siteMatch: !!info.website, reputation, score: Math.round(score * 100) / 100, summary: text.slice(0, 400), checked_at: now };
}

// 接触時の相手審査（受付ポリシー requireAiReview 時）。相手団体名をWeb調査し応答可否のヒントを返す。
export async function reviewIncomingPartner(env: Env, fromName: string): Promise<{ ok: boolean; reason: string }> {
  if (!fromName) return { ok: true, reason: "相手名不明（既定許可）" };
  const text = await webSearch(env, `団体「${fromName}」に詐欺・苦情・反社などの問題がないか簡潔に`).catch(() => null);
  if (!text) return { ok: true, reason: "Web検索未設定（既定許可）" };
  const bad = /詐欺|被害|苦情|反社|逮捕|行政処分|scam|fraud/.test(text);
  return { ok: !bad, reason: text.slice(0, 200) };
}

// === host ディレクトリ中継 ===
export async function publishDirectory(env: Env, ctx: Ctx, opts: { listed: boolean; verification?: Verification }): Promise<Record<string, unknown>> {
  const token = await getToken(env);
  if (!token) return { error: "ライセンス未取得" };
  const profile = await getPublicProfile(ctx);
  const orgName = await orgDisplayName(ctx);
  const publicActions = await listPublicActions(ctx);
  const text = `${orgName} ${profile.summary ?? ""} ${(profile.tags ?? []).join(" ")}`;
  const embedding = await buildEmbedding(env, text);
  const r = await hostFetch(env, "/api/directory/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, orgName, profile: { ...profile, public_actions: publicActions }, embedding, verification: opts.verification, listed: opts.listed }),
  });
  return (await r.json().catch(() => ({ error: "応答不正" }))) as Record<string, unknown>;
}
export async function unpublishDirectory(env: Env): Promise<Record<string, unknown>> {
  const token = await getToken(env);
  if (!token) return { error: "ライセンス未取得" };
  const r = await hostFetch(env, "/api/directory/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, _action: "unpublish" }) });
  return (await r.json().catch(() => ({ error: "応答不正" }))) as Record<string, unknown>;
}
export async function myDirectory(env: Env): Promise<Record<string, unknown>> {
  const token = await getToken(env);
  if (!token) return { error: "ライセンス未取得" };
  const r = await hostFetch(env, "/api/directory/mine", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  return (await r.json().catch(() => ({ error: "応答不正" }))) as Record<string, unknown>;
}
export type SearchCandidate = { license_id: string; org_name: string; summary: string; tags: string[]; verified: boolean; trust_score: number; public_actions: { name: string; label?: string }[] };
export async function searchDirectory(env: Env, query: string, tags?: string[]): Promise<{ ok: boolean; results?: SearchCandidate[]; error?: string }> {
  const token = await getToken(env);
  if (!token) return { ok: false, error: "ライセンス未取得" };
  const queryEmbedding = query ? await buildEmbedding(env, query) : null;
  const r = await hostFetch(env, "/api/directory/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, query, queryEmbedding, tags }) });
  return (await r.json().catch(() => ({ ok: false, error: "応答不正" }))) as { ok: boolean; results?: SearchCandidate[]; error?: string };
}
export async function reportDirectory(env: Env, target: string, reason: string, detail?: string): Promise<Record<string, unknown>> {
  const token = await getToken(env);
  if (!token) return { error: "ライセンス未取得" };
  const r = await hostFetch(env, "/api/directory/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, target, reason, detail }) });
  return (await r.json().catch(() => ({ error: "応答不正" }))) as Record<string, unknown>;
}
