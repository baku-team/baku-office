import type { APIRoute } from "astro";
import { initialEntitlement, randomId, type Plan } from "@baku-office/shared";

export const prerender = false;
const nowSec = (): number => Math.floor(Date.now() / 1000);

// 申込（申込専用Worker）：団体情報＋プラン → customers/licenses 作成。free は即時、plus/pro は入金前 free 相当（§2.3）。
// ホストポータルと同じ D1 を共有。本番は Google ログイン後に呼ぶ（Phase1 は googleSub 任意）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as {
    orgName?: string;
    contactName?: string;
    contactEmail?: string;
    plan?: Plan;
    googleSub?: string;
  };
  if (!b.orgName || !b.contactEmail || !b.plan || !["free", "plus", "pro"].includes(b.plan)) {
    return json({ error: "orgName・contactEmail・plan(free/plus/pro) が必要" }, 400);
  }
  const now = nowSec();
  const customerId = randomId();
  const licenseId = randomId();
  await env.DB.prepare("INSERT INTO customers (id, org_name, contact_name, contact_email, created_at) VALUES (?,?,?,?,?)")
    .bind(customerId, b.orgName, b.contactName ?? null, b.contactEmail ?? null, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO licenses (license_id, customer_id, plan, entitlement, status, google_sub, created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(licenseId, customerId, b.plan, initialEntitlement(b.plan), "active", b.googleSub ?? null, now)
    .run();
  return json({ ok: true, licenseId, plan: b.plan, entitlement: initialEntitlement(b.plan) });
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
