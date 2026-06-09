import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth.ts";
import { exchangeGoogleCode } from "../../../lib/google.ts";

export const prerender = false;

// Google Workspace 連携のコールバック：code → リフレッシュトークンを暗号保存（apikey:google_refresh）。
export const GET: APIRoute = async ({ request, locals, url, cookies, redirect }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return new Response("管理者のみ", { status: 403 });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = cookies.get("google_state")?.value;
  cookies.delete("google_state", { path: "/" });
  if (!code || !state || state !== saved) return redirect("/calendar?error=state", 302);
  const ok = await exchangeGoogleCode(env, url.origin, code);
  return redirect(ok ? "/calendar?connected=1" : "/calendar?error=token", 302);
};
