// アプリストア（クライアント側）：ホスト中継でカタログ閲覧・評価・掲載設定（提供者）。
import { hostFetch, getToken } from "./client.ts";

export type StoreApp = { id: string; name: string; version: string; category: string | null; description: string | null; permissions: string[]; min_entitlement: string; downloads: number; avg_rating: number; reviews: number; badges: string[] };

async function call(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await getToken(env);
  if (!token) return { error: "ライセンス未取得" };
  try {
    const r = await hostFetch(env, "/api/registry/store", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...body }) });
    return (await r.json().catch(() => ({ error: "応答不正" }))) as Record<string, unknown>;
  } catch (e) { return { error: "ホストへ到達できません：" + ((e as Error).message ?? "") }; }
}

export async function storeCatalog(env: Env): Promise<StoreApp[]> {
  const r = await call(env, { _action: "catalog" });
  return (r.apps as StoreApp[]) ?? [];
}
export type MyApp = { id: string; name: string; version: string; status: string; listed: number; min_entitlement: string; downloads: number; avg: number; reviews: number };
export async function myApps(env: Env): Promise<MyApp[]> {
  const r = await call(env, { _action: "mine" });
  return (r.apps as MyApp[]) ?? [];
}
export async function setListed(env: Env, appId: string, listed: boolean, minEntitlement: string): Promise<Record<string, unknown>> {
  return call(env, { _action: "set_listed", appId, listed, minEntitlement });
}
export async function rateApp(env: Env, appId: string, rating: number, body?: string): Promise<Record<string, unknown>> {
  return call(env, { _action: "rate", appId, rating, body });
}
export async function listReviews(env: Env, appId: string): Promise<{ rating: number; body: string | null; created_at: number }[]> {
  const r = await call(env, { _action: "reviews", appId });
  return (r.reviews as { rating: number; body: string | null; created_at: number }[]) ?? [];
}
