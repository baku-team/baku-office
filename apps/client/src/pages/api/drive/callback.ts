import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth.ts";
import { exchangeDriveCode } from "../../../lib/drive.ts";

export const prerender = false;

// Google ドライブ連携のコールバック：code → リフレッシュトークンを暗号保存。
export const GET: APIRoute = async ({ request, locals, url, cookies, redirect }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return new Response("管理者のみ", { status: 403 });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = cookies.get("drive_state")?.value;
  cookies.delete("drive_state", { path: "/" });
  if (!code || !state || state !== saved) return redirect("/drive?error=state", 302);
  const ok = await exchangeDriveCode(env, url.origin, code);
  return redirect(ok ? "/drive?connected=1" : "/drive?error=token", 302);
};
