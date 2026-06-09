import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth.ts";
import { googleAuthUrl, normalizeGroups } from "../../../lib/google.ts";
import { newState } from "../../../lib/oauth.ts";

export const prerender = false;

// Google Workspace 連携の開始（管理者・org）。?groups=calendar,gmail_read,gmail_send,meet で
// 用途別 scope を選んで段階同意（incremental auth・P0-3）。groups 未指定は全グループ（後方互換）。
export const GET: APIRoute = async ({ request, locals, url, cookies, redirect }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return new Response("管理者のみ", { status: 403 });
  const param = url.searchParams.get("groups");
  const groups = normalizeGroups(param ? param.split(",").map((s) => s.trim()) : null);
  const s = newState();
  cookies.set("google_state", s, { httpOnly: true, secure: true, path: "/", maxAge: 600, sameSite: "lax" });
  cookies.set("google_groups", groups.join(","), { httpOnly: true, secure: true, path: "/", maxAge: 600, sameSite: "lax" });
  const authUrl = googleAuthUrl(env, url.origin, s, groups);
  if (!authUrl) return new Response("Google OAuth が未設定です（GOOGLE_CLIENT_ID/SECRET）。", { status: 400 });
  return redirect(authUrl, 302);
};
