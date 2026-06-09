import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { cachedEntitlement } from "../../lib/client.ts";
import { getLimits, setLimits, type Limits } from "../../lib/usage.ts";
import { atLeast } from "@baku-office/shared";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 従量上限の保存（管理者・Plus以上）。{ limits: { provider: {freeQuota,monthlyCap,monthlyUsdCap,onExceed} } }
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  if (!atLeast(await cachedEntitlement(env), "plus")) return json({ error: "API使用量は Plus 以上で利用できます" }, 403);

  const b = (await request.json().catch(() => ({}))) as { limits?: Limits };
  const incoming = b.limits ?? {};
  const clean: Limits = {};
  for (const [prov, v] of Object.entries(incoming)) {
    const fq = Number(v?.freeQuota); const mc = Number(v?.monthlyCap); const uc = Number(v?.monthlyUsdCap);
    const onExceed = v?.onExceed === "switch_free" ? "switch_free" : "pause";
    clean[prov] = {
      ...(Number.isFinite(fq) && fq > 0 ? { freeQuota: Math.round(fq) } : {}),
      ...(Number.isFinite(mc) && mc > 0 ? { monthlyCap: Math.round(mc) } : {}),
      ...(Number.isFinite(uc) && uc > 0 ? { monthlyUsdCap: Math.round(uc * 100) / 100 } : {}),
      onExceed,
    };
  }
  await setLimits(env, clean);
  return json({ ok: true, limits: await getLimits(env) });
};
