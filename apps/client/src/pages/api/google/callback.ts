import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth.ts";
import { exchangeGoogleCode, normalizeGroups } from "../../../lib/google.ts";

export const prerender = false;

// Google Workspace 連携のコールバック：code → リフレッシュトークンを暗号保存（apikey:google_refresh）。
// 開始時に選んだ用途別グループ（cookie）を付与scopeとして記録（P0-3）。
export const GET: APIRoute = async ({ request, locals, url, cookies, redirect }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return new Response("管理者のみ", { status: 403 });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = cookies.get("google_state")?.value;
  const groupsCookie = cookies.get("google_groups")?.value ?? "";
  cookies.delete("google_state", { path: "/" });
  cookies.delete("google_groups", { path: "/" });
  if (!code || !state || state !== saved) return redirect("/calendar?error=state", 302);
  const groups = normalizeGroups(groupsCookie ? groupsCookie.split(",") : null);
  const ok = await exchangeGoogleCode(env, url.origin, code, groups);
  return redirect(ok ? "/calendar?connected=1" : "/calendar?error=token", 302);
};
