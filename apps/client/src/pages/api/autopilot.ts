import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { entitlementForGate } from "../../lib/client.ts";
import { atLeast } from "@baku-office/shared";
import { ghDeviceStart, ghDevicePoll, ghListRepos, saveAutonomyConfig } from "../../lib/autonomy.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// オートパイロット：GitHub OAuth デバイスフロー（PAT不要）＋リポ自動検出。Pro・管理者。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  if (!atLeast(await entitlementForGate(env), "pro")) return json({ error: "オートパイロットは Pro 以上で利用できます" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; deviceCode?: string; repo?: string };
  if (b._action === "gh_start") return json(await ghDeviceStart(env));
  if (b._action === "gh_poll") return json(await ghDevicePoll(env, String(b.deviceCode ?? "")));
  if (b._action === "gh_repos") return json({ ok: true, repos: await ghListRepos(env) });
  if (b._action === "set_repo") { await saveAutonomyConfig(env, { ghRepo: String(b.repo ?? "") }); return json({ ok: true }); }
  return json({ error: "不明な操作" }, 400);
};
