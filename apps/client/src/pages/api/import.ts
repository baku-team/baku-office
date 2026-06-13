import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { cachedEntitlement } from "../../lib/client.ts";
import { simulateImport, runImport, type ImportSource } from "../../lib/import.ts";
import { atLeast } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 外部資料インポート（Plus以上・管理者）。simulate＝試算のみ、run＝実行。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  if (!atLeast(await cachedEntitlement(env), "plus")) return json({ error: "インポートは Plus 以上で利用できます" }, 403);

  const b = (await request.json().catch(() => ({}))) as { _action?: string; source?: string; withFiles?: boolean };
  const source = (b.source === "notion" ? "notion" : "drive") as ImportSource;
  const withFiles = !!b.withFiles;
  if (b._action === "simulate") return json(await simulateImport(env, source, withFiles));
  if (b._action === "run") return json(await runImport(env, source, withFiles));
  return json({ error: "不明な操作" }, 400);
};
