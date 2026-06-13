import type { APIRoute } from "astro";
import { stripeEnabled } from "../../../lib/billing.ts";
import { env } from "cloudflare:workers";

export const prerender = false;

// Stripe接続状態（クライアントの課金画面がデモ/本番を出し分けるため）。
export const GET: APIRoute = async ({ locals }) =>
  new Response(JSON.stringify({ stripe: stripeEnabled(env) }), { headers: { "content-type": "application/json" } });
