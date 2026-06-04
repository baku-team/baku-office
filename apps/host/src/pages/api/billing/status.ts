import type { APIRoute } from "astro";
import { stripeEnabled } from "../../../lib/billing.ts";

export const prerender = false;

// Stripe接続状態（クライアントの課金画面がデモ/本番を出し分けるため）。
export const GET: APIRoute = async ({ locals }) =>
  new Response(JSON.stringify({ stripe: stripeEnabled(locals.runtime.env) }), { headers: { "content-type": "application/json" } });
