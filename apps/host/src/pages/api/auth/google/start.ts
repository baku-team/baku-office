import type { APIRoute } from "astro";
import { googleEnabled, googleAuthUrl } from "../../../../lib/hostauth.ts";
import { randomId } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  if (!googleEnabled(env)) return new Response("Google未設定（devログインをご利用ください）", { status: 404 });
  const state = randomId(12);
  return new Response(null, {
    status: 302,
    headers: { location: googleAuthUrl(env, url.origin, state), "set-cookie": `host_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` },
  });
};
