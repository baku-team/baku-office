import type { APIRoute } from "astro";
import { getApp, signAppPackage, callerFromToken, recordDownload } from "../../../lib/registry.ts";
import { atLeast, type Entitlement } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 署名付きアプリ取り込み（token必須）。承認済み＋DL可能な最低プラン充足のみ。DL を記録。
export const POST: APIRoute = async ({ request, locals }) => {
  const b = (await request.json().catch(() => ({}))) as { token?: string; id?: string };
  const caller = await callerFromToken(env, b.token);
  if (!caller) return json({ error: "有効なライセンスが必要" }, 401);
  const id = (b.id ?? "").trim();
  if (!id) return json({ error: "id が必要" }, 400);
  const app = await getApp(env, id);
  if (!app || app.status !== "approved") return json({ error: "承認済みアプリが見つかりません" }, 404);
  if (!atLeast(caller.entitlement, (app.min_entitlement || "free") as Entitlement)) return json({ error: `このアプリの入手には ${app.min_entitlement} 以上のプランが必要です` }, 403);
  await recordDownload(env, id, caller.licenseId);
  return json({ ok: true, pkg: await signAppPackage(env, app) });
};
