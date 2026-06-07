import type { APIRoute } from "astro";
import { approvedCatalog } from "../../../lib/registry.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 取り込み候補カタログ（公開・承認済みのみ）。
export const GET: APIRoute = async ({ locals }) => json({ ok: true, apps: await approvedCatalog(locals.runtime.env) });
