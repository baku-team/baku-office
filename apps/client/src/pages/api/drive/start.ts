import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth.ts";
import { driveAuthUrl } from "../../../lib/drive.ts";
import { newState } from "../../../lib/oauth.ts";

export const prerender = false;

// Google ドライブ連携の開始（管理者・Plus以上）。OAuth同意（offline）へリダイレクト。
export const GET: APIRoute = async ({ request, locals, url, cookies, redirect }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return new Response("管理者のみ", { status: 403 });
  const authUrl = driveAuthUrl(env, url.origin, (() => { const s = newState(); cookies.set("drive_state", s, { httpOnly: true, secure: true, path: "/", maxAge: 600, sameSite: "lax" }); return s; })());
  if (!authUrl) return new Response("Google OAuth が未設定です（GOOGLE_CLIENT_ID/SECRET）。", { status: 400 });
  return redirect(authUrl, 302);
};
